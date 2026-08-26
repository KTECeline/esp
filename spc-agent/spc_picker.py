"""The expression picker — /faces, the page someone opens to choose a face.

The reason this exists: expressions became JSON files so that a user could add
one, and a user who cannot see what already exists will not add anything good.
This draws every expression the device knows, at once, with the SAME geometry
the panel uses (spc_faceparts.py, shared with spc_face.py) — a picker whose
preview disagrees with the glass is worse than no picker.

It does three jobs, in the order someone needs them:

  look     every face, live, labelled, with the file it came from
  choose   click one and it goes on the panel
  extend   the shapes available, a starter file, and where to put it

Setting a face is the one thing here that changes anything, and it goes through
POST /display like every other caller — so it needs the fleet token when one is
configured. The token is asked for once and kept in localStorage; nothing else
on this page is privileged, which is why the page itself is served open.
"""

from spc_faceparts import FACE_PARTS_JS

_PICKER_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spc-agent faces</title>
<style>
  :root {
    --ink: #34d0ff;
    --glow: rgba(52, 208, 255, 0.5);
    --bg: #060d1a;
    --card: #0d1c33;
    --edge: rgba(120, 190, 255, 0.16);
    --text: #eaf4ff;
    --dim: #8fb2d6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text); min-height: 100vh;
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    padding: 28px 22px 60px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }

  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 25px; font-weight: 800; letter-spacing: -0.02em; }
  .count { color: var(--dim); font-size: 14px; }
  .lede { color: var(--dim); font-size: 14.5px; line-height: 1.55; max-width: 62ch; margin: 10px 0 22px; }

  .bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 24px; }
  button {
    font: inherit; font-size: 13.5px; font-weight: 600; color: var(--text);
    background: #16305a; border: 1px solid var(--edge); border-radius: 9px;
    padding: 8px 15px; cursor: pointer; transition: background 140ms ease;
  }
  button:hover { background: #1d3f74; }
  button.ghost { background: transparent; }
  #status { font-size: 13px; color: var(--dim); min-height: 1.2em; }
  #status.bad { color: #ff9b9b; }
  #status.good { color: #7ee0a8; }

  /* ---- the grid of faces ------------------------------------------------- */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 13px; }
  .tile {
    background: var(--card); border: 1px solid var(--edge); border-radius: 13px;
    padding: 11px 11px 13px; cursor: pointer; text-align: center;
    transition: border-color 140ms ease, transform 140ms ease, background 140ms ease;
  }
  .tile:hover { border-color: var(--ink); transform: translateY(-2px); }
  .tile.live { border-color: var(--ink); background: #123561; box-shadow: 0 0 0 1px var(--ink) inset; }
  .tile svg { width: 100%; height: 96px; display: block; }
  .tile .stroke {
    fill: none; stroke: var(--ink); stroke-width: 13;
    stroke-linecap: round; stroke-linejoin: round;
    filter: drop-shadow(0 0 7px var(--glow));
  }
  .tile .glint { fill: var(--ink); stroke: none; }
  .tile .name { font-size: 13.5px; font-weight: 700; margin-top: 7px; }
  .tile .src { font-size: 10.5px; color: var(--dim); margin-top: 3px;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; }
  .tile .desc { font-size: 11px; color: var(--dim); margin-top: 5px; line-height: 1.35; min-height: 2.7em; }
  .badge {
    display: inline-block; font-size: 9.5px; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; padding: 2px 6px; border-radius: 5px; margin-top: 5px;
    background: #1c4b2f; color: #8ce8ae;
  }

  /* ---- problems ---------------------------------------------------------- */
  #problems {
    display: none; background: #33131a; border: 1px solid #7d3040; border-radius: 11px;
    padding: 13px 16px; margin-bottom: 22px;
  }
  #problems h2 { font-size: 14px; margin-bottom: 8px; color: #ffb3b3; }
  #problems li { font-size: 12.5px; color: #ffd4d4; margin-left: 17px; line-height: 1.55; font-family: ui-monospace, Menlo, monospace; }

  /* ---- how to add one ---------------------------------------------------- */
  details {
    margin-top: 34px; background: var(--card); border: 1px solid var(--edge);
    border-radius: 13px; padding: 15px 18px;
  }
  summary { cursor: pointer; font-weight: 700; font-size: 14.5px; }
  details p { color: var(--dim); font-size: 13.5px; line-height: 1.6; margin: 13px 0 0; max-width: 70ch; }
  details h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .07em;
               color: var(--dim); margin: 18px 0 7px; }
  pre {
    background: #05101f; border: 1px solid var(--edge); border-radius: 9px;
    padding: 12px 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.5;
    font-family: ui-monospace, Menlo, Consolas, monospace; color: #cfe6ff;
  }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px;
         background: #05101f; padding: 1px 5px; border-radius: 4px; color: #cfe6ff; }
  .shapes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .shapes code { font-size: 12px; }
  .dirs { list-style: none; }
  .dirs li { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px;
             color: #cfe6ff; padding: 2px 0; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1>Faces</h1>
    <span class="count" id="count"></span>
  </header>
  <p class="lede">
    Every expression this device can draw. Click one to put it on the panel.
    Each is a JSON file — add your own and it appears here.
  </p>

  <div class="bar">
    <button id="reload">Reload from disk</button>
    <button id="forget" class="ghost">Forget token</button>
    <span id="status"></span>
  </div>

  <div id="problems"><h2>Files that could not be loaded</h2><ul id="problem-list"></ul></div>

  <div class="grid" id="grid"></div>

  <details>
    <summary>Adding your own</summary>

    <p>
      Drop a <code>.json</code> file in one of these directories and press
      <strong>Reload from disk</strong>. The filename is the name a model sends
      to <code>spc_expression</code>, so <code>pizza.json</code> becomes
      <code>pizza</code>. A file here overrides a built-in one of the same name;
      delete it and the built-in comes back.
    </p>
    <ul class="dirs" id="dirs"></ul>

    <h3>The easy way: name shapes that already exist</h3>
    <pre id="starter-simple"></pre>
    <p>Eyes, brows and mouths you can name:</p>
    <div class="shapes" id="shape-list"></div>

    <h3>The other way: draw something new</h3>
    <p>
      Any part can carry geometry instead of a name. Coordinates are relative to
      that part's own centre, in the same 400&times;300 box as the previews above —
      an eye is about 86 wide and 122 tall, a mouth about 112 wide. The panel
      renderer transforms them into its own units, so what you see here is what
      lands on the glass.
    </p>
    <pre id="starter-geometry"></pre>
    <p>
      Shapes: <code>quad</code> (three points: start, control, end),
      <code>line</code> (two or more points), <code>rounded_rect</code>
      (<code>w</code>, <code>h</code>, <code>r</code> — eyes only),
      <code>cross</code> (<code>size</code>), and <code>paths</code> to combine
      several into one part. <code>ink</code> takes a hex colour, and
      <code>blink</code>: <code>false</code> stops the idle blink for a face
      whose eyes are already shut.
    </p>
  </details>

</div>

<svg style="display:none"><defs></defs></svg>
<script>
__FACE_PARTS__

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------
// Drawn with the shared geometry above rather than a copy, so a face that looks
// right here looks right on the panel. The face page's own drawFace() writes
// into one fixed set of element ids; a grid needs one per tile, so this builds
// the markup instead of mutating it. Same paths, same numbers.

const SVG_NS = "http://www.w3.org/2000/svg";

function previewSvg(spec) {
  const eyes = spec.eyes || {};
  const gaze = GAZE[spec.gaze || "center"] || GAZE.center;
  const parts = [];

  for (const which of ["left", "right"]) {
    const [bx, by] = BROW_AT[which];
    const brow = shapePath(spec.brow, BROW);
    if (brow) parts.push(`<path class="stroke" d="${brow}" transform="translate(${bx} ${by})"/>`);
  }

  const eyeParts = [];
  for (const which of ["left", "right"]) {
    const [cx, cy] = EYE_AT[which];
    const shape = eyes[which];
    const d = shapePath(shape, EYE);
    if (d) eyeParts.push(`<path class="stroke" d="${d}" transform="translate(${cx} ${cy})"/>`);
    const size = typeof shape === "string"
      ? EYE_SIZE[shape]
      : (shape && shape.rounded_rect ? [shape.rounded_rect.w, shape.rounded_rect.h] : null);
    if (size) {
      eyeParts.push(`<circle class="glint" cx="${cx - size[0] * 0.19}" cy="${cy - size[1] * 0.2}" r="9"/>`);
      eyeParts.push(`<circle class="glint" cx="${cx + size[0] * 0.12}" cy="${cy + size[1] * 0.03}" r="5"/>`);
    }
  }
  parts.push(`<g transform="translate(${gaze[0]} ${gaze[1]})">${eyeParts.join("")}</g>`);

  const mouth = shapePath(spec.mouth, MOUTH);
  if (mouth) parts.push(`<path class="stroke" d="${mouth}" transform="${mouthTransform(spec.mouth)}"/>`);

  // 300x300 rather than the page's 400x300: a tile is roughly square, and the
  // face is centred in the middle 300 of the wider box anyway.
  return `<svg viewBox="50 10 300 280" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`;
}

// ---------------------------------------------------------------------------
// Talking to the agent
// ---------------------------------------------------------------------------
// Reading is open; changing anything is not. The token is asked for only when
// the agent actually refuses, so a deployment with no token configured never
// sees a prompt.

const TOKEN_KEY = "spc-fleet-token";
let token = localStorage.getItem(TOKEN_KEY) || "";

function say(text, kind) {
  const node = document.getElementById("status");
  node.textContent = text;
  node.className = kind || "";
}

async function post(path, body) {
  const send = (tok) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(tok ? { "X-Fleet-Token": tok } : {}) },
    body: JSON.stringify(body || {}),
  });

  let res = await send(token);
  if (res.status === 401) {
    const entered = prompt("This agent needs its fleet token (X-Fleet-Token):", token || "");
    if (!entered) { say("Cancelled — nothing changed.", "bad"); return null; }
    token = entered.trim();
    res = await send(token);
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      say("That token was rejected.", "bad");
      return null;
    }
    localStorage.setItem(TOKEN_KEY, token);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { say(data.error || `Request failed (${res.status})`, "bad"); return null; }
  return data;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

let catalog = null;
let live = null;

function render() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  for (const spec of catalog.expressions) {
    const source = catalog.sources[spec.name] || "";
    const tile = document.createElement("div");
    tile.className = "tile" + (spec.name === live ? " live" : "");
    // Its own ink, so a custom colour is visible in the picker and not just on
    // the panel. Set on the tile rather than the document: this is a grid of
    // faces that disagree about colour, which the live page never has to be.
    if (spec.ink) {
      tile.style.setProperty("--ink", spec.ink);
      tile.style.setProperty("--glow", hexGlow(spec.ink));
    }
    tile.innerHTML =
      previewSvg(spec) +
      `<div class="name">${spec.emoji ? spec.emoji + " " : ""}${escapeHtml(spec.label || spec.name)}</div>` +
      `<div class="desc">${escapeHtml(spec.description || "")}</div>` +
      `<div class="src" title="${escapeHtml(source)}">${escapeHtml(source === "builtin" ? "built in" : source)}</div>` +
      (spec.name === live ? `<div class="badge">on the panel</div>` : "");
    tile.onclick = () => choose(spec.name);
    grid.appendChild(tile);
  }

  document.getElementById("count").textContent =
    `${catalog.expressions.length} available` +
    (catalog.problems.length ? ` · ${catalog.problems.length} file(s) rejected` : "");

  const box = document.getElementById("problems");
  box.style.display = catalog.problems.length ? "block" : "none";
  document.getElementById("problem-list").innerHTML =
    catalog.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("");

  document.getElementById("dirs").innerHTML =
    catalog.dirs.map((d) => `<li>${escapeHtml(d)}/</li>`).join("");

  document.getElementById("shape-list").innerHTML =
    ["eyes", "brows", "mouths"].map((group) =>
      `<code>${group}: ${catalog.shapes[group].join(" · ")}</code>`).join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function choose(name) {
  const done = await post("/display", { expression: name });
  if (!done) return;
  live = name;
  say(`Panel is showing "${name}".`, "good");
  render();
}

async function refresh() {
  const res = await fetch("/expressions", { cache: "no-store" });
  catalog = await res.json();
  try {
    const state = await (await fetch("/display/state", { cache: "no-store" })).json();
    live = state.expression;
  } catch (err) { /* the panel's current face is a nicety, not a requirement */ }
  render();
}

document.getElementById("reload").onclick = async () => {
  say("Rescanning…");
  const done = await post("/expressions/reload");
  if (!done) return;
  await refresh();
  say(done.problems.length
    ? `Reloaded — ${done.expressions.length} faces, ${done.problems.length} file(s) rejected.`
    : `Reloaded — ${done.expressions.length} faces, all valid.`,
    done.problems.length ? "bad" : "good");
};

document.getElementById("forget").onclick = () => {
  localStorage.removeItem(TOKEN_KEY);
  token = "";
  say("Token forgotten.");
};

document.getElementById("starter-simple").textContent = JSON.stringify({
  name: "smug",
  label: "Smug",
  emoji: "😏",
  description: "Narrowed eyes, looking away.",
  eyes: { left: "narrow", right: "narrow" },
  brow: "raised",
  mouth: "small",
  gaze: "right"
}, null, 2);

document.getElementById("starter-geometry").textContent = JSON.stringify({
  name: "starstruck",
  label: "Starstruck",
  eyes: {
    left:  { line: [[0,-56],[13,-16],[54,0],[13,16],[0,56],[-13,16],[-54,0],[-13,-16],[0,-56]] },
    right: { line: [[0,-56],[13,-16],[54,0],[13,16],[0,56],[-13,16],[-54,0],[-13,-16],[0,-56]] }
  },
  brow: "raised",
  mouth: { paths: [
    { quad: [[-64,-6],[0,22],[64,-6]] },
    { quad: [[-64,-6],[0,84],[64,-6]] }
  ]},
  ink: "#ffd166"
}, null, 2);

refresh();
</script>
</body>
</html>
"""

PICKER_HTML = _PICKER_HTML.replace("__FACE_PARTS__", FACE_PARTS_JS)
