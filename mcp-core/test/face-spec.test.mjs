// The face contract, after expressions became data.
//
// What changed: an expression used to be a row in three hand-kept tables, in two
// languages, on two machines. It is a JSON file now, and the device validates
// names rather than mcp-tools.js. So the drift this file guards has moved.
//
// What is still fixed, and still needs guarding:
//
//   gazes, panel modes   still branches compiled into both renderers. Adding one
//                        is a code change in two languages; face-spec.json is
//                        what says they must agree.
//   the SHAPE vocabulary the two renderers both have to draw every shape a JSON
//                        file may name, or a user's face renders in a browser
//                        and silently falls back on the actual glass.
//   the ten builtins     duplicated on purpose (spc_expressions.BUILTIN, so a
//                        device that lost its expressions directory still boots
//                        a screen; the shipped JSON files; face-spec.json, which
//                        mcp-tools.js quotes to a model). Three copies, kept
//                        honest here.
//
// The framebuffer half of this does not read source with a regex any more. It
// RUNS spc_fb.py against a recording stand-in for the panel and checks that each
// shape actually draws something of its own. The bug worth catching is a shape
// that falls through to a default — `MOUTH_SHAPE.get(x, "smile")` returns a
// perfectly good mouth for a shape nobody implemented, and a regex over the
// source cannot tell the difference. Two shapes that render identically can.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "..", "face-spec.json");
const agentDir = join(here, "..", "..", "spc-agent");

const SPEC = JSON.parse(readFileSync(specPath, "utf8"));
const read = (name) => readFileSync(join(agentDir, name), "utf8");

// Runs a snippet inside spc-agent with its modules importable, and parses the
// single JSON object it prints. Python is what actually decides whether a shape
// draws, so this asks it rather than guessing from the source text.
function python(snippet) {
  const out = execFileSync("python3", ["-c", snippet], {
    cwd: agentDir,
    encoding: "utf8",
    env: { ...process.env, SPC_EXPRESSIONS_DIR: join(agentDir, "expressions"), PYTHONPATH: agentDir }
  });
  return JSON.parse(out.trim().split("\n").pop());
}

function literals(source, pattern, what) {
  const m = source.match(pattern);
  assert.ok(m, `Could not find ${what} — it was renamed or removed. Update this test.`);
  return new Set([...m[1].matchAll(/["'](\w+)["']/g)].map((x) => x[1]));
}

const setEq = (actual, expected, what) =>
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    `${what} does not match face-spec.json`
  );

// ---------------------------------------------------------------------------
// The ten builtins, in their three deliberate copies
// ---------------------------------------------------------------------------

test("spc_expressions.py ships the builtins face-spec.json promises", () => {
  // face-spec.json is what mcp-tools.js quotes to a model as "every device has
  // at least these". BUILTIN is what a device with no expressions directory
  // actually falls back to. A model promised a face the fallback lacks is the
  // failure, and it only shows up on a half-deployed device.
  const got = python(`import json, spc_expressions; print(json.dumps(sorted(spc_expressions.BUILTIN)))`);
  setEq(got, SPEC.builtin_expressions, "spc_expressions.BUILTIN");
});

test("the shipped JSON files are the builtins, field for field", () => {
  // The JSON directory is the real source; BUILTIN is its safety copy. They are
  // edited by hand in different places and will drift the moment nobody looks.
  const result = python(`
import json, spc_expressions
shipped = spc_expressions.load(dirs=["expressions"])
diff = {}
for name, spec in spc_expressions.BUILTIN.items():
    loaded = shipped.get(name)
    want = spc_expressions._normalise(name, spec)
    if loaded != want:
        diff[name] = {"json": loaded, "builtin": want}
print(json.dumps({"names": shipped.names(), "diff": diff, "problems": shipped.problems}))
`);
  assert.deepEqual(result.problems, [], "a shipped expression JSON does not validate");
  assert.deepEqual(result.diff, {},
    "a shipped expressions/*.json disagrees with spc_expressions.BUILTIN — " +
    "the fallback a device uses when its directory is missing is no longer the face it ships");
  setEq(result.names, SPEC.builtin_expressions, "shipped expressions/*.json");
});

// ---------------------------------------------------------------------------
// The shape vocabulary, which both renderers must cover
// ---------------------------------------------------------------------------

test("spc_face.py draws every shape a JSON file may name (browser renderer)", () => {
  const src = read("spc_faceparts.py");
  for (const [table, expected, pattern] of [
    ["EYE", SPEC.shapes.eyes, /const EYE = \{([\s\S]*?)\n\};/],
    ["BROW", SPEC.shapes.brows, /const BROW = \{([\s\S]*?)\n\};/],
    ["MOUTH", SPEC.shapes.mouths, /const MOUTH = \{([\s\S]*?)\n\};/]
  ]) {
    const m = src.match(pattern);
    assert.ok(m, `spc_faceparts.py no longer has a const ${table} block — update this test.`);
    const keys = new Set([...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]));
    setEq(keys, expected, `spc_faceparts.py ${table}`);
  }
});

test("spc_fb.py draws every shape, and draws each one differently (panel renderer)", () => {
  // The one that matters. This is the renderer on the actual glass, and its
  // failure mode is silent: an unimplemented mouth falls through to the `else`
  // and draws a perfectly convincing wrong face. So: render every shape, and
  // require each to differ from all the others AND from a name that does not
  // exist. A shape that matches the nonsense one was never implemented.
  const result = python(`
import json, spc_expressions, spc_fb

class Rec:
    w, h = 1080, 1920
    def __init__(self): self.calls = []
    def rect(self, *a): pass
    def round_rect(self, *a): self.calls.append(("rr",) + tuple(round(float(x), 3) for x in a[:5]))
    def disc(self, cx, cy, r, c): self.calls.append(("disc", round(cx, 3), round(cy, 3), r))
    def stroke(self, pts, w, c): self.calls.append(("st", [(round(p[0], 3), round(p[1], 3)) for p in pts]))

cat = spc_expressions.load(dirs=["expressions"])

def render(part, shape):
    s = Rec()
    f = spc_fb.Face(s, None, catalog=cat)
    f.s = s
    if part == "eyes":   f._eye(500, 300, shape, (1, 2, 3), 0.0)
    elif part == "brows": f._brow(500, 300, shape, (1, 2, 3))
    else:                 f._mouth(shape, (1, 2, 3))
    return json.dumps(s.calls)

out = {}
for part, shapes in (("eyes", ${JSON.stringify(SPEC.shapes.eyes)}),
                     ("brows", ${JSON.stringify(SPEC.shapes.brows)}),
                     ("mouths", ${JSON.stringify(SPEC.shapes.mouths)})):
    out[part] = {shape: render(part, shape) for shape in shapes}
    out[part]["__unimplemented__"] = render(part, "zzz_not_a_shape")
print(json.dumps(out))
`);

  for (const [part, rendered] of Object.entries(result)) {
    const fallback = rendered.__unimplemented__;
    const seen = new Map();
    for (const [shape, drawing] of Object.entries(rendered)) {
      if (shape === "__unimplemented__") continue;
      // "none" is a brow that is meant to draw nothing, and so is legitimately
      // whatever an unimplemented eye draws. Everything else must be real.
      if (shape !== "none") {
        assert.notEqual(drawing, fallback,
          `spc_fb.py draws ${part}/${shape} exactly as it draws a shape that does not exist — ` +
          `it fell through to a default, so a JSON file naming it renders the wrong face on the panel.`);
      }
      const clash = seen.get(drawing);
      assert.equal(clash, undefined,
        `spc_fb.py draws ${part}/${shape} and ${part}/${clash} identically — one of them is unimplemented.`);
      seen.set(drawing, shape);
    }
  }
});

test("inline geometry reaches the panel renderer", () => {
  // The feature that makes a JSON file able to hold a face nobody wrote code
  // for. If _geometry ever stops being reached, custom faces quietly become
  // whatever the named-shape path defaults to, which is the same silent class
  // of bug as above.
  const result = python(`
import json, spc_expressions, spc_fb

class Rec:
    w, h = 1080, 1920
    def __init__(self): self.calls = []
    def rect(self, *a): pass
    def round_rect(self, *a): self.calls.append("rr")
    def disc(self, *a): self.calls.append("disc")
    def stroke(self, pts, w, c): self.calls.append(("st", len(pts)))

cat = spc_expressions.load(dirs=["expressions"])
out = {}
for label, part, shape in [
    ("quad",   "mouth", {"quad": [[-60, 0], [0, 80], [60, 0]]}),
    ("line",   "eye",   {"line": [[0, -50], [40, 40], [-40, 40], [0, -50]]}),
    ("rect",   "eye",   {"rounded_rect": {"w": 80, "h": 110, "r": 24}}),
    ("cross",  "eye",   {"cross": {"size": 40}}),
    ("paths",  "mouth", {"paths": [{"quad": [[-60, 0], [0, 40], [60, 0]]},
                                   {"quad": [[-60, 0], [0, -40], [60, 0]]}]}),
]:
    s = Rec(); f = spc_fb.Face(s, None, catalog=cat); f.s = s
    if part == "eye": f._eye(500, 300, shape, (1, 2, 3), 0.0)
    else:             f._mouth(shape, (1, 2, 3))
    out[label] = s.calls
print(json.dumps(out))
`);
  for (const [label, calls] of Object.entries(result)) {
    assert.ok(calls.length > 0, `inline ${label} geometry drew nothing on the panel renderer`);
  }
  assert.equal(result.paths.length, 2, "a paths shape should draw each of its parts");
});

// ---------------------------------------------------------------------------
// What is still a fixed enum
// ---------------------------------------------------------------------------

test("spc_agent.py validates exactly the gazes and panel modes in face-spec.json", () => {
  const src = read("spc_agent.py");
  setEq(literals(src, /^GAZES = \(([\s\S]*?)\)/m, "GAZES in spc_agent.py"),
        SPEC.gazes, "spc_agent.py GAZES");
  setEq(literals(src, /^PANEL_MODES = \(([\s\S]*?)\)/m, "PANEL_MODES in spc_agent.py"),
        SPEC.panel_modes, "spc_agent.py PANEL_MODES");
});

test("spc_agent.py no longer carries its own expression list", () => {
  // It used to, and it had to, and now it must not: a hardcoded tuple here would
  // reject the JSON file a user just added, with an error blaming their file.
  assert.doesNotMatch(read("spc_agent.py"), /^EXPRESSIONS = \(/m,
    "spc_agent.py has a hardcoded EXPRESSIONS tuple again — it validates against " +
    "the loaded catalog now, or user-added faces get rejected.");
});

test("both renderers offer every gaze direction", () => {
  // Separate from the shape check because gaze lives in its own table and is
  // the half more easily forgotten: a missing shape draws visibly wrong, a
  // missing gaze just fails to move the eyes.
  const parts = read("spc_faceparts.py");
  const g = parts.match(/const GAZE = \{([\s\S]*?)\n\};/);
  assert.ok(g, "spc_faceparts.py no longer has a const GAZE block — update this test.");
  setEq(new Set([...g[1].matchAll(/(\w+): \[/g)].map((x) => x[1])),
        SPEC.gazes, "spc_faceparts.py GAZE");

  const fb = read("spc_fb.py");
  const m = fb.match(/GAZE = \{([\s\S]*?)\n?\}/);
  assert.ok(m, "spc_fb.py no longer has a GAZE table — update this test.");
  setEq(new Set([...m[1].matchAll(/"(\w+)":/g)].map((x) => x[1])), SPEC.gazes, "spc_fb.py GAZE");
});

test("both renderers handle every panel mode", () => {
  const fb = read("spc_fb.py");
  setEq(new Set([...fb.matchAll(/mode == "(\w+)"/g)].map((x) => x[1])),
        SPEC.panel_modes, "spc_fb.py panel modes");

  const face = read("spc_face.py");
  setEq(new Set([...face.matchAll(/mode === "(\w+)"/g)].map((x) => x[1])),
        SPEC.panel_modes, "spc_face.py panel modes");
});

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

test("spc_expression does not enum the expression argument", () => {
  // The whole point of the change. An enum here rejects a face that is sitting
  // on the glass, and the model gets a validation error it cannot act on.
  const src = readFileSync(join(here, "..", "mcp-tools.js"), "utf8");
  assert.doesNotMatch(src, /expression: z\s*\n?\s*\.enum\(/,
    "spc_expression enums `expression` again — expressions are per-device JSON " +
    "files, so only the device can validate them.");
});

test("the tool description promises exactly the builtins every device has", () => {
  // The enum is gone, so this prose is now the ONLY list a model sees before it
  // calls spc_list_devices. A name here that a bare device lacks is a tool call
  // that fails for no reason the model can see.
  const src = readFileSync(join(here, "..", "mcp-tools.js"), "utf8");
  const m = src.match(/expression \(string, optional\): the face\. Every device has ([a-z, ]+)\./);
  assert.ok(m, "spc_expression's description no longer lists the builtins — update this test.");
  setEq(new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean)),
        SPEC.builtin_expressions, "spc_expression description");

  const g = src.match(/gaze \(string, optional\): ([a-z, ]+)\\n/);
  assert.ok(g, "spc_expression's description no longer lists gazes — update this test.");
  setEq(new Set(g[1].split(",").map((s) => s.trim()).filter(Boolean)),
        SPEC.gazes, "spc_expression description gazes");
});
