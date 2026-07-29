# Roadmap

Long-term vision: turn this restaurant voice assistant into a general-purpose
**MCP-enabled edge AI platform** — voice + vision + remote management behind a
flexible MCP interface, so the same ESP hardware serves restaurants, hospitals,
retail, smart homes and kiosks with minimal core changes.

Each item below carries a status and, where relevant, the hardware or design
constraint that shapes it. Constraints marked **MEASURED** were verified on the
real device, not assumed.

---

## 1. Conversation & Session Management — *high*

Make conversations feel natural; stop re-greeting the same customer.

- Clear session lifecycle per customer.
- Greet **once** at session start ("Hi, go ahead."), then stay quiet for the
  rest of the session.
- Ending/clearing a session resets state so the next customer is greeted again.
- Greeting logic: idle box → greet normally; occupied box → greet only at the
  start, then continue without repeating the opening prompt.

**Partly built already:** presence-triggered greeting exists, with a 20s
`GREET_COOLDOWN_MS` and a guard that suppresses greeting while a transcript is
pending. What's missing is a real *session* concept on the box (start → active →
cleared), rather than a cooldown timer approximating one.

> ⚠️ **Blocker — "hold the top button to clear session" will not work.**
> The top button is the **hardware mic mute** (MEASURED): it's a toggle that
> physically cuts the microphone on every press, and firmware cannot override
> it. It was retired as a trigger for exactly this reason.
> The side (BOOT) button's 5s hold is already taken by WiFi reset.
> **Viable alternatives:** an on-screen "NEW CUSTOMER" touch button (touch works
> and is already the primary trigger), a short BOOT press, or automatic session
> clear when the presence radar reports the customer has left for N seconds
> (likely the best UX — no button at all).

## 2. Radar / Presence Detection — *low*

Tune detection frequency; balance latency against resource use.

> ℹ️ **Reality check:** presence is a single **GPIO read** (MEASURED: the radar's
> output is a digital pin, not I2C), so polling cost is effectively zero — it is
> not a CPU or network burden. Nothing meaningful to reclaim here.
> The tuning that *actually* matters is **debounce and cooldown**: the radar
> drops and re-fires as a person shifts, which is what causes repeat greetings.
> That work belongs to item 1 (session lifecycle), not to polling frequency.

## 3. Network Reliability — *largely done, keep hardening*

**Done:**
- Box HTTP server now starts **before** the server-reachability wait, so a box
  that can't find its server is still reachable and fixable over the network.
- `POST /server` repoints a box live (persisted to NVS) — no QR, no re-provision.
- `point_box_at_me.sh` finds boxes on the LAN and repoints them in one command.
- mcp-core auto-adopts known boxes on startup and every 60s.
- Hold-BOOT-5s escape hatch works during the pre-READY phases (it used to be
  dead exactly when needed).
- mDNS advertiser can no longer crash mcp-core; `MDNS_DISABLE=1` to skip it.

**Remaining:**
- mDNS (`mcp-core.local`) is **blocked on some managed/campus networks**
  (MEASURED: multicast filtered). Unicast works fine there, which is why the
  push-based mechanisms above are the reliable path.
- iPhone hotspot needs **"Maximise Compatibility" ON** — the box is 2.4GHz-only
  and cannot see a 5GHz-only hotspot (MEASURED: hotspot absent from the box's
  own scan list).
- Better auto-recovery after network interruptions (currently a reboot or a
  manual repoint).

## 4. Camera & QR — *todo, needs hardware*

- Add a camera module (esp-see) for a "look" capability.
- Detect/scan QR codes; verify a scan before confirming payment.
- Display payment QR codes (TNG/eWallet) from the POS.

> ⚠️ **Split these two — they are not the same difficulty.**
> **Displaying** a payment QR is cheap and buildable **today**: QR rendering
> already exists on the box (the provisioning screen draws one via `qrcodegen`),
> and there is plenty of flash headroom (4MB partition, ~74% free).
> **Scanning** a QR needs a camera the BOX-3 **does not have** — that is a
> hardware addition plus image capture and decode, which is a different and much
> larger project.

## 5. Healthcare Use Case — *todo, exploratory*

Hospital bedside assistant, nurse call, patient interaction, elderly voice
assistance.

> ⚠️ **Privacy/legal, not just technical.** Always-on audio monitoring in
> bathrooms and patient rooms is legally regulated in most jurisdictions
> (consent, recording, data retention) and is a hard requirement to settle
> *before* engineering, not after. Design for on-device processing with nothing
> recorded or transmitted unless an event fires.

## 6. Fall Detection — *todo, hard*

Detect falls, cries for help, pain sounds, abnormal moaning; raise an alert,
notify staff, optionally verify with camera.

> ⚠️ **The hard part is false positives, not detection.** A toilet is full of
> loud, percussive, confusable sounds (doors, flushes, dropped items, hand
> dryers). Also note the STT accuracy work is still unmeasured on real Manglish
> speech — a fall-detection classifier is a *harder* audio problem than that, on
> the same microphone. Treat as research, and gate on item 5's privacy answer.

## 7. Flexible MCP Architecture — *high, mostly achieved*

Reusable across restaurants, hospitals, smart homes, kiosks, retail. No
restaurant-specific logic inside mcp-core.

> ✅ **Already true, and verified:** a grep of `mcp-core/` finds no menu,
> pricing, persona or restaurant strings. All business logic lives behind the
> agent webhook (`agents/restaurant/`), which is swappable via one line in
> `config.json`. mcp-core also has its own README and an MCP registry manifest.
> **Remaining:** more example agents (a non-restaurant one would prove the
> claim), and keeping the boundary honest as features land.

## 8. Remote Deployment — *medium*

SSH/IP deployment, remote config updates, remote file transfer.

> The highest-value piece is **OTA firmware updates**. Today every firmware
> change needs a USB cable, which has been a real friction point. ESP-IDF has
> built-in OTA support; the 4MB partition would need re-planning for an OTA
> layout (two app slots).

## 9. Private Networking (Tailscale) — *server side DONE; boxes deferred*

**Done (2026-07-24):** mcp-core is on the tailnet and reachable from anywhere at
a stable `100.x` address (and its MagicDNS name) with no port forwarding — the
structural fix for "the server's IP moved". Shipped alongside it, because
Tailscale alone did **not** meet the stated goal of "other people can't control
it": the boxes keep a LAN listener regardless, so a **fleet shared secret**
(`X-Fleet-Token`) now authenticates all four box endpoints and mcp-core's
box-facing routes. See README → Security. Before this, anyone on the same WiFi
could `POST /server` and permanently repoint a box's microphone upload URL.

Also fixed: `lanIp()` used to return the first non-internal IPv4 in enumeration
order. Tailscale adds a `100.x` interface, so it was one enumeration flip away
from pushing an unroutable address to every box every 60s and bricking the
fleet's upload path. CGNAT is now filtered explicitly and the choice is logged.

**Deferred — boxes on the tailnet.** [MicroLink](https://github.com/CamM2325/microlink)
is genuinely ESP32-S3-optimised and PSRAM-aware, but it does **not** integrate
with lwIP sockets — it exposes a proprietary `microlink_tcp_*` API, so the
firmware's entire networking layer (`esp_http_client` ×5 + `esp_http_server` ×4)
would need rewriting by hand on a library with 9 commits and no tagged releases.
The lwIP-native alternative, `trombik/esp_wireguard`, would be transparent but is
self-described alpha and lists neither ESP32-S3 nor ESP-IDF v5.x (we're on
v5.4.4). Revisit as its own project; **add heap instrumentation first** — there
is no `heap_caps_get_free_size()` anywhere in the firmware today, the "~300KB
free" figure below is boot-time and unreproducible, and there's a 64KB
internal-SRAM spike during every `/play`.

> This would **structurally fix** the recurring "the server's IP changed" pain:
> both ends get a fixed private IP regardless of the physical network.
> ⚠️ **Two honest cautions.**
> **Memory:** MicroLink needs ~100KB SRAM. The box has ~300KB internal SRAM free
> at boot (MEASURED) alongside 16MB PSRAM — so it's roughly a third of the fast
> RAM, on top of mic/display/touch/radar. Measure free heap *under load*, not at
> boot, before trusting it fits.
> **Maturity vs "must be stable":** it's a young project (few commits, first
> releases this year). Those two goals are in tension — adopt it deliberately,
> with time to test, never right before a demo.

## 10. Vision Tool (esp-see) — *todo, blocked on item 4 hardware*

MCP tools `esp_look`, `esp_scan_qr`, `esp_capture`; observe environment, scan
QR, recognise objects on request.

> Naturally fits the existing MCP tool surface (`esp_speak` / `esp_display` /
> `esp_list_boxes`) — the pattern is proven, so this is mostly gated on the
> camera hardware, not on architecture.

## 11. Remote Fleet Control — *depends on item 9*

Remote access to every box, status monitoring, remote speech/display, restart
and update, central dashboard.

> The MCP tool surface already does remote speech/display and box listing — over
> the LAN. Item 9 is what extends that beyond the local network.

---

## Suggested sequencing

1. **Item 1** (session lifecycle) — biggest UX win, no new hardware. Decide the
   session-clear mechanism first, given the top-button constraint.
2. **Item 7** finish (a second, non-restaurant example agent) — cheap, proves
   the platform claim.
3. **Item 3** remaining hardening + **item 8** OTA — removes the two biggest
   day-to-day friction points (network changes, USB flashing).
4. **Item 9** Tailscale — do it calmly, with test time; it makes item 11 real.
5. **Item 4/10** camera + vision — once hardware is chosen.
6. **Items 5/6** healthcare — gate on the privacy/legal answer before building.

## Also open (not in the numbered list)

- **Manglish/accent STT accuracy is still unmeasured on real human speech.** The
  eval tooling exists; the test set doesn't. This is the project's biggest
  untested assumption, and it sits underneath every use case above.


Done
Item	Evidence
1. Session lifecycle	d68a665 — the button blocker is fully resolved: sessions now start on presence/touch/BOOT and auto-clear on presence-departure (SESSION_ABSENT_MS), with the timer fed by interaction too (fixed a real "4 greetings in 70s" bug found on hardware). Server-scoped /session-end per box, isolation verified between boxes. This closes the exact gap flagged in the review — the roadmap text under item 1 is now stale, it still says "what's missing is a real session concept."
2. Radar/presence	Nothing to build — roadmap itself concludes there's no polling cost to reclaim; folded into item 1.
3. Network reliability	Largely done: /server push + auto-adopt (97307b8), hold-BOOT-5s fixed during pre-READY (461da4f), mDNS crash-guard + MDNS_DISABLE. Remaining: better auto-recovery after an interruption (currently needs reboot/manual repoint).
7. Flexible MCP (partial)	Verified — no restaurant strings anywhere in mcp-core, own README + registry manifest exist (5356fb1).
9. Tailscale (server side)	Done 2026-07-24 — mcp-core reachable on tailnet at stable 100.x address, no port forwarding; X-Fleet-Token now authenticates all box endpoints and mcp-core's box-facing routes (closes the "anyone on WiFi could repoint a box" hole). Also fixed lanIp() CGNAT-filtering bug this surfaced.
Not started
Item	Status
4. Camera & QR	Zero commits. The cheap half (displaying a payment QR) is buildable today and isn't done. Scanning still needs camera hardware.
5. Healthcare	Not started — correctly gated on a privacy/legal answer first.
6. Fall detection	Not started — gated on #5.
7. Flexible MCP (remainder)	Only agents/restaurant exists — the second, non-restaurant example agent that would prove the platform claim hasn't been built.
8. Remote deployment / OTA	Not started. Every firmware change still needs a USB cable — this is real, current friction, not hypothetical.
9. Tailscale (boxes on tailnet)	Deferred, not started — MicroLink doesn't integrate with lwIP sockets (would need a full networking-layer rewrite); esp_wireguard is alpha and untested on ESP32-S3/IDF v5.x. Revisit as its own project once heap instrumentation exists to check it actually fits. (Server side is done — see above.)
10. Vision (esp-see)	Not started — blocked on #4's hardware.
11. Remote fleet control	The LAN half already works (MCP tools do remote speech/display/listing today); the beyond-LAN half depends entirely on #9.