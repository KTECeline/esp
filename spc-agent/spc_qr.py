#!/usr/bin/env python3
"""spc-qr — a byte-mode QR encoder, error-correction level M, versions 1-40.

The framebuffer face (spc_fb.py) is the renderer physically on the glass of the
kiosk panels, and until now it could not draw a real QR code — it printed the
payload as text and left the customer to type it. This is the missing encoder.

It is a direct port of the JavaScript `QR` module inside spc_face.py (the browser
renderer), kept deliberately line-for-line so the two cannot drift: a panel
showing spc_fb.py and a laptop showing /face must produce the *same* symbol, and
so must a code shown on an ESP box, which encodes through espressif/qrcode the
same way. The JS side is contract-tested by round trip in
mcp-core/test/face-qr.test.mjs; the equivalent check for this file is
mcp-core/test/fb-qr.test.mjs, which compares the two encoders module for module.

Implements ISO/IEC 18004 directly. Stdlib only — no pip, nothing fetched — the
same constraint as the rest of spc-agent, because the kiosk Pi may have no
internet.

    from spc_qr import modules
    grid = modules("https://pay.example.my/tng?ref=RM13.50")   # list[list[int]] or None

`modules(text)` returns a square list of 0/1 rows (1 == dark), or None when the
payload is too long for any version to hold.
"""

import math

# Per-version tables for error-correction level M. Index by version (1-40);
# element 0 is a placeholder so the version number indexes directly.
ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24,
                 28, 28, 26, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
                 28, 28, 28, 28, 28, 28, 28, 28, 28]
NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14,
              16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40,
              43, 45, 47, 49]


def _raw_data_modules(ver):
    n = (16 * ver + 128) * ver + 64
    if ver >= 2:
        num_align = ver // 7 + 2
        n -= (25 * num_align - 10) * num_align - 55
        if ver >= 7:
            n -= 36
    return n


def _data_codeword_count(ver):
    return _raw_data_modules(ver) // 8 - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver]


def _align_positions(ver):
    if ver == 1:
        return []
    num_align = ver // 7 + 2
    step = 26 if ver == 32 else math.ceil((ver * 4 + 4) / (num_align * 2 - 2)) * 2
    out = [6]
    pos = ver * 4 + 10
    while len(out) < num_align:
        out.insert(1, pos)
        pos -= step
    return out


# -- GF(256) arithmetic, primitive polynomial 0x11d --------------------------
#
# The bit-8 cancellation in _gf_mul keeps z in [0, 255] at the end of every
# iteration without an explicit mask (see the JS original's assertion): when
# bit 7 of z is set, `z << 1` sets bit 8 and XOR-ing 0x11d (which also has bit 8
# set) clears it again. Ported unchanged so the two encoders stay identical.

def _gf_mul(x, y):
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11d)
        z ^= ((y >> i) & 1) * x
    return z & 0xff


def _rs_divisor(degree):
    out = [0] * degree
    out[degree - 1] = 1
    root = 1
    for _ in range(degree):
        for j in range(degree):
            out[j] = _gf_mul(out[j], root)
            if j + 1 < degree:
                out[j] ^= out[j + 1]
        root = _gf_mul(root, 0x02)
    return out


def _rs_remainder(data, divisor):
    out = [0] * len(divisor)
    for b in data:
        factor = b ^ out[0]
        del out[0]
        out.append(0)
        for i in range(len(out)):
            out[i] ^= _gf_mul(divisor[i], factor)
    return out


def _data_codewords(data_bytes, ver):
    """Bit stream -> data codewords for `ver`, or None if the payload overflows."""
    capacity_bits = _data_codeword_count(ver) * 8
    bits = []

    def push(value, length):
        for i in range(length - 1, -1, -1):
            bits.append((value >> i) & 1)

    push(0b0100, 4)                              # byte mode
    push(len(data_bytes), 8 if ver <= 9 else 16)  # character count (UTF-8 bytes)
    for b in data_bytes:
        push(b, 8)
    if len(bits) > capacity_bits:
        return None
    push(0, min(4, capacity_bits - len(bits)))   # terminator
    while len(bits) % 8 != 0:
        bits.append(0)
    words = []
    for i in range(0, len(bits), 8):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | bits[i + j]
        words.append(byte)
    pad = 0xec
    while len(words) < capacity_bits // 8:
        words.append(pad)
        pad ^= 0xec ^ 0x11                        # alternate 0xEC / 0x11
    return words


def _interleave(words, ver):
    num_blocks = NUM_BLOCKS[ver]
    ecc_len = ECC_PER_BLOCK[ver]
    raw_words = _raw_data_modules(ver) // 8
    num_short = num_blocks - (raw_words % num_blocks)
    short_len = raw_words // num_blocks - ecc_len
    divisor = _rs_divisor(ecc_len)
    blocks = []
    k = 0
    for i in range(num_blocks):
        length = short_len + (0 if i < num_short else 1)
        dat = words[k:k + length]
        k += length
        blocks.append((dat, _rs_remainder(dat, divisor)))
    out = []
    for i in range(short_len + 1):
        for dat, _ecc in blocks:
            if i < len(dat):
                out.append(dat[i])
    for i in range(ecc_len):
        for _dat, ecc in blocks:
            out.append(ecc[i])
    return out


def _mask_bit(mask, x, y):
    if mask == 0:
        return (x + y) % 2 == 0
    if mask == 1:
        return y % 2 == 0
    if mask == 2:
        return x % 3 == 0
    if mask == 3:
        return (x + y) % 3 == 0
    if mask == 4:
        return (x // 3 + y // 2) % 2 == 0
    if mask == 5:
        return (x * y) % 2 + (x * y) % 3 == 0
    if mask == 6:
        return ((x * y) % 2 + (x * y) % 3) % 2 == 0
    return ((x + y) % 2 + (x * y) % 3) % 2 == 0


def _draw_format(grid, mask):
    size = len(grid)
    data = (0b00 << 3) | mask                     # 00 == level M
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    bits = ((data << 10) | rem) ^ 0b101010000010010
    # grid is [y][x]. First copy hugs the top-left finder; the second is split
    # between the other two corners.
    for i in range(6):
        grid[i][8] = (bits >> i) & 1
    grid[7][8] = (bits >> 6) & 1
    grid[8][8] = (bits >> 7) & 1
    grid[8][7] = (bits >> 8) & 1
    for i in range(9, 15):
        grid[8][14 - i] = (bits >> i) & 1
    for i in range(8):
        grid[size - 1 - i][8] = (bits >> i) & 1
    for i in range(8, 15):
        grid[8][size - 15 + i] = (bits >> i) & 1
    grid[size - 8][8] = 1


def _penalty(grid):
    size = len(grid)
    score = 0

    def runs(line):
        s = 0
        run = 1
        for i in range(1, len(line) + 1):
            if i < len(line) and line[i] == line[i - 1]:
                run += 1
                continue
            if run >= 5:
                s += 3 + (run - 5)
            run = 1
        return s

    pattern = [1, 0, 1, 1, 1, 0, 1]

    def finderish(line, at):
        for k in range(7):
            if line[at + k] != pattern[k]:
                return False
        before = line[max(0, at - 4):at]
        after = line[at + 7:at + 11]
        clear = lambda side: len(side) >= 4 and all(v == 0 for v in side)
        return clear(before) or clear(after)

    for i in range(size):
        row = list(grid[i])
        col = [grid[j][i] for j in range(size)]
        score += runs(row) + runs(col)
        for at in range(0, size - 6):
            if finderish(row, at):
                score += 40
            if finderish(col, at):
                score += 40
    for y in range(size - 1):
        for x in range(size - 1):
            c = grid[y][x]
            if c == grid[y][x + 1] and c == grid[y + 1][x] and c == grid[y + 1][x + 1]:
                score += 3
    dark = sum(sum(row) for row in grid)
    total = size * size
    score += (abs(dark * 20 - total * 10) * 10 // total) * 10
    return score


def modules(text):
    """A square list of 0/1 rows for `text`, or None when it does not fit."""
    data_bytes = list(text.encode("utf-8"))
    words = None
    ver = 1
    while ver <= 40:
        words = _data_codewords(data_bytes, ver)
        if words:
            break
        ver += 1
    if not words:
        return None

    size = ver * 4 + 17
    grid = [[0] * size for _ in range(size)]
    fixed = [[0] * size for _ in range(size)]

    def setm(x, y, dark):
        grid[y][x] = 1 if dark else 0
        fixed[y][x] = 1

    # Finder patterns at the three corners.
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if x < 0 or y < 0 or x >= size or y >= size:
                    continue
                d = max(abs(dx), abs(dy))
                setm(x, y, d != 2 and d <= 3)
    # Timing patterns, between the finders only.
    for i in range(8, size - 8):
        setm(6, i, i % 2 == 0)
        setm(i, 6, i % 2 == 0)
    # Alignment patterns.
    pos = _align_positions(ver)
    for i in range(len(pos)):
        for j in range(len(pos)):
            corner = ((i == 0 and j == 0)
                      or (i == 0 and j == len(pos) - 1)
                      or (i == len(pos) - 1 and j == 0))
            if corner:
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    setm(pos[j] + dx, pos[i] + dy, max(abs(dx), abs(dy)) != 1)
    # Reserve the format-info modules.
    for i in range(9):
        if i != 6:
            fixed[8][i] = 1
            fixed[i][8] = 1
    fixed[8][8] = 1
    for i in range(8):
        fixed[size - 1 - i][8] = 1
        fixed[8][size - 1 - i] = 1
    setm(8, size - 8, True)                       # dark module
    # Version info (v7+).
    if ver >= 7:
        rem = ver
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1f25)
        bits = (ver << 12) | rem
        for i in range(18):
            bit = ((bits >> i) & 1) == 1
            a = size - 11 + (i % 3)
            b = i // 3
            setm(a, b, bit)
            setm(b, a, bit)

    # Lay the data/ECC stream in the zigzag.
    codes = _interleave(words, ver)
    bit = 0
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                upward = ((right + 1) & 2) == 0
                y = size - 1 - vert if upward else vert
                if fixed[y][x]:
                    continue
                idx = bit >> 3
                byte = codes[idx] if idx < len(codes) else None
                grid[y][x] = 0 if byte is None else (byte >> (7 - (bit & 7))) & 1
                bit += 1
        right -= 2

    # Try every mask, keep the lowest-penalty result.
    best = None
    for mask in range(8):
        candidate = [row[:] for row in grid]
        for y in range(size):
            for x in range(size):
                if not fixed[y][x] and _mask_bit(mask, x, y):
                    candidate[y][x] ^= 1
        _draw_format(candidate, mask)
        sc = _penalty(candidate)
        if best is None or sc < best[0]:
            best = (sc, candidate)
    return best[1]


if __name__ == "__main__":
    import sys
    payload = sys.argv[1] if len(sys.argv) > 1 else "ORDER-4417"
    grid = modules(payload)
    if grid is None:
        print("(too long to encode)")
        raise SystemExit(1)
    for row in grid:
        print("".join("##" if v else "  " for v in row))
