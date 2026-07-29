// Reverse channel: boxes dial OUT to us and hold the connection open, so we can
// push to them without needing a route back in.
//
// Why this exists: pushes today go to `box.ip` over the LAN, which only works
// while the box and this machine share a network. A box on a phone hotspot, a
// different site, or behind any NAT is simply unreachable. The usual fix is a
// VPN on the device — rejected here (see ROADMAP item 9: it would mean either a
// firmware networking rewrite or hand-rolled crypto). An outbound WebSocket
// needs neither: it's the same thing any HTTPS client does, and the box keeps
// using ordinary, audited TLS.
//
// This module owns ONLY the socket registry and framing. It deliberately does
// not import boxes.js (which imports from here) — no cycle, and it stays a dumb
// transport that knows nothing about captions, audio or orders.
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

// box_id -> live socket. At most one per box: a reconnecting box replaces its
// own entry, so a half-dead predecessor can't keep receiving pushes.
const sockets = new Map();
// request id -> { resolve, reject, timer }. Pushes await the box's ack because
// callers depend on it: sendAudio()'s response is what signals "playback
// finished" for the final chunk, and speakToBox() paces chunks off it.
const pending = new Map();

let fleetToken = null;
export function setWsFleetToken(t) { fleetToken = t; }

// ---- Brute-force throttle ---------------------------------------------------
// Once this endpoint is exposed publicly (Tailscale Funnel), the shared token
// is the ONLY thing in front of it, and nothing else in mcp-core rate-limits
// anything. An unthrottled endpoint lets an attacker grind guesses as fast as
// the network allows; a few-per-minute ceiling makes that hopeless while being
// invisible to a real box, which authenticates once and then stays connected.
//
// Keyed by source IP. Behind Funnel every request appears to come from the
// local relay, so all bad actors share one bucket — that's deliberately
// conservative (a global cap), not a bug: legitimate boxes essentially never
// fail auth, so the bucket should stay empty regardless.
const FAIL_WINDOW_MS = 60000;
const FAIL_MAX = 10;
const failures = new Map();   // ip -> { count, resetAt }

function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() > f.resetAt) { failures.delete(ip); return false; }
  return f.count >= FAIL_MAX;
}

function noteFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || now > f.resetAt) {
    failures.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    return;
  }
  f.count++;
  if (f.count === FAIL_MAX) {
    console.warn(`WS: ${FAIL_MAX} failed upgrades from ${ip} in under a minute — throttling it`);
  }
}

export function wsHas(boxId) {
  const s = sockets.get(boxId);
  return !!s && s.readyState === 1 /* OPEN */;
}

export function wsBoxIds() {
  return [...sockets.keys()].filter(wsHas);
}

// ---- Wire format ------------------------------------------------------------
// One WebSocket message per push, shaped like a tiny HTTP request:
//
//     <path>\n  id:<n>\n  <Header>:<value>\n  ...  \n\n  <raw body bytes>
//
// Text header block, blank line, then the body verbatim (so a WAV survives
// untouched). Deliberately NOT JSON: the firmware avoids a JSON parser in C on
// purpose — the order screen already uses a pipe-delimited line protocol for
// the same reason — and this is parseable there with strchr/strncmp alone.
// WebSocket preserves message boundaries, so no length prefix is needed.
function encodeFrame(id, path, headers, body) {
  let head = `${path}\nid:${id}\n`;
  for (const [k, v] of Object.entries(headers || {})) head += `${k}:${v}\n`;
  head += "\n";
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  return Buffer.concat([Buffer.from(head, "utf8"), bodyBuf]);
}

// Box -> server ack: "ACK <id> <status>". Tiny on purpose — trivial to emit
// from C with a single snprintf.
function handleAck(text) {
  const m = /^ACK\s+(\S+)\s+(\d+)/.exec(text);
  if (!m) return;
  const p = pending.get(m[1]);
  if (!p) return;             // late ack after timeout — ignore
  pending.delete(m[1]);
  clearTimeout(p.timer);
  p.resolve(parseInt(m[2], 10));
}

// ---- Push -------------------------------------------------------------------
// Returns the box's status code, mirroring postToBox()'s HTTP contract so the
// caller can't tell which transport carried it. Rejects on timeout/dead socket
// so the caller can fall back.
export function wsPush(boxId, path, body, headers = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const sock = sockets.get(boxId);
    if (!sock || sock.readyState !== 1) return reject(new Error("no live websocket for " + boxId));
    const id = randomUUID().slice(0, 8);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`websocket push to ${boxId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sock.send(encodeFrame(id, path, headers, body), (err) => {
      if (!err) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---- Server -----------------------------------------------------------------
// Attaches to the EXISTING http server rather than opening a second port, so
// there's one thing to expose, one port in config, and one firewall story.
export function startWsHub(httpServer, { path = "/ws" } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();   // not ours; nothing else here speaks WebSocket
      return;
    }
    // Same shared secret as every other box-facing route — no second auth
    // system. This matters more here than elsewhere: once Tailscale Funnel is
    // turned on, this endpoint is reachable from the public internet, and the
    // token is the only thing standing in front of it.
    const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    if (tooManyFailures(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = req.headers["x-fleet-token"];
    const boxId = req.headers["x-box-id"];
    if (fleetToken && token !== fleetToken) {
      noteFailure(ip);
      console.warn(`WS upgrade rejected (bad/missing X-Fleet-Token) from ${ip}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!boxId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, boxId));
  });

  wss.on("connection", (ws, req, boxId) => {
    const from = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    // A reconnect replaces the old socket. Without this, a box that dropped
    // without a clean close would leave a zombie that swallows pushes.
    const prev = sockets.get(boxId);
    if (prev && prev !== ws) prev.terminate();
    sockets.set(boxId, ws);
    ws.isAlive = true;
    console.log(`Box "${boxId}" opened a reverse channel from ${from} (pushes can now reach it anywhere)`);

    // Liveness = ANY traffic from the box, not just a pong to our own ping.
    //
    // A pong-only check assumes our ping reaches the box and its pong comes
    // back. Through a proxy that doesn't relay WebSocket control frames
    // (MEASURED with Tailscale Funnel) that round trip silently never
    // completes, so a perfectly healthy box looks dead: we terminate its
    // channel, it doesn't even notice for a while, and pushes fall back to LAN
    // or time out. The firmware sends its own ping every 20s (ws_client.c), so
    // counting inbound pings and acks as proof-of-life keeps a working box
    // alive while still reaping a genuinely dead socket.
    const alive = () => { ws.isAlive = true; };
    ws.on("pong", alive);
    ws.on("ping", alive);
    ws.on("message", (data, isBinary) => {
      alive();
      if (!isBinary) handleAck(data.toString());
    });
    ws.on("close", () => {
      if (sockets.get(boxId) === ws) sockets.delete(boxId);
      console.log(`Box "${boxId}" reverse channel closed`);
    });
    ws.on("error", (err) => console.warn(`WS error for "${boxId}": ${err.message}`));
  });

  // A TCP socket can stay "open" long after the peer is gone (box unplugged,
  // WiFi dropped). Without this, pushes would hang for the full timeout on a
  // socket that will never answer. Ping every 30s; a client that misses one
  // round gets terminated, which frees the id for the LAN fallback.
  const heartbeat = setInterval(() => {
    for (const [boxId, ws] of sockets) {
      if (ws.isAlive === false) {
        console.warn(`Box "${boxId}" missed heartbeat — dropping stale channel`);
        ws.terminate();
        sockets.delete(boxId);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref?.();

  console.log(`Reverse channel listening at ws://<host>:<port>${path}`);
  return wss;
}
