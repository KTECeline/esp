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
import { wsHas, wsPush } from "./ws-hub.js";

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

// 100.64.0.0/10 — CGNAT space, which is what Tailscale hands out. A box's
// entry must always hold the address we can reach it at from the LAN: every
// outbound push (/play, /caption, /order, /server) dials `box.ip` directly.
// If a box ever appeared over a tunnel, recording that 100.x address would
// overwrite the working LAN address and silently break every push to it.
export function isCgnat(ip) {
  const m = /^(\d+)\.(\d+)\./.exec(ip || "");
  return !!m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127;
}

// Shared secret proving a request came from our own system, sent on every push
// to a box. Set once at startup by server.js; boxes.js deliberately doesn't
// import config.js (it stays a dumb transport layer).
let fleetToken = null;
export function setFleetToken(token) { fleetToken = token; }

// For HTTP HEADER values (X-Speaker, X-Reply-Text, order fields): headers
// must be latin-1 and single-line, and the box's title/order font is
// ASCII-only (renders uppercase) with no CJK companion table — strip
// anything else so these don't corrupt the request or render as mush.
export function asciiOneline(s, limit = 200) {
  return (s || "")
    .replace(/[\n\r]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, limit);
}

// For the /caption HTTP BODY only: bodies can carry arbitrary UTF-8, unlike
// headers, and F_BODY (the caption font) has a curated CJK glyph subset (see
// listen_v2/main/ui_font_cjk.c) — so this keeps script instead of stripping
// it. Still flattens newlines and drops control characters, since the
// firmware still expects one line. A codepoint outside the ASCII+CJK glyph
// set falls back to '?' on-device (resolve_glyph() in display.c), same
// as any other unknown character.
export function utf8Oneline(s, limit = 200) {
  return (s || "")
    .replace(/[\n\r]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
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
      host: b.ip.split(":")[0],
      // null = unknown (box hasn't reported a session event since this
      // process started, or is on firmware too old to). Live-only, never
      // written to config.json — a customer being at the box right now isn't
      // fleet-registry data.
      occupied: null,
      // When `occupied` last changed, as epoch ms. Read by esp_sense: presence
      // with no timestamp is not a sensor reading, it's a rumour. A box that
      // says "occupied" and last said so four hours ago has a stuck radar or a
      // missed departure, and only the age distinguishes that from a customer
      // who is genuinely standing there right now.
      occupiedAt: null,
      // Which firmware the box reported at its last /register. Live-only for
      // the same reason as `occupied`, and null until it registers — boxes on
      // pre-OTA firmware never send it, so null means "unknown", not "stale".
      fw: null,
      // Which runtime-settings revision this box is known to have applied.
      // null = unknown, which is the correct starting state after a restart:
      // the box may well be up to date, but this process has not verified it,
      // and re-pushing to a box that already agrees is cheap. Assuming it were
      // current would leave a box quietly running old tuning forever.
      settingsRev: null
    }));
  }

  // Record the firmware a box reported when it registered. Deliberately does
  // NOT persist: this is an observation about a running box, and it changes on
  // every update, so writing it to config.json would be churn. Keeping it live
  // also means a restarted server shows "unknown" rather than a remembered
  // version that may no longer be what's on the hardware.
  setFirmware(id, fw) {
    const b = this.byId(id);
    if (b) b.fw = fw;
  }

  // The shape that goes back into config.json's "boxes" array.
  toConfig() {
    return this.boxes.map((b) => ({ id: b.id, name: b.name, ip: b.ip }));
  }

  byId(id) {
    return this.boxes.find((b) => b.id === id) || null;
  }

  // Live status only — deliberately does NOT call onChange/persist to
  // config.json. Whether a customer is standing at a box right now isn't
  // fleet-registry data, and periodic writes for something that changes every
  // few seconds would be pure churn.
  setOccupied(id, occupied) {
    const b = this.byId(id);
    if (!b) return;
    // Only a real transition restamps the clock. Re-reporting the same state
    // must not, or a box that repeats "still occupied" every few seconds would
    // keep looking freshly changed and the staleness check above would never
    // fire — which is the one case the timestamp exists to catch.
    if (b.occupied !== occupied) b.occupiedAt = Date.now();
    b.occupied = occupied;
  }

  // Add or update a box, keyed by its immutable id — a DHCP-renewed IP updates
  // the existing entry instead of creating a duplicate. Returns "added",
  // "updated", or "unchanged".
  upsert(id, name, ip) {
    const host = ip.split(":")[0];
    const existing = this.byId(id);
    if (!existing) {
      this.boxes.push({ id, name: name || id, ip, host, occupied: null, occupiedAt: null,
                        fw: null, settingsRev: null });
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

  // Drop a box from the fleet. Returns false when there was nothing to remove,
  // so the caller can 404 rather than reporting a deletion that didn't happen.
  //
  // This only forgets the box HERE. The box itself still holds our address in
  // NVS and keeps uploading, and fromId() re-adds any id that talks to us — so
  // a box removed while still powered on and pointed here WILL come back. That
  // is deliberate (a registry that fights its own self-healing would be worse),
  // but it means "forget" is for retiring hardware, not for muting a live box.
  remove(id) {
    const i = this.boxes.findIndex((b) => b.id === id);
    if (i === -1) return false;
    this.boxes.splice(i, 1);
    this.onChange?.();
    return true;
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
    if (existing.host !== ip && !OWN_IPS.has(ip) && !isCgnat(ip)) {
      console.log(`Box "${id}" moved ${existing.ip} -> ${ip} (DHCP drift) — config updated.`);
      this.upsert(id, null, ip);
    } else if (existing.host !== ip) {
      const why = isCgnat(ip)
        ? `that's a tailnet/CGNAT address, not the LAN address we push to`
        : `that's this host's own address, not a real box (test harness or proxy?)`;
      console.warn(`Ignoring "${id}" IP change to ${ip}: ${why}. Keeping ${existing.ip}.`);
    }
    return existing;
  }
}

// Every push to a box funnels through here — the shared secret and the
// transport choice both live in one place, so a new call site can't forget
// either.
//
// Two transports, and the live reverse channel wins when there is one:
//
//   1. WebSocket (ws-hub.js) — the box dialled US, so this connection is
//      PROVEN to work right now, whatever network the box is on. On the LAN it
//      rides the same LAN, so preferring it costs nothing.
//   2. Direct LAN HTTP to box.ip — the original path. Still the only option for
//      a box on older firmware with no reverse channel.
//
// Preferring (1) is a deliberate inversion of "try LAN, fall back to WS": a
// stale box.ip doesn't fail fast, it HANGS until the timeout (60s for /play),
// so trying it first would stall every push to a box that has moved networks.
// Asking "is there a proven-live channel?" is instant and has no such failure
// mode. The heartbeat in ws-hub.js is what keeps "live" honest.
async function postToBox(box, boxPath, body, headers = {}, timeoutMs = 60000) {
  const withToken = fleetToken ? { ...headers, "X-Fleet-Token": fleetToken } : headers;

  if (wsHas(box.id)) {
    try {
      // No token in the frame: the socket was authenticated once at the
      // upgrade, so repeating the secret on every message would just spread it
      // across more bytes (and more logs) for no additional guarantee.
      return await wsPush(box.id, boxPath, body, headers, timeoutMs);
    } catch (err) {
      // Socket died between the check and the send, or the box never acked.
      // Fall through to LAN rather than failing the push outright.
      console.warn(`       (reverse channel to ${box.name} failed: ${err.message} — trying LAN)`);
    }
  }

  const res = await fetch(`http://${box.ip}${boxPath}`, {
    method: "POST",
    body,
    headers: withToken,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return res.status;
}

export async function sendCaption(box, text, { who = "YOU" } = {}) {
  const headers = { "X-Speaker": asciiOneline(who, 40) };
  try {
    return await postToBox(box, "/caption", utf8Oneline(text), headers, 5000);
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

// Force a box's session state — occupied=true plays the same greeting a real
// presence detection would; occupied=false does the same cleanup a real
// departure does. No body needed, the header carries everything.
export async function sendSessionOverride(box, occupied) {
  try {
    return await postToBox(box, "/session", "", { "X-Occupied": occupied ? "1" : "0" }, 5000);
  } catch (err) {
    console.warn(`       (session override to ${box.name} failed: ${err.message})`);
    return null;
  }
}

// Push the box-scoped runtime settings (VAD tuning, session timeout, screen
// hold times) to one box, which stores them in NVS and applies them on its next
// listen or session.
//
// The wire format is the same "KEY|VALUE" line protocol the order screen
// already uses, rather than JSON, and that is not laziness: the firmware has no
// JSON parser linked in, and adding one to a box whose scarcest resource is
// internal SRAM to carry eight integers would be a poor trade. `revision` rides
// in a header so a box can ignore a push it has already applied without parsing
// the body at all.
//
// Throws rather than warning: unlike a caption, a settings push that silently
// failed leaves the fleet disagreeing with what the server reports, which is
// the exact failure this whole mechanism exists to prevent. Callers that are
// sweeping many boxes catch per box.
export async function sendSettings(box, { revision, settings }) {
  const body = Object.entries(settings)
    .map(([k, v]) => `${k}|${typeof v === "boolean" ? (v ? "1" : "0") : v}`)
    .join("\n");
  // Both receivers on the box read into a 512-byte static buffer (WS_BODY_MAX
  // in ws_client.c, the same size in settings_handler) and silently truncate
  // past it. Truncation here would not fail — it would apply the first N
  // settings, mangle the one straddling the cut, and report success, which is
  // the worst shape a bug can take. Caught on this side, where the message can
  // name the fix, because the box cannot know what it never received.
  if (Buffer.byteLength(body) > BOX_SETTINGS_BODY_MAX) {
    throw new Error(
      `box-scoped settings are ${Buffer.byteLength(body)} bytes, over the firmware's ` +
      `${BOX_SETTINGS_BODY_MAX}-byte limit. Either shorten the key names in ` +
      `settings-spec.json, or raise WS_BODY_MAX in ws_client.c and the buffer in ` +
      `settings_handler (both), and reflash. Nothing was sent.`
    );
  }
  return await postToBox(box, "/settings", body, { "X-Settings-Rev": String(revision) }, 8000);
}
// Must match WS_BODY_MAX in listen_v2/main/ws_client.c and the body[] in that
// file's settings_handler. Kept as a named constant so the coupling is visible
// from this side too — the two numbers have to move together.
const BOX_SETTINGS_BODY_MAX = 511;   // 512-byte buffer, minus the NUL

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
