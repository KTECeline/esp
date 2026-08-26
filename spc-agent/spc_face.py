"""The OrangePi's face — the page a kiosk browser renders full-screen.

Kept apart from spc_agent.py because it is markup, not a service: mixing 500
lines of CSS and SVG into the HTTP layer would bury the six routes that file
exists for. It is a Python module rather than a .html file so the agent stays
deployable as plain source files with no static directory to get out of sync —
spc_agent.py imports FACE_HTML and serves it from memory.

Two halves, stacked for a portrait panel:

  upper   the face. Eyes, brows and mouth as stroked SVG, driven by the
          `expression` field. Never static — it blinks and breathes on its own,
          because a frozen face reads as a crashed screen.
  lower   the panel. One layout per `panel.mode`: a spoken message, a QR code,
          choice tiles, or an order summary.

The page owns no state. It long-polls /display/state and redraws; every decision
about what to show was made by the model that called spc_expression. That is
also why it is safe to open on a laptop — it is a viewer, not a controller.

Nothing is fetched from the network, including the QR encoder, because the Pi
this runs on may well have no route off the tailnet.
"""

from spc_faceparts import FACE_PARTS_JS

_FACE_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>spc-agent face</title>
<style>
  :root {
    --ink: #34d0ff;              /* the face's colour; expressions may override */
    --glow: rgba(52, 208, 255, 0.55);
    --bg-face: #04080f;
    --bg-panel: #060d1a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    background: var(--bg-panel);
    color: #eaf4ff;
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
                 "Noto Sans SC", "PingFang SC", "Microsoft YaHei",
                 "WenQuanYi Micro Hei", sans-serif;
    overflow: hidden;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  body { display: flex; flex-direction: column; }

  /* ---- upper: the face -------------------------------------------------- */
  #face {
    flex: 45 1 0;
    min-height: 0;
    background: radial-gradient(ellipse at 50% 45%, #0a1830 0%, var(--bg-face) 70%);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  #face svg { width: 100%; height: 100%; }
  .stroke {
    fill: none;
    stroke: var(--ink);
    stroke-width: 13;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 10px var(--glow));
    transition: stroke 400ms ease;
  }
  .glint { fill: var(--ink); stroke: none; filter: drop-shadow(0 0 6px var(--glow)); }

  /* The whole head breathes, so the panel below never looks like the only live
     thing on the screen. */
  #head { animation: breathe 5.5s ease-in-out infinite; transform-origin: 200px 150px; }
  @keyframes breathe {
    0%, 100% { transform: scale(1) translateY(0); }
    50%      { transform: scale(1.02) translateY(-4px); }
  }

  /* Blink and expression change are the same motion: the eyes squash shut, the
     new shape is swapped in while nothing can be seen, and they open again.
     That sidesteps path interpolation entirely — any expression can follow any
     other without a morph that browsers may or may not tween. */
  .eye-group { transform-origin: center; }
  #eyeL { transform-origin: 128px 134px; }   /* must match EYE_AT below */
  #eyeR { transform-origin: 272px 134px; }
  .blink { animation: blink 260ms ease-in-out; }
  @keyframes blink {
    0%, 100% { transform: scaleY(1); }
    45%, 55% { transform: scaleY(0.06); }
  }

  #pupils { transition: transform 500ms cubic-bezier(.34,1.3,.4,1); }

  /* Listening: a slow pulse around the head, so someone can tell across a room
     that the thing is waiting for them to talk. */
  #aura { fill: none; stroke: var(--ink); stroke-width: 3; opacity: 0; transform-origin: 200px 150px; }
  body[data-expression="listening"] #aura { animation: aura 2.4s ease-out infinite; }
  @keyframes aura {
    0%   { opacity: 0.45; transform: scale(0.86); }
    100% { opacity: 0;    transform: scale(1.12); }
  }

  /* Speaking: the mouth works. Cheap, and reads correctly from two metres. */
  body[data-expression="speaking"] #mouth { animation: talk 420ms ease-in-out infinite; transform-origin: 200px 232px; }
  @keyframes talk {
    0%, 100% { transform: scaleY(0.55); }
    50%      { transform: scaleY(1.35); }
  }

  /* An expression's colour comes from its JSON "ink" field, applied to the body
     as an inline custom property by drawFace(). error's red and sleeping's blue
     used to be two CSS rules keyed on those two names — which is precisely why
     an eleventh face could not have had a colour of its own. */

  #zzz { opacity: 0; transition: opacity 600ms ease; }
  body[data-expression="sleeping"] #zzz { opacity: 1; }
  #zzz text { fill: var(--ink); font-size: 26px; font-weight: 700; opacity: 0.9; }
  #zzz text:nth-child(1) { animation: float 3s ease-in-out infinite; }
  #zzz text:nth-child(2) { animation: float 3s ease-in-out infinite 1s; }
  #zzz text:nth-child(3) { animation: float 3s ease-in-out infinite 2s; }
  @keyframes float {
    0%   { opacity: 0; transform: translate(0, 8px) scale(0.8); }
    35%  { opacity: 0.9; }
    100% { opacity: 0; transform: translate(14px, -26px) scale(1.1); }
  }

  #dots { opacity: 0; transition: opacity 300ms ease; }
  body[data-expression="thinking"] #dots { opacity: 1; }
  #dots circle { fill: var(--ink); }
  #dots circle:nth-child(1) { animation: bob 1.2s ease-in-out infinite; }
  #dots circle:nth-child(2) { animation: bob 1.2s ease-in-out infinite .2s; }
  #dots circle:nth-child(3) { animation: bob 1.2s ease-in-out infinite .4s; }
  @keyframes bob { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }

  /* ---- lower: the panel ------------------------------------------------- */
  #panel {
    flex: 55 1 0;
    min-height: 0;
    padding: 3vmin;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2.2vmin;
  }
  /* The card hugs its content and is centred in the panel: a two-line greeting
     floating in the middle of a full-height box reads as a layout that failed
     to load. */
  .card {
    background: linear-gradient(180deg, #14356b 0%, #0b2247 100%);
    border: 1px solid rgba(120, 190, 255, 0.18);
    border-radius: 3.2vmin;
    box-shadow: 0 1.4vmin 3vmin rgba(0, 0, 0, 0.45);
    padding: 4.5vmin 3.4vmin;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    flex: 0 1 auto;
    max-height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  .title {
    font-size: clamp(24px, 7vmin, 64px);
    font-weight: 800;
    letter-spacing: -0.01em;
    line-height: 1.12;
  }
  .subtitle {
    margin-top: 1.4vmin;
    font-size: clamp(15px, 4.2vmin, 38px);
    font-weight: 500;
    color: #a9cdf0;
    line-height: 1.3;
  }

  /* QR: caption left, code right, the way the reference kiosk lays it out. It
     collapses to a stack when the panel is too narrow to read both. */
  .qr-row { display: flex; align-items: center; justify-content: center; gap: 3.5vmin; width: 100%; }
  .qr-row.stacked { flex-direction: column; gap: 2vmin; }
  .qr-caption { font-size: clamp(18px, 4.4vmin, 44px); font-weight: 800; line-height: 1.15; }
  .qr-box {
    background: #fff;
    border-radius: 1.6vmin;
    padding: 1.4vmin;
    flex: 0 0 auto;
    display: flex;
  }
  .qr-box svg { width: 100%; height: 100%; display: block; shape-rendering: crispEdges; }
  .qr-fallback { font-size: clamp(12px, 2.4vmin, 22px); color: #ffd9d9; word-break: break-all; }

  .tiles { display: grid; gap: 2.4vmin; width: 100%; grid-template-columns: repeat(2, 1fr); }
  .tiles.one { grid-template-columns: 1fr; }
  .tile {
    background: #f2f7ff;
    color: #10305e;
    border-radius: 2.4vmin;
    padding: 2.4vmin 1.6vmin;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1vmin;
    min-height: 14vmin;
    box-shadow: inset 0 -0.6vmin 0 rgba(16, 48, 94, 0.12);
  }
  .tile .icon { font-size: clamp(24px, 6vmin, 62px); line-height: 1; }
  .tile .label { font-size: clamp(14px, 3.1vmin, 30px); font-weight: 700; text-align: center; }

  .order { width: 100%; display: flex; flex-direction: column; gap: 1vmin; }
  .order .row { display: flex; justify-content: space-between; gap: 2vmin; font-size: clamp(15px, 3.4vmin, 32px); }
  .order .row .name { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .order .row .price { font-variant-numeric: tabular-nums; color: #cfe6ff; }
  .order .total {
    margin-top: 1.4vmin;
    padding-top: 1.6vmin;
    border-top: 1px solid rgba(140, 200, 255, 0.28);
    font-weight: 800;
    font-size: clamp(18px, 4.2vmin, 40px);
  }
  .order .note { margin-top: 1.4vmin; color: #a9cdf0; font-size: clamp(13px, 2.8vmin, 26px); }

  #panel.blank .card { display: none; }

  /* A dead agent must not look like a blank panel — this is the difference
     between "nothing to show" and "nobody is home". */
  #offline {
    position: fixed;
    right: 1.6vmin;
    bottom: 1.6vmin;
    width: 1.6vmin;
    height: 1.6vmin;
    min-width: 8px;
    min-height: 8px;
    border-radius: 50%;
    background: #ff5b5b;
    box-shadow: 0 0 12px rgba(255, 91, 91, 0.8);
    opacity: 0;
    transition: opacity 400ms ease;
  }
  body.offline #offline { opacity: 1; }
</style>
</head>
<body data-expression="neutral">

<div id="face">
  <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <circle id="aura" cx="200" cy="150" r="140"></circle>
    <g id="head">
      <path id="browL" class="stroke"></path>
      <path id="browR" class="stroke"></path>
      <g id="pupils">
        <g id="eyeL" class="eye-group"><path id="eyeLp" class="stroke"></path><g id="glintL"></g></g>
        <g id="eyeR" class="eye-group"><path id="eyeRp" class="stroke"></path><g id="glintR"></g></g>
      </g>
      <path id="mouth" class="stroke"></path>
      <g id="dots">
        <circle cx="336" cy="36" r="7"></circle>
        <circle cx="358" cy="36" r="7"></circle>
        <circle cx="380" cy="36" r="7"></circle>
      </g>
      <g id="zzz">
        <text x="330" y="76">z</text>
        <text x="350" y="60">z</text>
        <text x="370" y="44">z</text>
      </g>
    </g>
  </svg>
</div>

<div id="panel"><div class="card" id="card"></div></div>
<div id="offline"></div>

<script>
// ---------------------------------------------------------------------------
// QR encoder — byte mode, error correction level M, versions 1-40.
// Implements ISO/IEC 18004 directly; no dependency, nothing fetched. The ESP
// box encodes the same way through espressif/qrcode, so a code shown here and
// one shown on a box are the same code.
// ---------------------------------------------------------------------------
const QR = (() => {
  const ECC_PER_BLOCK = [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,
                         26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28];
  const NUM_BLOCKS    = [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,
                         16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49];

  const rawDataModules = (ver) => {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      n -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  };
  const dataCodewordCount = (ver) =>
    Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

  const alignPositions = (ver) => {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const out = [6];
    for (let pos = ver * 4 + 10; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
    return out;
  };

  const gfMul = (x, y) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  };
  const rsDivisor = (degree) => {
    const out = new Uint8Array(degree);
    out[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        out[j] = gfMul(out[j], root);
        if (j + 1 < degree) out[j] ^= out[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return out;
  };
  const rsRemainder = (data, divisor) => {
    const out = new Uint8Array(divisor.length);
    for (const b of data) {
      const factor = b ^ out[0];
      out.copyWithin(0, 1);
      out[out.length - 1] = 0;
      for (let i = 0; i < out.length; i++) out[i] ^= gfMul(divisor[i], factor);
    }
    return out;
  };

  const dataCodewords = (bytes, ver) => {
    const capacityBits = dataCodewordCount(ver) * 8;
    const bits = [];
    const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);                          // byte mode
    push(bytes.length, ver <= 9 ? 8 : 16);    // character count
    for (const b of bytes) push(b, 8);
    if (bits.length > capacityBits) return null;
    push(0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      words.push(byte);
    }
    for (let pad = 0xec; words.length < capacityBits / 8; pad ^= 0xec ^ 0x11) words.push(pad);
    return words;
  };

  const interleave = (words, ver) => {
    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const rawWords = Math.floor(rawDataModules(ver) / 8);
    const numShort = numBlocks - (rawWords % numBlocks);
    const shortLen = Math.floor(rawWords / numBlocks) - eccLen;
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const len = shortLen + (i < numShort ? 0 : 1);
      const dat = words.slice(k, k + len);
      k += len;
      blocks.push({ dat, ecc: rsRemainder(dat, divisor) });
    }
    const out = [];
    for (let i = 0; i < shortLen + 1; i++) {
      for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
    }
    for (let i = 0; i < eccLen; i++) {
      for (const b of blocks) out.push(b.ecc[i]);
    }
    return out;
  };

  const maskBit = (mask, x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };

  const drawFormat = (grid, mask) => {
    const size = grid.length;
    const data = (0b00 << 3) | mask;   // 00 = level M
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0b101010000010010;
    // grid is [y][x]. First copy hugs the top-left finder; second is split
    // between the other two corners.
    for (let i = 0; i <= 5; i++) grid[i][8] = (bits >>> i) & 1;
    grid[7][8] = (bits >>> 6) & 1;
    grid[8][8] = (bits >>> 7) & 1;
    grid[8][7] = (bits >>> 8) & 1;
    for (let i = 9; i < 15; i++) grid[8][14 - i] = (bits >>> i) & 1;
    for (let i = 0; i < 8; i++) grid[size - 1 - i][8] = (bits >>> i) & 1;
    for (let i = 8; i < 15; i++) grid[8][size - 15 + i] = (bits >>> i) & 1;
    grid[size - 8][8] = 1;
  };

  const penalty = (grid) => {
    const size = grid.length;
    let score = 0;
    const runs = (line) => {
      let s = 0, run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) { run++; continue; }
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
      return s;
    };
    for (let i = 0; i < size; i++) {
      const row = Array.from(grid[i]);
      const col = [];
      for (let j = 0; j < size; j++) col.push(grid[j][i]);
      score += runs(row) + runs(col);
      const pattern = [1, 0, 1, 1, 1, 0, 1];
      const finderish = (line, at) => {
        for (let k = 0; k < 7; k++) if (line[at + k] !== pattern[k]) return false;
        const before = line.slice(Math.max(0, at - 4), at);
        const after = line.slice(at + 7, at + 11);
        const clear = (side) => side.length >= 4 && side.every((v) => v === 0);
        return clear(before) || clear(after);
      };
      for (let at = 0; at + 7 <= size; at++) {
        if (finderish(row, at)) score += 40;
        if (finderish(col, at)) score += 40;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = grid[y][x];
        if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of grid) for (const v of row) dark += v;
    const total = size * size;
    score += Math.floor((Math.abs(dark * 20 - total * 10) * 10) / total) * 10;
    return score;
  };

  // Returns a square array of 0/1 rows, or null when the text does not fit.
  const modules = (text) => {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1, words = null;
    for (; ver <= 40; ver++) {
      words = dataCodewords(bytes, ver);
      if (words) break;
    }
    if (!words) return null;

    const size = ver * 4 + 17;
    const grid = Array.from({ length: size }, () => new Uint8Array(size));
    const fixed = Array.from({ length: size }, () => new Uint8Array(size));
    const set = (x, y, dark) => { grid[y][x] = dark ? 1 : 0; fixed[y][x] = 1; };

    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d <= 3);
        }
      }
    }
    for (let i = 8; i < size - 8; i++) {   // timing, between the finders only
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    const pos = alignPositions(ver);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const corner = (i === 0 && j === 0) ||
                       (i === 0 && j === pos.length - 1) ||
                       (i === pos.length - 1 && j === 0);
        if (corner) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            set(pos[j] + dx, pos[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    for (let i = 0; i <= 8; i++) {          // reserve format info
      if (i !== 6) { fixed[8][i] = 1; fixed[i][8] = 1; }
    }
    fixed[8][8] = 1;
    for (let i = 0; i < 8; i++) { fixed[size - 1 - i][8] = 1; fixed[8][size - 1 - i] = 1; }
    set(8, size - 8, true);                 // dark module
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(a, b, bit);
        set(b, a, bit);
      }
    }

    const codes = interleave(words, ver);
    let bit = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (fixed[y][x]) continue;
          const byte = codes[bit >>> 3];
          grid[y][x] = byte === undefined ? 0 : (byte >>> (7 - (bit & 7))) & 1;
          bit++;
        }
      }
    }

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = grid.map((row) => Uint8Array.from(row));
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (!fixed[y][x] && maskBit(mask, x, y)) candidate[y][x] ^= 1;
        }
      }
      drawFormat(candidate, mask);
      const score = penalty(candidate);
      if (!best || score < best.score) best = { score, grid: candidate };
    }
    return best.grid;
  };

  // An SVG string. The quiet zone is part of the code, not decoration: a QR
  // butted against a coloured card is one a phone will refuse to read.
  const svg = (text) => {
    const grid = modules(text);
    if (!grid) return null;
    const size = grid.length;
    const quiet = 4;
    const dim = size + quiet * 2;
    let path = "";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (grid[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    }
    return `<svg viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg">` +
           `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
           `<path d="${path}" fill="#000"/></svg>`;
  };

  return { modules, svg };
})();

// ---------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------
__FACE_PARTS__

const el = (id) => document.getElementById(id);

function setEye(which, shape) {
  const [cx, cy] = EYE_AT[which];
  const path = el(which === "left" ? "eyeLp" : "eyeRp");
  path.setAttribute("d", shapePath(shape, EYE) || "");
  path.setAttribute("transform", `translate(${cx} ${cy})`);
  // The two highlight dots only make sense on an eye with an inside, and they
  // are placed as fractions of it so a narrow eye does not wear them outside
  // its own outline. A custom rounded_rect eye gets them on the same terms.
  const glint = el(which === "left" ? "glintL" : "glintR");
  const size = typeof shape === "string"
    ? EYE_SIZE[shape]
    : (shape && shape.rounded_rect ? [shape.rounded_rect.w, shape.rounded_rect.h] : null);
  glint.innerHTML = size
    ? `<circle cx="${cx - size[0] * 0.19}" cy="${cy - size[1] * 0.2}" r="9" class="glint"></circle>` +
      `<circle cx="${cx + size[0] * 0.12}" cy="${cy + size[1] * 0.03}" r="5" class="glint"></circle>`
    : "";
}

function setBrow(which, shape) {
  const [cx, cy] = BROW_AT[which];
  const path = el(which === "left" ? "browL" : "browR");
  path.setAttribute("d", shapePath(shape, BROW) || "");
  path.setAttribute("transform", `translate(${cx} ${cy})`);
}

let currentExpression = null;

function faceSpec(expression) {
  return EXPRESSIONS[expression] || EXPRESSIONS.neutral;
}

function drawFace(expression, gaze) {
  const spec = faceSpec(expression);
  const eyes = spec.eyes || {};
  setEye("left", eyes.left);
  setEye("right", eyes.right);
  setBrow("left", spec.brow);
  setBrow("right", spec.brow);
  el("mouth").setAttribute("d", shapePath(spec.mouth, MOUTH) || "");
  // Removed rather than set to "" for a named mouth, so the markup a builtin
  // produces stays exactly what it has always been.
  const shift = mouthTransform(spec.mouth);
  if (shift) el("mouth").setAttribute("transform", shift);
  else el("mouth").removeAttribute("transform");
  // An explicit gaze wins; "center" is the absence of one, so an expression
  // that looks somewhere by nature (thinking looks up) still gets to.
  const chosen = gaze && gaze !== "center" ? gaze : (spec.gaze || "center");
  const [gx, gy] = GAZE[chosen] || GAZE.center;
  el("pupils").setAttribute("transform", `translate(${gx} ${gy})`);
  // An expression's colour is its own field now, so a user's file can be
  // orange. The CSS rules that hardcoded error's red and sleeping's blue
  // against those two names are gone; these two properties are what replaced
  // them, and clearing them falls back to the stylesheet's cyan.
  document.body.style.setProperty("--ink", spec.ink || "");
  document.body.style.setProperty("--glow", spec.ink ? hexGlow(spec.ink) : "");
  document.body.dataset.expression = expression;
}

function blink(then) {
  for (const id of ["eyeL", "eyeR"]) {
    const node = el(id);
    node.classList.remove("blink");
    node.getBoundingClientRect();   // forces a reflow, which restarts it
    node.classList.add("blink");
  }
  // Swapped at the midpoint, while the eyes are shut.
  setTimeout(then, 118);
}

function applyFace(expression, gaze) {
  if (expression === currentExpression) {
    drawFace(expression, gaze);     // gaze-only change: no blink
    return;
  }
  currentExpression = expression;
  blink(() => drawFace(expression, gaze));
}

// Idle blinking. Irregular on purpose — a metronome blink is unsettling.
function scheduleBlink() {
  const wait = 2600 + Math.random() * 4200;
  setTimeout(() => {
    if (faceSpec(currentExpression).blink !== false) blink(() => {});
    scheduleBlink();
  }, wait);
}
scheduleBlink();

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderPanel(panel) {
  const mode = (panel && panel.mode) || "blank";
  const root = el("panel");
  const card = el("card");
  root.className = mode === "blank" ? "blank" : "";
  if (mode === "blank") { card.innerHTML = ""; return; }

  if (mode === "message") {
    // A subtitle with no title is the whole message — what spc_speak mirrors
    // when it puts the words it is saying on screen. It gets title treatment,
    // or the spoken line would be the smallest type on the panel.
    const lone = !panel.title && panel.subtitle;
    card.innerHTML =
      (panel.title ? `<div class="title">${escapeHtml(panel.title)}</div>` : "") +
      (panel.subtitle
        ? `<div class="${lone ? "title" : "subtitle"}">${escapeHtml(panel.subtitle)}</div>`
        : "");
    return;
  }

  if (mode === "qr") {
    const code = QR.svg(panel.qr_data || "");
    const side = Math.min(window.innerWidth, window.innerHeight) * (panel.qr_caption ? 0.34 : 0.42);
    const stacked = window.innerWidth < 420 ? " stacked" : "";
    card.innerHTML = code
      ? `<div class="qr-row${stacked}">` +
          (panel.qr_caption ? `<div class="qr-caption">${escapeHtml(panel.qr_caption)}</div>` : "") +
          `<div class="qr-box" style="width:${side}px;height:${side}px">${code}</div>` +
        `</div>`
      : `<div class="title">QR too long to show</div>` +
        `<div class="qr-fallback">${escapeHtml(panel.qr_data || "")}</div>`;
    return;
  }

  if (mode === "choices") {
    const choices = Array.isArray(panel.choices) ? panel.choices : [];
    card.innerHTML =
      (panel.title ? `<div class="title" style="margin-bottom:2vmin">${escapeHtml(panel.title)}</div>` : "") +
      (panel.subtitle ? `<div class="subtitle" style="margin:-1vmin 0 2vmin">${escapeHtml(panel.subtitle)}</div>` : "") +
      `<div class="tiles${choices.length === 1 ? " one" : ""}">` +
        choices.map((c) =>
          `<div class="tile" data-id="${escapeHtml(c.id)}">` +
            (c.icon ? `<div class="icon">${escapeHtml(c.icon)}</div>` : "") +
            `<div class="label">${escapeHtml(c.label)}</div>` +
          `</div>`).join("") +
      `</div>`;
    return;
  }

  if (mode === "order") {
    const items = Array.isArray(panel.items) ? panel.items : [];
    card.innerHTML =
      `<div class="order">` +
        (panel.title ? `<div class="title" style="margin-bottom:1.4vmin">${escapeHtml(panel.title)}</div>` : "") +
        items.map((it) =>
          `<div class="row">` +
            `<div class="name">${it.qty ? escapeHtml(it.qty) + " x " : ""}${escapeHtml(it.name)}</div>` +
            `<div class="price">${escapeHtml(it.price || "")}</div>` +
          `</div>`).join("") +
        (panel.total
          ? `<div class="row total"><div class="name">Total</div><div class="price">${escapeHtml(panel.total)}</div></div>`
          : "") +
        (panel.note ? `<div class="note">${escapeHtml(panel.note)}</div>` : "") +
      `</div>`;
  }
}

// ---------------------------------------------------------------------------
// Following the agent
// ---------------------------------------------------------------------------
let version = -1;
let lastPanel = "";
let catalogVersion = null;

// The expressions this page can draw. Fetched rather than compiled in, so a
// JSON file dropped on the device reaches the glass without redeploying this
// page. A failure here is deliberately quiet: the fallback neutral defined at
// the top still draws, and the next poll tries again.
async function loadExpressions() {
  try {
    const res = await fetch("/expressions", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const body = await res.json();
    const next = {};
    for (const spec of body.expressions || []) next[spec.name] = spec;
    if (Object.keys(next).length) EXPRESSIONS = next;
    catalogVersion = body.version ?? catalogVersion;
    return true;
  } catch (err) {
    return false;
  }
}

function apply(state) {
  applyFace(state.expression || "neutral", state.gaze || "center");
  const panelKey = JSON.stringify(state.panel || {});
  if (panelKey !== lastPanel) {
    lastPanel = panelKey;
    renderPanel(state.panel);
  }
  version = state.version;
}

// Two triggers, because they cover different failures. The version stamp is the
// normal path: someone added a file and hit Reload. The unknown-name check is
// the race — a tool call naming a brand-new expression can reach this page
// before its own poll has noticed the catalog moved, and re-fetching there
// turns a defaulted neutral face into the right one.
async function syncCatalog(state) {
  const stale = state.expressions_version != null && state.expressions_version !== catalogVersion;
  const unknown = state.expression && !EXPRESSIONS[state.expression];
  if (stale || unknown) await loadExpressions();
}

async function follow() {
  for (;;) {
    try {
      // Long poll: the agent holds the request until something changes, so a
      // tool call lands on the glass in about as long as it takes to draw.
      const res = await fetch(`/display/state?v=${version}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const state = await res.json();
      await syncCatalog(state);
      apply(state);
      document.body.classList.remove("offline");
    } catch (err) {
      document.body.classList.add("offline");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

window.addEventListener("resize", () => {
  // The QR is sized in pixels against the viewport, so a rotation has to redraw
  // it; everything else is in vmin and looks after itself.
  if (lastPanel) {
    const panel = JSON.parse(lastPanel);
    if (panel.mode === "qr") renderPanel(panel);
  }
});

drawFace("neutral", "center");
loadExpressions().then(() => drawFace("neutral", "center"));
follow();
</script>
</body>
</html>
"""

# One copy of the geometry, two pages. See spc_faceparts.py.
FACE_HTML = _FACE_HTML.replace("__FACE_PARTS__", FACE_PARTS_JS)
