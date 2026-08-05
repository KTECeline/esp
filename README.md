# BOX-3 voice assistant

Fully local voice pipeline for the ESP32-S3-BOX-3. No cloud, no API keys.

> **Running a demo?** → **[`DEMO.md`](DEMO.md)** — system overview, WiFi setup,
> Tailscale, OTA, troubleshooting and a pre-demo checklist, in order.
>
> **Setting up a new machine?** → run `./check_setup.sh` first. It names every
> missing prerequisite and the command that installs it.

## Requirements

On the machine running the brain:

| Needs | Why | Install |
|---|---|---|
| Node.js 18+ | runs mcp-core; 18 is the floor for built-in `fetch` | [nodejs.org](https://nodejs.org) (LTS) |
| **`sox`** | **every** recording is peak-normalized before STT, and every reply downsampled for the box's mono speaker — without it the audio path fails on the first customer | `brew install sox` (Linux: `apt install sox`) |
| `python3` | eval tooling and the MOSS-TTS venv | preinstalled on macOS |
| whisper.cpp | speech → text — **only for `whisper_local`** | see `docs/client-setup.html` step 7 |
| MOSS-TTS-Nano | text → speech — **only for `moss_local`** | see `docs/client-setup.html` step 7 |

The two speech engines are the genuinely hard part of a fresh install: neither
ships in this repo and neither has a simple installer. **A hosted `speech` block
skips both entirely** — see below. `./check_setup.sh` checks only what your
config actually uses.

The tree resolves paths from its own location, so it does **not** have to live at
`~/esp`. Set `ESP_ROOT` to override (split code/data layouts, containers).

## Quick reference

```bash
./check_setup.sh                        # is everything installed?  (new machine)
./start_voice_assistant.sh [box_ip]     # start the whole stack
./check_health.sh                       # is everything running?    (before a demo)
./point_box_at_me.sh 192.168.68.142     # repoint a box at this machine

cd listen_v2 && source idfenv.sh        # firmware: activate ESP-IDF first
idf.py build
idf.py flash                            # USB flash; over-the-air is POST /ota
```

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

                         ┌─────────────────────────────────────────┐
                         │           YOUR MAC (mcp-core host)        │
                         │                                           │
  ESP32-S3-BOX-3 ──WiFi──▶  mcp-core (:8000)                         │
  (mic/speaker/screen/     │    ├─ box registry (X-Box-Id → IP)      │
   touch/presence radar)   │    ├─ STT/TTS via voice-mcp-server      │
                         │    │     (MCP over stdio → whisper.cpp    │
                         │    │      + MOSS-TTS-Nano)                 │
                         │    ├─ backend router (priority list):     │
                         │    │     1. agent webhook (:4000)         │
                         │    │     2. local_llm (Ollama, fallback)  │
                         │    └─ /mcp — mcp-core itself IS an MCP    │
                         │          server (esp_speak/esp_display/   │
                         │          esp_list_boxes, any MCP client)  │
                         │                                           │
                         │  restaurant agent (:4000)                 │
                         │    ├─ menu.json (source of truth)         │
                         │    ├─ LLM order extraction (temp=0)       │
                         │    └─ code-decided confirm (not LLM)      │
                         │                                           │
                         │  Ollama (:11434) — llama3.2:3b            │
                         │  MOSS-TTS (:8080) — local TTS              │
                         └─────────────────────────────────────────┘


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
                    (Streamable HTTP, stateless; Bearer token when configured)
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
claude mcp add --transport http mcp-core http://<mac-ip>:8000/mcp \
  --header "Authorization: Bearer $ESP_MCP_TOKEN"
```

## Speech engines — local or hosted, by config

STT and TTS dispatch by **type**, the same way backends do, so swapping either
is a config edit rather than a code change:

```jsonc
"speech": {
  "stt": { "type": "whisper_local", "model": "whisper.cpp/models/ggml-small.bin" },
  "tts": { "type": "moss_local" }
}
```

| Side | Type | Runs |
|---|---|---|
| stt | `whisper_local` | local whisper.cpp. `model` is a **file path** |
| stt | `openai_whisper` | any OpenAI-compatible `/v1/audio/transcriptions` (OpenAI, Groq, self-hosted). `model` is a **name** |
| tts | `moss_local` | local MOSS-TTS server |
| tts | `openai_tts` | any OpenAI-compatible `/v1/audio/speech` |

**Why it matters: if both sides are hosted, `voice-mcp-server` is never started**,
so that install needs neither whisper.cpp compiled nor MOSS-TTS set up — the two
steps `docs/client-setup.html` itself calls genuinely difficult. Mixing is fine
(local STT + hosted TTS is a real combination); either local half still starts
the subprocess. `sox` is required either way — it formats audio for the box's
mono speaker regardless of which engine produced it.

Keys are **never** written in `config.json` — `token_env` names an environment
variable, exactly like backends. `prompt_file` works for hosted STT too: it's
read and sent as the bias prompt, so Manglish/menu vocabulary keeps helping
accuracy. Omit the `speech` block entirely and the legacy top-level `stt`
section is used, resolving to the local pair exactly as before — no migration.

Startup logs the active pair (`Speech: stt=… tts=…`) and `/health` reports it.

```bash
cd mcp-core && npm test     # contract tests for the provider layer
```

## Security

Two independent shared secrets, both read **only** from environment variables
(never from `config.json`), kept in a gitignored `~/esp/.env` that
`start_voice_assistant.sh` sources:

| Secret | Config key | Protects |
|---|---|---|
| `ESP_FLEET_TOKEN` | `fleet_token_env` | Box ↔ server traffic, as `X-Fleet-Token` |
| `ESP_MCP_TOKEN` | `mcp_token_env` | The `/mcp` tool surface, as `Authorization: Bearer` |

They're separate on purpose: one authenticates **hardware**, the other
authenticates **MCP clients**, and leaking one must not grant the other.

**Why the fleet token matters.** The box's own HTTP server is on the LAN, and
without a token anyone on the same WiFi could `POST /server` to permanently
repoint where its microphone uploads — or `POST /play` with `X-Auto-Listen` to
force a recording. With `fleet_token_env` set, all four box endpoints
(`/play`, `/caption`, `/order`, `/server`) require the header, and mcp-core's
box-facing routes do too. `/health` stays open for `check_health.sh` but hides
the box inventory unless authenticated.

**Rollout is safe in any order.** A box enforces only once it *holds* a token,
and the only way it gets one is the server's `/server` adopt push
(trust-on-first-use on your own LAN). So you can never lock yourself out — a box
that rejects you is rejecting with a secret the server knows. To re-key: hold
BOOT 5s on the box (wipes the token with the WiFi credentials) and re-provision.

Leaving `fleet_token_env` unset keeps the old open behavior, and mcp-core prints
`Fleet auth: OFF` at startup so the state is never ambiguous.

## Remote access over Tailscale

mcp-core is reachable on the machine's tailnet address, so you can drive the
fleet from anywhere without port forwarding — and that address never changes,
which is the permanent fix for "the server's IP moved":

```bash
curl -s http://<tailnet-ip>:8000/mcp -H "Authorization: Bearer $ESP_MCP_TOKEN" ...
# MagicDNS names work too: http://<host>.<tailnet>.ts.net:8000/mcp
```

The boxes themselves are **not** on the tailnet — they stay LAN devices and
reach mcp-core over the LAN, which is exactly why the fleet token (not the VPN)
is what protects them.

> ⚠️ **`lanIp()` must never return a tailnet address.** `adoptKnownBoxes()` pushes
> whatever it returns to every box every 60s, and boxes can't route to `100.64/10`
> — a wrong pick would brick the fleet's upload path until each box was physically
> re-provisioned. CGNAT addresses are filtered explicitly, an interface sharing a
> subnet with a known box is preferred, `lan_ip` in `config.json` overrides, and
> the chosen address is logged at startup so a bad pick is visible immediately.

## Firmware updates over WiFi (OTA)

Build, then push — no USB cable:

```bash
cd listen_v2 && source idfenv.sh && idf.py build
curl -X POST http://<mcp-core>:8000/ota                 # whole fleet
curl -X POST "http://<mcp-core>:8000/ota?box=<box-id>"  # one box
```

mcp-core serves the built image from `GET /firmware` and tells each box to fetch
it. Both routes need `X-Fleet-Token` when fleet auth is on. The box answers
immediately and downloads in the background, then reboots — watch its log or
`/health` to see it come back. You can also point a box at any image directly:
`curl -X POST http://<box-ip>/ota --data "http://<host>/firmware.bin"`.

Firmware is **never** pushed automatically. Adoption re-runs every 60s because
repointing a box is always safe; reflashing the fleet on every build is not.

**Why a bad push can't strand a box.** There are two app slots: a download
writes to the idle one, so the running firmware survives a failed or corrupt
transfer. A new image then boots in `PENDING_VERIFY` and is only made permanent
after the box joins WiFi *and* its server answers (`ota_mark_valid()`). If it
can't get online it reverts to the previous slot and reboots, so the worst case
is one reboot rather than a site visit with a cable.

> ⚠️ **Each box needs one final USB flash** to move onto the OTA partition
> table — a box on the old single-slot table has nowhere to put an update.
> `nvs` keeps its exact offset and size in the new table, so WiFi credentials,
> server URL and fleet token all survive; no box needs re-provisioning.

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