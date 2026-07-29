# Demo runbook

Everything needed to take this from cold hardware to a working demo, plus what
the system actually is. Written to be followed top to bottom on demo day.

Companion docs: `README.md` (architecture reference), `HANDOVER.md` (the agent
webhook contract), `ROADMAP.md` (what's built vs. not).

---

## Part 1 — What this thing is

### One paragraph

An **ESP32-S3-BOX-3** on your desk listens when a customer walks up, records what
they say, and ships the audio to a **Mac running `mcp-core`**. The Mac turns
speech into text, hands the text to a **restaurant agent** that knows the menu and
prices, gets back a reply plus an order screen, turns the reply into speech, and
pushes both back to the box. Everything runs **locally** — no cloud, no API keys.
The same core drives non-restaurant products by swapping one webhook URL.

### The box itself

| Part | Detail |
|---|---|
| Board | ESP32-S3-BOX-3, 16MB flash, PSRAM, 2.4GHz WiFi **only** |
| Mic | ES7210 array — records on trigger, not always-on |
| Speaker | ES8311 codec + amp |
| Screen | 320×240, **uppercase ASCII only** (`. : - ' ? ! ,` — anything else renders blank) |
| Touch | Primary trigger. Tap the screen to order. |
| Presence radar | A single GPIO. Starts a session when someone approaches, clears it when they leave. |
| BOOT button | Short press = order. **Hold 5s = wipe WiFi credentials + fleet token.** |
| Top button | **Hardware mic mute.** Firmware cannot override it — it physically cuts the mic. Not usable as a trigger. |

### What it's connected to

```
   ESP32-S3-BOX-3  ──WiFi(2.4GHz)──►  YOUR MAC
   192.168.68.142                     192.168.68.111
        │                                  │
        │  uploads mic audio  ────────────►│  mcp-core  :8000
        │◄──── pushes audio/screens ───────│    │
        │                                  │    ├─► voice-mcp-server (stdio)
        │  reverse WebSocket               │    │     ├─ whisper.cpp   (STT)
        │  ws://mac:8000/ws  ◄────────────►│    │     └─ MOSS-TTS      (TTS) :8080
        │  (lets the Mac reach the box     │    │
        │   even without a LAN route)      │    ├─► restaurant agent   :4000
                                           │    │     └─ menu.json + Ollama :11434
                                           │    │        (llama3.2:3b)
                                           │    └─► /mcp — mcp-core is itself an
                                           │         MCP server for any client
                                           │
                                           └─ Tailscale ─► reachable from anywhere
```

**Addresses above are today's DHCP values.** The box is identified by its
`X-Box-Id` header (`BOX-C3B4`), never by IP — IP is just a last-known address,
self-healed on every request.

### Ports

| Port | Service | Notes |
|---|---|---|
| 8000 | mcp-core | The hub. Everything goes through it. |
| 4000 | restaurant agent | The brain. Menu, prices, order state. |
| 11434 | Ollama (`llama3.2:3b`) | Used by the agent, and as fallback backend |
| 8080 | MOSS-TTS | Text → speech |
| 80 (on box) | box HTTP server | `/play` `/caption` `/order` `/server` `/session` `/ota` |

### Features

- **Voice ordering** — speak, get a spoken reply plus an itemized order screen.
- **Session lifecycle** — greets **once** per customer, then stays quiet. Auto-clears
  when the radar sees them leave, so the next person gets a fresh greeting.
- **Fleet-ready** — boxes self-register on boot. Adding box #2 needs no code change.
- **OTA firmware updates** — push new firmware over WiFi, with automatic rollback
  if the new image can't get online. No USB cable.
- **MCP tool surface** — any MCP client can drive the fleet:
  `esp_list_boxes`, `esp_speak`, `esp_display`, `esp_set_occupied`.
- **Remote access** — Tailscale gives the Mac a fixed address from anywhere.
- **Two-token security** — `ESP_FLEET_TOKEN` (hardware ↔ server), `ESP_MCP_TOKEN`
  (MCP clients). Separate on purpose; leaking one must not grant the other.

### Repo layout

```
~/esp/
├── config.json              # boxes, backend priority, STT — the one config file
├── .env                     # ESP_FLEET_TOKEN / ESP_MCP_TOKEN (gitignored)
├── mcp-core/                # the router. zero business logic
├── agents/restaurant/       # the brain: menu.json, persona, pricing
├── voice-mcp-server/        # STT + TTS exposed as MCP tools
├── listen_v2/               # firmware (ESP-IDF)
└── *.sh                     # start / health / repoint helpers
```

---

## Part 2 — Demo day, in order

### Step 0 — Start the stack

```bash
cd ~/esp
./start_voice_assistant.sh          # or: ./start_voice_assistant.sh <box-ip>
./check_health.sh
```

Want five green lines: Ollama, MOSS-TTS, Restaurant agent, MCP core, Box.

> ⚠️ **The restart script has a blind spot.** It kills the agent with
> `pkill -f "agents/restaurant/agent.js"`. If an agent was started as
> `node agent.js` from inside that directory, that pattern **does not match it** —
> the old one survives, the new one fails on a busy port 4000, and you're left
> running whatever stale code the old process has. Check before you trust it:
>
> ```bash
> pgrep -fl agent.js          # expect exactly ONE
> curl -s localhost:4000/health
> ```
>
> Kill a stray by PID.

### Step 1 — Get the box on WiFi

**It must be a 2.4GHz network.** The box has no 5GHz radio. On an iPhone hotspot,
turn **"Maximise Compatibility" ON** or the box cannot see the network at all.

**If the box already knows the network,** it just connects — nothing to do. Its
screen shows its IP once ready.

**If it's a new box, or the network changed:** it fails to connect and opens a
provisioning portal by itself.

1. The screen shows a **QR code**, plus an SSID and an 8-character password.
   The SSID is the box's own id (e.g. `BOX-C3B4`).
2. Scan the QR with a phone camera — it's a standard WiFi QR, so the phone offers
   "join this network". Or join manually with the SSID/password on screen.
3. A **captive portal pops up automatically** (the box hijacks DNS). If it
   doesn't, browse to `http://192.168.4.1`.
4. Pick your WiFi from the live scan dropdown, enter its password, and set
   **Computer address** to your Mac: `http://<mac-ip>:8000/upload`
   (must start with `http://`).
5. Save. The box reboots and joins.

The portal stays open for 15 minutes. To force a box back into provisioning,
**hold BOOT for 5 seconds** — that wipes stored WiFi credentials *and* the fleet
token.

### Step 2 — If the box says "NO SERVER"

This means the box is on WiFi but the Mac's address it stored is stale — the
usual cause is the Mac getting a new IP. **You do not need to re-provision.**

```bash
cd ~/esp
./point_box_at_me.sh                 # scans the LAN and repoints every box
./point_box_at_me.sh 192.168.68.142  # or name the box directly
```

Boxes pick it up within ~30s. mcp-core also re-adopts known boxes every 60s on
its own.

> The script needs the fleet token exported, or boxes holding a token will
> answer `401`. `start_voice_assistant.sh` sources `~/esp/.env`; a bare terminal
> does not. Fix: `set -a; source ~/esp/.env; set +a`

> **Don't rely on `mcp-core.local`.** mDNS is blocked on many managed/campus
> networks. The push-based commands above are the reliable path.

### Step 3 — Run the demo

1. **Walk up to the box** (or tap the screen / press BOOT).
   It greets you once: *"Hi! Go ahead!"*
2. **Speak your order** — "two nasi lemak and one teh tarik".
3. It replies out loud and draws the itemized order screen with a total.
4. **Confirm** — "yes confirm".
5. **Walk away.** The radar notices, the session clears, and the next person is
   greeted fresh.

Round trip is ~3s when warm. First request after startup is slower — the models
are cold, so **do one throwaway interaction before the audience is watching.**

Useful during a demo, from any terminal:

```bash
# make the box say something without touching it
curl -s http://<mac-ip>:8000/mcp -H "Authorization: Bearer $ESP_MCP_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"esp_speak","arguments":{"text":"order up"}}}'

# reset everything between runs
curl -X POST http://<mac-ip>:8000/reset
```

---

## Part 3 — Tailscale (demoing from anywhere)

Tailscale gives the Mac a **fixed private address that never changes**, which is
the permanent fix for "the server's IP moved". mcp-core reaching *out* to the
world isn't the whole story here, though — as of 2026-07-30, **boxes can be
reached from anywhere too**, without a VPN client on the chip:

```bash
tailscale status            # confirm it's running; "Tailscale is stopped." = not
tailscale up                # opens a browser to authenticate the first time
tailscale funnel status     # confirm the public URL + /ws forwarding are up
```

Reach the fleet from anywhere on your tailnet:

```bash
curl -s http://<tailnet-ip>:8000/mcp -H "Authorization: Bearer $ESP_MCP_TOKEN" ...
# MagicDNS also works: http://<host>.<tailnet>.ts.net:8000/mcp
```

**How boxes get reached beyond the LAN — the box dials out, nothing dials in.**
The box already holds an outbound reverse WebSocket to mcp-core
(`ws_client.c`). Point `ws_url` in `config.json` at a **Tailscale Funnel**
address instead of the LAN — a normal public `wss://` URL mcp-core answers on
`/ws` — and the box can be reached from anywhere its own WiFi can reach the
internet, no VPN client on the chip required:

```json
"ws_url": "wss://<your-machine>.<tailnet>.ts.net/ws"
```

Push it to a box the same way you push anything else (`./point_box_at_me.sh`,
or wait ~60s for auto-adopt) — the box saves it to NVS and re-dials, same
mechanism as everything else it learns. **The box is still not on the
tailnet** — it's an ordinary LAN device that happens to hold open one outbound
connection to a public address. That's why the fleet token still matters here:
it's what stops a stranger from using that same public `/ws` endpoint.

> ⚠️ **Two real bugs found getting this working — both fixed, both worth
> knowing about if you ever repeat this on a different network:**
>
> **DNS.** Some routers (a mesh router, MEASURED) refuse to resolve a Funnel
> hostname at all — `NXDOMAIN`, even though the address is genuinely public and
> resolves fine everywhere else. Firmware now overrides DNS to `1.1.1.1` /
> `1.0.0.1` after joining WiFi specifically so this can't happen again on a
> different (e.g. client's) network. If a box logs
> `ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME`, this fix should already cover it —
> if it still happens, that firmware predates the fix.
>
> **A crash the first time real audio played over the tunnel.** A live `wss://`
> connection and a playing clip both fight for the same internal-SRAM pool;
> under memory pressure the box could crash outright. Fixed (moved TLS buffers
> to PSRAM + the box now skips a clip instead of crashing if allocation ever
> fails). Full root cause in `ROADMAP.md` item 9 if it ever resurfaces.

> ⚠️ **The other hazard, older and still true.** `adoptKnownBoxes()` pushes the
> Mac's *LAN* address to every box every 60s (for uploads — a separate address
> from `ws_url`). If that ever resolved to the `100.x` tailnet address, every
> box would be pointed somewhere it cannot route — bricking the fleet's upload
> path until each was physically re-provisioned. CGNAT (`100.64/10`) is filtered
> explicitly and the chosen address is logged at startup. **After starting
> Tailscale, check that line:**
>
> ```bash
> grep "LAN address boxes are told to use" /tmp/mcp-core.log
> ```
>
> It must be your normal LAN IP (`192.168.x.x`), never `100.x`. Override with
> `lan_ip` in `config.json` if the guess is ever wrong.

---

## Part 4 — Firmware updates (OTA)

Migrated boxes update over WiFi. No cable.

```bash
cd ~/esp/listen_v2 && source idfenv.sh && idf.py build

set -a; source ~/esp/.env; set +a
curl -X POST -H "X-Fleet-Token: $ESP_FLEET_TOKEN" \
  "http://<mac-ip>:8000/ota?box=BOX-C3B4"    # one box
curl -X POST -H "X-Fleet-Token: $ESP_FLEET_TOKEN" \
  "http://<mac-ip>:8000/ota"                 # whole fleet
```

The box answers immediately, downloads in the background (~13s), and reboots.
Confirm which image it actually landed on:

```bash
grep "Box registered" /tmp/mcp-core.log | tail -2
# Box registered: BOX-C3B4 ... fw=<ver>/<sha> slot=ota_1
```

`slot` flips `ota_0` ↔ `ota_1` on every successful update, and `fw_sha` changes on
every rebuild. **A box that silently rolled back looks perfectly healthy** — the
only tell is that it reports the *old* sha. That's what these fields are for.
`PENDING-VERIFY` means it's installed but still on probation.

**Why a bad push can't strand a box:** two app slots, so a download never touches
the running image; and a new image only becomes permanent after it joins WiFi
*and* its server answers. If it can't get online, it reverts itself and reboots.
Verified on hardware — see `ROADMAP.md` item 8.

> ⚠️ **A brand-new box needs one USB flash first** to move onto the OTA partition
> table (an old single-slot box has nowhere to put an update). `nvs` keeps its
> exact offset, so credentials survive — no re-provisioning.
>
> ```bash
> cd ~/esp/listen_v2 && source idfenv.sh && idf.py -p /dev/cu.usbmodem11101 flash
> ```
>
> **Never `erase-flash`** — that wipes the credentials this table was designed to
> preserve.
>
> ⚠️ **Before any flash, confirm rollback is actually compiled in.**
> `sdkconfig.defaults` is only read when `sdkconfig` does **not** exist, and
> `sdkconfig` is gitignored — so an old local one silently ignores it, and the
> safety net is absent while everything looks correct.
>
> ```bash
> grep ROLLBACK ~/esp/listen_v2/sdkconfig    # want CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y
> ```
>
> If it's missing: delete `sdkconfig`, run `idf.py reconfigure`, rebuild.

---

## Part 5 — Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Box replies but generically, no order screen | The agent isn't being reached; core fell back to `local_llm`. Check `pgrep -fl agent.js` and `curl localhost:4000/health`. |
| Screen shows `NO SERVER` + an IP | Stale server address. `./point_box_at_me.sh` |
| Box never joins WiFi | 5GHz network, or wrong password. Hotspot needs "Maximise Compatibility" ON. |
| Box not in `./check_health.sh` | Check the IP on its screen: `./check_health.sh <ip>` |
| `401` from a box | Fleet token not exported: `set -a; source ~/esp/.env; set +a` |
| Spoken total ≠ screen total | The LLM did arithmetic. Prices must be computed in code. See `HANDOVER.md` #1. |
| Gaps/missing characters on screen | Non-ASCII text. Uppercase ASCII only. |
| Weird glitch/buzz from the speaker | A clip was cut off mid-stream, leaving the codec open. Fixed in current firmware; if it happens on older firmware, reboot the box. |
| Mic seems dead | Someone pressed the **top button** — it's a hardware mute. Press again. |
| Everything green but no reply | Cold models on first request. Do one warm-up interaction. |

**Logs:** `/tmp/mcp-core.log` (routing + per-stage timing), `/tmp/restaurant-agent.log`,
`/tmp/moss-tts.log`, `/tmp/ollama.log`. Box's own log: `idf.py -p <port> monitor`.

---

## Pre-demo checklist

- [ ] `./start_voice_assistant.sh` then `./check_health.sh` — five green lines
- [ ] `pgrep -fl agent.js` shows exactly one process
- [ ] Box screen shows its IP, not `NO SERVER`
- [ ] One throwaway interaction to warm the models
- [ ] If demoing remotely: `tailscale up`, then check the LAN-address log line is `192.168.x.x`
- [ ] Top button not muted
