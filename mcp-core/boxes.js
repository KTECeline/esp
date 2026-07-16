// Box registry + push helpers. The core never generates display content — it
// only delivers what a backend produced, over the firmware's existing HTTP
// endpoints (/caption, /play, /order). Firmware is unchanged by design.

// The box font is ASCII-only (renders uppercase); HTTP headers must be latin-1
// and single-line — strip anything else so captions don't corrupt the request.
export function asciiOneline(s, limit = 200) {
  return (s || "")
    .replace(/[\n\r]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, limit);
}

export class BoxRegistry {
  // Box "ip" may carry an optional :port (useful for mock boxes in tests —
  // real firmware always listens on 80). Matching is on the host part only.
  constructor(boxes) {
    this.boxes = boxes.map((b, i) => ({
      name: b.name || `box${i + 1}`,
      ip: b.ip,
      host: b.ip.split(":")[0]
    }));
  }

  // Boxes are identified by the source IP of their /upload request. Unknown
  // IPs still get service (logged) so a box with a fresh DHCP lease works
  // before the config catches up.
  fromRequest(req) {
    const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const known = this.boxes.find((b) => b.host === ip);
    if (known) return known;
    console.warn(`Request from unlisted box IP ${ip} — serving it anyway (add it to config.json).`);
    return { name: ip, ip };
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

export async function sendAudio(box, wavBuffer, { quiet = false, final = false } = {}) {
  const headers = { "Content-Type": "audio/wav" };
  if (quiet) headers["X-Quiet"] = "1"; // sentence chunk: don't touch the display
  if (final) headers["X-Final"] = "1"; // last chunk: linger caption, then READY
  return await postToBox(box, "/play", wavBuffer, headers);
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
