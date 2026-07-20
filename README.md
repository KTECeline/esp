# BOX-3 voice assistant

Fully local voice pipeline for the ESP32-S3-BOX-3. No cloud, no API keys.
~/esp/start_voice_assistant.sh 
~/esp/check_health.sh

cd ~/esp/listen_v2 && source idfenv.sh 
idf.py build     


## Architecture

mcp-core has two faces: it **serves** MCP tools inbound (any client can drive the
fleet), and it **routes** outbound to whichever brain answers first.

```
   MCP clients (Claude, agents, cloud LLMs)
                    |
                    |  Streamable HTTP
                    v
        +-----------------------------+
        |   mcp-core  (:8000)         |     config: ~/esp/config.json
        |                             |
        |  MCP tools   |  backend router ---> agent webhook (:4000) <- business logic
        |  esp_speak   |               |     (agents/restaurant)
        |  esp_display |               |        falls back to ->
        |  esp_list_.. |               |     cloud LLM (OpenAI-compatible)
        +-----------------------------+        falls back to ->
                    |                        local LLM (Ollama, plain chat)
                    |  STT/TTS via voice-mcp-server (whisper.cpp, MOSS-TTS)
                    v
        ESP box(es) --WiFi--  mic / speaker / screen
```

- **mcp-core/** — thin, dumb router. Speech↔text, route text to a backend, push
  audio + display payloads to boxes, and expose the fleet as MCP tools. Zero
  business logic, zero hardcoded config; everything comes from `config.json`
  (copy `config.example.json`). Refuses to start if no backend is configured.
  Reusable for non-restaurant projects as-is.
- **agents/restaurant/** — the smarts: mamak persona, `menu.json` (source of truth
  for prices — the LLM never does arithmetic), order pricing, session state, and
  the order-screen payloads the core relays verbatim to the box.
- **voice-mcp-server/** — MCP server exposing STT (whisper.cpp) and TTS (MOSS-TTS)
  tools; auto-started by mcp-core over stdio.
- **listen_v2/** — box firmware (ESP-IDF) + eval tooling.

Boxes live only in `config.json` (`boxes: [{id, name, ip}]`) and **register
themselves** on boot — adding box #2..N needs no code change and usually no config
edit either. A box is identified by the `X-Box-Id` header it sends, never by its IP
(which DHCP can reassign); `ip` is just its last known address, self-healed on every
request. The agent webhook contract is `POST {session_id, text}` →
`{reply, display, end_session}`, so a remote agent plugs in by changing one URL.

## MCP tools — driving the boxes from any client

mcp-core is itself an MCP server, so **any** MCP client can discover and drive the
fleet. This is the "pull and use" surface — it is not Claude-specific.

```
any MCP client  ->  http://<host>:8000/mcp  ->  ESP fleet
                    (Streamable HTTP, stateless, no auth — LAN only)
```

| Tool | Arguments | Does |
|---|---|---|
| `esp_list_boxes` | — | Lists every box with `{id, name, ip, online}`. `online` is a real 2s reachability probe. Call this first to learn valid ids. |
| `esp_speak` | `box_id?`, `text` | Says text out loud. Sentence-chunked, so long replies start playing in ~1s. Speaks only — no screen change. |
| `esp_display` | `box_id?`, `text?`/`speaker?` **or** `items[]`/`title?`/`total?` | Caption, or an itemized screen. Display only — no sound. |

`box_id` is optional when exactly one box is registered. Prices/totals are rendered
verbatim — mcp-core never does arithmetic.

Raw JSON-RPC (no client needed):
```bash
curl -s http://<host>:8000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"esp_speak","arguments":{"text":"order up"}}}'
```

Claude Code, as one example client:
```bash
claude mcp add --transport http mcp-core http://<mac-ip>:8000/mcp
```

> **Note:** `/mcp` has no authentication — fine on a trusted LAN, but it combines
> device discovery *and* speaker/display control in one endpoint. Add a bearer token
> or bind to localhost before exposing it any wider.

## 1. Start the full stack

```
~/esp/start_voice_assistant.sh [box_ip]    # box_ip updates config.json's box1
./check_health.sh                          # one green/red line per service
```

## 2. Run the accuracy + latency test

```
cd ~/esp/listen_v2/eval
python3 -u stt_eval.py
```

It prints one command at a time — for each: tap BOOT, say the phrase, tap BOOT
again, then wait for the box to finish speaking its reply before doing the next
one (full round trip is ~15–25s; the script waits up to 90s per command, so
don't rush). When done (or Ctrl-C early), it prints WER, Command Accuracy %,
and per-stage latency stats, and saves a JSON report.

Command list: `stt_test_commands.txt` (20 lines now — add more, one phrase per
line, to reach 100)

## 3. Optional: watch live per-stage timing while testing

In a second terminal:

```
cd ~/esp/listen_v2
python3 show_latency.py
```

Shows a full timeline (record/upload/STT/LLM/TTS/playback) for every
interaction as it happens, plus flags if playback stutters.

## 4. Optional: TTS voice-quality test (needs human raters)

```
cd ~/esp/listen_v2/eval
python3 tts_generate_samples.py      # generates 30 speech clips + blank ratings CSV
# have people rate the clips 1-5 in tts_ratings_template.csv (naturalness/clarity/pronunciation)
python3 tts_score_mos.py             # computes MOS once ratings are filled in
```

~/esp/
├── config.json / config.example.json   # boxes registry, backend priority, STT settings
├── mcp-core/            # the router (diagram above)
├── agents/restaurant/   # the "brain" — menu, persona, pricing
├── voice-mcp-server/    # MCP server: whisper.cpp (STT) + MOSS-TTS (TTS) as 2 tools
├── listen_v2/main/      # firmware
│   ├── listen_v2.c        # boot sequence, WiFi, recording, HTTP client+server
│   ├── display.c/.h       # everything drawn on the 320×240 screen
│   ├── provisioning.c/.h  # NEW: WiFi setup — NVS identity, SoftAP portal
│   └── dns_hijack.c/.h    # NEW: captive-portal DNS trick
└── start_voice_assistant.sh / check_health.sh