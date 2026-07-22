// Box registry + push helpers. The core never generates display content — it
// only delivers what a backend produced, over the firmware's existing HTTP
// endpoints (/caption, /play, /order). Firmware is unchanged by design.
//
// Identity: a box IS its X-Box-Id header (an immutable, MAC-derived id the
// firmware persists in NVS and sends on every request) — never its source IP.
// IPs are DHCP leases; treating them as identity is how a registry silently
// rots. Here `ip` is just "last known address for this id", self-healed on
// every request the box makes.

import { networkInterfaces } from "node:os";

// The mcp-core host's own addresses. A real box is NEVER at one of these, so a
// request that appears to come "from" the host (loopback, or the Mac's own LAN
// IP — e.g. a test harness or proxy POSTing with a box's id from this machine)
// must NOT overwrite the box's real IP. Without this guard, such a request
// silently repointed the box at the host and broke every push to it — and
// persisted the bad IP to config.json.
const OWN_IPS = new Set(["127.0.0.1", "::1", "localhost"]);
for (const list of Object.values(networkInterfaces())) {
  for (const ni of list || []) OWN_IPS.add(ni.address.replace(/^::ffff:/, ""));
}

// The box font is ASCII-only (renders uppercase); HTTP headers must be latin-1
// and single-line — strip anything else so captions don't corrupt the request.
export function asciiOneline(s, limit = 200) {
  return (s || "")
    .replace(/[\n\r]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, limit);
}

export class BoxRegistry {
  // `onChange` fires after any mutation (new box, IP drift, rename) so the
  // owner can persist the registry back to config.json.
  // Box "ip" may carry an optional :port (useful for mock boxes in tests —
  // real firmware always listens on 80).
  constructor(boxes, onChange = null) {
    this.onChange = onChange;
    this.boxes = boxes.map((b, i) => ({
      // Older config files predate the id field — fall back to name so they
      // keep working; the first /register or request from the real box will
      // then pin the true id.
      id: b.id || b.name || `box${i + 1}`,
      name: b.name || b.id || `box${i + 1}`,
      ip: b.ip,
      host: b.ip.split(":")[0]
    }));
  }

  // The shape that goes back into config.json's "boxes" array.
  toConfig() {
    return this.boxes.map((b) => ({ id: b.id, name: b.name, ip: b.ip }));
  }

  byId(id) {
    return this.boxes.find((b) => b.id === id) || null;
  }

  // Add or update a box, keyed by its immutable id — a DHCP-renewed IP updates
  // the existing entry instead of creating a duplicate. Returns "added",
  // "updated", or "unchanged".
  upsert(id, name, ip) {
    const host = ip.split(":")[0];
    const existing = this.byId(id);
    if (!existing) {
      this.boxes.push({ id, name: name || id, ip, host });
      this.onChange?.();
      return "added";
    }
    let changed = false;
    // Match on host (not the full ip string) so a mock box registered with an
    // explicit :port isn't clobbered by a same-host request without one.
    if (existing.host !== host) {
      existing.ip = ip;
      existing.host = host;
      changed = true;
    }
    if (name && existing.name !== name) {
      existing.name = name;
      changed = true;
    }
    if (changed) this.onChange?.();
    return changed ? "updated" : "unchanged";
  }

  // Resolve the box a request came from, via its X-Box-Id header.
  // Returns null when the header is missing (caller should 400 — a request
  // with no id is a bug to surface, not something to guess from the IP).
  // Unknown ids auto-register with a loud warning; known ids self-heal a
  // drifted IP in passing.
  fromId(req) {
    const id = req.headers["x-box-id"];
    if (!id) return null;
    const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const existing = this.byId(id);
    if (!existing) {
      console.warn(`Unknown box "${id}" auto-registered from ${ip} — verify this is expected.`);
      this.upsert(id, id, ip);
      return this.byId(id);
    }
    if (existing.host !== ip && !OWN_IPS.has(ip)) {
      console.log(`Box "${id}" moved ${existing.ip} -> ${ip} (DHCP drift) — config updated.`);
      this.upsert(id, null, ip);
    } else if (existing.host !== ip) {
      console.warn(`Ignoring "${id}" IP change to ${ip}: that's this host's own address, ` +
                   `not a real box (test harness or proxy?). Keeping ${existing.ip}.`);
    }
    return existing;
  }
}

async function postToBox(box, boxPath, body, headers = {}, timeoutMs = 60000) {
  const res = await fetch(`http://${box.ip}${boxPath}`, {
    method: "POST",
    body,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return res.status;
}

export async function sendCaption(box, text, { who = "YOU", confirm = false } = {}) {
  const headers = { "X-Speaker": asciiOneline(who, 40) };
  // Tells the firmware to arm its tap-to-confirm window for this caption.
  if (confirm) headers["X-Confirm"] = "1";
  try {
    return await postToBox(box, "/caption", asciiOneline(text), headers, 5000);
  } catch (err) {
    console.warn(`       (caption to ${box.name} failed: ${err.message})`);
    return null;
  }
}

export async function sendAudio(box, wavBuffer, { quiet = false, final = false, replyText = null, autoListen = false } = {}) {
  const headers = { "Content-Type": "audio/wav" };
  if (quiet) headers["X-Quiet"] = "1"; // sentence chunk: don't touch the display
  if (final) headers["X-Final"] = "1"; // last chunk: linger caption, then READY
  if (replyText) headers["X-Reply-Text"] = asciiOneline(replyText); // shows + lingers a caption
  // Tells the firmware to start a listen turn (record+upload, no button
  // needed) the instant this audio finishes playing — used for the wake/
  // greeting flow. A long timeout: the box doesn't respond to this POST
  // until the ENTIRE listen+upload round trip completes on its end.
  if (autoListen) headers["X-Auto-Listen"] = "1";
  return await postToBox(box, "/play", wavBuffer, headers, autoListen ? 120000 : 60000);
}

// Verbatim passthrough of a backend-supplied display entry:
//   { path: "/order", body: "TITLE|...", headers: {...} }
// The core does not know or care what the body means.
export async function sendDisplay(box, entry) {
  const allowed = ["/order", "/caption"];
  if (!entry || !allowed.includes(entry.path)) {
    console.warn(`       (display entry with unsupported path ${entry && entry.path} — dropped)`);
    return null;
  }
  try {
    return await postToBox(box, entry.path, entry.body || "", entry.headers || {}, 5000);
  } catch (err) {
    console.warn(`       (display push to ${box.name} failed: ${err.message})`);
    return null;
  }
}
