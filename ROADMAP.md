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

## 8. Remote Deployment — *OTA DONE; rest medium*

SSH/IP deployment, remote config updates, remote file transfer.

**Done (2026-07-29): OTA firmware updates.** `POST /ota` on the box takes a
firmware URL, downloads into the idle app slot and reboots into it;
`POST /ota` on mcp-core pushes that to one box (`?box=<id>`) or the whole fleet,
serving the image from `GET /firmware`. Both are behind `X-Fleet-Token` like
every other box-facing route. Firmware pushes are **manual on purpose** —
adoption re-runs every 60s because repointing a box is always safe, whereas
auto-reflashing the fleet on every build would roll a bad image out unattended.

Safety net, which is the part that matters for a box you can't reach: two app
slots, so a failed download never touches the running image; and
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`, so a new image is only made permanent
after it has joined WiFi *and* reached its server. An update that breaks
networking reverts itself instead of stranding the box.

> ❌ **The old note here was wrong** and is worth recording, because it blocked
> this item for months. It said "the 4MB partition would need re-planning for an
> OTA layout (two app slots)" — that confused the *app partition* with the
> *chip*. BOX-3 has **16MB of flash** and was using ~4MB of it; `partitions.csv`
> even said so on line 1. Two 4MB slots fit with ~7.75MB still spare. There was
> never a space problem.

**Migration done for BOX-C3B4 (2026-07-29).** The final USB flash landed and
`nvs` survived exactly as designed — the box rejoined WiFi and re-registered
with its stored token, never entering provisioning. No more cables for this box.

> ⚠️ **Landmine, found the hard way: `sdkconfig.defaults` is only read when
> `sdkconfig` does not exist.** `sdkconfig` is gitignored, so the local one
> (dated Jul 25) predated `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` and silently
> ignored it. The partition table still applied (it's read from `partitions.csv`
> at build time), so *everything looked correct while the entire safety net was
> absent*: without rollback compiled in, images never enter `PENDING_VERIFY`, so
> `ota_mark_valid()` and `ota_rollback_if_pending()` both hit their early-return
> guards and do nothing. Fix is to delete `sdkconfig` and rebuild. **Verify with
> `grep ROLLBACK sdkconfig`, never by reading `sdkconfig.defaults`.**

**Both halves verified on hardware (2026-07-29), not assumed:**
- *OTA works*: pushed build downloaded into the idle slot, rebooted, and the
  reported slot flipped `ota_0` → `ota_1` with a new `fw_sha`. It then survived
  a reboot still on `ota_1`, proving `ota_mark_valid()` cancelled the rollback.
- *Rollback works*: pushed again into `ota_0`, then killed mcp-core the moment
  the box rebooted. It retried `/health` at 2/4/8/16/32s backoff for the full
  5-minute deadline, logged "could not get online — reverting", and came back on
  `ota_1` **unattended**. This is the failure that must never strand a box, and
  it is now a tested path rather than a design intention.

**Still open:** remote config updates and file transfer.

## 9. Private Networking (Tailscale) — *approach proven, Funnel transport NOT production-ready*

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

> ⚠️ **STATUS CORRECTION (2026-07-30, same day).** This was briefly marked DONE
> after a single successful `esp_speak` over Funnel. That was premature — under
> sustained use the Funnel-proxied socket **drops repeatedly, specifically around
> large audio pushes**, which is audible as chopped/glitching speech. `ws_url` is
> back to the LAN default; **do not demo on the Funnel path.** The *approach*
> below is sound and the VPN-on-the-box plan really is superseded — but the
> public transport needs the work in "What's left" before it can be trusted.

**Superseded — boxes don't need to be on the tailnet after all (2026-07-30).**
The plan below (MicroLink / esp_wireguard) is now moot. The reverse WebSocket
channel (`ws_client.c`, shipped 2026-07-29) already lets mcp-core reach a box
from anywhere — the box dials OUT, so no VPN client on the chip is needed.
Point `ws_url` in `config.json` at a **Tailscale Funnel** address (a normal
public `wss://` endpoint mcp-core already answers on `/ws`) and any box on any
WiFi can be reached, LAN or not. Verified live: a box on a home network,
mcp-core on a laptop on the same network, talking over the public internet via
Funnel rather than the LAN — `esp_speak` round-tripped in ~9s.

Two real bugs surfaced getting there, both now fixed, both worth recording
because neither was hit until the reverse channel *actually* carried traffic
over a public relay for the first time — LAN-only testing could never have
found either one:

- **DNS.** MEASURED: the WiFi router's own DNS resolver returned `NXDOMAIN` for
  the Funnel hostname (a mesh router, likely filtering anything that looks
  VPN/tunnel-shaped) while a public resolver answered it fine — `esp-tls`
  failed with `ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME` on every connect
  attempt. Fixed by overriding DNS to `1.1.1.1`/`1.0.0.1` in the
  `IP_EVENT_STA_GOT_IP` handler (`listen_v2.c`), reapplied on every IP
  acquisition including DHCP renewal. **Any future client site could hit the
  same wall** if their router does similar filtering — this fix generalizes to
  that case for free.
- **Heap exhaustion → hard crash.** MEASURED: the very first clip played over
  a *live* `wss://` reverse channel crashed the box (`assert failed:
  xStreamBufferBytesAvailable`). Root cause: `CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC`
  keeps the TLS session's buffers in internal SRAM for the connection's whole
  lifetime; combined with the 64KB internal-SRAM ring buffer `play_begin()`
  allocates per clip, internal heap ran out and `xStreamBufferCreate()`
  returned NULL — which nothing checked, so the first FreeRTOS call on that
  NULL handle asserted and rebooted the box. This is exactly the heap-pressure
  risk this section already warned about *before* it was ever measured. Fixed
  two ways: `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y` moves TLS buffers to the 16MB
  PSRAM instead, and `play_begin()`/`play_feed()` now check the allocation and
  skip the clip instead of crashing if it ever fails again regardless of cause.
- **Still true, still open:** there is still no `heap_caps_get_free_size()`
  anywhere in the firmware. This bug was root-caused by reasoning from the
  sdkconfig, not from an actual heap reading — real instrumentation would have
  shown it directly and would catch the *next* heap surprise faster than
  another crash-and-diagnose cycle.
- Also worth knowing: **rollback did not protect against this.** The crashed
  image had already reached the server and called `ota_mark_valid()` *before*
  the crash, so it was confirmed and stuck — rollback only guards "can't get
  online," not "runs, but has a bug." A push that boots and phones home can
  still need a second push to actually fix.

**A third bug, found by the glitching this caused (fixed):** `play_after()` ran
inline on the WebSocket event task, and for a greeting it calls
`run_auto_listen()`, which blocks until the customer's whole turn finishes (up
to `MAX_RECORD_SECONDS` = 30, plus upload and STT). That task is the *only* one
servicing the socket, so it answered no pings and read no incoming pushes for
the entire window — server saw a missed heartbeat, killed the channel, and the
mid-clip drop tripped `play_abort()`. The HTTP path never showed this because
httpd gives every request its own task. Fixed by dispatching `play_after()` to
its own task (`play_after_async()` in `ws_client.c`), with a busy guard so turns
can't stack. **Generalisable lesson: nothing long-running may execute on the WS
event task** — any future instruction handler needs the same treatment.

**What's left before the Funnel path can be trusted:**
- The socket still drops around large audio pushes even with the box idle and
  the `play_after` fix in. Suspected: Funnel's HTTP proxy and multi-hundred-KB
  binary WebSocket messages. Not yet root-caused.
- Server-side liveness was widened to count *any* inbound frame, not just a
  pong (`ws-hub.js`), because Funnel appears not to relay WS control frames —
  a healthy box looked dead. That was necessary but not sufficient.
- Likely real fix: **chunk audio into smaller WS messages** rather than one
  large one (mcp-core already sentence-chunks for latency — the same seam could
  cap frame size), and/or an application-level keepalive that doesn't depend on
  control frames traversing the proxy.
- Until then `ws_url` stays empty (LAN-derived). LAN reverse channel is stable
  and measurably faster (`total_ms` 6100 vs 7433 through Funnel).

## 10. Vision Tool (esp-see) — *done*

`esp_look` and `esp_scan_qr` ship, backed by the counter camera on the mcp-core
machine. `esp_look` returns the frame as an image block, so the calling model
looks at it directly rather than needing a separate vision backend.

> The prediction held: this fit the existing tool surface with no architectural
> change, and the work was almost entirely camera hardware (naming devices
> instead of indexing them, pixel formats, discarding unexposed first frames).

The fleet has since grown a second namespace. Every sense is now a tool on both
machine kinds — `esp_*` for the boxes, `spc_*` for OrangePi devices running
`spc-agent/` — so a model can choose *where* to look, speak, listen or sense:

| | see | speak | listen | sense |
|---|---|---|---|---|
| **ESP box** | `esp_look`¹ | `esp_speak` | `esp_listen`² | `esp_sense`³ |
| **OrangePi** | `spc_look` | `spc_speak` | `spc_listen` | `spc_sense` |

¹ the counter camera on the server; the BOX-3 has no camera of its own.
² *waits* for the box's own recording — there is no firmware command to make a
box record on demand, whereas `spc_listen` opens the Pi's mic immediately.
³ presence radar only. The sensor dock's AHT30 temp/humidity chip (I2C 0x38) is
still unread by the firmware, and `esp_sense` names it in `unavailable` rather
than pretending it isn't there.

## 11. Remote Fleet Control — *the LAN-only limit is gone*

Remote access to every box, status monitoring, remote speech/display, restart
and update, central dashboard.

> The MCP tool surface already does remote speech/display and box listing.
> The thing that used to gate this beyond the LAN — item 9 — is now resolved by
> the reverse channel + Funnel, not by a separate project. `esp_speak`,
> `esp_display` and OTA pushes already work over that path. What's left here is
> a dashboard/status UI, not connectivity.

---

## Suggested sequencing

1. **Item 1** (session lifecycle) — biggest UX win, no new hardware. Decide the
   session-clear mechanism first, given the top-button constraint.
2. **Item 7** finish (a second, non-restaurant example agent) — cheap, proves
   the platform claim.
3. ~~**Item 3** remaining hardening + **item 8** OTA~~ — OTA landed 2026-07-29
   and BOX-C3B4 is migrated onto the OTA table, with both the update path and
   the rollback path verified on hardware. The USB-cable friction is gone.
   Any future box still needs that one migration flash. Item 3's remaining piece
   (auto-recovery after a network interruption) is still open.
4. ~~**Item 9** Tailscale~~ — done 2026-07-30 via reverse channel + Funnel
   (not the VPN-on-the-box plan this used to point to). Item 11 is real now.
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
8. OTA firmware updates	Done 2026-07-29 — two app slots + auto-rollback; POST /ota on box and on mcp-core, image served from GET /firmware, all behind X-Fleet-Token. The "4MB partition blocks this" note was simply wrong: the chip has 16MB. BOX-C3B4 migrated to the OTA table the same day with nvs preserved (no re-provisioning), and BOTH the update and the unattended-rollback paths were exercised on real hardware. Boxes now report fw/fw_sha/slot/pending_verify on /register, surfaced via esp_list_boxes — the only way to catch a silent revert, since a rolled-back box looks perfectly healthy on the older image. Caught en route: sdkconfig.defaults never reached the local sdkconfig, so rollback was compiled OUT while looking enabled — see item 8's landmine note.
9. Tailscale (server side)	Done 2026-07-24 — mcp-core reachable on tailnet at stable 100.x address, no port forwarding; X-Fleet-Token now authenticates all box endpoints and mcp-core's box-facing routes (closes the "anyone on WiFi could repoint a box" hole). Also fixed lanIp() CGNAT-filtering bug this surfaced.
9. Tailscale (boxes reachable anywhere)	PARTIAL 2026-07-30 — approach proven, transport not production-ready. NOT via a VPN on the box (that plan is superseded). ws_url in config.json points the existing reverse channel at a Tailscale Funnel address; mcp-core reaches a box from anywhere without the box being on the tailnet. One esp_speak succeeded over the public Funnel URL, but under sustained use the Funnel-proxied socket drops around large audio pushes (audible glitching), so ws_url is back to the LAN default — see item 9's status correction. Found and fixed two real bugs surfaced only by this being the first time the reverse channel carried real traffic over a public relay: (1) the WiFi router's own DNS returned NXDOMAIN for the Funnel hostname while a public resolver answered fine — fixed by overriding DNS to 1.1.1.1/1.0.0.1 in firmware; (2) a live wss:// session's TLS buffers competing with the 64KB per-clip audio ring buffer for internal SRAM caused xStreamBufferCreate() to return NULL, which nothing checked, crashing the box on an unhandled assert — fixed via CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y (TLS buffers move to PSRAM) plus defensive alloc checks in play_begin()/play_feed(). Rollback did NOT catch the crash (the image had already confirmed itself before crashing) — a reminder that rollback only covers "can't get online," not "runs but has a bug." heap_caps_get_free_size() is still absent from the firmware; this bug was root-caused from sdkconfig reasoning, not a heap reading.
11. Remote fleet control	LAN: done. Beyond-LAN: blocked on #9's transport being made reliable. esp_speak/esp_display/OTA all work over the reverse channel + Funnel from anywhere. What's left is a dashboard/status UI, not connectivity.
Not started
Item	Status
4. Camera & QR	Zero commits. The cheap half (displaying a payment QR) is buildable today and isn't done. Scanning still needs camera hardware.
5. Healthcare	Not started — correctly gated on a privacy/legal answer first.
6. Fall detection	Not started — gated on #5.
7. Flexible MCP (remainder)	Only agents/restaurant exists — the second, non-restaurant example agent that would prove the platform claim hasn't been built.
8. Remote deployment / OTA	OTA done 2026-07-29 — moved to the Done list above. Remote config updates and file transfer are still not started.
10. Vision (esp-see)	Not started — blocked on #4's hardware.