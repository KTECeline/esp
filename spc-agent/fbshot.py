#!/usr/bin/env python3
"""Capture /dev/fb0 to /tmp/fbshot.png — how you see the panel from another machine.

Stdlib-only PNG writer, because these boards have no Pillow and no working pip.

    python3 fbshot.py          # 1:3, small and quick — layout checks
    python3 fbshot.py 1        # 1:1, full resolution — needed to READ text
    python3 fbshot.py 2 /tmp/x.png

Downsampling defaults to 3 since a full-res 32bpp grab is ~9x the pixels to
compress in pure Python; ask for 1 only when the detail actually matters.
"""
import sys
import zlib
import struct

step = int(sys.argv[1]) if len(sys.argv) > 1 else 3
out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/fbshot.png"
step = max(1, step)

w, h = [int(v) for v in open("/sys/class/graphics/fb0/virtual_size").read().strip().split(",")]
stride = int(open("/sys/class/graphics/fb0/stride").read())
raw = open("/dev/fb0", "rb").read(stride * h)
ow, oh = w // step, h // step

rows = bytearray()
for y in range(oh):
    rows += b"\x00"
    base = y * step * stride
    if step == 1:
        # Whole scanline in one slice: the per-pixel loop below is the slow part,
        # and at 1:1 it is 600 rows x 1024 pixels of Python.
        line = raw[base:base + w * 4]
        rows += bytes(b for i in range(0, w * 4, 4) for b in (line[i + 2], line[i + 1], line[i]))
    else:
        for x in range(ow):
            o = base + x * step * 4
            rows += bytes((raw[o + 2], raw[o + 1], raw[o]))


def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)


png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", ow, oh, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b""))
open(out, "wb").write(png)
print(f"captured {ow}x{oh} (step {step}) -> {out}")
