# spc-agent — the OrangePi half of the fleet

mcp-core drives ESP boxes by pushing to firmware it controls. It can't do that
to a Linux board, so the Pi runs this instead: a small HTTP service that exposes
its microphone, speaker, sensors, camera and screen as a handful of routes.

Anything that answers those routes is a valid `spc` device. This implementation
is a convenience, not a requirement — swap it for your own agent and mcp-core
won't notice.

Three files: `spc_agent.py` is the service, `spc_face.py` is the page it serves
to a browser on an attached panel, and `spc_fb.py` draws that same screen
straight to the framebuffer when there is no browser to serve it to.

## Install on the Pi

Stdlib Python only, so there is nothing to `pip install`. The hardware work is
shelled out to standard Linux tools:

```bash
sudo apt install alsa-utils sox espeak-ng ffmpeg   # drop what you don't need
```

| Tool | Needed for | Without it |
|---|---|---|
| `alsa-utils` (`arecord`/`aplay`) | `listen`, `speak` | those capabilities disappear |
| `sox` | `listen` | still records, but always for the full timeout instead of stopping when you stop talking |
| `espeak-ng` | `speak` | no voice unless you set `SPC_TTS_CMD` |
| `ffmpeg` | `look` | no camera (`fswebcam` also works) |
| a browser (`chromium`) | `screen` | only for `GET /face`; `spc_fb.py` needs nothing at all |

Copy `spc_agent.py` **and `spc_face.py`** to the Pi, side by side, then check
what it found:

```bash
python3 spc_agent.py --help     # prints resolved config + detected capabilities
python3 spc_agent.py            # run it
```

Then point mcp-core at it in `config.json`:

```json
"devices": [
  { "id": "SPC-1", "name": "OrangePi", "kind": "spc",
    "base_url": "http://orangepi:8080",
    "capabilities": ["speak", "sense", "listen", "screen"] }
]
```

Use the Pi's **Tailscale MagicDNS name**, not a raw `100.x` address — that's
CGNAT space and it will break on a network change, the same landmine documented
for `lan_ip`.

`capabilities` decides which `spc_*` tools mcp-core exposes, and it's read from
config rather than probed from the Pi. That's deliberate: if the tool surface
came from `/health`, a Pi that happened to be switched off at boot would tell
the model this restaurant has no speaker at all. mcp-core probes `/health`
anyway and prints a warning when the two disagree. Add `"look"` and restart once
a camera is plugged in.

`"screen"` is the exception worth declaring early: there is no honest test for
"is a monitor attached" (an unplugged HDMI port still leaves `/dev/dri/card0`),
so set `SPC_SCREEN=1` and the whole face works over the network before any glass
is involved.

## Configuration

All environment variables, all optional.

| Variable | Default | Notes |
|---|---|---|
| `SPC_ID` | `SPC-1` | Must match the `id` in mcp-core's config |
| `SPC_HOST` / `SPC_PORT` | `0.0.0.0` / `8080` | |
| `SPC_FLEET_TOKEN` | *(unset)* | Shared secret. Falls back to `ESP_FLEET_TOKEN`. **Set this** — without it, anyone who can reach the port can open the microphone |
| `SPC_MIC_DEVICE` | `default` | ALSA name; list with `arecord -l` |
| `SPC_SPEAKER_DEVICE` | `default` | ALSA name; list with `aplay -l`. Override when the default is an HDMI port nobody is listening to |
| `SPC_CAMERA_DEVICE` | `/dev/video0` | Missing file = no `look` capability |
| `SPC_TTS_CMD` | *(espeak-ng)* | Real voice, e.g. piper. Text arrives on stdin; write a WAV to the path substituted into `{out}` |
| `SPC_PRESENCE_GPIO` | *(unset)* | sysfs GPIO number read as a `presence` bit |
| `SPC_SENSE_CMD` | *(unset)* | Command printing a JSON object of readings on stdout |
| `SPC_SCREEN` | *(auto)* | `1` forces the `screen` capability on, `0` off. Auto-detection looks for `/dev/dri/card*` or `/dev/fb0` and is a guess — HDMI unplugged still leaves a card node. Force it on to build the face before a panel arrives |

### Sensors

`spc_sense` is a passthrough — mcp-core does not interpret the readings, so name
the keys for a reader (`presence`, not `d7`). Two ways in:

- **`SPC_PRESENCE_GPIO=7`** covers the common PIR / mmWave case with no script
  to write. Reports `{"presence": true|false}`, or `null` if the pin can't be
  read. Null means *unknown*, never *nobody there*.
- **`SPC_SENSE_CMD=/opt/sensors.py`** is the general escape hatch: any sensor,
  any library. Print one JSON object and exit.

Both can be set at once; the command's keys win on a collision. A sensor script
that crashes reports itself in a `_error` key rather than taking down a working
GPIO reading next to it.

## Run it at boot

```ini
# /etc/systemd/system/spc-agent.service
[Unit]
Description=spc-agent
After=network-online.target sound.target

[Service]
ExecStart=/usr/bin/python3 /opt/spc-agent/spc_agent.py
Environment=SPC_ID=SPC-1
Environment=SPC_FLEET_TOKEN=<same value as ESP_FLEET_TOKEN on mcp-core>
Environment=SPC_SCREEN=1
Restart=always
RestartSec=5
User=orangepi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now spc-agent
journalctl -u spc-agent -f
```

`User=` matters for hardware access — that account needs to be in the `audio`
and `video` groups.

## The HTTP contract

Every route except `/health` requires `X-Fleet-Token` when a token is set.
`/health` stays open deliberately: it reports nothing about the room, and
putting it behind auth means the first thing you reach for when debugging auth
is itself behind auth.

### `GET /health` → 200

```json
{ "ok": true, "id": "SPC-1",
  "capabilities": ["speak", "sense", "listen"],
  "missing": { "look": "no camera at /dev/video0 (set SPC_CAMERA_DEVICE, or plug one in)" },
  "auth": true }
```

### `GET /look` → 200 `image/jpeg`

A single frame. Two frames are grabbed and the last kept — a USB webcam's first
frame is captured before exposure settles and is routinely black.

### `POST /speak` → 200

```json
{ "text": "your order is ready" }          →  { "spoken": true, "ms": 1840 }
```

**Blocks until the speaker has actually gone quiet.** That's a promise the
contract makes so two replies in a row can't talk over each other in the air —
only the Pi knows when its own audio stopped.

### `GET /sense` → 200

```json
{ "sensors": { "presence": true }, "ts": "2026-08-07T09:14:02Z" }
```

### `POST /listen` → 200 `audio/wav`, or 204

```json
{ "timeout_s": 10, "silence_s": 1.2 }
```

Records until you stop talking or `timeout_s` elapses. **204 means nobody
spoke** — a normal outcome of listening, not an error.

Returns **audio, not text.** Transcription stays on mcp-core, where whisper.cpp
and the Manglish bias prompt already live, so the Pi's mic and a box's mic are
transcribed by the identical model with the identical prompt. Moving STT onto
the Pi would give two devices in one restaurant two different accents' worth of
accuracy, and would strand the Manglish tuning on one of them.

### `POST /display` → 200

```json
{ "expression": "happy",
  "gaze": "center",
  "panel": { "mode": "message", "title": "Welcome!", "subtitle": "How can I help you?" } }
```

Sets what the attached panel shows. All three keys are optional and **anything
left out is left alone** — sending only `expression` changes the eyes without
disturbing a QR code someone is halfway through scanning. `panel`, when given,
replaces the previous panel wholesale, because a panel is one coherent layout
and merging would leave the old mode's fields lying around to be drawn by
accident.

Returns `{"updated": true, "version": 7, "expression": "...", "panel_mode": "..."}`.
The version is a monotonic counter used by the page below.

Panel modes: `message` (`title`, `subtitle`), `qr` (`qr_data` required,
`qr_caption`), `choices` (`title`, `subtitle`, `choices[{id,label,icon}]`),
`order` (`title`, `items[{name,qty,price}]`, `total`, `note`), `blank`.

Choice tiles are **shown, not tappable** — the customer still answers out loud.

### `GET /face` → 200 `text/html`

The page a browser renders full-screen on the panel: the face on top, the panel
below. Self-contained — no CDN, no fonts, no network of any kind, including the
QR encoder, because this Pi may have no route off the tailnet.

Open on the panel:

```bash
chromium --kiosk --noerrdialogs --disable-infobars \
         --disable-session-crashed-bubble http://localhost:8080/face
```

Portrait: `xrandr --output HDMI-1 --rotate left` under X, or append
`video=HDMI-A-1:1080x1920@60,rotate=90` to the kernel command line for a panel
driven straight from DRM with no desktop.

The same URL works from any machine that can reach the Pi, which is how the face
is developed and demoed with no panel attached at all.

### `GET /display/state?v=N` → 200

Long poll. Returns the current state immediately if its `version` differs from
`N`, otherwise holds the request for up to 25 s and answers anyway. That
heartbeat is what tells the page the agent is still alive — the offline dot in
the corner appears when it stops arriving, so a dead service looks different
from an empty panel.

`/face` and `/display/state` are **not** behind `X-Fleet-Token`: a kiosk browser
started by a `.desktop` file has no way to send a header, and neither route
reveals anything that is not already lit up on a screen in the room. `POST
/display` and `GET /display` (which returns the current state as JSON, for
debugging) are behind it as usual.

## Drawing the face without a browser

`GET /face` assumes something can render HTML. On a server image there may be
nothing that can — this OrangePi has no X, no Wayland, and the only chromium and
firefox packages in its repos are snap stubs. So `spc_fb.py` draws the same
screen straight to `/dev/fb0`:

```bash
python3 spc_fb.py            # follows SPC_FB_URL, default http://127.0.0.1:8080
```

No display server, no packages, and **no root** — `/dev/fb0` is `root:video` and
the login user is already in `video`. Text comes from the Terminus PSF console
fonts that ship with `console-setup`. A full repaint is about 75&nbsp;ms, so it
still blinks on its own.

It follows the same `/display/state` long poll the browser page uses, so
`spc_expression` drives whichever renderer is running and the tool never has to
know which one that is.

| Variable | Default | Notes |
|---|---|---|
| `SPC_FB_URL` | `http://127.0.0.1:8080` | Agent to follow |
| `SPC_FB_ROTATE` | `270` | The panel is mounted a quarter turn from the framebuffer's idea of it |
| `SPC_FB_DEVICE` | `/dev/fb0` | |
| `SPC_FB_FONT` | *(largest Terminus found)* | Any `.psf`/`.psf.gz` |

Rotation is done here rather than in the kernel or a compositor on purpose:
everything is composed in portrait content coordinates and mapped on the way
out, so a landscape framebuffer on a portrait panel needs no boot parameters and
no reboot to get right. Content columns become framebuffer rows, which is also
what keeps a pure-Python renderer fast enough to be worth having.

**Not yet drawn:** `mode: "qr"` shows the link as text. The browser page has a
real encoder; an unscannable square would be worse than a readable URL.

Both halves run as **user** units, so they come back after a reboot without root
(lingering is already enabled on this box):

```bash
install -m 644 spc-screen.service spc-face.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now spc-screen.service spc-face.service
```

### Status codes

| Code | Means |
|---|---|
| 204 | Listened, heard nothing. Normal |
| 401 | Wrong or missing `X-Fleet-Token`. The Pi is up — only the secret is wrong |
| 501 | No hardware for this capability. Nothing is broken; the part isn't plugged in. The body names the fix |
| 500 | The hardware was there and the operation failed. Body carries the tool's own stderr |

## Troubleshooting

**`capabilities: NONE`** — nothing is wired up. Run `--help`; it prints a
per-capability reason.

**`arecord failed: Device or resource busy`** — something else holds the mic.
Concurrent `/listen` calls are serialized internally, so this is another process
on the Pi, usually a leftover `arecord`.

**Recordings are always the full timeout** — `sox` isn't installed, so there's
nothing detecting the pause. `apt install sox`.

**Speech comes out of the wrong device** — `aplay -l`, then set
`SPC_SPEAKER_DEVICE`.

**mcp-core says "offline" but `curl` from the Pi works** — check it from the
*mcp-core machine*: `curl http://<host>:8080/health`. Almost always the
Tailscale name, a firewall, or `SPC_HOST` bound to localhost.

**`/face` answers "face page not installed"** — `spc_face.py` has to sit in the
same directory as `spc_agent.py`; Python imports it by module name from beside
the running script. `deploy_spc_agent.sh` copies both.

**`spc_expression` exists in mcp-core but the Pi answers 501** — the config
declares `screen` but the Pi did not detect a panel. Expected before the monitor
is plugged in: set `SPC_SCREEN=1` in the unit and restart.

**The face is frozen** — that is a stopped page, not a stopped service; the
eyes blink and breathe on their own with no traffic at all. Reload the kiosk
tab. The red dot in the corner means the page has lost the agent.
