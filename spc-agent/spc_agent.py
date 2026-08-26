#!/usr/bin/env python3
"""spc-agent — the OrangePi half of the fleet.

mcp-core drives ESP boxes by pushing to firmware it controls. It cannot do that
to a Linux box, so the Pi runs this instead: a small HTTP service exposing the
Pi's microphone, speaker, sensors and (optionally) camera and screen as a
handful of routes.

Deliberately stdlib-only. Setting up hardware is already the hard part of this
project, and "pip install failed on the Pi" is a genuinely bad place to lose an
afternoon — especially on an Armbian image with a system Python that refuses
non-venv installs. Everything here ships with Python 3. The actual hardware work
is shelled out to the standard Linux tools (arecord, aplay, sox, espeak-ng,
ffmpeg), which are apt-installable and already present on most images.

    python3 spc_agent.py

Configuration is by environment variable — see CONFIG below, or run with
--help for the resolved values on this machine.
"""

import errno
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The kiosk page is ~500 lines of HTML/CSS/SVG/JS and lives in its own module so
# it does not bury this one. Imported defensively: a Pi part-way through a deploy
# (new spc_agent.py, spc_face.py not copied yet) must keep its microphone and
# speaker rather than refuse to start over a screen it may not even have.
try:
    from spc_face import FACE_HTML
except ImportError:
    FACE_HTML = None

# The expression catalog. Imported the same defensive way and for the same
# reason, except that a device without it can still drive its screen — the
# module carries the ten builtins, so the fallback here is the narrower one of
# refusing to validate expressions at all rather than a black panel.
try:
    import spc_expressions
except ImportError:
    spc_expressions = None

# The picker at /faces. Optional in exactly the way the face page is: a device
# part-way through a deploy serves the panel and simply has no picker yet.
try:
    from spc_picker import PICKER_HTML
except ImportError:
    PICKER_HTML = None


def search_dirs_hint():
    """Where a user should put a new expression file, phrased for an error message."""
    dirs = spc_expressions.search_dirs() if spc_expressions else []
    return " or ".join(dirs) if dirs else "the expressions directory"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST = os.environ.get("SPC_HOST", "0.0.0.0")
PORT = int(os.environ.get("SPC_PORT", "8080"))
DEVICE_ID = os.environ.get("SPC_ID", "SPC-1")

# Must match ESP_FLEET_TOKEN on the mcp-core side. Empty disables the check,
# which is fine on a trusted tailnet and reckless anywhere else — this service
# can open the microphone in the room it is sitting in.
FLEET_TOKEN = os.environ.get("SPC_FLEET_TOKEN") or os.environ.get("ESP_FLEET_TOKEN") or ""

# ALSA device names. "default" follows the system default; override when the Pi
# has several cards and the default is the HDMI output nobody is listening to.
# List them with:  arecord -l   and   aplay -l
MIC_DEVICE = os.environ.get("SPC_MIC_DEVICE", "default")
SPEAKER_DEVICE = os.environ.get("SPC_SPEAKER_DEVICE", "default")

# Playback volume, as an amixer simple-control name plus the card holding it.
#
# Opt-in rather than guessed, because "which control is the volume" has no
# reliable answer across boards: one Pi's is 'PCM', another's 'Master', and a
# USB device whose firmware exposes no mixer at all (the ReSpeaker Lite) has
# none until an ALSA softvol plugin invents one. Unset = no `volume` capability
# and /volume answers 501, which is honest; a wrong guess would instead return
# 200 while moving a control nobody is listening through.
#
# NOTE amixer strips a trailing " Volume" from the control name, so a softvol
# declared as `control { name "SPC Volume" }` is addressed here as "SPC".
VOLUME_CONTROL = os.environ.get("SPC_VOLUME_CONTROL", "")
VOLUME_CARD = os.environ.get("SPC_VOLUME_CARD", "")

# Where the level is remembered across restarts. A softvol control does not
# exist until its PCM is first opened, so it comes back at 100% every boot —
# loud enough to be alarming in a room. The agent re-applies this on startup.
VOLUME_STATE = os.environ.get(
    "SPC_VOLUME_STATE",
    os.path.join(os.path.expanduser("~"), ".spc_volume"),
)

# What to use when nothing has been remembered yet — a fresh install, or a
# state file that was deleted. Not 100: the first thing a new box ever says
# should not be the loudest thing it can say.
VOLUME_DEFAULT = int(os.environ.get("SPC_VOLUME_DEFAULT", "65"))

# Video4Linux node for the camera. Absent = no camera = /look returns 501 and
# mcp-core is told not to expose spc_look.
CAMERA_DEVICE = os.environ.get("SPC_CAMERA_DEVICE", "/dev/video0")

# How to read that node.
#
#   ffmpeg    a normal webcam that yields a decodable format. The default.
#   v4l2raw   a MIPI sensor whose ISP path does not work, so the only node that
#             produces frames hands over raw Bayer that ffmpeg cannot read.
#
# The second is not exotic: it is the OrangePi 5 Max's own OV13855 kit. Its ISP
# path needs an rkaiq 3A daemon that does not exist in these repos, so the ISP
# node accepts a stream request and then times out with a 0-byte file, while
# /dev/video11 quietly delivers 10-bit Bayer. mcp-core solved this once in
# vision.js; this is the same solution on the agent side, so a Pi whose camera
# is not on the mcp-core machine still answers /look.
CAMERA_BACKEND = os.environ.get("SPC_CAMERA_BACKEND", "ffmpeg")
CAMERA_WIDTH = int(os.environ.get("SPC_CAMERA_WIDTH", "4224"))
CAMERA_HEIGHT = int(os.environ.get("SPC_CAMERA_HEIGHT", "3136"))
CAMERA_RAW_FORMAT = os.environ.get("SPC_CAMERA_RAW_FORMAT", "BG10")
# MUST be even, and is fastest as a multiple of 4. A Bayer mosaic repeats every
# 2 pixels, so an odd step alternates colour planes and produces a checkerboard
# that reads as texture — which defeats exactly the QR finder patterns this is
# most often pointed at.
CAMERA_RAW_DOWNSAMPLE = int(os.environ.get("SPC_CAMERA_RAW_DOWNSAMPLE", "4"))
CAMERA_RAW_WARMUP = int(os.environ.get("SPC_CAMERA_RAW_WARMUP", "2"))

RAW10_PIXELS_PER_GROUP = 4
RAW10_BYTES_PER_GROUP = 5

# Recording format. 16kHz mono 16-bit is what whisper.cpp wants; sending
# anything else just makes mcp-core resample it.
SAMPLE_RATE = 16000

# Sensors. Two independent mechanisms, because "what is plugged into the Pi" is
# not something this file can know:
#
#   SPC_SENSE_CMD    a command printing a JSON object of readings on stdout.
#                    This is the general escape hatch — any sensor, any library,
#                    any language. Its keys are passed through to the model
#                    untouched, so name them for a reader ("presence", not "d7").
#   SPC_PRESENCE_GPIO  a sysfs GPIO number read as a presence bit. Covers the
#                    common PIR/mmWave case with no extra script to write.
#
# Both may be set; the command's keys win on a collision, since someone who
# wrote a script had a more specific intent than someone who set a pin number.
SENSE_CMD = os.environ.get("SPC_SENSE_CMD", "")
PRESENCE_GPIO = os.environ.get("SPC_PRESENCE_GPIO", "")

# Text-to-speech. espeak-ng is the fallback because it is in every apt repo and
# needs no model download; it also sounds like a robot from 1985. Point
# SPC_TTS_CMD at piper (or anything else) for a real voice — the text is passed
# on stdin and the command must write a WAV to the path in {out}.
TTS_CMD = os.environ.get("SPC_TTS_CMD", "")

# The panel. Unlike a camera or a mic there is no reliable "is a screen plugged
# in" test — a Pi with HDMI unplugged still has /dev/dri/card0, and a panel on
# SPI/DSI may present as neither. So detection is a best guess and SPC_SCREEN is
# the override that always wins, in both directions: "1" forces the capability
# on (which is how you develop the face before the panel arrives), "0" forces it
# off.
SCREEN_ENV = os.environ.get("SPC_SCREEN", "")

# ---------------------------------------------------------------------------
# Runtime settings
# ---------------------------------------------------------------------------
# The knobs mcp-core can change without anyone touching this Pi. Everything
# above is environment: it describes what hardware this box HAS, is decided when
# the service is installed, and changing it means editing a systemd unit. What
# follows is behaviour: how long to allow, how long to listen, when to give up —
# the numbers that depend on the room and the queue, and that someone standing
# at the counter has a real reason to want changed right now.
#
# Pushed by mcp-core (PATCH /settings) and persisted, so a reboot does not
# silently revert to defaults while the server still reports the tuned values.
# The authoritative catalog — names, ranges, meanings — is
# mcp-core/settings-spec.json; these are the fallbacks for a Pi that has never
# been pushed to, and they are the values this file had as constants before any
# of this existed.
# In the service user's home, NOT next to this script — same choice, and the
# same reason, as VOLUME_STATE above. deploy_spc_agent.sh installs to
# /opt/spc-agent as root and runs the unit as an ordinary user, so a file beside
# the script would fail to write. That failure is handled (it warns and stays in
# memory), but the result would be tuning that silently reverts on every reboot
# while mcp-core keeps reporting the value someone set — the exact "changed and
# didn't" failure this whole mechanism exists to avoid.
SETTINGS_PATH = os.environ.get(
    "SPC_SETTINGS_FILE",
    os.path.join(os.path.expanduser("~"), ".spc_settings.json"),
)

SETTING_DEFAULTS = {
    "spc.look_timeout_s": 15,
    "spc.speak_timeout_s": 55,
    "spc.sense_timeout_s": 5,
    "spc.volume_timeout_s": 5,
    "spc.listen_silence_s": 1.2,
    "spc.listen_timeout_s": 12,
}

# Clamped independently of the server, and wider than the server's ranges, for
# the same reason the firmware clamps: this side has to stay usable even if the
# push came from something that miscalculated, and a 0-second speak timeout
# would kill every sentence mid-word with no way to fix it but SSH.
SETTING_BOUNDS = {
    "spc.look_timeout_s": (1, 300),
    "spc.speak_timeout_s": (1, 600),
    "spc.sense_timeout_s": (1, 120),
    "spc.volume_timeout_s": (1, 120),
    "spc.listen_silence_s": (0.1, 30),
    "spc.listen_timeout_s": (1, 300),
}

SETTINGS = dict(SETTING_DEFAULTS)
SETTINGS_REVISION = 0
SETTINGS_LOCK = threading.Lock()


def settings_load():
    """Restore pushed settings at startup. A missing or unreadable file means
    defaults, never a failure to start: a service that refuses to boot because a
    tuning file got truncated has turned a cosmetic problem into an outage."""
    global SETTINGS, SETTINGS_REVISION
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as fh:
            saved = json.load(fh)
    except FileNotFoundError:
        return
    except Exception as err:
        print(f"[settings] {SETTINGS_PATH} unreadable ({err}) — using defaults", flush=True)
        return
    values = saved.get("settings", saved) if isinstance(saved, dict) else {}
    merged = dict(SETTING_DEFAULTS)
    for key, val in (values or {}).items():
        # Unknown keys are dropped rather than kept: they come from a newer
        # mcp-core, this build has no code that reads them, and holding them
        # would only make /settings advertise knobs that do nothing.
        if key in SETTING_DEFAULTS:
            merged[key] = _clamp_setting(key, val, merged[key])
    SETTINGS = merged
    SETTINGS_REVISION = int(saved.get("revision", 0) or 0) if isinstance(saved, dict) else 0
    print(f"[settings] rev {SETTINGS_REVISION} loaded from {SETTINGS_PATH}", flush=True)


def _clamp_setting(key, raw, fallback):
    lo, hi = SETTING_BOUNDS[key]
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return fallback
    val = max(lo, min(hi, val))
    # Ints stay ints so `-d 12` on the arecord command line does not become
    # `-d 12.0`, which arecord rejects.
    return int(val) if isinstance(SETTING_DEFAULTS[key], int) else val


def settings_apply(values, revision):
    """Merge a push and persist it. Returns the keys that actually changed."""
    global SETTINGS, SETTINGS_REVISION
    changed = []
    with SETTINGS_LOCK:
        merged = dict(SETTINGS)
        for key, val in (values or {}).items():
            if key not in SETTING_DEFAULTS:
                continue
            new = _clamp_setting(key, val, merged[key])
            if new != merged[key]:
                merged[key] = new
                changed.append(key)
        SETTINGS = merged
        SETTINGS_REVISION = int(revision or 0)
        try:
            tmp = SETTINGS_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"revision": SETTINGS_REVISION, "settings": SETTINGS}, fh, indent=2)
            os.replace(tmp, SETTINGS_PATH)
        except Exception as err:
            # Live but not durable. Said out loud rather than swallowed, because
            # the failure is invisible until the next reboot quietly reverts.
            print(f"[settings] could not save to {SETTINGS_PATH} ({err}) — "
                  f"applied in memory only, will revert on restart", flush=True)
    if changed:
        print(f"[settings] rev {SETTINGS_REVISION} applied: "
              + ", ".join(f"{k}={SETTINGS[k]}" for k in changed), flush=True)
    return changed


def setting(key):
    return SETTINGS.get(key, SETTING_DEFAULTS[key])


# The per-command kill timeouts, read through the settings so a change lands on
# the next command with no restart. Kept as a function rather than the old dict
# so every call site stayed a one-word edit.
def timeout_for(kind):
    return setting(f"spc.{kind}_timeout_s")


def have(binary):
    return shutil.which(binary) is not None


def have_screen():
    """Whether this Pi should claim the `screen` capability.

    SPC_SCREEN wins outright when set, because the guess below is genuinely
    unreliable and being wrong in either direction is annoying: a declared-but-
    absent screen registers a tool that draws to nothing, and an undeclared-but-
    present one leaves the face unreachable with no obvious reason why.
    """
    if SCREEN_ENV:
        return SCREEN_ENV.strip().lower() not in ("0", "false", "no", "off")
    return bool(glob.glob("/dev/dri/card*")) or os.path.exists("/dev/fb0")


# ---------------------------------------------------------------------------
# Capability detection
# ---------------------------------------------------------------------------

def camera_ready():
    """Whether /look can actually produce a frame — not just whether a node exists.

    The distinction matters: the old check passed on this board (node present,
    ffmpeg installed) while every /look returned HTTP 500, because ffmpeg cannot
    read the raw Bayer node. A capability that is advertised but cannot work is
    worse than one that is absent, since mcp-core registers a tool for it.
    """
    if not os.path.exists(CAMERA_DEVICE):
        return False
    if CAMERA_BACKEND == "v4l2raw":
        if not (have("v4l2-ctl") and have("ffmpeg")):
            return False
    elif not (have("ffmpeg") or have("fswebcam")):
        return False

    # The node existing is not the same as the sensor being there. On a MIPI
    # board every /dev/videoN is created whether or not a camera is attached, so
    # a dead or unseated sensor still passes an exists() check and /look then
    # fails with "No such device". Opening it costs nothing and is the cheapest
    # question that distinguishes the two.
    try:
        fd = os.open(CAMERA_DEVICE, os.O_RDWR | os.O_NONBLOCK)
    except OSError as err:
        # EBUSY means something else is streaming from it — which proves it
        # works, so that one counts as ready.
        return getattr(err, "errno", None) == errno.EBUSY
    os.close(fd)
    return True


def capabilities():
    """What this Pi can actually do, right now.

    Recomputed per /health call rather than cached at startup, so plugging a USB
    webcam in is visible without restarting the service. mcp-core does not use
    this to decide which tools to register (its config does that, deliberately)
    — it compares the two and warns when they disagree, which is the only way a
    mismatch ever gets noticed before a tool fails in front of a customer.
    """
    caps = []
    if camera_ready():
        caps.append("look")
    if have("aplay") and (TTS_CMD or have("espeak-ng") or have("espeak")):
        caps.append("speak")
    if SENSE_CMD or PRESENCE_GPIO:
        caps.append("sense")
    if have("arecord") or have("rec"):
        caps.append("listen")
    if have_screen():
        caps.append("screen")
    if VOLUME_CONTROL and have("amixer"):
        caps.append("volume")
    return caps


def missing_reason(cap):
    """Why a capability is absent, in terms of the thing to install or plug in."""
    if cap == "look":
        if not os.path.exists(CAMERA_DEVICE):
            return f"no camera at {CAMERA_DEVICE} (set SPC_CAMERA_DEVICE, or plug one in)"
        if CAMERA_BACKEND == "v4l2raw" and not have("v4l2-ctl"):
            return "no v4l2-ctl, which is what reads a raw MIPI camera (apt install v4l-utils)"
        if not (have("ffmpeg") or have("fswebcam")):
            return "no ffmpeg or fswebcam installed (apt install ffmpeg)"
        return (f"{CAMERA_DEVICE} exists but will not open — on a MIPI board that means the "
                f"sensor was not detected at boot. Check: dmesg | grep -i ov13855. A ribbon "
                f"that is not fully seated does exactly this; re-seat both ends and reboot")
    if cap == "speak":
        if not have("aplay"):
            return "no aplay (apt install alsa-utils)"
        return "no text-to-speech (apt install espeak-ng, or set SPC_TTS_CMD)"
    if cap == "sense":
        return "no sensors configured (set SPC_SENSE_CMD or SPC_PRESENCE_GPIO)"
    if cap == "listen":
        return "no arecord (apt install alsa-utils)"
    if cap == "screen":
        return "no display detected (/dev/dri/card*, /dev/fb0) — set SPC_SCREEN=1 if a panel is attached"
    if cap == "volume":
        if not have("amixer"):
            return "no amixer (apt install alsa-utils)"
        return ("no volume control configured (set SPC_VOLUME_CONTROL, and SPC_VOLUME_CARD if it "
                "is not on the default card). A USB device whose firmware exposes no mixer needs "
                "an ALSA softvol plugin in ~/.asoundrc to have a control at all")
    return "not available"


# ---------------------------------------------------------------------------
# Hardware
# ---------------------------------------------------------------------------

def run(cmd, timeout, stdin=None):
    """Run a command, raising with its stderr attached.

    stderr matters more than usual here: ALSA and ffmpeg put the entire
    diagnosis in it ("Device or resource busy", "No such file or directory"),
    and a bare non-zero exit code sent back to a model is unactionable.
    """
    try:
        proc = subprocess.run(
            cmd, input=stdin, capture_output=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{cmd[0]} did not finish within {timeout}s")
    except FileNotFoundError:
        raise RuntimeError(f"{cmd[0]} is not installed on this Pi")
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise RuntimeError(f"{cmd[0]} failed: {err.splitlines()[-1] if err else 'exit ' + str(proc.returncode)}")
    return proc.stdout


# -- volume -----------------------------------------------------------------
#
# Shelled out to amixer for the same reason everything else here is: it is the
# one interface that behaves identically on every board, and it needs no pip.

def _amixer(*args):
    cmd = ["amixer"]
    if VOLUME_CARD:
        cmd += ["-c", VOLUME_CARD]
    return run(cmd + list(args), timeout_for("volume")).decode("utf-8", "replace")


def volume_get():
    """Current playback level, 0-100.

    amixer prints per-channel lines like `Front Left: 153 [60%] [-20.40dB]`, or
    `Mono: Playback 153 [60%]` on a mono control. The first percentage is the
    answer in both shapes.
    """
    out = _amixer("sget", VOLUME_CONTROL)
    match = re.search(r"\[(\d{1,3})%\]", out)
    if not match:
        raise RuntimeError(
            f"could not read a level from control {VOLUME_CONTROL!r} — "
            f"amixer said: {out.strip().splitlines()[-1] if out.strip() else '(nothing)'}"
        )
    return int(match.group(1))


def volume_set(level):
    """Set the level, 0-100, and return what it actually became.

    Reads back rather than echoing the request: a softvol has 256 steps, so the
    stored value is the nearest one and can differ by a percent from what was
    asked for. Returning the request would make the web UI and the hardware
    disagree by a hair forever.
    """
    level = max(0, min(100, int(level)))
    _amixer("sset", VOLUME_CONTROL, f"{level}%")
    actual = volume_get()
    try:
        with open(VOLUME_STATE, "w") as fh:
            fh.write(str(actual))
    except OSError as err:
        # Losing the level across a reboot is not worth failing a call that
        # already worked — the sound did change.
        print(f"spc-agent: could not persist volume to {VOLUME_STATE}: {err}", flush=True)
    return actual


def volume_restore():
    """Apply the remembered level at startup, or the default if there is none.

    Best effort by design — see the except below.
    """
    if not VOLUME_CONTROL:
        return
    try:
        with open(VOLUME_STATE) as fh:
            saved = int(fh.read().strip())
        source = "restored"
    except (OSError, ValueError):
        # No state yet, or it was corrupted. Falling through to the default
        # rather than returning is the point: leaving an uninitialised softvol
        # alone means leaving it at 100%.
        saved = VOLUME_DEFAULT
        source = "set to default"
    try:
        print(f"spc-agent: volume {source} {volume_set(saved)}%", flush=True)
    except Exception as err:
        # The usual cause is a softvol whose PCM has not been opened yet, so the
        # control does not exist. Say so instead of dying before the HTTP server
        # is even up — every other capability still works.
        print(f"spc-agent: could not restore volume ({err})", flush=True)


def playback_devices():
    """Every ALSA playback device, as reported by `aplay -l`.

    Exposed through /health because "aplay exited 0" is NOT evidence anyone
    heard anything — ALSA will cheerfully render audio into an HDMI port with
    no cable in it, and the exit code is still 0. On a board like the OrangePi
    5 Max the default sink is usually HDMI, so the honest default assumption is
    that speak() is silent until a human confirms otherwise. Listing the sinks
    is the only way to diagnose that from the other end of the network.
    """
    if not have("aplay"):
        return []
    try:
        out = run(["aplay", "-l"], 5).decode("utf-8", "replace")
    except Exception:
        return []
    devices = []
    for line in out.splitlines():
        if line.startswith("card "):
            # "card 0: rockchiphdmi0 [rockchip-hdmi0], device 0: ..."
            try:
                card = line.split("card ")[1].split(":")[0].strip()
                dev = line.split("device ")[1].split(":")[0].strip()
                label = line.split("[", 1)[1].split("]")[0] if "[" in line else line
                devices.append({"id": f"hw:{card},{dev}", "name": label,
                                "likely_hdmi": "hdmi" in line.lower()})
            except (IndexError, ValueError):
                continue
    return devices


def capture_raw_gray():
    """One frame off a raw-Bayer MIPI node, unpacked to 8-bit greyscale.

    Returns (bytes, width, height). Colour is discarded on purpose: this camera
    exists to read QR codes and see what is on the counter, and demosaicing in
    pure Python would cost far more than it is worth.
    """
    out = run([
        "v4l2-ctl", "-d", CAMERA_DEVICE,
        f"--set-fmt-video=width={CAMERA_WIDTH},height={CAMERA_HEIGHT},"
        f"pixelformat={CAMERA_RAW_FORMAT}",
        "--stream-mmap=3", "--stream-to=-",
        f"--stream-count={CAMERA_RAW_WARMUP}",
    ], timeout_for("look"))

    if not out:
        raise RuntimeError(
            f"{CAMERA_DEVICE} produced no data. On this board that usually means the "
            f"sensor was not detected at boot — check dmesg for 'Unexpected sensor id'."
        )
    if len(out) % CAMERA_RAW_WARMUP != 0:
        raise RuntimeError(f"camera returned {len(out)} bytes, not divisible into "
                           f"{CAMERA_RAW_WARMUP} frames")
    frame_bytes = len(out) // CAMERA_RAW_WARMUP

    # Derive the stride from what actually arrived rather than from a formula.
    # The hardware pads rows to an alignment boundary — 4224 RAW10 pixels is
    # 5280 bytes but lands as 5376 — and getting it wrong does not raise, it
    # shears the picture diagonally and silently decodes nothing.
    stride, rem = divmod(frame_bytes, CAMERA_HEIGHT)
    if rem:
        raise RuntimeError(f"frame of {frame_bytes} bytes does not divide by height "
                           f"{CAMERA_HEIGHT} — check SPC_CAMERA_HEIGHT")
    min_stride = -(-CAMERA_WIDTH * RAW10_BYTES_PER_GROUP // RAW10_PIXELS_PER_GROUP)
    if stride < min_stride:
        raise RuntimeError(f"stride {stride} is too small for {CAMERA_WIDTH} RAW10 pixels "
                           f"(need {min_stride}) — check SPC_CAMERA_WIDTH")

    step = max(2, CAMERA_RAW_DOWNSAMPLE)
    if step % 2:
        step += 1                                  # odd steps cross Bayer planes
    # Keep the LAST frame: the first one after stream start is still settling.
    base = len(out) - frame_bytes
    out_w = CAMERA_WIDTH // step
    out_h = CAMERA_HEIGHT // step
    gray = bytearray()

    # In RAW10, 4 pixels share 5 bytes and the first 4 are their high bytes, so
    # pixel x lives at (x//4)*5 + (x%4). When step is a multiple of 4 that lands
    # on a fixed byte stride, and the whole row becomes one slice — which is the
    # difference between milliseconds and half a minute in pure Python.
    if step % RAW10_PIXELS_PER_GROUP == 0:
        byte_step = (step // RAW10_PIXELS_PER_GROUP) * RAW10_BYTES_PER_GROUP
        for oy in range(out_h):
            row = base + oy * step * stride
            gray += out[row : row + out_w * byte_step : byte_step]
    else:
        for oy in range(out_h):
            row = base + oy * step * stride
            for ox in range(out_w):
                x = ox * step
                gray.append(out[row + (x // RAW10_PIXELS_PER_GROUP) * RAW10_BYTES_PER_GROUP
                                + (x % RAW10_PIXELS_PER_GROUP)])

    if len(gray) != out_w * out_h:
        raise RuntimeError(f"unpacked {len(gray)} bytes, expected {out_w * out_h}")
    return bytes(gray), out_w, out_h


def encode_jpeg(gray, width, height):
    """Greyscale bytes -> JPEG. ffmpeg only ever encodes here; it never captures."""
    return run([
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{width}x{height}",
        "-i", "-", "-frames:v", "1", "-f", "mjpeg", "-"
    ], timeout_for("look"), stdin=gray)


def capture_jpeg():
    # A sensor with no working ISP path never reaches ffmpeg's v4l2 input at all,
    # so the backend is chosen before anything else happens.
    if CAMERA_BACKEND == "v4l2raw":
        gray, w, h = capture_raw_gray()
        return encode_jpeg(gray, w, h)

    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "frame.jpg")
        if have("ffmpeg"):
            # -vframes 2 then keeping the last: a USB webcam's first frame is
            # captured before exposure settles and is routinely black. The ESP
            # side discards 12 frames for the same reason; two is enough here
            # because v4l2 does not have avfoundation's warm-up problem.
            run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-f", "v4l2", "-i", CAMERA_DEVICE,
                 "-vframes", "2", "-q:v", "3", out], timeout_for("look"))
        else:
            run(["fswebcam", "-d", CAMERA_DEVICE, "--no-banner", "-q", out], timeout_for("look"))
        with open(out, "rb") as fh:
            return fh.read()


def speak(text):
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "say.wav")
        if TTS_CMD:
            cmd = [part.replace("{out}", wav) for part in TTS_CMD.split()]
            run(cmd, timeout_for("speak"), stdin=text.encode("utf-8"))
        else:
            engine = "espeak-ng" if have("espeak-ng") else "espeak"
            run([engine, "-w", wav, text], timeout_for("speak"))
        # Blocks until the speaker has finished. mcp-core's contract promises
        # this, so that two replies in a row cannot overlap in the air.
        run(["aplay", "-D", SPEAKER_DEVICE, "-q", wav], timeout_for("speak"))
        # Returned so the caller learns WHERE the sound went. A bare
        # {"spoken": true} is close to worthless here: it is equally consistent
        # with a speaker in the room and with an HDMI port nobody is plugged
        # into, and the difference is the whole question when someone says they
        # heard nothing.
        return SPEAKER_DEVICE


def read_gpio(number):
    """Read one sysfs GPIO, exporting it first if needed.

    Returns None rather than False on any failure. A sensor that could not be
    read is UNKNOWN, and reporting that as "nobody is there" would have the
    model confidently narrate an empty room it cannot actually see.
    """
    base = f"/sys/class/gpio/gpio{number}"
    try:
        if not os.path.exists(base):
            with open("/sys/class/gpio/export", "w") as fh:
                fh.write(str(number))
            time.sleep(0.1)   # udev needs a moment to create the node
        with open(f"{base}/value") as fh:
            return fh.read().strip() == "1"
    except Exception:
        return None


def sense():
    sensors = {}
    if PRESENCE_GPIO:
        sensors["presence"] = read_gpio(PRESENCE_GPIO)
    if SENSE_CMD:
        try:
            out = run(SENSE_CMD.split(), timeout_for("sense"))
            parsed = json.loads(out.decode("utf-8", "replace"))
            if isinstance(parsed, dict):
                sensors.update(parsed)
            else:
                sensors["_error"] = "SPC_SENSE_CMD printed JSON that is not an object"
        except json.JSONDecodeError:
            sensors["_error"] = "SPC_SENSE_CMD did not print valid JSON"
        except Exception as err:
            # One broken sensor script must not take out a working GPIO reading
            # alongside it, so this is reported as a field rather than raised.
            sensors["_error"] = str(err)
    return sensors


# Only one recording at a time. Two concurrent arecords on one card fail with a
# busy error that reads like a hardware fault; serializing turns that into a
# short wait, which is what the caller actually wanted.
_mic_lock = threading.Lock()


def listen(timeout_s, silence_s):
    """Record until the speaker stops, or timeout_s elapses. WAV bytes or None.

    Returns audio, NOT text. Transcription belongs to mcp-core, where the
    whisper model and the Manglish bias prompt already live — see the comment on
    device.listen() in mcp-core/spc.js.
    """
    with _mic_lock:
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "in.wav")
            run(["arecord", "-D", MIC_DEVICE, "-f", "S16_LE", "-r", str(SAMPLE_RATE),
                 "-c", "1", "-d", str(int(timeout_s)), "-q", raw], timeout_s + 10)

            # sox trims leading silence and stops at the first trailing pause,
            # so a two-word answer returns in two seconds instead of always
            # burning the full timeout. Without sox the recording still works,
            # it just always runs the full duration.
            if not have("sox"):
                with open(raw, "rb") as fh:
                    return fh.read() or None
            trimmed = os.path.join(tmp, "trim.wav")
            try:
                run(["sox", raw, trimmed,
                     "silence", "1", "0.1", "1%", "1", str(silence_s), "1%"],
                    15)
            except RuntimeError:
                # sox refuses a recording that is silence end to end. That is
                # the "nobody spoke" case, and it is a normal outcome.
                return None
            if not os.path.exists(trimmed) or os.path.getsize(trimmed) <= 44:
                return None
            with open(trimmed, "rb") as fh:
                return fh.read()


# ---------------------------------------------------------------------------
# Screen
# ---------------------------------------------------------------------------
#
# The panel is the one piece of hardware this file does not drive directly. It
# holds a state object; a browser in kiosk mode renders it (GET /face) and
# follows changes (GET /display/state). That split is what lets the whole face
# be built and demoed with no monitor attached — the same page opens on a
# laptop — and it means the drawing code is CSS and SVG rather than a framebuffer
# library this stdlib-only service is in no position to import.
#
# The state is deliberately last-write-wins with a per-key merge: a caller that
# sends only an expression must not blank the QR code someone is mid-scan of.

# ---------------------------------------------------------------------------
# What this screen can spell
# ---------------------------------------------------------------------------
# A panel renders whatever text it is handed, and any character it has no glyph
# for comes out as '?'. That is the right fallback — a readable question mark
# beats a blank — but it happens silently, so a model can write a Chinese menu
# item, get updated:true back, and never learn that the customer is looking at
# "?? ??". The glyph table is the one thing the device knows and mcp-core cannot
# guess, so the device is what has to say it.
#
# Coverage here describes the FRAMEBUFFER renderer (spc_fb.py), which is what is
# physically on the glass of both boards. A browser pointed at /face uses the
# system's own fonts and will usually draw more than this reports; that is a
# better-than-promised direction, and not worth a second, differently-wrong
# number.
try:
    from cjk_font_data import GLYPHS as _CJK_GLYPHS
    CJK_CODEPOINTS = frozenset(cp for cp, _ in _CJK_GLYPHS)
except ImportError:
    # gen_fb_cjk_font.py has not been run, or its output is not beside this
    # file. Latin still draws; Chinese becomes '?'. Reported honestly as zero
    # rather than assumed, because assuming coverage is how the silent failure
    # above happens in the first place.
    CJK_CODEPOINTS = frozenset()

# The PSF console font spc_fb.py loads covers the low codepoints — 256 glyphs on
# the fonts shipped for this, sometimes 512. Anything below this is treated as
# drawable without inspecting the font file, which the agent does not load.
# Erring low: a character wrongly called drawable is the failure that matters.
CONSOLE_FONT_LIMIT = 0x100


def undrawable(text):
    """The distinct characters in `text` this screen has no glyph for.

    Returned in the order first seen, so a caller reading the message left to
    right meets them in the order they appear in their own string.
    """
    seen, out = set(), []
    for ch in text or "":
        cp = ord(ch)
        if cp < CONSOLE_FONT_LIMIT or cp in CJK_CODEPOINTS:
            continue
        if ch in seen:
            continue
        seen.add(ch)
        out.append(ch)
    return out


def panel_text(panel):
    """Every string a panel will actually put on the glass.

    Walks the whole structure rather than naming fields, because the modes carry
    different keys and a new one must not quietly escape the coverage check.
    Keys are skipped: qr_data is encoded, not drawn, and mode names are ours.
    """
    SKIP = {"mode", "qr_data", "id", "icon"}
    out = []

    def walk(node, key=None):
        if isinstance(node, str):
            if key not in SKIP:
                out.append(node)
        elif isinstance(node, dict):
            for k, v in node.items():
                walk(v, k)
        elif isinstance(node, list):
            for v in node:
                walk(v, key)

    walk(panel or {})
    return out


def text_coverage():
    """What this screen can spell, for /health."""
    return {
        "cjk_glyphs": len(CJK_CODEPOINTS),
        "latin": True,
        "renderer": "framebuffer",
        "note": (
            "Characters outside this set render as '?'. cjk_glyphs is a curated "
            "subset, not all of Unicode CJK — send text through /display and read "
            "`undrawable` in the reply to know about a specific string."
            if CJK_CODEPOINTS else
            "No CJK glyph table on this device — Chinese and other non-Latin text "
            "renders as '?'. Run gen_fb_cjk_font.py and deploy cjk_font_data.py "
            "beside spc_fb.py to fix."
        ),
    }


PANEL_MODES = ("message", "qr", "choices", "order", "blank")

GAZES = ("center", "left", "right", "up", "down")

# The expressions this device can draw are JSON files now, not a tuple here.
# spc_expressions.py finds them, falls back to its own ten builtins when the
# directory is missing, and reports what it could not parse instead of raising —
# one malformed file a user just wrote must not stop the agent from booting.
#
# CATALOG is swapped wholesale on reload rather than mutated, so a request that
# is mid-validation keeps reading a consistent set.
CATALOG = spc_expressions.load() if spc_expressions else None
CATALOG_VERSION = 0
CATALOG_LOCK = threading.Lock()

for _problem in (CATALOG.problems if CATALOG else
                 ["spc_expressions.py is not installed beside spc_agent.py — "
                  "expression names cannot be validated and /expressions is unavailable. "
                  "Copy it over; the screen itself still works."]):
    print(f"expression problem: {_problem}", flush=True)


def expressions_reload():
    """Re-scan the expression directories. Returns the new catalog.

    Bumps the screen version too, which is what pushes the change out to both
    renderers: they are already long-polling /display/state, so a face added on
    a wall-mounted panel appears without anyone restarting anything.
    """
    global CATALOG, CATALOG_VERSION
    if spc_expressions is None:
        raise RuntimeError("spc_expressions.py is not installed beside spc_agent.py")
    catalog = spc_expressions.load()
    with CATALOG_LOCK:
        CATALOG = catalog
        CATALOG_VERSION += 1
    for problem in catalog.problems:
        print(f"expression problem: {problem}", flush=True)
    with SCREEN_COND:
        SCREEN["version"] += 1
        SCREEN["expressions_version"] = CATALOG_VERSION
        SCREEN["ts"] = time.time()
        SCREEN_COND.notify_all()
    return catalog

SCREEN = {
    "expression": "neutral",
    "gaze": "center",
    "panel": {"mode": "blank"},
    # Monotonic, never reset. The page passes the version it last drew back in
    # its poll, so a page that reconnects after a nap redraws exactly once, and
    # a page that missed three updates while unplugged skips straight to the
    # current one instead of replaying them.
    "version": 0,
    # Which generation of the expression directory the renderers should be
    # drawing from. Separate from `version` because the two change for different
    # reasons: `version` says the face changed, this says the vocabulary did.
    "expressions_version": 0,
    "ts": 0.0,
}

# A Condition rather than a Lock: the state route parks readers here until
# something changes, so an update reaches the panel in milliseconds without the
# page polling in a hot loop.
SCREEN_COND = threading.Condition()


def screen_snapshot():
    with SCREEN_COND:
        return json.loads(json.dumps(SCREEN))


def screen_update(patch):
    """Merge a patch into the screen state and wake every waiting page.

    Returns the new state. Raises ValueError with a message meant for a language
    model — these come back through mcp-core as the tool's error text.
    """
    expression = patch.get("expression")
    gaze = patch.get("gaze")
    panel = patch.get("panel")

    if expression is not None and CATALOG is not None and expression not in CATALOG:
        raise ValueError(
            f"unknown expression '{expression}' — this device draws: "
            f"{', '.join(CATALOG.names())}. Add one by dropping a JSON file in "
            f"{search_dirs_hint()} and calling POST /expressions/reload."
        )
    if gaze is not None and gaze not in GAZES:
        raise ValueError(f"unknown gaze '{gaze}' — use one of: {', '.join(GAZES)}")
    if panel is not None:
        if not isinstance(panel, dict):
            raise ValueError("panel must be an object")
        mode = panel.get("mode")
        if mode not in PANEL_MODES:
            raise ValueError(f"unknown panel mode '{mode}' — use one of: {', '.join(PANEL_MODES)}")
        if mode == "qr" and not (panel.get("qr_data") or "").strip():
            raise ValueError("panel mode 'qr' needs qr_data — there is nothing to encode")

    with SCREEN_COND:
        if expression is not None:
            SCREEN["expression"] = expression
        if gaze is not None:
            SCREEN["gaze"] = gaze
        if panel is not None:
            # Replaced wholesale, not merged: a panel is one coherent layout, and
            # merging would leave the previous mode's fields lying around to be
            # rendered by accident.
            SCREEN["panel"] = panel
        SCREEN["version"] += 1
        SCREEN["expressions_version"] = CATALOG_VERSION
        SCREEN["ts"] = time.time()
        SCREEN_COND.notify_all()
        return json.loads(json.dumps(SCREEN))


def screen_wait(since, timeout_s):
    """Current state, once it differs from `since`. Long-poll for the page.

    Returns the state either way when the timeout expires — an unchanged answer
    is how the page confirms the agent is still alive, which is what drives the
    offline indicator.
    """
    deadline = time.monotonic() + timeout_s
    with SCREEN_COND:
        while SCREEN["version"] == since:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            SCREEN_COND.wait(remaining)
        return json.loads(json.dumps(SCREEN))


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "spc-agent/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}", flush=True)

    # -- helpers ------------------------------------------------------------

    def _send(self, code, body=b"", content_type="application/octet-stream", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, code, obj, headers=None):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json", headers)

    def _authorized(self):
        if not FLEET_TOKEN:
            return True
        return self.headers.get("X-Fleet-Token") == FLEET_TOKEN

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return {}

    def _require(self, cap):
        """501 when the hardware is absent. Distinct from 500 on purpose: the
        service is healthy, the part is simply not there, and the message says
        which package or plug fixes it."""
        if cap in capabilities():
            return True
        self._json(501, {"error": f"this Pi cannot '{cap}' — {missing_reason(cap)}"})
        return False

    # -- routes -------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?")[0]
        # /health stays open even with a token configured: it reports no
        # readings and no room contents, and locking it means the first thing
        # you reach for when debugging auth is itself behind auth.
        if path == "/health":
            caps = capabilities()
            return self._json(200, {
                "ok": True,
                "id": DEVICE_ID,
                "capabilities": caps,
                "missing": {c: missing_reason(c) for c in ("look", "speak", "sense", "listen", "screen", "volume") if c not in caps},
                "auth": bool(FLEET_TOKEN),
                # The revision only — not the values, which are behind the token
                # at /settings. Enough for the server to spot a Pi that came back
                # from a reboot holding older tuning, without making an open
                # endpoint describe how this device is configured.
                "settings_rev": SETTINGS_REVISION,
                "speaker_device": SPEAKER_DEVICE,
                "mic_device": MIC_DEVICE,
                "audio_out": playback_devices(),
                # Only meaningful for a device with a screen, and omitted rather
                # than sent as zeroes otherwise — an absent key reads as "not
                # applicable", where "cjk_glyphs: 0" reads as "broken font".
                **({"text": text_coverage()} if "screen" in caps else {}),
                # What this device can actually draw. Sent for the same reason
                # `text` is: the expression list is now per-device — a user can
                # add to it — so mcp-core cannot know it from its own config,
                # and a model choosing an argument has to be able to ask.
                **({"expressions": CATALOG.names()} if "screen" in caps and CATALOG else {}),
            })

        # /face and /display/state are open for the same reason /health is: the
        # thing asking for them is a kiosk browser started by a .desktop file,
        # which has no way to attach a header. Neither leaks a secret — the page
        # is static markup, and the state is whatever is already lit up on a
        # screen anyone in the room can see.
        if path == "/face":
            if not self._require("screen"):
                return
            if FACE_HTML is None:
                return self._send(500, b"face page not installed - copy spc_face.py next to spc_agent.py",
                                  "text/plain; charset=utf-8")
            return self._send(200, FACE_HTML.encode("utf-8"), "text/html; charset=utf-8",
                              {"Cache-Control": "no-store"})

        # Open for the same reason /health is: a wall-mounted web UI needs to draw
        # the slider in the right position on load, and the current loudness of a
        # speaker in a public room is not a secret. CHANGING it still needs auth.
        if path == "/volume":
            if not self._require("volume"):
                return
            try:
                return self._json(200, {
                    "volume": volume_get(),
                    "control": VOLUME_CONTROL,
                    "card": VOLUME_CARD or "(default)",
                })
            except Exception as err:
                return self._json(500, {"error": str(err)})

        # Open alongside /face and /display/state: the two renderers fetch this
        # to know what they can draw, and neither can attach a header. It lists
        # the shapes of faces on a screen anyone in the room is already looking
        # at, so there is nothing here to keep back.
        if path == "/expressions":
            if not self._require("screen"):
                return
            if CATALOG is None:
                return self._json(500, {"error": "spc_expressions.py is not installed beside spc_agent.py"})
            body = CATALOG.to_json()
            body["version"] = CATALOG_VERSION
            return self._json(200, body, headers={"Cache-Control": "no-store"})

        # The picker. Same reasoning as /face — it is a page, and every action
        # it can take goes back through an authenticated POST.
        if path == "/faces":
            if not self._require("screen"):
                return
            if PICKER_HTML is None:
                return self._send(500, b"picker page not installed - copy spc_picker.py next to spc_agent.py",
                                  "text/plain; charset=utf-8")
            return self._send(200, PICKER_HTML.encode("utf-8"), "text/html; charset=utf-8",
                              {"Cache-Control": "no-store"})

        if path == "/display/state":
            if not self._require("screen"):
                return
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                since = int((query.get("v") or ["-1"])[0])
            except ValueError:
                since = -1
            # 25s: comfortably inside every default proxy and browser idle
            # timeout, so a quiet screen re-polls a couple of times a minute
            # instead of hammering the loopback.
            return self._json(200, screen_wait(since, 25), headers={"Cache-Control": "no-store"})

        if not self._authorized():
            return self._json(401, {"error": "missing or wrong X-Fleet-Token"})

        if path == "/display":
            if not self._require("screen"):
                return
            return self._json(200, screen_snapshot())

        if path == "/look":
            if not self._require("look"):
                return
            try:
                return self._send(200, capture_jpeg(), "image/jpeg")
            except Exception as err:
                return self._json(500, {"error": str(err)})

        if path == "/sense":
            if not self._require("sense"):
                return
            return self._json(200, {
                "sensors": sense(),
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })

        # What this Pi is currently tuned to. Behind the token, unlike /health,
        # because it is the read half of a write endpoint and there is no reason
        # for it to be more open than the write.
        if path == "/settings":
            if not self._authorized():
                return self._json(401, {"error": "missing or wrong X-Fleet-Token"})
            return self._json(200, {"revision": SETTINGS_REVISION, "settings": dict(SETTINGS)})

        return self._json(404, {"error": f"no route {path}. Try /health, /look, /sense, /face, /faces, /display, /display/state, /expressions, /settings, /volume."})

    def do_PATCH(self):
        """Runtime settings push from mcp-core.

        PATCH rather than POST because it is a merge: keys left out keep their
        current values, which is what lets the server push only the device-scoped
        subset without having to know, or restate, everything else this Pi holds.
        """
        path = self.path.split("?")[0]
        if not self._authorized():
            return self._json(401, {"error": "missing or wrong X-Fleet-Token"})
        if path != "/settings":
            return self._json(404, {"error": f"no PATCH route {path}. Only /settings accepts PATCH."})
        body = self._body()
        values = body.get("settings", body) if isinstance(body, dict) else {}
        if not isinstance(values, dict):
            return self._json(400, {"error": "body must be a JSON object of { key: value }"})
        changed = settings_apply(values, body.get("revision", 0) if isinstance(body, dict) else 0)
        # `ignored` is reported rather than swallowed so a newer mcp-core pushing
        # a knob this build predates shows up as a fact in the reply, instead of
        # a setting that appears to have been accepted and does nothing.
        ignored = [k for k in values if k not in SETTING_DEFAULTS]
        return self._json(200, {
            "revision": SETTINGS_REVISION,
            "changed": changed,
            "ignored": ignored,
            "settings": dict(SETTINGS),
        })

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._authorized():
            return self._json(401, {"error": "missing or wrong X-Fleet-Token"})
        body = self._body()

        if path == "/volume":
            if not self._require("volume"):
                return
            level = body.get("level", body.get("volume"))
            if level is None:
                return self._json(400, {"error": "level is required, 0-100"})
            try:
                level = int(level)
            except (TypeError, ValueError):
                return self._json(400, {"error": f"level must be a number 0-100, got {level!r}"})
            try:
                return self._json(200, {"volume": volume_set(level), "requested": level})
            except Exception as err:
                return self._json(500, {"error": str(err)})

        # Rescan the expression directories. A POST rather than a GET because it
        # is what publishes a new face to the glass, and because that makes it
        # land behind the token like every other change to what the screen shows.
        if path == "/expressions/reload":
            if not self._require("screen"):
                return
            try:
                catalog = expressions_reload()
            except RuntimeError as err:
                return self._json(500, {"error": str(err)})
            return self._json(200, {
                "reloaded": True,
                "version": CATALOG_VERSION,
                "expressions": catalog.names(),
                "problems": catalog.problems,
            })

        if path == "/speak":
            if not self._require("speak"):
                return
            text = (body.get("text") or "").strip()
            if not text:
                return self._json(400, {"error": "text is required and must not be empty"})
            try:
                started = time.time()
                device = speak(text)
                return self._json(200, {
                    "spoken": True,
                    "ms": int((time.time() - started) * 1000),
                    # Named explicitly, plus the full sink list, so "I heard
                    # nothing" is diagnosable without shelling into the Pi.
                    "device": device,
                    "available_outputs": playback_devices(),
                })
            except Exception as err:
                return self._json(500, {"error": str(err)})

        if path == "/listen":
            if not self._require("listen"):
                return
            # An explicit argument still wins — a caller who says "give me 30
            # seconds" has a reason. Omitting it now means "use this Pi's
            # configured default" rather than a literal buried here, so the
            # auto-stop tuning has one home and mcp-core can move it.
            timeout_s = min(max(float(body.get("timeout_s") or setting("spc.listen_timeout_s")), 1), 60)
            silence_s = min(max(float(body.get("silence_s") or setting("spc.listen_silence_s")), 0.2), 5)
            try:
                wav = listen(timeout_s, silence_s)
            except Exception as err:
                return self._json(500, {"error": str(err)})
            if not wav:
                # 204, not an error: listening and hearing nothing is a
                # successful answer to the question that was asked.
                return self._send(204)
            return self._send(200, wav, "audio/wav")

        if path == "/display":
            if not self._require("screen"):
                return
            if not any(k in body for k in ("expression", "gaze", "panel")):
                return self._json(400, {
                    "error": "nothing to change — send an expression, a gaze, a panel, or any combination"
                })
            try:
                state = screen_update(body)
            except ValueError as err:
                return self._json(400, {"error": str(err)})
            panel_mode = state["panel"].get("mode")
            # Reported, never rejected. The panel is already up by the time this
            # is computed and '?' is a better answer than a 400 — but the caller
            # is told, because the alternative is a model that believes it wrote
            # Chinese to a screen showing question marks.
            missing = undrawable("".join(panel_text(state["panel"])))
            print(f"screen v{state['version']}: {state['expression']} / {panel_mode}"
                  + (f" [undrawable: {''.join(missing)}]" if missing else ""), flush=True)
            return self._json(200, {
                "updated": True,
                "version": state["version"],
                "expression": state["expression"],
                "panel_mode": panel_mode,
                **({"undrawable": "".join(missing)} if missing else {}),
            })

        return self._json(404, {"error": f"no route {path}. Try /speak, /listen, /display."})


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        print(f"  id           {DEVICE_ID}")
        print(f"  listen on    {HOST}:{PORT}")
        print(f"  auth         {'ON' if FLEET_TOKEN else 'OFF (set SPC_FLEET_TOKEN)'}")
        print(f"  mic          {MIC_DEVICE}")
        print(f"  speaker      {SPEAKER_DEVICE}")
        print(f"  volume       {VOLUME_CONTROL or '(none configured)'}"
              f"{' on card ' + VOLUME_CARD if VOLUME_CARD else ''}"
              f"{f', default {VOLUME_DEFAULT}%' if VOLUME_CONTROL else ''}")
        print(f"  camera       {CAMERA_DEVICE}")
        print(f"  screen       {'yes' if have_screen() else 'no'}")
        print(f"  cjk glyphs   {len(CJK_CODEPOINTS) or 'none — non-Latin text renders as ?'}")
        print(f"  capabilities {', '.join(capabilities()) or 'none'}")
        for cap in ("look", "speak", "sense", "listen", "screen", "volume"):
            if cap not in capabilities():
                print(f"    {cap}: {missing_reason(cap)}")
        return

    caps = capabilities()
    print(f"spc-agent {DEVICE_ID} on {HOST}:{PORT}", flush=True)
    print(f"  capabilities: {', '.join(caps) or 'NONE — nothing is wired up'}", flush=True)
    for cap in ("look", "speak", "sense", "listen", "screen", "volume"):
        if cap not in caps:
            print(f"  no {cap}: {missing_reason(cap)}", flush=True)
    if "screen" in caps:
        print(f"  face page: http://localhost:{PORT}/face", flush=True)
        if FACE_HTML is None:
            print("  WARNING: spc_face.py is missing next to this script — /face has nothing to serve.", flush=True)
        if CJK_CODEPOINTS:
            print(f"  text: Latin + {len(CJK_CODEPOINTS)} CJK glyphs", flush=True)
        else:
            print("  text: Latin only — no cjk_font_data.py beside this script, so Chinese "
                  "renders as '?'. Run gen_fb_cjk_font.py and deploy its output.", flush=True)
    if not FLEET_TOKEN:
        print("  WARNING: no SPC_FLEET_TOKEN — anyone who can reach this port can open the mic.", flush=True)
    # Before volume_restore() and before serving: every timeout below reads
    # through these, so loading them late would mean the first command of the
    # day ran on defaults this Pi was explicitly told not to use.
    settings_load()
    # After the banner so its failure message has context, and before serving so
    # the first /speak of the day is not at whatever level the last boot left.
    volume_restore()
    # Threading matters: /speak and /listen both block for many seconds, and a
    # single-threaded server would make a health check queue behind them.
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
