# AI Voice Kiosk — Architecture Report

## 1. What This System Is

An AI-powered voice ordering kiosk for restaurants/SMEs, built on ESP32-S3-BOX-3 hardware. A customer talks to the box; an AI (OpenClaw) understands them, can hold a conversation, and can place real food orders on a restaurant's ordering website — all through voice, with no screen interaction required from the customer.

---

## 2. Current State: Development Prototype

Everything below is running today on a single development Mac, proven working end to end.

### Components

| Component | Role | Language |
|---|---|---|
| **listen_v2** (ESP32 firmware) | Captures mic audio, plays replies, shows captions | C (ESP-IDF) |
| **mcp-core** | Thin router: box ↔ STT/TTS ↔ AI backend | Node.js |
| **voice-mcp-server** | Wraps whisper.cpp (STT) and MOSS-TTS (TTS) as MCP tools | TypeScript |
| **whisper.cpp** | Speech-to-text engine (external dependency, not in repo) | C++ |
| **MOSS-TTS** | Text-to-speech engine (external dependency, own FastAPI server) | Python/ONNX |
| **OpenClaw** | The "brain" — reasoning, browser automation, tool calling | External product |

### Data Flow (Voice Loop)

```
Customer speaks → box mic → mcp-core → whisper.cpp (STT) → text
   → OpenClaw (via /v1/chat/completions) → reply text
   → MOSS-TTS (TTS) → audio → box speaker → customer hears reply
```

Captions are streamed to the box screen in parallel with audio playback.

### Data Flow (OpenClaw-Initiated Actions)

OpenClaw is also a registered MCP client of `mcp-core`, and can call three tools directly:
- `esp_list_boxes` — check which boxes are online
- `esp_speak` — make a box say something, unprompted
- `esp_display` — push text to a box's screen

### Food Ordering

OpenClaw uses its own browser automation tool to place real orders on a restaurant's website. This is defined per-restaurant as an OpenClaw **Skill** (`SKILL.md`), which specifies the exact URL, how to find items, and how to select the "pay later" checkout option. One skill = one ordering platform.

### Known Issues in the Dev Setup

- **Mac's local IP is unstable** — changed three times in one session, breaking the box's connection each time. Needs either a static IP reservation or a move to mDNS-based discovery (attempted once, failed with `ESP_ERR_NOT_FOUND` — root cause not yet diagnosed).
- **whisper.cpp GPU crash** — the shared codebase was tuned for Apple Silicon (Metal GPU). On this Intel + AMD Mac, Metal hangs; fixed locally with a `-ng` (no-GPU) flag, but this is a per-machine patch, not yet a proper config toggle in the shared repo.
- **Local Ollama too slow** — CPU-only inference on this hardware times out for real conversations; currently bridged to Ollama Cloud / OpenClaw's own cloud model instead.
- **GitHub repo is currently public** — code (not secrets) is visible to anyone. Worth a deliberate decision, not an oversight.

---

## 3. Target Product Architecture

### Deployment Model

Each paying client receives a **pre-configured local device** from App360 (not a shared cloud service). That device runs the full stack locally:

```
Client's shop:
  ESP32 box  ⇄  Client's device (mcp-core + OpenClaw, running locally)
                        │
                        ├─ (optional) Cloud AI provider, if client chooses
                        └─ Ordering website — visited automatically by
                           OpenClaw's browser tool when placing an order
```

The client never sees a website, a terminal, or a config file. They interact with the system in two ways only:

1. **One-time setup** — a simple button-based web page (see below)
2. **Daily use** — just talking to the box

### Client-Facing Setup Page (Planned)

A minimal, branded web page — not OpenClaw's own full dashboard, which is too complex for a non-technical user. Each button quietly runs a real command underneath (the same ones used manually during development):

| Button | Underlying action |
|---|---|
| Connect to WiFi | Box's existing captive portal (already built, no change needed) |
| Choose AI: Cloud / Local | `openclaw config set agents.defaults.model.primary <model>` |
| Save API key (if Cloud chosen) | `openclaw config set models.providers.<id>.apiKey ...` |
| Which website do you order from? | Generates a `SKILL.md` file for that ordering platform |
| Business contact info | Saved into the skill, so it's not asked on every order |
| Test my setup | Calls `esp_list_boxes` + `esp_speak`, confirms box responds |
| Save & Restart | Applies changes, restarts the local service |

### Pre-Shipping Setup (App360-side, not client-facing)

Done once per device before it ships:
- Install dependencies (`npm install` for both Node projects)
- Download STT model (`whisper.cpp` model file)
- Build `voice-mcp-server`
- Pre-flash ESP32 firmware with correct target device address

### Future: QR-Based Ordering

A camera dock (official `ESP32-S3-BOX-3-DOCK`, USB, up to 720p) will let a customer scan a table QR code to identify which restaurant/menu is active. This doesn't replace the browser-ordering step — it replaces how the system decides *which* restaurant's skill/website to use. The customer still only ever talks; OpenClaw still does the ordering invisibly in the background.

---

## 4. Open Decisions (Not Yet Settled)

- **Repo visibility** — keep public, or move private now that this is a real product?
- **Multi-tenancy** — even with per-client local devices, does App360 need a way to remotely manage/monitor many deployed devices? Not yet designed.
- **Skill strategy at scale** — one skill per restaurant (reliable, manual work) vs. one skill per ordering platform (covers more restaurants, less manual work) vs. fully generic browsing (flexible, higher risk). Leaning toward per-platform as the realistic middle ground.
- **mDNS vs. static IP** — worth revisiting so devices don't break every time a network reassigns an IP.

---

## 5. Suggested Next Steps

1. Decide repo visibility (private recommended, given real business logic is now involved).
2. Build the client-facing setup page, starting with the "Choose AI + API key" button (already proven to work manually).
3. Resolve the IP-instability issue at the infrastructure level before shipping any real device.
4. Decide on the skill strategy for scaling to multiple restaurants.
