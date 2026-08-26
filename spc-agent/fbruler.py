#!/usr/bin/env python3
"""Measure which part of the framebuffer this panel actually puts on glass.

A panel that publishes no EDID (`edid bytes: 0` in /sys/class/drm/*/edid) makes
the driver guess its timing, and the scaler then pushes some of the frame off
the edges. The amount is a property of the physical panel, so it cannot be read
back from software — it has to be seen.

Each edge gets its own ruler of labelled ticks, and every label carries the
edge's letter, so a photo taken at any angle is still unambiguous:

    L0 L20 L40 ...   ticks in from the LEFT edge of the content
    T0 T40 T80 ...   in from the TOP
    R0 R20 R40 ...   in from the RIGHT
    B0 B40 B80 ...   in from the BOTTOM

For each edge find the SMALLEST number whose tick you can still see, then:

    SPC_FB_INSET=left,top,right,bottom

An edge showing its 0 tick is not cropped at all. Long edges are ruled further
out than short ones because that is where the scaler usually eats the most.

Run with the face service stopped — both write to /dev/fb0:

    systemctl --user stop spc-face
    SPC_FB_FONT=... python3 fbruler.py
    systemctl --user start spc-face

Deliberately ignores SPC_FB_INSET (it is measuring what that should be) but
honours SPC_FB_ROTATE, since rotation decides which content edge lands where.
"""
import os
import sys

os.environ["SPC_FB_INSET"] = ""
os.environ["SPC_FB_USABLE"] = "1.0"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spc_fb import Screen, load_font, FB_DEVICE, ROTATE   # noqa: E402

SCALE = 1
THICK = 3
LONG_STEPS = [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400]
SHORT_STEPS = [0, 20, 40, 60, 80, 100, 120]

# Focus mode: measure ONE edge finely, once the coarse pass has bracketed it.
#
#     python3 fbruler.py B 260,280,300,320,340,360
#
# Bars span the full width and are labelled twice, in big type, because at this
# point the answer is one number and it needs to survive a phone photo taken at
# an angle in a lit room.
FOCUS_EDGE = sys.argv[1].upper() if len(sys.argv) > 1 else ""
FOCUS_STEPS = ([int(v) for v in sys.argv[2].split(",")] if len(sys.argv) > 2 else [])

# One hue per edge, so even a blurry photo separates them.
C_LEFT = (0xFF, 0xF0, 0x40)     # yellow
C_TOP = (0x40, 0xFF, 0x70)      # green
C_RIGHT = (0xFF, 0x90, 0x30)    # orange
C_BOTTOM = (0x60, 0xC0, 0xFF)   # blue


def focus(screen, font, edge, steps):
    """One edge, full-width bars, alternating colours, big labels at both ends."""
    W, H = screen.w, screen.h
    scale = 2
    _, th = font.measure("0", scale)
    palette = [(0xFF, 0x60, 0x60), (0x60, 0xFF, 0x80), (0x60, 0xC0, 0xFF), (0xFF, 0xE0, 0x40)]
    screen.fill((0x00, 0x00, 0x00))
    for i, v in enumerate(steps):
        color = palette[i % len(palette)]
        label = f"{edge}{v}"
        tw, _ = font.measure(label, scale)
        # Labels are staggered ACROSS the bar, not stacked at its ends: steps are
        # 20px apart and the type is ~64px tall, so end-aligned labels overprint
        # each other into an unreadable pile. Columns wrap, and a wrapped pair is
        # then 4 steps apart vertically, which clears the glyph height.
        cols = max(1, W // (tw + 10))
        dx = 8 + (i % cols) * (tw + 10)
        if edge == "B":
            y = H - 1 - v - THICK
            screen.rect(0, y, W, THICK, color)
            font.draw(screen, dx, y - th - 4, label, scale, color)
        elif edge == "T":
            screen.rect(0, v, W, THICK, color)
            font.draw(screen, dx, v + THICK + 4, label, scale, color)
        elif edge == "L":
            screen.rect(v, 0, THICK, H, color)
            font.draw(screen, v + THICK + 4, 8 + i * (th + 6), label, scale, color)
        elif edge == "R":
            x = W - 1 - v - THICK
            screen.rect(x, 0, THICK, H, color)
            font.draw(screen, x - tw - 4, 8 + i * (th + 6), label, scale, color)
    print(f"fbruler focus {edge}: {steps} on {W}x{H}", flush=True)
    print(f"  -> the SMALLEST {edge} number still fully on the glass is that edge's inset",
          flush=True)


def main():
    screen = Screen(FB_DEVICE, ROTATE)
    font = load_font()
    W, H = screen.w, screen.h
    _, th = font.measure("0", SCALE)

    if FOCUS_EDGE in ("L", "T", "R", "B") and FOCUS_STEPS:
        focus(screen, font, FOCUS_EDGE, FOCUS_STEPS)
        screen.close()
        return

    screen.fill((0x00, 0x00, 0x00))

    # Long axis is whichever is taller; ticks reach further along it.
    top_steps = bottom_steps = LONG_STEPS if H >= W else SHORT_STEPS
    left_steps = right_steps = SHORT_STEPS if H >= W else LONG_STEPS

    for i, v in enumerate(bottom_steps):
        y = H - 1 - v - THICK
        if y < H * 0.55:
            break
        screen.rect(0, y, int(W * 0.46), THICK, C_BOTTOM)
        font.draw(screen, 6, y - th - 2, f"B{v}", SCALE, C_BOTTOM)

    for i, v in enumerate(top_steps):
        y = v
        if y > H * 0.42:
            break
        screen.rect(int(W * 0.54), y, W - int(W * 0.54), THICK, C_TOP)
        font.draw(screen, int(W * 0.54) + 6, y + THICK + 2, f"T{v}", SCALE, C_TOP)

    for i, v in enumerate(left_steps):
        x = v
        if x > W * 0.42:
            break
        screen.rect(x, int(H * 0.30), THICK, int(H * 0.10), C_LEFT)
        font.draw(screen, x + THICK + 2, int(H * 0.40) + i * (th + 4), f"L{v}", SCALE, C_LEFT)

    for i, v in enumerate(right_steps):
        x = W - 1 - v - THICK
        if x < W * 0.58:
            break
        screen.rect(x, int(H * 0.60), THICK, int(H * 0.10), C_RIGHT)
        tw, _ = font.measure(f"R{v}", SCALE)
        font.draw(screen, x - tw - 4, int(H * 0.70) + i * (th + 4), f"R{v}", SCALE, C_RIGHT)

    print(f"fbruler: content {W}x{H} (rotate {screen.rot})", flush=True)
    print(f"  L/R ticks {left_steps}", flush=True)
    print(f"  T/B ticks {top_steps}", flush=True)
    print("Smallest visible tick per edge -> SPC_FB_INSET=left,top,right,bottom", flush=True)
    screen.close()


if __name__ == "__main__":
    main()
