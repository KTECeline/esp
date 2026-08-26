// Contract tests for the QR encoder inside the OrangePi's face page.
//
// That encoder is the one piece of this feature with no visible failure mode:
// a wrong error-correction table or a transposed format block still draws
// something that looks exactly like a QR code, and the only symptom is a
// customer's phone quietly refusing to read it. So it is tested by round trip —
// encode here, decode with the repo's own decoder (mcp-core/vision.js, the same
// one the counter camera uses) — and the code under test is pulled out of the
// SHIPPED page rather than a copy, so the two cannot drift apart.
//
// The Python file is read and the browser module extracted from it. That is
// unusual, and it is the point: there is no build step to keep in sync, and a
// version of the encoder that only exists in a test proves nothing about the
// version on the glass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeQr } from "../vision.js";

const here = dirname(fileURLToPath(import.meta.url));
const facePath = join(here, "..", "..", "spc-agent", "spc_face.py");

// Lift `const QR = (() => { ... })();` out of the page and evaluate it.
function loadEncoder() {
  const source = readFileSync(facePath, "utf8");
  const start = source.indexOf("const QR = (() => {");
  assert.notEqual(start, -1, "spc_face.py no longer contains the QR module — update this test");
  const end = source.indexOf("\n})();", start);
  assert.notEqual(end, -1, "could not find the end of the QR module in spc_face.py");
  const body = source.slice(start, end + "\n})();".length);
  return new Function(`${body}\nreturn QR;`)();
}

const QR = loadEncoder();

// The encoder emits SVG for the page; the tests need modules, which it also
// exposes. Rendered to the RGBA buffer shape decodeQr expects.
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

const roundTrip = (text, scale = 6) => decodeQr(toFrame(QR.modules(text), scale, 4));

// Payloads a food counter would really put on the screen.
const PAYLOADS = [
  "ORDER-4417",
  "https://pay.example.my/tng?ref=RM13.50",
  "https://pay.example.com/checkout?session=9f2b7c1e-4d8a-11ee-be56-0242ac120002&amount=132.75",
  "nasi lemak x2, teh tarik x1 - RM14.50"
];

for (const payload of PAYLOADS) {
  test(`encodes ${payload.slice(0, 34)}${payload.length > 34 ? "..." : ""}`, () => {
    const got = roundTrip(payload);
    assert.ok(got, "the encoder produced something no decoder can find");
    assert.equal(got.text, payload);
  });
}

test("picks a version that fits, across the whole practical size range", () => {
  // Every length up to the schema's 400-character cap. Version selection and
  // the per-version block tables are the parts most likely to be subtly wrong,
  // and they are only exercised at the lengths where the version changes.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/?=&.-_%";
  const versions = new Set();
  for (let len = 1; len <= 400; len += 7) {
    let text = "";
    for (let i = 0; i < len; i++) text += alphabet[(i * 37 + len * 13) % alphabet.length];
    const grid = QR.modules(text);
    assert.ok(grid, `no grid for a ${len}-character payload`);
    versions.add((grid.length - 17) / 4);
    assert.equal(roundTrip(text, 4)?.text, text, `failed to round-trip ${len} characters`);
  }
  assert.ok(versions.size >= 10, `expected several QR versions to be exercised, saw ${versions.size}`);
});

test("encodes non-ASCII by bytes, not characters", () => {
  // The character-count field counts UTF-8 bytes. Counting characters instead
  // overruns the block on the first accented word and produces a symbol that
  // decodes to garbage rather than failing loudly.
  const text = "Kopi ais — RM4.50 ✓";
  assert.equal(roundTrip(text)?.text, text);
});

test("survives being drawn small, as it is on a panel across a counter", () => {
  assert.equal(roundTrip("https://pay.example.my/tng?ref=RM13.50", 3)?.text,
               "https://pay.example.my/tng?ref=RM13.50");
});

test("svg() wraps the code in a quiet zone", () => {
  // Without the white border a phone cannot find the symbol's edges, which is
  // the difference between a QR that scans off a screen and one that does not.
  const svg = QR.svg("ORDER-4417");
  const size = QR.modules("ORDER-4417").length;
  assert.match(svg, new RegExp(`viewBox="0 0 ${size + 8} ${size + 8}"`));
  assert.match(svg, /fill="#fff"/);
});

test("refuses a payload too large to encode instead of drawing a broken one", () => {
  assert.equal(QR.modules("x".repeat(5000)), null);
});

test("the whole face page parses as JavaScript", () => {
  // A syntax error in the page is invisible from the Python side — the agent
  // serves it happily and the panel just stays black. Compiling it here (never
  // running it; it wants a DOM) catches that before a deploy does.
  const source = readFileSync(facePath, "utf8");
  const script = source.slice(source.indexOf("<script>") + "<script>".length,
                             source.lastIndexOf("</script>"));
  assert.ok(script.length > 1000, "could not find the page's script block");
  assert.doesNotThrow(() => new Function(script));
});

// The expression/gaze agreement check that used to live here has moved to
// face-spec.test.mjs. It compared two of the four places that carry the face
// vocabulary — the enum here and the table in spc_face.py — by scraping the
// enum's literal out of this file. That literal is gone: mcp-tools.js now reads
// face-spec.json, so there is a named source to compare everything against
// instead of two lists checked against each other. The replacement also covers
// spc_agent.py and spc_fb.py, which this never did, and spc_fb.py is the
// renderer actually on the glass.
