# spc-agent — the OrangePi half of the fleet

mcp-core drives ESP boxes by pushing to firmware it controls. It can't do that
to a Linux board, so the Pi runs this instead: a small HTTP service that exposes
its microphone, speaker, sensors and camera as five routes.

Anything that answers those five routes is a valid `spc` device. This
implementation is a convenience, not a requirement — swap it for your own agent
and mcp-core won't notice.

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

Copy `spc_agent.py` to the Pi and check what it found:

```bash
python3 spc_agent.py --help     # prints resolved config + detected capabilities
python3 spc_agent.py            # run it
```

Then point mcp-core at it in `config.json`:

```json
"devices": [
  { "id": "SPC-1", "name": "OrangePi", "kind": "spc",
    "base_url": "http://orangepi:8080",
    "capabilities": ["speak", "sense", "listen"] }
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
