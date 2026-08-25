#!/usr/bin/env python3
"""Rasterize a curated Chinese subset into spc-agent/cjk_font_data.py, matching
the console PSF font's cell geometry so spc_fb.py can draw mixed Latin+CJK
text with the same column-run technique it already uses for the console font.

spc_fb.py is deliberately stdlib-only at RUNTIME (no PIL, no browser -- see
its own docstring) so the Pi never needs a Chinese font installed or a
rasterizer on board. This script is the one place PIL is allowed: it runs
once, here on a dev machine, and its output is a plain Python data file of
packed 1bpp glyph bytes -- the same shape as the PSF glyphs spc_fb.py already
parses, just keyed by codepoint instead of by console code-page index.

    python3 gen_fb_cjk_font.py                     # uses ../listen_v2/tools/.cache/NotoSansSC.ttf
    python3 gen_fb_cjk_font.py --font /path/to/NotoSansSC.ttf

CELL GEOMETRY: the deployed kiosk font is Lat15-TerminusBold32x16.psf.gz
(16w x 32h). CJK glyphs are baked at 32x32 -- double-width, so a Chinese
character occupies exactly two Latin cells, the same convention every CJK
terminal font uses. spc_fb.py's Font class advances the pen by 1 cell for a
Latin glyph and 2 cells for a CJK one; if the deployed console font is ever
swapped for a different size, these glyphs no longer line up and need
re-baking with a matching CELL_H (see CELL_H below).

FIRST CUT of this was a ~150-character curated ordering/greeting subset,
mirroring listen_v2/tools/gen_cjk_font.py (the ESP32 kiosk screen's font).
That was wrong for this device: the OrangePi's captions mirror whatever the
agent actually says -- general conversation ("你好！我是 Claw，我已经准备好
了。请说话吧！"), not just ordering phrases -- and a hand-picked list turned
most of a real greeting into '?' soup (已经/准备/说话 and even the fullwidth
punctuation were missing). The ESP32 screen only ever shows curated order
confirmations, so its narrow list is still the right call there; it stays
unchanged. This device has no flash-size pressure (the Pi has ~200GB free),
so instead of guessing more words to add one at a time, this now bakes
GB2312's level-1 hanzi table -- the standard ~3755 most-frequent Simplified
Chinese characters, i.e. everyday-conversation coverage -- plus common
fullwidth punctuation. Anything rarer (obscure names, technical terms) still
round-trips through STT/TTS/the agent correctly; it just falls back to '?'
on THIS screen only.
"""

import argparse
import os
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

NOTO_SANS_SC_URL = ("https://raw.githubusercontent.com/google/fonts/main/"
                     "ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf")

# Must match the console font actually deployed on the kiosk (32px tall).
CELL_H = 32
CELL_W = 32   # double the Lat15-TerminusBold32x16 console font's 16px width
WEIGHT = "Bold"   # match TerminusBold, the loaded console face


def gb2312_level1_hanzi():
    """The ~3755 most-frequent Simplified Chinese characters: GB2312 areas
    16-55 (bytes 0xB0..0xD7 x 0xA1..0xFE), the standard "level 1" ordering
    every Chinese input method and font subset uses for common-word coverage.
    Decoded via Python's built-in gb2312 codec -- no download needed."""
    chars = []
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except (UnicodeDecodeError, LookupError):
                continue
            if len(ch) == 1 and 0x4E00 <= ord(ch) <= 0x9FFF:   # CJK Unified Ideographs
                chars.append(ch)
    return chars


# Fullwidth punctuation an LLM/TTS response actually uses in Chinese text.
PUNCTUATION = "，。！？：；“”‘’（）、…—～·"

# The original ordering/greeting curation, kept and unioned in rather than
# dropped -- cheap insurance in case a future glyph-hinting pass narrows the
# GB2312 table back down.
NUMBERS = "零一二三四五六七八九十百千两半几"
UNITS = "个杯碗份包份条块片粒"
GRAMMAR = ("我你他她它们的了吗呢吧啊哦是不没有要请问这那个什么样"
           "还多少点可以给来去走还有再一些点儿之和跟对啦哈嗯")
ORDER = ("买卖打包堂食吃喝叫换加减够完成确定好谢谢你好再见麻烦"
         "钱共总帮先等一下慢急快先生小姐老板")
FOOD = ("椰浆饭炒面粿条印度煎饼鸡蛋炸鸡沙爹肉牛猪鱼虾豆腐青菜汤饭面"
        "包水果汁茶奶咖啡冰热甜酸辣咸淡糖美禄龙拉红青柠水丝")
CURATED = NUMBERS + UNITS + GRAMMAR + ORDER + FOOD

CHARS = "".join(gb2312_level1_hanzi()) + PUNCTUATION + CURATED


def load_face(path, size, weight):
    f = ImageFont.truetype(path, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        axes = {"Thin": 100, "ExtraLight": 200, "Light": 300, "Regular": 400,
                "Medium": 500, "SemiBold": 600, "Bold": 700, "ExtraBold": 800,
                "Black": 900}
        try:
            f.set_variation_by_axes([float(axes[weight])])
        except Exception:
            print(f"  ! no variation support, using default weight for {weight}")
    return f


def rasterize(face, ch):
    """Render one glyph into a CELL_W x CELL_H monochrome, row-packed bitmap
    -- the exact byte shape PSF glyphs already have (row_bytes = ceil(w/8)),
    so spc_fb.py's existing column-run walk works on it unmodified."""
    img = Image.new("L", (CELL_W, CELL_H), 0)
    draw = ImageDraw.Draw(img)
    # Oversample at 2x then threshold down -- a straight 1-bit render of a
    # 32px CJK glyph is too thin/broken to read from across a counter.
    big = Image.new("L", (CELL_W * 2, CELL_H * 2), 0)
    ImageDraw.Draw(big).text((CELL_W, CELL_H), ch, font=face, fill=255, anchor="mm")
    img = big.resize((CELL_W, CELL_H), Image.LANCZOS)

    row_bytes = (CELL_W + 7) // 8
    out = bytearray(row_bytes * CELL_H)
    px = img.load()
    for y in range(CELL_H):
        for x in range(CELL_W):
            if px[x, y] >= 128:
                out[y * row_bytes + (x >> 3)] |= 0x80 >> (x & 7)
    return bytes(out)


def emit(out_path, entries):
    with open(out_path, "w") as out:
        out.write(f"# Generated by {os.path.basename(__file__)} -- do not edit.\n")
        out.write("# Noto Sans SC (SIL Open Font License 1.1), rasterized to 1bpp,\n")
        out.write("# row-packed the same way spc_fb.py's PSF glyphs are.\n")
        out.write("# Curated subset -- see gen_fb_cjk_font.py's CHARS for what's covered.\n\n")
        out.write(f"CELL_W = {CELL_W}\n")
        out.write(f"CELL_H = {CELL_H}\n\n")
        out.write("# (codepoint, row-packed glyph bytes), sorted ascending -- spc_fb.py\n")
        out.write("# binary-searches this the same way ui_font_cjk.c does on the ESP32.\n")
        out.write("GLYPHS = [\n")
        for cp, data in entries:
            ch = chr(cp)
            out.write(f"    (0x{cp:04X}, {data!r}),  # {ch}\n")
        out.write("]\n")

    size = os.path.getsize(out_path)
    print(f"wrote {out_path} ({size} bytes, {len(entries)} glyphs)")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--font", default=os.path.join(
        here, os.pardir, "listen_v2", "tools", ".cache", "NotoSansSC.ttf"))
    ap.add_argument("--out", default=os.path.join(here, "cjk_font_data.py"))
    args = ap.parse_args()

    font_path = os.path.abspath(args.font)
    if not os.path.exists(font_path):
        os.makedirs(os.path.dirname(font_path), exist_ok=True)
        print(f"downloading Noto Sans SC -> {font_path}")
        urllib.request.urlretrieve(NOTO_SANS_SC_URL, font_path)

    face = load_face(font_path, CELL_H, WEIGHT)

    seen = set()
    entries = []
    for ch in sorted(set(CHARS)):
        cp = ord(ch)
        if cp in seen:
            continue
        seen.add(cp)
        entries.append((cp, rasterize(face, ch)))
    entries.sort(key=lambda e: e[0])

    print(f"CJK fb font  {CELL_W}x{CELL_H}  {len(entries)} glyphs")
    emit(os.path.abspath(args.out), entries)
    return 0


if __name__ == "__main__":
    sys.exit(main())
