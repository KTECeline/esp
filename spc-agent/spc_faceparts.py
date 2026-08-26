"""The shapes a face is made of, shared by the two pages that draw one.

/face renders the live panel; /faces is the picker that shows every expression
at once so someone can look at them and choose. Both need identical geometry —
a picker whose preview does not match the glass is worse than no picker — and
both are Python string constants spliced together at import time rather than a
static .js file, so spc-agent keeps its "plain source files, no static directory
to get out of sync" deployment shape.

What is here is the SHAPE vocabulary: the named parts a JSON expression can
refer to, plus the reader for the inline geometry a JSON expression can define
instead. What is NOT here is any expression — those are JSON files that
spc_expressions.py loads and both pages fetch from /expressions.

Coordinates are the face page's 400x300 viewBox, which is the canonical space an
expression JSON is authored in. spc_fb.py transforms them into framebuffer
units on its way to the panel.
"""

FACE_PARTS_JS = r"""
// Built rather than written out, because a hand-written rounded-rect path is
// easy to get subtly off-centre — and an eye whose path is not centred on its
// own origin drifts away from its brow and its highlights.
function roundedEye(w, h, r) {
  const x = -w / 2, y = -h / 2;
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}` +
         `v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}` +
         `h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}` +
         `v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}

// Height matters twice over: it positions the highlights, and it decides how
// close the mouth can sit without the smile touching the eyes.
const EYE_SIZE = { open: [86, 122], wide: [96, 132], narrow: [86, 62] };

const EYE = {
  open:   roundedEye(...EYE_SIZE.open, 28),
  wide:   roundedEye(...EYE_SIZE.wide, 32),
  narrow: roundedEye(...EYE_SIZE.narrow, 26),
  happy:  "M-52 26Q0-50 52 26",
  closed: "M-52 0Q0 38 52 0",
  cross:  "M-40-40 40 40M40-40-40 40"
};
// The eye paths are drawn around a notional origin and then translated, so both
// eyes reuse one geometry and only their offset differs.
const EYE_AT = { left: [128, 134], right: [272, 134] };

const BROW = {
  flat:   "M-54 0Q0-14 54 0",
  raised: "M-56 6Q0-26 56 6",
  angry:  "M-54-14Q0-2 54 18",
  sad:    "M-54 14Q0-4 54-16",
  none:   ""
};
const BROW_AT = { left: [128, 44], right: [272, 44] };

// Unlike the eyes and brows, the builtin mouth paths are written in ABSOLUTE
// viewBox coordinates — #mouth carries no transform, so they place themselves.
// Inline geometry is relative to the part's centre like everything else, which
// means an inline mouth needs this anchor applied where a named one does not.
// (spc_fb.py has always drawn its mouth from a centre, so only this renderer
// has the two cases.) The value is where a builtin mouth's ends sit: y=222 on
// the 400-wide centreline.
const MOUTH_AT = [200, 222];

// The transform #mouth needs for a given shape: none for a named one, the
// anchor for geometry. Returning "" rather than translate(0 0) keeps the
// builtin markup byte-identical to what it has always been.
function mouthTransform(shape) {
  return typeof shape === "string" || !shape ? "" : `translate(${MOUTH_AT[0]} ${MOUTH_AT[1]})`;
}

const MOUTH = {
  smile:  "M144 222Q200 274 256 222",
  grin:   "M132 222Q200 300 268 222",
  small:  "M164 226Q200 250 236 226",
  flat:   "M162 232H238",
  frown:  "M148 250Q200 202 252 250",
  open:   "M168 226Q200 196 232 226Q200 272 168 226",
  wave:   "M152 232Q176 210 200 232T248 232"
};

// The expressions themselves are no longer written here. They are JSON files on
// the device, fetched from /expressions, so someone can add a face without
// touching this page or the framebuffer renderer beside it. The SHAPE tables
// above stay: a JSON file names a shape and each renderer draws it in its own
// tuned geometry, which is why the ten builtins look exactly as they always did.
//
// EXPRESSIONS starts as a single fallback rather than empty. This page can be
// opened before the fetch lands, or against an agent whose expressions
// directory has gone missing, and a face is the one thing on this screen that
// must never fail to draw.
let EXPRESSIONS = {
  neutral: { eyes: { left: "open", right: "open" }, brow: "flat", mouth: "smile",
             gaze: "center", ink: null, blink: true }
};

// Inline geometry: a shape that is in neither table because a user drew it.
// Coordinates are this page's own — relative to the part's centre, in the
// 400x300 viewBox — which is why they are authored against this renderer and
// merely transformed for the framebuffer one.
function geometryPath(shape) {
  if (typeof shape === "string" || !shape) return null;
  const [kind, body] = Object.entries(shape)[0] || [];
  const xy = (p) => `${p[0]} ${p[1]}`;

  if (kind === "paths") return body.map(geometryPath).filter(Boolean).join(" ");
  if (kind === "quad")  return `M${xy(body[0])}Q${xy(body[1])} ${xy(body[2])}`;
  if (kind === "line")  return `M${xy(body[0])}` + body.slice(1).map((p) => `L${xy(p)}`).join("");
  if (kind === "rounded_rect") return roundedEye(body.w, body.h, body.r || 0);
  if (kind === "cross") {
    const a = body.size;
    return `M${-a} ${-a} ${a} ${a}M${a} ${-a} ${-a} ${a}`;
  }
  return null;
}

// Resolves either form to path data. Returns null for a shape that is neither,
// which the caller draws as nothing rather than as a stray default — a missing
// brow is honest, a wrong brow is not.
function shapePath(shape, table) {
  if (typeof shape === "string") return table[shape] ?? null;
  return geometryPath(shape);
}

// Small on purpose: the whole eye moves, not a pupil inside it, so a large
// offset walks the eyes into the brows.
const GAZE = {
  center: [0, 0], left: [-14, 0], right: [14, 0], up: [0, -6], down: [0, 6]
};

// The face's colour at 50% — the halo every stroke is drawn with. Derived
// rather than a second field, because an ink and a glow that disagree is a
// thing nobody writing a JSON file would ever want to have to keep in step.
function hexGlow(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.5)`;
}
"""
