# mcp-core

A thin, config-driven MCP server that turns a fleet of ESP32-S3-BOX devices
into voice-controllable tools any MCP client can call — and, in the other
direction, a router that gives each box a voice by wiring its mic/speaker to
speech-to-text, a pluggable "brain" (your own agent webhook or any
OpenAI-compatible LLM), and text-to-speech.

It has **zero hardcoded business logic**. No menu, no persona, no product
assumptions — everything comes from `config.json`. What the box says and does
is entirely up to whatever backend you point it at.

```
   MCP clients (Claude, agents, cloud LLMs)
                    |
                    |  Streamable HTTP
                    v
        +-----------------------------+
        |   mcp-core  (:8000)         |     config: config.json
        |                             |
        |  MCP tools   |  backend router ---> your agent webhook
        |  esp_speak   |               |        falls back to ->
        |  esp_display |               |     cloud LLM (OpenAI-compatible)
        |  esp_list_.. |               |        falls back to ->
        +-----------------------------+     local LLM (Ollama, plain chat)
                    |
                    |  STT/TTS via voice-mcp-server (MCP over stdio)
                    v
        ESP32-S3-BOX(es) --WiFi--  mic / speaker / screen
```

## Why this exists

Most MCP servers wrap an API. This one wraps **hardware** — a fleet of
physical devices that can listen, speak, and display something. It's the
kind of MCP server that's genuinely useful as-is for anyone with an
ESP32-S3-BOX: point it at your own agent and it talks for you, with no
restaurant/kiosk assumptions baked in anywhere.

## MCP tools — drive the fleet from any client

`mcp-core` is itself an MCP server, reachable over Streamable HTTP. This is
the "pull and use" surface — it's not tied to any specific client.

```
any MCP client  ->  http://<host>:8000/mcp  ->  esp_*  ESP box fleet    (pushed to)
                                            ->  spc_*  OrangePi devices (called out to)
```

Each sense is its own tool, namespaced by the machine it lives on, so a model
can pick *where* to speak or look rather than guessing between id strings.

| Tool | Arguments | Does |
|---|---|---|
| `esp_list_boxes` | — | Lists every registered box with `{id, name, ip, online}`. `online` is a live 2s reachability probe. Call this first to learn valid ids. |
| `esp_speak` | `box_id?`, `text` | Speaks text out loud. Sentence-chunked, so long replies start playing in ~1s instead of waiting for the whole thing to synthesize. Speaks only — no screen change. |
| `esp_display` | `box_id?`, `text?`/`speaker?` **or** `items[]`/`title?`/`total?` | Shows a caption, or an itemized list screen. Display only — no sound. |
| `esp_listen` | `box_id?`, `timeout_s?` | Waits for the box's next recording and returns the transcript. Passive — the customer's tap-to-confirm flow is untouched. |
| `esp_sense` | `box_id?` | Presence radar, with the age of the reading so a stuck sensor is visible. |
| `esp_set_occupied` | `box_id?`, `occupied` | Forces a session start (greets) or end (resets), bypassing the radar. |
| `esp_look` / `esp_scan_qr` | — | Counter camera on **this server** — registered only when `vision` is configured. |
| `spc_list_devices` | — | Lists OrangePis with their capabilities, whether each answers, and what it reports it has. |
| `spc_speak` | `device_id?`, `text` | Speaks through a Pi's speaker; returns once the audio has finished playing. |
| `spc_listen` | `device_id?`, `timeout_s?` | Opens the Pi's mic **now**, stops when you stop talking, transcribes here. |
| `spc_sense` | `device_id?` | Passthrough of whatever sensors that Pi reports. |
| `spc_look` | `device_id?` | A frame from the Pi's camera. |
| `spc_expression` | `device_id?`, `expression?`, `gaze?`, `panel?` | Drives the Pi's own screen: an animated face on top, and below it a message, a QR code, choice tiles or an order summary. What you leave out stays as it was, so the eyes can change without disturbing a QR someone is scanning. |

Every tool is registered only when the hardware behind it exists — see
[`../spc-agent/README.md`](../spc-agent/README.md) for the Pi-side contract.

`box_id` is optional when exactly one box is registered; `device_id` is optional
when exactly one configured device has the capability being asked for.

Raw JSON-RPC, no client library needed:
```bash
curl -s http://localhost:8000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"esp_speak","arguments":{"text":"hello from mcp-core"}}}'
```

Claude Code, as one example client:
```bash
claude mcp add --transport http mcp-core http://<host>:8000/mcp
```

## The other direction: giving a box its own voice

Point a box's `POST /upload` at `mcp-core:8000`, and it becomes a full
speak/listen loop: mic audio → STT → your backend → TTS → speaker, with the
transcript/reply/order pushed back to the box's screen as it happens.

**Backends are tried in `config.json`'s `priority` order — the first that
answers wins, so a dead one degrades to the next instead of going silent.**

- **`webhook`** — your own agent. Contract: `POST {session_id, text}` →
  `{reply, display?, end_session?}`. Point this at anything — the menu, the
  persona, the "smarts" are entirely the webhook's problem, not mcp-core's.
- **`openai_chat`** — any OpenAI-compatible chat endpoint (Ollama, OpenAI,
  a local vLLM server, etc.) as a plain-chat fallback.

Boxes **self-register** on boot (`POST /register` with their `X-Box-Id`
header) and are identified by that immutable id, never by IP — so DHCP
reassigning an address doesn't orphan a box, and adding box #2..N needs no
code change and usually no config edit either.

## Setup

```bash
npm install
cp ../config.example.json ../config.json   # or point MCP_CORE_CONFIG elsewhere
node server.js
```

`config.json` (see `config.example.json` for the full annotated shape):

```json
{
  "boxes": [{ "id": "BOX-A1B4", "name": "box1", "ip": "192.168.1.50" }],
  "backends": {
    "priority": ["agent", "local_llm"],
    "agent": { "webhook_url": "http://localhost:4000/agent" },
    "local_llm": { "url": "http://localhost:11434/v1/chat/completions", "model": "llama3.2:3b" }
  },
  "stt": { "language": "en", "model": "path/to/ggml-small.bin" },
  "listen_port": 8000
}
```

Requires a local `voice-mcp-server` (STT via whisper.cpp, TTS via any
OpenAI-compatible speech endpoint) — mcp-core spawns it over stdio
automatically. See the parent repo for a working example.

## Security

`/mcp` has **no authentication by default** — fine on a trusted LAN, where it
already is by default, but it combines device discovery *and*
speaker/display control in one endpoint. Before exposing it more widely, set
`mcp_token_env` in `config.json` to the name of an environment variable
holding a bearer token:

```json
{ "mcp_token_env": "MCP_CORE_TOKEN" }
```

```bash
export MCP_CORE_TOKEN=your-secret-here
node server.js
```

Requests then need `Authorization: Bearer your-secret-here`, or they get a
`401`. The token is **never** read from `config.json` directly — only the
name of an env var to look it up from, so a real credential never ends up
committed to source control.

## Design notes

- **No box-specific or product-specific logic lives here.** If you catch
  yourself wanting to add a menu, a persona, or an order-parsing rule to this
  file, it belongs in your backend webhook instead.
- **Identity is the box's `X-Box-Id`, never its IP.** IPs are DHCP leases;
  treating them as identity is how a device registry silently rots.
- **A hang is treated as a crash.** Backend timeouts default short
  (`10s` for LLMs) because a customer standing at a silent box can't tell the
  difference between "slow" and "broken" — better to fail over to the next
  backend than to leave them waiting.
