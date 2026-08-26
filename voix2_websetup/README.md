# voix_websetup

## 1. What this is

An AI voice-ordering kiosk stack for restaurants/SMEs, running on ESP32-S3-BOX-3
hardware talking to a local single-board computer ("the brain" — OrangePi or
Radxa, picked in the setup web app's first step and persisted as
`BRAIN_DEVICE` in `.env`) that runs mcp-core, OpenClaw, and the setup web app
itself. The systemd units under `systemd/` use the `%h` specifier rather than
a hardcoded home directory so the same unit files work on either board. For
the full system architecture (components, data flow,
target deployment model, open decisions), see
[voice-kiosk-architecture-report.md](voice-kiosk-architecture-report.md). For
the MCP tool contracts the box and OpenClaw use to talk to each other
(`esp_speak`, `esp_display`, `esp_list_boxes`, etc.), see
[mcp-core/README.md](mcp-core/README.md).

This README covers what those two docs don't: the actual deploy sequence and
the operational gotchas discovered while running this in production.

## 2. Deploy flow

**Templates** (`SOUL.md`, `templates/skills/*/SKILL.md`):

1. `scp` the changed file(s) to `~/esp/...` on the box.
2. `curl -X POST http://localhost:3000/api/setup-openclaw`
3. `openclaw gateway restart` to pick up the changes.

**Code files** (`setup-server.js`, `openclaw-agent-bridge.js`):

`/api/setup-openclaw` does **not** pick these up. After scp'ing a code
change, restart the specific systemd service directly:

```
sudo systemctl restart voix-setup-server
sudo systemctl restart voix-openclaw-bridge
```

This is necessary because `/api/setup-openclaw` is itself served by the old
code until that service restarts — hitting the endpoint after a code change
just re-runs the stale handler.

## 3. Known recurring gotchas

**food-ordering keeps reappearing.**
Every `/api/setup-openclaw` run redeploys `skills/food-ordering/SKILL.md`
from source, even if it was manually disabled at the destination (renamed to
`.disabled` or `.new-copy`) — because the SOURCE folder
(`~/esp/templates/skills/food-ordering/`) still exists. After every deploy,
check `ls ~/.openclaw/workspace/skills/` and `rm -rf` the freshly-recreated
`food-ordering` folder if it's not meant to be active.

**mcp-core reads `.env.systemd`, not `.env`.**
Whenever `~/esp/.env` changes, regenerate the stripped copy mcp-core
actually reads:

```
sed 's/^export //' ~/esp/.env > ~/esp/.env.systemd
```

then restart the affected service. This fails silently — no error, just
unset variables — if skipped.

**systemd's PATH is narrower than an interactive SSH shell's.**
Services that shell out to `openclaw`/`ollama`/`npm`/`git`/`cmake`/`nmcli`/`pip`
(`voix-setup-server`, `voix-openclaw-bridge`) can fail with `ENOENT` even
though the same command works fine when SSH'd in and run manually. Fix by
adding an explicit `Environment=PATH=...` line to the specific `.service`
file.

**Chromium on this board has no headless ozone platform compiled in.**
OpenClaw must never launch it directly — `browser.attachOnly` and
`browser.noSandbox` must both be `true`, with Xvfb (`voix-xvfb.service`) +
a separately-launched Chromium (`voix-browser.service`) that OpenClaw
attaches to instead. Confirm `voix-xvfb.service` is running before
`voix-browser.service` — the latter `Requires=` the former.

**`esp_speak`/`esp_display` require an explicit `box_id` now that more than
one box is registered** (BOX-A1B4, BOX-C0C0) — the "defaults to the only
box when just one is registered" fallback in mcp-core no longer applies.
`openclaw-agent-bridge.js`'s `askOpenClaw()` sends `box_id` as a
developer-role message ahead of the customer's text specifically so the
model always has it, rather than needing to guess or call
`esp_list_boxes`. If a new box gets registered and tool calls start
failing with a "box_id is required" error, this is the first thing to
check.

**Session lifecycle is handled by `session.reset.idle`** (5-minute idle
timeout), configured in `setup-server.js`'s `SESSION_RESET_CONFIG` — not by
anything in `openclaw-agent-bridge.js`. `end_session` in the bridge's
webhook response contract is currently always `false` and is **not** the
mechanism that ends a session; `llmHistoryByBox` in mcp-core is unrelated to
OpenClaw's own session state (it's only used by the `local_llm` backend
path). Don't try to "fix" `end_session` as a way to force a session reset —
the idle-timeout config is the real mechanism, already working and already
part of the deploy flow.

Dead ends tried while debugging a stuck session, so they don't get
re-walked:

- `openclaw sessions delete` **does not exist** in this installed version
  (2026.7.1-2) — confirmed via `openclaw sessions delete --help`, which
  silently falls through to the parent `sessions` command's help instead
  of erroring, because `delete` isn't a real subcommand. The only real
  subcommands are `cleanup`, `compact`, `export-trajectory`, `list`,
  `tail`.
- Sending `/new` as plain text through the bridge **does not reset
  anything**. Slash-command interception happens at the channel-connector
  layer in OpenClaw; this project's bridge talks to OpenClaw's
  OpenResponses HTTP endpoint directly with no channel connector in
  between, so `/new` just gets treated as literal words and answered like
  any other message — confirmed live (the reply text visibly "played
  along" with restarting, but the same session id kept writing to the
  same trajectory file afterward).
- `openclaw sessions cleanup --active-key "<key>"` **does not delete or
  target that key** — despite the name suggesting otherwise. Per
  `--help`, `--active-key` actually means "protect this session key from
  budget-eviction." Using it against the stuck session made the tool
  report 0 pruned, and confirmed there's no flag on `sessions cleanup`
  that force-deletes one specific key by name — it only prunes by
  age/policy across the whole store.
- The one manual method confirmed to work: delete the session's entry
  directly from the store file
  (`~/.openclaw/agents/<agent>/sessions/sessions.json`), keyed by its
  full `sessionKey` (e.g. `agent:main:openresponses-user:box-c0c0`) — via
  `jq 'del(."<sessionKey>")' sessions.json > tmp && mv tmp sessions.json`.
  OpenClaw's own docs describe this as a safe operation ("deleting
  entries is safe; they are recreated on demand"). Caveat: every time
  this was done today it was immediately followed by `openclaw gateway
  restart`, so whether the deletion alone (without a gateway restart) is
  sufficient on its own was never actually isolated or confirmed —
  treat that as untested, not proven either way.

## 4. Known open issues

- **Inconsistent localization of menu item names in speech.** Menu item
  names occasionally don't get localized when spoken in a non-English reply
  (e.g. "Oreo慕斯" — half-translated) despite the SOUL.md rule requiring it.
  Inconsistent, not yet root-caused.
- **Setup page's box online/offline status can't be trusted.**
  `setup-server.js`'s `/api/boxes` (or wherever `fetchFleetHealth`'s result
  is surfaced to the setup web page) hardcodes `online: true` for every box
  regardless of the real value returned by mcp-core's `esp_list_boxes`.
