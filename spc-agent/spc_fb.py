#!/usr/bin/env python3
"""spc-fb — the face, drawn straight onto the panel's framebuffer.

The browser is the nicer renderer (spc_face.py) but it needs a browser, and on
an Armbian server image there isn't one: no X, no Wayland, and the only
chromium/firefox packages in these repos are snap stubs. Meanwhile /dev/fb0 is
right there, owned by root:video, and the login user is already in `video`. So
this draws the same screen with no display server, no packages and no sudo.

It reads the SAME state as the browser page — GET /display/state on the agent —
so `spc_expression` drives both, and nothing about the tool or the contract
changes depending on which one is running.

    python3 spc_fb.py

Deliberately stdlib-only, like the rest of spc-agent: no PIL, no numpy. Text
comes from the console PSF fonts every Linux already ships, plus a curated
Chinese subset baked ahead of time by gen_fb_cjk_font.py into cjk_font_data.py
(same PIL-at-build-time, stdlib-at-runtime split as the ESP32 kiosk screen's
ui_font_cjk.c). Missing that file is not an error -- Chinese text just draws
as '?' per glyph, the same fallback any unknown byte already gets.

Configuration is by environment variable:

    SPC_FB_URL      agent to follow          (default http://127.0.0.1:8080)
    SPC_FB_DEVICE   framebuffer              (default /dev/fb0)
    SPC_FB_ROTATE   0/90/180/270             (default 270)
    SPC_FB_FONT     path to a .psf/.psf.gz   (default: the largest Terminus found)

ROTATION. A panel screwed to a kiosk stand sideways still hands Linux a
landscape framebuffer, so the whole screen is composed in portrait "content"
coordinates and mapped on the way out. 270 is the case this was built for: the
frame's top-left lands at the panel's top-right, i.e. the panel is turned a
quarter turn clockwise from the way the framebuffer thinks it is.
"""

import bisect
import glob
import gzip
import json
import math
import mmap
import os
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

try:
    from cjk_font_data import GLYPHS as _CJK_GLYPHS, CELL_W as _CJK_W, CELL_H as _CJK_H
    _CJK_CODEPOINTS = [cp for cp, _ in _CJK_GLYPHS]
except ImportError:
    # gen_fb_cjk_font.py hasn't been run (or its output isn't next to this
    # file) -- Chinese text still draws, just as '?' per glyph like any other
    # uncovered character. Everything else about the face works unaffected.
    _CJK_GLYPHS, _CJK_W, _CJK_H, _CJK_CODEPOINTS = [], 0, 0, []

AGENT = os.environ.get("SPC_FB_URL", "http://127.0.0.1:8080").rstrip("/")
FB_DEVICE = os.environ.get("SPC_FB_DEVICE", "/dev/fb0")
ROTATE = int(os.environ.get("SPC_FB_ROTATE", "270"))

# How much of the picture the panel actually shows, as a fraction of the content
# height. 1.0 for a monitor that displays what it is sent.
#
# Cheap HDMI panels that publish no EDID often do not: the driver has to guess a
# timing, the panel's scaler locks onto a different active area, and the bottom
# of every frame falls off the glass while the rest is stretched to fill it. The
# panel this was built against shows content rows 0..725 of 1024 — measured by
# drawing labelled marks and photographing which was the last one visible.
#
# Layout uses this height; drawing is still clipped to the real buffer, so
# nothing overruns memory. Set it to 1.0 once the mode is right (forcing
# 1920x1080 in armbianEnv.txt made this panel behave) and the whole screen
# comes back.
USABLE = max(0.2, min(1.0, float(os.environ.get("SPC_FB_USABLE", "1.0"))))

# THE FRAME: which part of the picture this particular panel actually puts on
# glass, as content-space insets "left,top,right,bottom".
#
# Two separate faults, both from the same missing EDID:
#   - the bottom of every frame falls off the glass (hence the bottom inset)
#   - the picture sits off-centre, with a strip cut on one side and unreachable
#     black on the other (hence the left inset, which re-centres what is left)
#
# Measured against the hardware, not guessed: draw labelled marks, photograph
# the panel, read off the last one visible. The numbers below are for the 7"
# 1024x600 panel on this kiosk as of 2026-08-19. Any other panel needs its own,
# and a panel whose mode is correct needs none at all.
def _insets():
    raw = os.environ.get("SPC_FB_INSET", "").strip()
    if not raw:
        return (0, 0, 0, 0)
    try:
        parts = [int(v) for v in raw.split(",")]
    except ValueError:
        print(f"SPC_FB_INSET={raw!r} is not four numbers — ignoring", flush=True)
        return (0, 0, 0, 0)
    if len(parts) != 4:
        print(f"SPC_FB_INSET wants left,top,right,bottom — got {len(parts)} — ignoring", flush=True)
        return (0, 0, 0, 0)
    return tuple(max(0, v) for v in parts)

INSET_L, INSET_T, INSET_R, INSET_B = _insets()
FONT_PATH = os.environ.get("SPC_FB_FONT", "")

# Same palette as the browser page, so the two renderers are recognisably the
# same product. BGRA, because that is what a 32bpp Linux framebuffer wants.
INK = (0x34, 0xD0, 0xFF)          # cyan, the face
INK_ERROR = (0xFF, 0x7A, 0x7A)
INK_SLEEP = (0x2A, 0x6F, 0x95)
BG_FACE = (0x04, 0x08, 0x0F)
BG_PANEL = (0x06, 0x0D, 0x1A)
CARD_TOP = (0x14, 0x35, 0x6B)
CARD_BOTTOM = (0x0B, 0x22, 0x47)
TEXT = (0xEA, 0xF4, 0xFF)
TEXT_DIM = (0xA9, 0xCD, 0xF0)
TILE = (0xF2, 0xF7, 0xFF)
TILE_INK = (0x10, 0x30, 0x5E)


# ---------------------------------------------------------------------------
# Framebuffer
# ---------------------------------------------------------------------------

def fb_geometry():
    node = os.path.basename(FB_DEVICE)
    base = f"/sys/class/graphics/{node}"
    w, h = [int(v) for v in open(f"{base}/virtual_size").read().strip().split(",")]
    bpp = int(open(f"{base}/bits_per_pixel").read())
    stride = int(open(f"{base}/stride").read())
    if bpp != 32:
        raise SystemExit(f"{FB_DEVICE} is {bpp}bpp; this renderer only speaks 32bpp.")
    return w, h, stride


class Screen:
    """Portrait content coordinates in, rotated framebuffer bytes out.

    Every fill goes through vspan() — a run down a single content COLUMN —
    because at 90 or 270 degrees one content column is exactly one framebuffer
    row, which is one contiguous slice assignment. Filling by rows instead would
    make every span a strided per-pixel loop, and a full screen would take
    seconds in pure Python rather than milliseconds.
    """

    def __init__(self, path, rotate):
        self.fw, self.fh, self.stride = fb_geometry()
        self.rot = rotate % 360
        self.w, self.h = (self.fh, self.fw) if self.rot in (90, 270) else (self.fw, self.fh)
        # h stays the LAYOUT height so every proportional decision below lands
        # on glass the viewer can actually see; h_raw is the real buffer, used
        # for clipping so drawing can never overrun memory.
        self.w_raw, self.h_raw = self.w, self.h
        # The drawable frame: everything Face and Panel lay out lands inside it,
        # so they stay ignorant of the panel's quirks and the same code drives a
        # screen that behaves.
        self.x0, self.y0 = INSET_L, INSET_T
        self.w = self.w_raw - INSET_L - INSET_R
        self.h = int(self.h_raw * USABLE) - INSET_T - INSET_B
        self.fd = os.open(path, os.O_RDWR)
        self.mem = mmap.mmap(self.fd, self.stride * self.fh, mmap.MAP_SHARED,
                             mmap.PROT_READ | mmap.PROT_WRITE)

    def close(self):
        self.mem.close()
        os.close(self.fd)

    def vspan(self, x, y0, y1, color):
        """Fill column x of the FRAME, from row y0 up to (not including) y1."""
        self.vspan_raw(x + self.x0, y0 + self.y0, y1 + self.y0, color)

    def vspan_raw(self, x, y0, y1, color):
        """The same, in real buffer coordinates, ignoring the frame."""
        if x < 0 or x >= self.w_raw:
            return
        y0 = 0 if y0 < 0 else int(y0)
        y1 = self.h_raw if y1 > self.h_raw else int(y1)
        if y1 <= y0:
            return
        pixel = bytes((color[2], color[1], color[0], 0xFF))   # BGRA

        if self.rot == 270:
            fy = self.w_raw - 1 - x
            start = fy * self.stride + y0 * 4
            self.mem[start:start + (y1 - y0) * 4] = pixel * (y1 - y0)
        elif self.rot == 90:
            fy = x
            fx0 = self.h_raw - y1
            start = fy * self.stride + fx0 * 4
            self.mem[start:start + (y1 - y0) * 4] = pixel * (y1 - y0)
        else:
            # Unrotated (or 180): a content column is strided in the frame, so
            # this is the slow path. Supported for completeness — the kiosk runs
            # rotated, and that is the case worth optimising.
            for y in range(y0, y1):
                fx, fy = (x, y) if self.rot == 0 else (self.w_raw - 1 - x, self.h_raw - 1 - y)
                off = fy * self.stride + fx * 4
                self.mem[off:off + 4] = pixel

    def fill(self, color):
        # Deliberately raw: the insets have to be painted too, or the strips the
        # panel crops keep whatever was on screen before.
        for x in range(self.w_raw):
            self.vspan_raw(x, 0, self.h_raw, color)

    def rect(self, x, y, w, h, color):
        for cx in range(int(x), int(x + w)):
            self.vspan(cx, y, y + h, color)

    def round_rect(self, x, y, w, h, r, color):
        x, y, w, h, r = int(x), int(y), int(w), int(h), int(r)
        r = min(r, w // 2, h // 2)
        for cx in range(x, x + w):
            dx = 0
            if cx < x + r:
                dx = r - (cx - x)
            elif cx >= x + w - r:
                dx = cx - (x + w - r) + 1
            if dx:
                inset = r - int(math.sqrt(max(r * r - dx * dx, 0)))
            else:
                inset = 0
            self.vspan(cx, y + inset, y + h - inset, color)

    def vgrad_round_rect(self, x, y, w, h, r, top, bottom):
        """Rounded rect with a vertical gradient — one colour per content row is
        impossible with column runs, so it is drawn as horizontal bands."""
        bands = 72
        step = max(1, h // bands)
        for i in range(0, int(h), step):
            t = i / max(h - 1, 1)
            color = tuple(int(top[c] + (bottom[c] - top[c]) * t) for c in range(3))
            # Corner rounding only matters within r of either end.
            band_r = 0
            if i < r:
                band_r = r - int(math.sqrt(max(r * r - (r - i) ** 2, 0)))
            elif i > h - r:
                d = i - (h - r)
                band_r = r - int(math.sqrt(max(r * r - d * d, 0)))
            self.rect(x + band_r, y + i, w - 2 * band_r, min(step, h - i), color)

    def disc(self, cx, cy, r, color):
        cx, cy, r = int(cx), int(cy), int(r)
        for x in range(cx - r, cx + r + 1):
            dx = x - cx
            if abs(dx) > r:
                continue
            dy = int(math.sqrt(max(r * r - dx * dx, 0)))
            self.vspan(x, cy - dy, cy + dy + 1, color)

    def stroke(self, points, width, color):
        """Stamp a round brush along a polyline. Curves arrive pre-flattened."""
        r = max(1, width // 2)
        last = None
        for (px, py) in points:
            if last is not None:
                dist = math.hypot(px - last[0], py - last[1])
                steps = max(1, int(dist / max(r * 0.6, 1)))
                for s in range(1, steps):
                    t = s / steps
                    self.disc(last[0] + (px - last[0]) * t,
                              last[1] + (py - last[1]) * t, r, color)
            self.disc(px, py, r, color)
            last = (px, py)


def quad(p0, p1, p2, steps=26):
    """Flatten a quadratic bezier — the curve shape the face is drawn with."""
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


# ---------------------------------------------------------------------------
# Text, from the console fonts every Linux already has
# ---------------------------------------------------------------------------

PSF1_MAGIC = b"\x36\x04"
PSF2_MAGIC = b"\x72\xb5\x4a\x86"

FONT_PREFERENCE = [
    "/usr/share/consolefonts/Lat15-TerminusBold32x16.psf.gz",
    "/usr/share/consolefonts/Lat2-TerminusBold32x16.psf.gz",
    "/usr/share/consolefonts/Uni3-TerminusBold32x16.psf.gz",
    "/usr/share/consolefonts/Lat15-Terminus32x16.psf.gz",
]


class Font:
    """Console PSF glyphs, plus an optional companion CJK subset (see
    cjk_font_data.py / gen_fb_cjk_font.py) drawn through the exact same
    column-run machinery. A CJK glyph is baked double-width (see _CJK_W vs
    self.w), so it advances the pen by 2 "cells" where a Latin glyph advances
    by 1 -- the usual CJK terminal convention, and the reason every width
    calculation below counts in cells rather than characters.
    """

    def __init__(self, path):
        raw = gzip.open(path, "rb").read() if path.endswith(".gz") else open(path, "rb").read()
        if raw[:4] == PSF2_MAGIC:
            (_, _, headersize, flags, length, charsize, height, width) = struct.unpack("<4sIIIIIII", raw[:32])
            self.w, self.h, self.count = width, height, length
            self.glyph_bytes = charsize
            data_start = headersize
        elif raw[:2] == PSF1_MAGIC:
            mode, charsize = raw[2], raw[3]
            self.w, self.h = 8, charsize
            self.count = 512 if mode & 0x01 else 256
            self.glyph_bytes = charsize
            data_start = 4
            flags = 0
        else:
            raise SystemExit(f"{path} is not a PSF console font.")
        self.path = path
        self.row_bytes = (self.w + 7) // 8
        self.glyphs = [raw[data_start + i * self.glyph_bytes:
                           data_start + (i + 1) * self.glyph_bytes]
                       for i in range(self.count)]
        self.cjk_row_bytes = (_CJK_W + 7) // 8
        # Column runs are cached per (char, scale): the glyph bitmap is stored
        # by rows, but this renderer paints by columns, and converting on every
        # frame would be the slowest thing on the screen.
        self._cache = {}

    def _cjk_glyph(self, ch):
        """Binary search the sorted CJK table for ch's glyph bytes, or None."""
        if not _CJK_CODEPOINTS:
            return None
        cp = ord(ch)
        i = bisect.bisect_left(_CJK_CODEPOINTS, cp)
        if i < len(_CJK_CODEPOINTS) and _CJK_CODEPOINTS[i] == cp:
            return _CJK_GLYPHS[i][1]
        return None

    def _glyph_source(self, ch):
        """Returns (glyph_bytes, width_px, height_px, row_bytes, cells) for
        whichever table actually covers ch: the PSF console table first (so
        Latin-1 stays pixel-identical to before), then the CJK subset, then
        the console '?' glyph as the same safe fallback unknown ASCII bytes
        already used."""
        index = ord(ch)
        if index < self.count:
            return self.glyphs[index], self.w, self.h, self.row_bytes, 1
        cjk = self._cjk_glyph(ch)
        if cjk is not None:
            return cjk, _CJK_W, _CJK_H, self.cjk_row_bytes, 2
        return self.glyphs[ord("?")], self.w, self.h, self.row_bytes, 1

    def _is_cjk(self, ch):
        return self._cjk_glyph(ch) is not None

    def _columns(self, ch, scale):
        key = (ch, scale)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        glyph, w, h, row_bytes, cells = self._glyph_source(ch)
        runs = []                                  # (col, y0, y1) in scaled px
        for col in range(w):
            y = 0
            while y < h:
                byte = glyph[y * row_bytes + (col >> 3)]
                on = (byte >> (7 - (col & 7))) & 1
                if not on:
                    y += 1
                    continue
                start = y
                while y < h:
                    byte = glyph[y * row_bytes + (col >> 3)]
                    if not ((byte >> (7 - (col & 7))) & 1):
                        break
                    y += 1
                runs.append((col, start, y))
        # CJK glyphs are baked at their own pixel size (_CJK_W/_CJK_H), which
        # generally differs from the console font's -- scale relative to the
        # cell it fills (cells * self.w/self.h) rather than its own raw px,
        # so a CJK glyph lines up with the Latin glyphs beside it.
        cell_w, cell_h = cells * self.w, self.h
        sx = (cell_w * scale) / w
        sy = (cell_h * scale) / h
        scaled = [(round(c * sx), round(y0 * sy), round(y1 * sy)) for (c, y0, y1) in runs]
        self._cache[key] = scaled
        return scaled

    def _cells(self, ch):
        return 2 if self._is_cjk(ch) else 1

    def measure(self, text, scale):
        cells = sum(self._cells(ch) for ch in text)
        return cells * self.w * scale, self.h * scale

    def draw(self, screen, x, y, text, scale, color):
        pen = int(x)
        for ch in text:
            for (col, y0, y1) in self._columns(ch, scale):
                for s in range(scale):
                    screen.vspan(pen + col + s, y + y0, y + y1, color)
            pen += self.w * self._cells(ch) * scale

    def draw_centered(self, screen, cx, y, text, scale, color):
        w, _ = self.measure(text, scale)
        self.draw(screen, cx - w // 2, y, text, scale, color)

    def truncate(self, text, scale, max_w):
        """Longest prefix of text (in whole characters) that measures no
        wider than max_w -- cell-aware, so a CJK name doesn't run over a
        budget sized by counting characters instead of the width they draw."""
        cells, out = 0, []
        limit = max(1, max_w // (self.w * scale))
        for ch in text:
            cells += self._cells(ch)
            if cells > limit:
                break
            out.append(ch)
        return "".join(out)

    def wrap(self, text, scale, max_width):
        per_cell = self.w * scale
        limit = max(1, max_width // per_cell)

        # Tokenize: each CJK character is its own breakable token (Chinese
        # has no inter-word spaces), everything else is a whitespace-split
        # word, same as before. (text_fragment, cells, is_cjk).
        tokens = []
        i, n = 0, len(text)
        while i < n:
            ch = text[i]
            if ch.isspace():
                i += 1
                continue
            if self._is_cjk(ch):
                tokens.append((ch, 2, True))
                i += 1
                continue
            j = i
            while j < n and not text[j].isspace() and not self._is_cjk(text[j]):
                j += 1
            word = text[i:j]
            tokens.append((word, len(word), False))
            i = j

        lines, line, line_cells, prev_cjk = [], "", 0, False
        for tok, cells, is_cjk in tokens:
            glue = is_cjk and prev_cjk           # two adjacent CJK chars: no gap
            sep = 0 if (glue or not line) else 1
            if line and line_cells + sep + cells > limit:
                lines.append(line)
                line, line_cells, prev_cjk = "", 0, False
                glue, sep = False, 0
            if cells > limit and not line:
                # A single token wider than a whole line (URL, or CJK/ASCII
                # run-together from STT): hard-truncate it, same fallback the
                # original ASCII-only wrap() used.
                lines.append(tok[:limit] if not is_cjk else tok)
                continue
            if line and not glue:
                line += " "
                line_cells += 1
            line += tok
            line_cells += cells
            prev_cjk = is_cjk
        if line:
            lines.append(line)
        return lines


def load_font():
    for path in ([FONT_PATH] if FONT_PATH else []) + FONT_PREFERENCE:
        if path and os.path.exists(path):
            return Font(path)
    # Anything Terminus-shaped will do; prefer the tallest available.
    found = sorted(glob.glob("/usr/share/consolefonts/*Terminus*.psf.gz"))
    if not found:
        found = sorted(glob.glob("/usr/share/consolefonts/*.psf.gz"))
    if not found:
        raise SystemExit("No PSF console fonts found (apt install console-setup).")
    return Font(found[-1])


# ---------------------------------------------------------------------------
# The face
# ---------------------------------------------------------------------------
# Geometry lives in portrait content pixels, sized off the screen so the same
# code fills a 1080x1920 kiosk panel and a smaller one.

EYE_SHAPE = {
    "neutral":   ("open", "open"),
    "happy":     ("arc_up", "arc_up"),
    "listening": ("wide", "wide"),
    "thinking":  ("narrow", "open"),
    "speaking":  ("open", "open"),
    "confused":  ("open", "narrow"),
    "sad":       ("narrow", "narrow"),
    "wink":      ("arc_up", "open"),
    "sleeping":  ("arc_down", "arc_down"),
    "error":     ("cross", "cross"),
}
BROW_SHAPE = {
    "neutral": "flat", "happy": "raised", "listening": "raised", "thinking": "raised",
    "speaking": "flat", "confused": "raised", "sad": "sad", "wink": "raised",
    "sleeping": None, "error": "angry",
}
MOUTH_SHAPE = {
    "neutral": "smile", "happy": "grin", "listening": "small", "thinking": "flat",
    "speaking": "open", "confused": "wave", "sad": "frown", "wink": "grin",
    "sleeping": "flat", "error": "frown",
}
GAZE = {"center": (0, 0), "left": (-0.036, 0), "right": (0.036, 0),
        "up": (0, -0.016), "down": (0, 0.016)}


class Face:
    def __init__(self, screen, font):
        self.s = screen
        self.font = font
        W, H = screen.w, screen.h
        self.face_h = int(H * 0.45)
        self.u = W / 1080.0                      # everything below is drawn for
        self.stroke_w = max(8, int(46 * self.u)) # a 1080-wide portrait screen
        self.eye_y = int(self.face_h * 0.47)
        self.brow_y = int(self.face_h * 0.19)
        self.mouth_y = int(self.face_h * 0.76)
        self.eye_dx = int(232 * self.u)

    def ink(self, expression):
        if expression == "error":
            return INK_ERROR
        if expression == "sleeping":
            return INK_SLEEP
        return INK

    def draw(self, expression, gaze, blink=0.0):
        s, u = self.s, self.u
        color = self.ink(expression)
        s.rect(0, 0, s.w, self.face_h, BG_FACE)

        gx, gy = GAZE.get(gaze, (0, 0))
        ox, oy = int(gx * s.w), int(gy * s.w)
        left_shape, right_shape = EYE_SHAPE.get(expression, EYE_SHAPE["neutral"])
        cx_l = s.w // 2 - self.eye_dx + ox
        cx_r = s.w // 2 + self.eye_dx + ox
        cy = self.eye_y + oy

        for (cx, shape) in ((cx_l, left_shape), (cx_r, right_shape)):
            self._eye(cx, cy, shape, color, blink)

        brow = BROW_SHAPE.get(expression)
        if brow:
            for cx in (s.w // 2 - self.eye_dx + ox, s.w // 2 + self.eye_dx + ox):
                self._brow(cx, self.brow_y, brow, color)

        self._mouth(MOUTH_SHAPE.get(expression, "smile"), color)

    def _eye(self, cx, cy, shape, color, blink):
        s, u = self.s, self.u
        squash = 1.0 - blink
        if shape in ("open", "wide", "narrow"):
            w = {"open": 286, "wide": 318, "narrow": 286}[shape] * u
            h = {"open": 404, "wide": 438, "narrow": 205}[shape] * u * squash
            if h < 6:
                h = 6
            r = min(int(94 * u), int(h / 2))
            s.round_rect(cx - w / 2, cy - h / 2, w, h, r, color)
            # Hollow it out, leaving a stroked outline like the browser page.
            inner = self.stroke_w
            if w - 2 * inner > 8 and h - 2 * inner > 8:
                s.round_rect(cx - w / 2 + inner, cy - h / 2 + inner,
                             w - 2 * inner, h - 2 * inner,
                             max(r - inner, 2), BG_FACE)
                if squash > 0.55:
                    s.disc(cx - w * 0.19, cy - h * 0.20, int(30 * u), color)
                    s.disc(cx + w * 0.12, cy + h * 0.03, int(17 * u), color)
        elif shape == "arc_up":
            s.stroke(quad((cx - 172 * u, cy + 86 * u * squash),
                          (cx, cy - 166 * u * squash),
                          (cx + 172 * u, cy + 86 * u * squash)), self.stroke_w, color)
        elif shape == "arc_down":
            s.stroke(quad((cx - 172 * u, cy), (cx, cy + 122 * u), (cx + 172 * u, cy)),
                     self.stroke_w, color)
        elif shape == "cross":
            a = 132 * u
            s.stroke([(cx - a, cy - a), (cx + a, cy + a)], self.stroke_w, color)
            s.stroke([(cx + a, cy - a), (cx - a, cy + a)], self.stroke_w, color)

    def _brow(self, cx, cy, shape, color):
        u, w = self.u, 178 * self.u
        if shape == "flat":
            pts = quad((cx - w, cy), (cx, cy - 38 * u), (cx + w, cy))
        elif shape == "raised":
            pts = quad((cx - w, cy + 16 * u), (cx, cy - 70 * u), (cx + w, cy + 16 * u))
        elif shape == "sad":
            pts = quad((cx - w, cy + 38 * u), (cx, cy - 10 * u), (cx + w, cy - 43 * u))
        else:  # angry
            pts = quad((cx - w, cy - 38 * u), (cx, cy - 5 * u), (cx + w, cy + 48 * u))
        self.s.stroke(pts, self.stroke_w, color)

    def _mouth(self, shape, color):
        s, u, y = self.s, self.u, self.mouth_y
        cx = s.w // 2
        if shape == "smile":
            pts = quad((cx - 186 * u, y), (cx, y + 140 * u), (cx + 186 * u, y))
        elif shape == "grin":
            pts = quad((cx - 226 * u, y), (cx, y + 210 * u), (cx + 226 * u, y))
        elif shape == "small":
            pts = quad((cx - 119 * u, y), (cx, y + 80 * u), (cx + 119 * u, y))
        elif shape == "flat":
            pts = [(cx - 126 * u, y + 27 * u), (cx + 126 * u, y + 27 * u)]
        elif shape == "frown":
            pts = quad((cx - 172 * u, y + 93 * u), (cx, y - 54 * u), (cx + 172 * u, y + 93 * u))
        elif shape == "wave":
            pts = (quad((cx - 160 * u, y + 33 * u), (cx - 80 * u, y - 32 * u), (cx, y + 27 * u)) +
                   quad((cx, y + 27 * u), (cx + 80 * u, y + 86 * u), (cx + 160 * u, y + 33 * u)))
        else:  # open — the speaking mouth
            pts = (quad((cx - 106 * u, y + 12 * u), (cx, y - 70 * u), (cx + 106 * u, y + 12 * u)) +
                   quad((cx + 106 * u, y + 12 * u), (cx, y + 124 * u), (cx - 106 * u, y + 12 * u)))
        self.s.stroke(pts, self.stroke_w, color)


# ---------------------------------------------------------------------------
# The panel
# ---------------------------------------------------------------------------

class Panel:
    def __init__(self, screen, font):
        self.s = screen
        self.font = font
        self.top = int(screen.h * 0.45)
        self.h = screen.h - self.top
        self.pad = int(screen.w * 0.045)

    def draw(self, panel):
        s = self.s
        mode = (panel or {}).get("mode", "blank")
        s.rect(0, self.top, s.w, s.h - self.top, BG_PANEL)
        if mode == "blank":
            return

        card_x = self.pad
        card_w = s.w - 2 * self.pad
        card_y = self.top + self.pad
        card_h = self.h - 2 * self.pad
        radius = int(s.w * 0.035)
        s.vgrad_round_rect(card_x, card_y, card_w, card_h, radius, CARD_TOP, CARD_BOTTOM)

        inner = card_x + int(self.pad * 0.8)
        inner_w = card_w - 2 * int(self.pad * 0.8)
        cx = s.w // 2

        if mode == "message":
            self._message(panel, cx, card_y, card_h, inner_w)
        elif mode == "order":
            self._order(panel, inner, inner_w, card_y)
        elif mode == "choices":
            self._choices(panel, cx, inner, inner_w, card_y, card_h)
        elif mode == "qr":
            self._qr(panel, cx, card_y, card_h, inner_w)

    def _stack(self, lines, cx, y, scale, color, gap=None):
        line_h = self.font.h * scale
        gap = line_h + (gap if gap is not None else int(line_h * 0.25))
        for i, line in enumerate(lines):
            self.font.draw_centered(self.s, cx, y + i * gap, line, scale, color)
        return y + len(lines) * gap

    def _message(self, panel, cx, card_y, card_h, inner_w):
        title = (panel.get("title") or "").strip()
        subtitle = (panel.get("subtitle") or "").strip()
        big, small = self._scales()

        # A subtitle with no title above it IS the message — that is the shape
        # spc_speak sends when it mirrors what it is saying. Rendering it as
        # fine print would put the spoken line in the smallest type on screen.
        sub_scale, sub_color = (big, TEXT) if not title else (small, TEXT_DIM)

        t_gap = self.font.h * big * 1.25
        s_gap = self.font.h * sub_scale * 1.25
        title_gap = int(self.font.h * small * 0.4)   # spacer between title and subtitle

        # Capped to what card_h can actually hold, title first (it's the
        # short, load-bearing line) then as much subtitle as still fits. A
        # message too long to fit is truncated here, not spilled past the
        # card the way an uncapped wrap used to (a long spc_speak mirror, or
        # any Chinese reply once every character actually renders instead of
        # mostly '?', is routinely this long).
        t_lines = self.font.wrap(title, big, inner_w) if title else []
        max_t = max(1, int(card_h // t_gap)) if t_lines else 0
        t_lines = t_lines[:max_t]

        s_lines = self.font.wrap(subtitle, sub_scale, inner_w) if subtitle else []
        used = len(t_lines) * t_gap + (title_gap if t_lines and s_lines else 0)
        max_s = max(0, int((card_h - used) // s_gap)) if s_lines else 0
        s_lines = s_lines[:max_s]

        total = (len(t_lines) * t_gap
                 + (title_gap if t_lines and s_lines else 0)
                 + len(s_lines) * s_gap)
        y = int(card_y + (card_h - total) / 2)
        if t_lines:
            y = self._stack(t_lines, cx, y, big, TEXT)
            if s_lines:
                y += title_gap
        if s_lines:
            self._stack(s_lines, cx, y, sub_scale, sub_color)

    def _order(self, panel, x, w, card_y):
        big, small = self._scales()
        y = card_y + self.pad
        title = (panel.get("title") or "").strip()
        if title:
            self.font.draw_centered(self.s, self.s.w // 2, y,
                                    self.font.truncate(title, big, w), big, TEXT)
            y += self.font.h * big + self.pad // 2
        # An order line is a name AND a price, so it gets its own size: if the
        # longest line does not fit beside its price, the rows step down one
        # scale rather than truncating "Nasi Lemak" to "Nasi". The title above
        # stays big — that is what carries across a room.
        items = (panel.get("items") or [])[:6]
        row_scale = small
        for probe in (small, max(1, small - 1)):
            widest = 0
            for it in items:
                qty = it.get("qty")
                nm = f"{qty} x {it.get('name','')}" if qty else str(it.get("name", ""))
                pr = str(it.get("price") or "")
                widest = max(widest, self.font.measure(nm + " " + pr, probe)[0])
            row_scale = probe
            if widest <= w:
                break
        small = row_scale
        row_h = self.font.h * small + int(self.font.h * small * 0.45)
        char_w = self.font.w * small
        for item in items:
            qty = item.get("qty")
            name = f"{qty} x {item.get('name','')}" if qty else str(item.get("name", ""))
            price = str(item.get("price") or "")
            pw = self.font.measure(price, small)[0] if price else 0
            # The price is the part you cannot fudge, so it is measured first and
            # the name takes whatever is left. Truncating blind put RM9.00 on top
            # of "Nasi Lemak" the moment the panel turned out to be 600px wide.
            room = max(char_w * 4, w - pw - char_w)
            self.font.draw(self.s, x, y, self.font.truncate(name, small, room), small, TEXT)
            if price:
                self.font.draw(self.s, x + w - pw, y, price, small, TEXT_DIM)
            y += row_h
        total = panel.get("total")
        if total:
            y += int(row_h * 0.3)
            self.s.rect(x, y, w, max(2, int(3 * self.s.w / 1080)), (0x8C, 0xC8, 0xFF))
            y += int(row_h * 0.4)
            self.font.draw(self.s, x, y, "TOTAL", small, TEXT)
            tw, _ = self.font.measure(str(total), small)
            self.font.draw(self.s, x + w - tw, y, str(total), small, TEXT)
            y += row_h
        note = (panel.get("note") or "").strip()
        if note:
            y += int(row_h * 0.2)
            for line in self.font.wrap(note, max(1, small - 1), w)[:2]:
                self.font.draw_centered(self.s, self.s.w // 2, y, line, max(1, small - 1), TEXT_DIM)
                y += self.font.h * max(1, small - 1) + 6

    def _choices(self, panel, cx, x, w, card_y, card_h):
        big, small = self._scales()
        y = card_y + self.pad
        title = (panel.get("title") or "").strip()
        if title:
            y = self._stack(self.font.wrap(title, big, w), cx, y, big, TEXT)
        subtitle = (panel.get("subtitle") or "").strip()
        if subtitle:
            y = self._stack(self.font.wrap(subtitle, small, w), cx, y, small, TEXT_DIM)
        y += self.pad // 2
        choices = (panel.get("choices") or [])[:4]
        if not choices:
            return
        tile_h = min(int(self.font.h * small * 2.4),
                     max(60, (card_y + card_h - self.pad - y) // max(len(choices), 1) - 12))
        for choice in choices:
            self.s.round_rect(x, y, w, tile_h, int(tile_h * 0.28), TILE)
            label = self.font.truncate(str(choice.get("label", "")), small, w)
            lw, lh = self.font.measure(label, small)
            self.font.draw(self.s, cx - lw // 2, y + (tile_h - lh) // 2, label, small, TILE_INK)
            y += tile_h + 12

    def _qr(self, panel, cx, card_y, card_h, inner_w):
        # No encoder here yet — the browser page draws a real code. Showing the
        # link as text is at least actionable; pretending to draw a QR would not
        # be, and an unscannable square is worse than a readable URL.
        big, small = self._scales()
        caption = (panel.get("qr_caption") or "Scan to continue").strip()
        data = (panel.get("qr_data") or "").strip()
        y = card_y + self.pad
        y = self._stack(self.font.wrap(caption, big, inner_w), cx, y, big, TEXT)
        y += self.pad // 2
        self._stack(self.font.wrap(data, max(1, small - 1), inner_w)[:6], cx, y,
                    max(1, small - 1), TEXT_DIM)

    def _scales(self):
        """Font multipliers picked off the panel width, so text stays readable
        from across a counter on any size of screen."""
        big = max(3, int(self.s.w / 240))
        small = max(2, big - 1)
        return big, small


# ---------------------------------------------------------------------------
# Following the agent
# ---------------------------------------------------------------------------

class Follower(threading.Thread):
    """Long-polls /display/state. Same endpoint the browser page uses."""

    daemon = True

    def __init__(self):
        super().__init__()
        self.state = {"expression": "neutral", "gaze": "center",
                      "panel": {"mode": "blank"}, "version": -1}
        self.changed = threading.Event()
        self.online = False

    def run(self):
        version = -1
        while True:
            try:
                with urllib.request.urlopen(f"{AGENT}/display/state?v={version}", timeout=40) as res:
                    body = json.loads(res.read().decode("utf-8"))
                if body.get("version") != version:
                    self.state = body
                    version = body.get("version", -1)
                    self.changed.set()
                self.online = True
            except Exception:
                if self.online:
                    print("lost the agent; retrying", flush=True)
                self.online = False
                time.sleep(2)


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return

    screen = Screen(FB_DEVICE, ROTATE)
    font = load_font()
    print(f"spc-fb: {screen.fw}x{screen.fh} framebuffer -> {screen.w}x{screen.h_raw} portrait "
          f"(rotate {screen.rot})", flush=True)
    if (screen.w, screen.h) != (screen.w_raw, screen.h_raw):
        print(f"  frame {screen.w}x{screen.h} at +{screen.x0}+{screen.y0} "
              f"(inset {INSET_L},{INSET_T},{INSET_R},{INSET_B}; usable {USABLE:.0%}) "
              f"— the panel does not show the rest", flush=True)
    cjk_note = f", CJK {len(_CJK_CODEPOINTS)} glyphs" if _CJK_CODEPOINTS else ", no CJK glyph table found"
    print(f"  font  {os.path.basename(font.path)} {font.w}x{font.h}{cjk_note}", flush=True)
    print(f"  agent {AGENT}", flush=True)

    face = Face(screen, font)
    panel = Panel(screen, font)
    follower = Follower()
    follower.start()

    screen.fill(BG_PANEL)
    drawn = None
    next_blink = time.time() + 3
    # The framebuffer is shared with the kernel console, which will happily
    # paint over it — a stray kernel message, a getty waking up, or anyone
    # echoing to /dev/tty1 blanks whatever is on the glass. The blink only
    # repaints the eyes, so without this the panel half would stay black until
    # the next tool call. Cheap insurance: a full repaint on a slow heartbeat.
    HEAL_EVERY = 20.0
    next_heal = time.time() + HEAL_EVERY
    try:
        while True:
            state = follower.state
            key = json.dumps(state, sort_keys=True)
            if time.time() >= next_heal:
                drawn = None                      # force a full repaint
                next_heal = time.time() + HEAL_EVERY
            if key != drawn:
                t0 = time.time()
                face.draw(state.get("expression", "neutral"), state.get("gaze", "center"))
                panel.draw(state.get("panel"))
                drawn = key
                next_heal = time.time() + HEAL_EVERY
                print(f"drew {state.get('expression')} / "
                      f"{(state.get('panel') or {}).get('mode')} in "
                      f"{(time.time()-t0)*1000:.0f}ms", flush=True)
                next_blink = time.time() + 3

            # A face that never moves reads as a crashed screen, so it blinks
            # even when nothing is calling the tool. Only the eye band is
            # repainted, which is why this is affordable at all.
            if time.time() >= next_blink:
                expression = state.get("expression", "neutral")
                if expression != "sleeping":
                    for amount in (0.55, 0.95, 0.55, 0.0):
                        face.draw(expression, state.get("gaze", "center"), blink=amount)
                        time.sleep(0.045)
                next_blink = time.time() + 2.8 + (time.time() % 3)

            follower.changed.wait(timeout=0.4)
            follower.changed.clear()
    except KeyboardInterrupt:
        pass
    finally:
        screen.close()


if __name__ == "__main__":
    main()
