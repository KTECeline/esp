// Contract tests for the framebuffer face's QR encoder (spc-agent/spc_qr.py).
//
// spc_fb.py draws the code physically on the kiosk panels; spc_face.py draws it
// in a browser. They MUST produce the same symbol, and so must an ESP box. The
// browser encoder is round-trip-tested in face-qr.test.mjs; this file does the
// same for the Python port, two ways:
//
//   1. round trip — encode with spc_qr.py, decode with the repo's own decoder
//      (mcp-core/vision.js). A wrong ECC table or a transposed format block
//      still draws something QR-shaped; only a decoder catches it.
//   2. equivalence — compare spc_qr.py module for module against the JS encoder
//      lifted out of the shipped spc_face.py, so the two cannot silently drift.
//
// Skips (does not fail) when python3 is unavailable — the Python side has its
// own interpreter everywhere it actually runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeQr } from "../vision.js";

const here = dirname(fileURLToPath(import.meta.url));
const spcAgentDir = join(here, "..", "..", "spc-agent");
const facePath = join(spcAgentDir, "spc_face.py");

const python = ["python3", "python"].find((bin) => {
  try {
    return spawnSync(bin, ["--version"]).status === 0;
  } catch {
    return false;
  }
});

// Lift `const QR = (() => { ... })();` out of the shipped browser page, exactly
// as face-qr.test.mjs does — same reason: no build step to drift against.
function loadJsEncoder() {
  const source = readFileSync(facePath, "utf8");
  const start = source.indexOf("const QR = (() => {");
  assert.notEqual(start, -1, "spc_face.py no longer contains the QR module");
  const end = source.indexOf("\n})();", start);
  assert.notEqual(end, -1, "could not find the end of the QR module in spc_face.py");
  return new Function(`${source.slice(start, end + "\n})();".length)}\nreturn QR;`)();
}

// grid (0/1 rows) -> the RGBA frame shape decodeQr wants.
function toFrame(grid, scale, quiet) {
  const n = grid.length;
  const side = (n + quiet * 2) * scale;
  const buf = Buffer.alloc(side * side * 4, 0xff);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!grid[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((quiet + y) * scale + dy) * side + ((quiet + x) * scale + dx)) * 4;
          buf[o] = buf[o + 1] = buf[o + 2] = 0x00;
        }
      }
    }
  }
  return { data: buf, width: side, height: side };
}

// Ask spc_qr.py for the module grid of `text`. Returns null for "won't fit".
function pyModules(text) {
  const out = spawnSync(
    python,
    ["-c", "import sys,spc_qr\ng=spc_qr.modules(sys.argv[1])\nprint('NULL' if g is None else '\\n'.join(''.join(map(str,r)) for r in g))", text],
    { cwd: spcAgentDir, encoding: "utf8" },
  );
  assert.equal(out.status, 0, `spc_qr.py failed: ${out.stderr}`);
  const body = out.stdout.trim();
  if (body === "NULL") return null;
  return body.split("\n").map((r) => Array.from(r, (c) => Number(c)));
}

const PAYLOADS = [
  "ORDER-4417",
  "https://pay.example.my/tng?ref=RM13.50",
  "https://pay.example.com/checkout?session=9f2b7c1e-4d8a-11ee-be56-0242ac120002&amount=132.75",
  "nasi lemak x2, teh tarik x1 - RM14.50",
  "Kopi ais — RM4.50 ✓",                       // non-ASCII: counted as UTF-8 bytes
];

test("spc_qr.py: round-trips real counter payloads through the decoder", { skip: !python && "no python3" }, () => {
  for (const payload of PAYLOADS) {
    const grid = pyModules(payload);
    assert.ok(grid, `no grid for ${payload}`);
    const got = decodeQr(toFrame(grid, 6, 4));
    assert.ok(got, `the encoder produced something no decoder can find: ${payload}`);
    assert.equal(got.text, payload);
  }
});

test("spc_qr.py: matches the browser encoder module for module, across versions", { skip: !python && "no python3" }, () => {
  const QR = loadJsEncoder();
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/?=&.-_%";
  const versions = new Set();
  for (let len = 1; len <= 400; len += 11) {
    let text = "";
    for (let i = 0; i < len; i++) text += alphabet[(i * 37 + len * 13) % alphabet.length];
    const js = QR.modules(text);
    const py = pyModules(text);
    assert.ok(js && py, `no grid for a ${len}-character payload`);
    assert.equal(py.length, js.length, `size disagrees at ${len} chars`);
    versions.add((js.length - 17) / 4);
    for (let y = 0; y < js.length; y++) {
      assert.deepEqual(py[y], Array.from(js[y]), `row ${y} differs at ${len} chars`);
    }
  }
  assert.ok(versions.size >= 8, `expected several QR versions exercised, saw ${versions.size}`);
});

test("spc_qr.py: refuses a payload too large instead of drawing a broken one", { skip: !python && "no python3" }, () => {
  assert.equal(pyModules("x".repeat(5000)), null);
});
