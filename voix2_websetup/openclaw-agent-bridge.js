'use strict';

// Bridge that lets an external OpenClaw agent answer live customer speech.
//
// mcp-core's ONLY hook for "external brain answers what the customer just
// said" is backends.agent.webhook_url: it POSTs {session_id, text} there and
// requires back {reply, display, end_session} (confirmed against the real
// contract: HANDOVER.md, mcp-core/README.md, and mcp-core/server.js's
// askWebhook() in https://github.com/KTECeline/esp). The esp_speak-style MCP
// tools wired elsewhere are a separate, one-way push mechanism (server ->
// box) and never see customer speech — this file is the other direction.
//
// This process is the translation layer: it receives mcp-core's webhook call
// and forwards it to OpenClaw Gateway's OpenResponses HTTP API
// (POST /v1/responses), which is OFF by default. Enable it first:
//   openclaw config set gateway.http.endpoints.responses.enabled true
// `config set` prints one of three hints after writing ("Restart the gateway
// to apply." / "Change will apply without restarting the gateway." / "No
// gateway restart needed.") — READ that hint, don't assume either way. This
// project has hit "config written but the running process never reread it"
// more than once with mcp-core already; if the hint says restart, run
// `openclaw gateway restart` and re-probe /health below before wiring
// anything to this bridge.
//
// Standalone Node process, own port, started detached (nohup) — same shape
// as piper-wrapper.js.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.OPENCLAW_BRIDGE_PORT || 4000;
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
// docs.openclaw.ai/gateway/openresponses-http-api: disabled by default,
// shares the Gateway's WS+HTTP port (default 18789) at POST /v1/responses.
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789/v1/responses';
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';
// mcp-core's webhook backend defaults to a 120000ms timeout when a backend
// doesn't set its own timeout_ms (mcp-core/config.js's backendTimeout()).
// This has to fire well before that: a slow OpenClaw run should come back
// to mcp-core as a clean failed-backend response (which mcp-core falls
// through to cloud_llm/local_llm on) instead of mcp-core's own abort tearing
// the connection down with nothing useful logged on this side.
const GATEWAY_TIMEOUT_MS = Number(process.env.OPENCLAW_BRIDGE_TIMEOUT_MS) || 90000;

// gateway.auth.token in openclaw.json can be a literal string OR a
// "${ENV_VAR}" interpolation (both are documented real shapes) — resolve
// either rather than sending the literal "${...}" text as a bearer token.
function resolveTokenValue(raw){
  if (typeof raw !== 'string' || !raw) return null;
  const interpolation = raw.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (interpolation) return process.env[interpolation[1]] || null;
  return raw;
}

// Deliberately reads the raw config file rather than shelling out to
// `openclaw config get gateway.auth.token` — OpenClaw's own docs say `config
// get` reads from a "redacted config snapshot" where secrets never print, so
// the CLI would hand back a masked placeholder instead of the real token.
function loadGatewayToken(){
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)){
    console.error(`openclaw-agent-bridge: no openclaw.json at ${OPENCLAW_CONFIG_PATH}`);
    console.error('Run `openclaw configure` (or `openclaw onboard`) on this box first, or set OPENCLAW_GATEWAY_TOKEN directly.');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  } catch (e) {
    // openclaw.json is allowed to be JSON5 (comments, unquoted keys) by
    // OpenClaw's own tooling — this reader intentionally stays dependency-
    // free and only handles plain JSON, which is what `openclaw config set`
    // writes back out. A hand-edited JSON5 file is a real gap, flagged loud
    // here rather than guessed at.
    console.error(`openclaw-agent-bridge: could not parse ${OPENCLAW_CONFIG_PATH} as JSON (${e.message}).`);
    console.error('If this file uses JSON5 syntax (comments, unquoted keys), run ' +
      '`openclaw config get gateway.auth.token --json` by hand and pass the result via OPENCLAW_GATEWAY_TOKEN instead.');
    process.exit(1);
  }

  const token = resolveTokenValue(parsed && parsed.gateway && parsed.gateway.auth && parsed.gateway.auth.token);
  if (!token){
    console.error(`openclaw-agent-bridge: no usable gateway.auth.token in ${OPENCLAW_CONFIG_PATH}.`);
    console.error('Set one with `openclaw config set gateway.auth.token <token>`, or set OPENCLAW_GATEWAY_TOKEN directly.');
    process.exit(1);
  }
  return token;
}

const GATEWAY_TOKEN = loadGatewayToken();

function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Pulls the assistant's spoken-out-loud text out of an OpenResponses
// response body:
//   { output: [ { type: "message", role: "assistant",
//                 content: [ { type: "output_text", text: "..." } ] } ] }
// This shape was NOT confirmed against a live call — no Gateway was
// reachable to test against in this environment (see openclaw-agent-bridge
// build notes). It was instead read out of OpenClaw's own source
// (createResponseResource / createAssistantOutputItem in the published
// `openclaw` npm package's dist/openresponses-http-*.js bundle), since the
// docs page only shows request examples, not a full response body. Treat
// this as unverified until the first real call against a live Gateway.
//
// function_call items (client tool calls) are skipped rather than erroring:
// this bridge never sends `tools`, so none should appear, but a stray one
// shouldn't be able to blank out an otherwise-good reply.
function extractReplyText(body){
  const output = Array.isArray(body && body.output) ? body.output : [];
  const parts = [];
  for (const item of output){
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content){
      if (part && part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n\n').trim();
}

async function askOpenClaw(sessionId, text){
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'x-openclaw-agent-id': AGENT_ID,
    },
    // `user` is what OpenResponses uses to derive a stable session key, so
    // reusing mcp-core's session_id here is what keeps one customer's
    // multi-turn conversation threaded on OpenClaw's side too — unconfirmed
    // against a live Gateway for the same reason noted in extractReplyText().
    //
    // `input` as an array of {type:"message", role, content} items (content
    // as a plain string) is the confirmed real shape from
    // docs.openclaw.ai/gateway/openresponses-http-api: "system" and
    // "developer" roles are both appended ahead of the system prompt, then
    // the "user" item becomes the current turn. Used here to tell the model
    // which box_id (== mcp-core's session_id) this turn belongs to — the box
    // fleet now has two registered boxes (BOX-A1B4, BOX-C0C0), so
    // esp_speak/esp_display's "defaults to the only box" fallback no longer
    // applies, and forwarding only `text` (the old shape) gave the model no
    // way to know which box_id to pass, which silently failed every
    // esp_speak/esp_display call the model attempted.
    body: JSON.stringify({
      model: 'openclaw',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: `You are currently serving box_id: ${sessionId}. Always pass this exact box_id as the box_id argument to esp_speak and esp_display — never omit it, and never call esp_list_boxes to guess it.`,
        },
        {
          type: 'message',
          role: 'user',
          content: text,
        },
      ],
      user: sessionId,
    }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });

  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* handled below */ }

  if (!res.ok){
    const message = (data && data.error && data.error.message) || raw.slice(0, 200) || `Gateway returned ${res.status}`;
    throw new Error(message);
  }
  if (!data) throw new Error('Gateway returned a non-JSON response');

  const reply = extractReplyText(data);
  if (!reply) throw new Error('OpenClaw returned no output_text');
  return reply;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health'){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // `service` isn't part of mcp-core's contract (it never calls this
    // route) — it's how setup-server.js's Save flow tells this process
    // apart from the demo restaurant agent, which also listens on this
    // port and also answers GET /health 200.
    return res.end(JSON.stringify({ status: 'ok', service: 'openclaw-agent-bridge' }));
  }

  if (req.method === 'POST' && req.url === '/agent'){
    try {
      const body = await readJsonBody(req);
      const sessionId = body.session_id || 'default';
      const text = (body.text || '').trim();
      if (!text){
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing "text"' }));
      }
      const reply = await askOpenClaw(sessionId, text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // display: nothing meaningful to show yet (null = no screen change).
      // end_session: no end-of-conversation detection exists yet, so this
      // always answers false — a known gap, not a considered "never ends".
      return res.end(JSON.stringify({ reply, display: null, end_session: false }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e.message || e).slice(0, 500) }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`openclaw-agent-bridge listening on http://0.0.0.0:${PORT}`);
  console.log(`-> forwarding to ${GATEWAY_URL} as agent "${AGENT_ID}"`);
});
