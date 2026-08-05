// Contract tests for the QR decoder.
//
// Only the DECODE half is covered here: capturing needs a physical camera, and
// a test that fails on a machine without one is a test people learn to ignore.
// The decoder is also the half with real logic — capture is an ffmpeg call.
//
// Fixtures are checked-in module grids rather than an encoder dependency, so
// the suite stays runnable with no devDependencies and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeQr } from "../vision.js";

// Real, spec-compliant QR symbols, stored as their module grids (# = dark).
// Checked in as data rather than generated at test time: no encoder dependency,
// no network, and what gets decoded is a genuine symbol rather than something
// this file helped construct. Payloads are what a food counter would actually
// see - an order reference and a payment link.
const FIXTURES = {
  "ORDER-4417": [
    "#######..###..#######",
    "#.....#....##.#.....#",
    "#.###.#.#.###.#.###.#",
    "#.###.#.#..##.#.###.#",
    "#.###.#.##..#.#.###.#",
    "#.....#.####..#.....#",
    "#######.#.#.#.#######",
    "........###..........",
    "#.#####..#.#..#####..",
    "#.#.#...#.######.####",
    "..#.#.#.##..#.##..#..",
    "...#...#########...#.",
    "....#.#..##.#......#.",
    "........#.#.#...##...",
    "#######...##.#.#.#.#.",
    "#.....#.#.#....#..##.",
    "#.###.#.####.#.#.#.#.",
    "#.###.#.##.#####.....",
    "#.###.#.#...#.#.#....",
    "#.....#....####...#.#",
    "#######.#.#.#.....#.."
  ],
  "https://pay.example.my/tng?ref=RM13.50": [
    "#######...#..###.###..#######",
    "#.....#..###..#.##..#.#.....#",
    "#.###.#.##..#..##.....#.###.#",
    "#.###.#.#.#.....##.##.#.###.#",
    "#.###.#.##.....#...##.#.###.#",
    "#.....#.#......#....#.#.....#",
    "#######.#.#.#.#.#.#.#.#######",
    "........##......#.#.#........",
    "#.#####...#....#.#.#..#####..",
    "#.##.#.#.##..#.#.########...#",
    "##..#.##.#.#.#####...........",
    "..####.#..#..#.##.###..#.#.#.",
    "#.#...#.#.##..####.#.....##..",
    "..####......#..##.##..#.#...#",
    "##..#.###.###....#..#######..",
    ".#..#..#.##.#.###...##.....#.",
    "##..#.#.###.....###....#.##..",
    "#...##.########..#.######.#.#",
    "#.#.#.#.##.#####.#...#.##.#..",
    "#.#.#....#####.#....#...#..#.",
    "#..#..###.#.#.##.#.######.###",
    "........###.........#...#####",
    "#######........######.#.###..",
    "#.....#.#.#.#.###.###...#...#",
    "#.###.#.##.##...##..#####.#.#",
    "#.###.#.#..#.##...#......##..",
    "#.###.#.####..##.....#######.",
    "#.....#..#####..#..##.#.##.#.",
    "#######.##.#..##.#.#....###.."
  ]
};

const parse = (rows) => rows.map((r) => [...r].map((c) => (c === "#" ? 1 : 0)));

// Turn a module grid into the RGBA buffer a camera frame would carry.
// `quiet` is the mandatory white border: without it a decoder cannot find the
// symbol's edges, which is exactly why a code printed flush to a card edge
// scans badly in real life.
function gridToRgba(grid, scale, quiet) {
  const n = grid.length;
  const side = (n + quiet * 2) * scale;
  const buf = Buffer.alloc(side * side * 4, 0xff);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!grid[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((quiet + x) * scale + dx);
          const py = ((quiet + y) * scale + dy);
          const o = (py * side + px) * 4;
          buf[o] = buf[o + 1] = buf[o + 2] = 0x00;
        }
      }
    }
  }
  return { data: buf, width: side, height: side };
}

for (const [payload, rows] of Object.entries(FIXTURES)) {
  test(`decodes ${payload.slice(0, 34)}${payload.length > 34 ? "..." : ""}`, () => {
    const got = decodeQr(gridToRgba(parse(rows), 8, 4));
    assert.ok(got, "no code found in a frame that plainly contains one");
    assert.equal(got.text, payload);
    // Callers use the corners to tell a code held up to the camera from one
    // that happens to be on a poster behind the customer.
    assert.ok(got.corners && got.corners.topLeft, "must report where it saw the code");
  });
}

test("decodes a code rendered small, as a handheld phone screen would be", () => {
  // 3px per module is roughly a phone held at arm's length on a 640x480 sensor.
  const got = decodeQr(gridToRgba(parse(FIXTURES["ORDER-4417"]), 3, 4));
  assert.equal(got && got.text, "ORDER-4417");
});

test("decodes an inverted code (light on dark)", () => {
  // Phone wallets in dark mode render exactly this, and it is the reason
  // inversionAttempts is set to attemptBoth.
  const f = gridToRgba(parse(FIXTURES["ORDER-4417"]), 8, 4);
  for (let i = 0; i < f.data.length; i += 4) {
    f.data[i] = 255 - f.data[i];
    f.data[i + 1] = 255 - f.data[i + 1];
    f.data[i + 2] = 255 - f.data[i + 2];
  }
  const got = decodeQr(f);
  assert.equal(got && got.text, "ORDER-4417");
});

test("a frame with no code returns null rather than throwing", () => {
  // Nobody holding up a code is the normal case, many times a second.
  const blank = { data: Buffer.alloc(320 * 240 * 4, 0xff), width: 320, height: 240 };
  assert.equal(decodeQr(blank), null);
});

test("pure noise returns null, not a false positive", () => {
  // A busy counter scene must not be read as a payment reference.
  const n = 320 * 240 * 4;
  const data = Buffer.alloc(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 0xff;
  }
  assert.equal(decodeQr({ data, width: 320, height: 240 }), null);
});

test("an all-black frame returns null", () => {
  // What a lens cap or an unplugged-mid-capture camera looks like.
  const dark = { data: Buffer.alloc(320 * 240 * 4, 0x00), width: 320, height: 240 };
  assert.equal(decodeQr(dark), null);
});

test("gridToRgba renders modules the decoder can actually see", () => {
  // Guards the helper itself: a black module must be black in the buffer, or a
  // failing decode test would be blamed on the decoder.
  const grid = [[1, 0], [0, 1]];
  const f = gridToRgba(grid, 4, 1);
  assert.equal(f.width, (2 + 2) * 4);
  const o = ((1 * 4 + 0) * f.width + (1 * 4 + 0)) * 4;   // first dark module
  assert.equal(f.data[o], 0x00);
  assert.equal(f.data[0], 0xff);                          // quiet zone stays white
});
