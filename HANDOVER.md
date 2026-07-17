# Handover — Agent Connect

**Your job in one sentence:** run an HTTP service with one endpoint. We send it
what the customer said; you send back what to say and (optionally) what to draw
on the box's screen.

You do not touch the firmware, the microphone, speech-to-text, text-to-speech,
WiFi, or the screen driver. All of that works already. The seam between us is a
single JSON contract, and it is already defined, implemented, and running.

---

## 1. Mental model — who calls whom

The most common misunderstanding: **you host the endpoint, we call you.** We are
the client. You are the server.

```
  customer speaks
        |
        v
  ESP32-S3-BOX-3  --WiFi-->  mcp-core (:8000)      <- Celine's side
                                  |
                                  |  POST {session_id, text}
                                  v
                             YOUR AGENT (:4000/agent)   <- your side
                                  |
                                  |  {reply, display, end_session}
                                  v
                             mcp-core  -> TTS -> speaker
                                       -> screen payloads -> box
```

**mcp-core is deliberately dumb.** It does speech<->text and delivery. It knows
nothing about menus, prices, orders, or personas — and it must stay that way.
Everything that thinks lives behind your webhook. That is the whole point of the
split: swap your service out and the same core drives a completely different
product.

**The one-line integration:** `backends.agent.webhook_url` in `~/esp/config.json`
points at your service. That's it. That's the connection.

---

## 2. The contract

### `POST /agent` — required

We send:

```json
{ "session_id": "BOX-C3B4", "text": "one roti canai please" }
```

You return:

```json
{
  "reply": "One roti canai, coming up boss!",
  "display": [
    { "path": "/order", "body": "TITLE|YOUR ORDER\nITEM|1X ROTI CANAI|RM2.00\nTOTAL|RM2.00" }
  ],
  "end_session": false
}
```

| Field | Required | Meaning |
|---|---|---|
| `reply` | **yes** | Spoken aloud via TTS. Missing/empty = we treat the call as failed. |
| `display` | no | Array of screens pushed to the box, in order. Omit or `null` for no screen change. |
| `end_session` | no | `true` when the interaction is finished (order done). Clears our per-box state. |

### `POST /reset` — recommended

We call this when someone resets the demo (`curl -X POST localhost:8000/reset`).
Drop that session's state. If you don't implement it, resets won't clear your
side and the next "customer" inherits the last one's order.

### `GET /health` — recommended

Cheap liveness check. The reference agent returns `{"status":"ok"}`.

### `display` payloads

Only two paths are accepted; anything else is dropped with a warning
(`mcp-core/boxes.js`):

- **`/order`** — the itemized order screen. Pipe-delimited, newline-separated:
  ```
  TITLE|YOUR ORDER
  ITEM|2X NASI LEMAK|RM11.00
  ITEM|1X TEH TARIK|RM2.50
  TOTAL|RM13.50
  ```
  Max 5 `ITEM` lines (the screen is 320x240). Longer names get truncated.

- **`/caption`** — a text caption screen. Body is the raw text; optional
  `headers: { "X-Speaker": "BOX" }`.

We relay these **verbatim** — we never build or modify them, and we never do
arithmetic on them.

---

## 3. Constraints that will bite you

These are not style preferences. Each one is a real property of the hardware or
pipeline, several learned the hard way.

1. **Never let the LLM do arithmetic.** We caught a model speaking "RM17.00" for
   a RM13.50 order. Compute prices and totals in your own code from your menu
   data. The reference agent makes the LLM write a literal `{TOTAL}` placeholder
   and substitutes the real computed value before returning — steal that trick.

2. **The box font is uppercase ASCII only.** Supported punctuation: `. : - ' ? ! ,`
   Anything else (emoji, curly quotes, accented or non-Latin characters) renders
   as a blank gap. Text is auto-uppercased for display.

3. **Reply in English.** The TTS voice is English-only. Light Manglish flavour
   ("lah", "boss") is good and intended; a reply in full Malay comes out
   mispronounced. (This happened; the reference prompt now pins it.)

4. **Keep replies short — 1-2 spoken sentences.** Every word is time the customer
   stands there listening. Long replies also read badly on a small screen.

5. **Latency is silence.** Aim for under ~3s. The hard timeout is 120s, but that
   is a failure mode, not a budget. STT is ~0.7s and TTS is ~1s per sentence, so
   your time is the customer's total wait.

6. **`session_id` is the box id** (e.g. `BOX-C3B4`), stable across DHCP changes.
   **You own all session state** keyed by it — conversation history, current
   order. mcp-core keeps none for webhook backends.

---

## 4. Getting started — the fast path (recommended)

You need **Node.js. That's it.** No box, no GPU, no speech stack.

```bash
git clone <repo> ~/esp
cd ~/esp/agents/restaurant
node agent.js                     # starts on :4000
```

Your entire dev loop is curl — pure JSON in, pure JSON out:

```bash
curl -s -X POST http://localhost:4000/agent \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test1","text":"two nasi lemak and one teh tarik"}' | jq
```

Multi-turn: reuse the same `session_id`.

```bash
curl -s -X POST http://localhost:4000/agent -H "Content-Type: application/json" \
  -d '{"session_id":"test1","text":"add one roti canai"}' | jq
curl -s -X POST http://localhost:4000/agent -H "Content-Type: application/json" \
  -d '{"session_id":"test1","text":"that is all"}' | jq
curl -s -X POST http://localhost:4000/agent -H "Content-Type: application/json" \
  -d '{"session_id":"test1","text":"yes confirm"}' | jq
curl -s -X POST http://localhost:4000/reset                 # start fresh
```

If your JSON looks right here, integration is a one-line config change. **Do not
wait on hardware to start.**

The reference agent uses local Ollama (`llama3.2:3b`) by default. To point it at
something else without touching code:

```bash
AGENT_LLM_URL=https://api.openai.com/v1/chat/completions \
AGENT_LLM_MODEL=gpt-4o-mini \
AGENT_LLM_TOKEN=sk-... \
node agent.js
```

(Your agent picks its own LLM — that's deliberately *not* in mcp-core's config.
The core doesn't care how you think.)

---

## 5. Connecting to the real system

When your service is ready, Celine changes one line in `~/esp/config.json`:

```json
"backends": {
  "priority": ["agent", "local_llm"],
  "agent": { "webhook_url": "http://<your-machine-ip>:4000/agent" }
}
```

Then restart the stack (`~/esp/start_voice_assistant.sh`). Your service can run
on any machine on the same LAN — it does not have to be hers.

**`priority` is a fallback chain, tried in order.** `agent` first, then
`local_llm`. If your service is down or times out, the box still talks — it just
degrades to a generic chatbot with no menu and no order screen. Two consequences:

- You can't break the demo by being offline. Good.
- "It replied, but like a generic assistant" = **your service isn't being
  reached.** That's the first thing to check, not a prompt bug.

---

## 6. Optional: running the whole stack yourself

**You probably don't need this.** Section 4 covers real development. Only do this
if you want end-to-end voice on your own machine.

Note that `whisper.cpp/` and `MOSS-TTS-Nano/` are **gitignored** — cloning the
repo does not give you them. You'd need to:

- install and build **whisper.cpp**, download `ggml-small.bin` (~465MB, multilingual)
- set up **MOSS-TTS-Nano** in a Python venv on `:8080`
- install **Ollama** + `llama3.2:3b`
- have a **physical BOX-3**, flashed, on the same WiFi

Then `~/esp/start_voice_assistant.sh` and `./check_health.sh` (one green/red line
per service). See `README.md` for the full architecture.

There is a middle option that's often best: run **only your agent** locally and
have Celine point her `config.json` at your IP. You get real voice end-to-end
with none of the setup.

---

## 7. Reference implementation

**`agents/restaurant/agent.js`** (~200 lines) is a complete, working
implementation of this contract: session state, menu-driven pricing, the
`{TOTAL}` trick, order-screen payloads, confirm flow. `agents/restaurant/menu.json`
is the source of truth for items and prices.

Either evolve it or treat it as the executable spec of expected behavior.

---

## 8. Debugging

| Symptom | Look at |
|---|---|
| Box replies but generically, no order screen | Your service isn't reachable — core fell back to `local_llm`. Check `webhook_url`, firewall, that you're on the same LAN. |
| `display entry with unsupported path X — dropped` | `path` must be exactly `/order` or `/caption`. |
| Spoken total ≠ screen total | Your LLM is doing arithmetic. See constraint #1. |
| Screen shows gaps/missing characters | Non-ASCII in your text. See constraint #2. |
| Reply sounds mispronounced/foreign | Replying in Malay. See constraint #3. |

Logs: `/tmp/mcp-core.log` (routing, per-stage timing), `/tmp/restaurant-agent.log`
(the reference agent).

---

## 9. Coordination note

The **ordering process** work overlaps with this. The reference agent *already
implements* a full ordering flow (menu, order state, confirm). If ordering logic
gets built anywhere other than behind this webhook, there will be two competing
brains.

Suggested split: **you own the agent service** — the contract, deployment, and
that it stays up. Whoever owns "ordering process" owns the **logic inside it** —
menu, order state machine, confirm rules.

Worth agreeing on explicitly before both sides write code.
