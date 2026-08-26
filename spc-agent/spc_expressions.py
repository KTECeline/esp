"""The face vocabulary, as data a user can add to.

Until now an expression was a row in three hand-kept tables — `EXPRESSIONS` in
spc_agent.py for validation, `EXPRESSIONS`/`EYE`/`BROW`/`MOUTH` in spc_face.py
for the browser page, and `EYE_SHAPE`/`BROW_SHAPE`/`MOUTH_SHAPE` in spc_fb.py
for the glass. Adding a face meant editing Python in two languages' worth of
renderers and remembering the third. Nobody who is not us was ever going to do
that, which is the whole reason the panel only ever had ten moods.

Now an expression is a JSON file. This module finds them, validates them, and
hands both renderers the same catalog.

  <this dir>/expressions/*.json      the ten shipped ones
  /etc/spc/expressions/*.json        a deployment's own
  ~/.spc/expressions/*.json          a user's own
  $SPC_EXPRESSIONS_DIR               overrides the list entirely

Later directories win, so dropping `happy.json` in the user directory
overrides the shipped one rather than colliding with it, and deleting the file
puts the shipped one back.

Two ways to write a face, and the difference matters:

  by name      "mouth": "grin" — picks a shape each renderer already draws in
               its own tuned geometry. Costs nothing, looks right on both, and
               is how all ten builtins are written. Recombining the existing
               parts already gets you far more than ten faces.

  by geometry  "mouth": {"quad": [[-70, 0], [0, 90], [70, 0]]} — a shape that
               did not exist before, in the coordinates of the browser page's
               400x300 face box (spc_face.py's viewBox), because that is the
               space you can actually look at while drawing one. Each renderer
               transforms it into its own units.

BUILTIN below duplicates the shipped JSON on purpose. A device that lost its
expressions directory mid-deploy still has to boot its screen — the same reason
spc_agent.py kept its own constants instead of reading mcp-core's face-spec.json.
The difference is that the duplication is now one dict in one file, and
test/face-spec.test.mjs asserts it still matches the JSON beside it.
"""

import copy
import glob
import json
import os
import re

# The shape names a JSON file may use. These are spc_face.py's names, because
# the canonical geometry space is its face box too — one vocabulary, and the
# framebuffer renderer maps them onto its own ("happy" is "arc_up" there).
EYE_SHAPES = ("open", "wide", "narrow", "happy", "closed", "cross")
BROW_SHAPES = ("flat", "raised", "angry", "sad", "none")
MOUTH_SHAPES = ("smile", "grin", "small", "flat", "frown", "open", "wave")

GAZES = ("center", "left", "right", "up", "down")

# Canonical coordinates are the browser page's 400x300 face box. Nothing a user
# draws should land outside it; a stray extra zero would otherwise paint a
# stroke across the whole panel and read as a crashed screen.
COORD_LIMIT = 400

_HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


# ---------------------------------------------------------------------------
# The ten shipped expressions
# ---------------------------------------------------------------------------
# Kept as the fallback for a device with no expressions directory. `mirror` is
# not a field: an expression names its two eyes separately, which is what makes
# a wink a wink rather than two identical arcs.

BUILTIN = {
    "neutral": {
        "label": "Neutral", "emoji": "🙂",
        "description": "Resting face. What the panel shows when nothing else is happening.",
        "eyes": {"left": "open", "right": "open"}, "brow": "flat", "mouth": "smile",
    },
    "happy": {
        "label": "Happy", "emoji": "😄",
        "description": "Grinning, eyes arched, brows up.",
        "eyes": {"left": "happy", "right": "happy"}, "brow": "raised", "mouth": "grin",
    },
    "listening": {
        "label": "Listening", "emoji": "👂",
        "description": "Eyes wide and attentive. Set this before you listen.",
        "eyes": {"left": "wide", "right": "wide"}, "brow": "raised", "mouth": "small",
    },
    "thinking": {
        "label": "Thinking", "emoji": "🤔",
        "description": "One eye narrowed, looking up. Set this while you work.",
        "eyes": {"left": "narrow", "right": "open"}, "brow": "raised", "mouth": "flat",
        "gaze": "up",
    },
    "speaking": {
        "label": "Speaking", "emoji": "💬",
        "description": "Open mouth, which the browser page animates while it talks.",
        "eyes": {"left": "open", "right": "open"}, "brow": "flat", "mouth": "open",
    },
    "confused": {
        "label": "Confused", "emoji": "😕",
        "description": "Lopsided eyes and a wavy mouth. For a request that did not parse.",
        "eyes": {"left": "open", "right": "narrow"}, "brow": "raised", "mouth": "wave",
    },
    "sad": {
        "label": "Sad", "emoji": "🙁",
        "description": "Narrowed eyes, drooping brows, a frown.",
        "eyes": {"left": "narrow", "right": "narrow"}, "brow": "sad", "mouth": "frown",
    },
    "wink": {
        "label": "Wink", "emoji": "😉",
        "description": "One eye arched shut. The asymmetry is the point.",
        "eyes": {"left": "happy", "right": "open"}, "brow": "raised", "mouth": "grin",
    },
    "sleeping": {
        "label": "Sleeping", "emoji": "😴",
        "description": "Eyes closed, no brows, dimmed. The page adds drifting z's.",
        "eyes": {"left": "closed", "right": "closed"}, "brow": "none", "mouth": "flat",
        "ink": "#2a6f95", "blink": False,
    },
    "error": {
        "label": "Error", "emoji": "😵",
        "description": "Crossed-out eyes in red. For a failure someone in the room should notice.",
        "eyes": {"left": "cross", "right": "cross"}, "brow": "angry", "mouth": "frown",
        "ink": "#ff7a7a",
    },
}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
# Everything here returns a message rather than raising, because these messages
# are read by whoever just wrote the file — in the picker page, in the agent's
# log, and in the error a model gets back. "bad shape" helps nobody.

def _point(value, where):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return f"{where} must be a two-number point like [-52, 26], got {value!r}"
    for n in value:
        if isinstance(n, bool) or not isinstance(n, (int, float)):
            return f"{where} must be numbers, got {value!r}"
        if abs(n) > COORD_LIMIT:
            return (f"{where} is {n}, outside the {COORD_LIMIT}-unit face box. "
                    f"Coordinates are relative to the part's own centre, so an "
                    f"eye is about 86 wide and a mouth about 112.")
    return None


def _geometry(spec, where, allow_rect):
    """Validate one inline shape. Returns an error message, or None."""
    if not isinstance(spec, dict) or not spec:
        return f"{where} must be a shape name or a geometry object"
    if len(spec) != 1:
        return (f"{where} has {len(spec)} keys ({', '.join(sorted(spec))}); a geometry "
                f"object holds exactly one of: quad, line, rounded_rect, cross, paths")

    kind, body = next(iter(spec.items()))

    if kind == "quad":
        if not isinstance(body, (list, tuple)) or len(body) != 3:
            return f"{where}.quad needs exactly 3 points: start, control, end"
        for i, pt in enumerate(body):
            err = _point(pt, f"{where}.quad[{i}]")
            if err:
                return err
        return None

    if kind == "line":
        if not isinstance(body, (list, tuple)) or len(body) < 2:
            return f"{where}.line needs at least 2 points"
        for i, pt in enumerate(body):
            err = _point(pt, f"{where}.line[{i}]")
            if err:
                return err
        return None

    if kind == "rounded_rect":
        if not allow_rect:
            return f"{where}.rounded_rect is only available for eyes"
        if not isinstance(body, dict):
            return f"{where}.rounded_rect must be an object with w, h and r"
        for key in ("w", "h"):
            n = body.get(key)
            if isinstance(n, bool) or not isinstance(n, (int, float)) or not 4 <= n <= COORD_LIMIT:
                return f"{where}.rounded_rect.{key} must be a number between 4 and {COORD_LIMIT}, got {n!r}"
        r = body.get("r", 0)
        if isinstance(r, bool) or not isinstance(r, (int, float)) or r < 0:
            return f"{where}.rounded_rect.r must be a number >= 0, got {r!r}"
        if r > min(body["w"], body["h"]) / 2:
            return (f"{where}.rounded_rect.r is {r}, more than half the shorter side — "
                    f"the corners would overlap. Use at most {min(body['w'], body['h']) / 2:g}.")
        return None

    if kind == "cross":
        if not isinstance(body, dict):
            return f"{where}.cross must be an object with a size"
        n = body.get("size")
        if isinstance(n, bool) or not isinstance(n, (int, float)) or not 4 <= n <= COORD_LIMIT:
            return f"{where}.cross.size must be a number between 4 and {COORD_LIMIT}, got {n!r}"
        return None

    if kind == "paths":
        if not isinstance(body, (list, tuple)) or not body:
            return f"{where}.paths must be a non-empty list of shapes"
        for i, part in enumerate(body):
            if isinstance(part, dict) and "paths" in part:
                return f"{where}.paths[{i}] nests another paths — flatten it into one list"
            err = _geometry(part, f"{where}.paths[{i}]", allow_rect)
            if err:
                return err
        return None

    return (f"{where} has unknown shape type {kind!r}. Use one of: "
            f"quad, line, rounded_rect, cross, paths")


def _part(spec, where, names, allow_rect=False):
    if isinstance(spec, str):
        if spec not in names:
            return f"{where} is {spec!r}, which is not a shape this draws. Use one of: {', '.join(names)} — or give geometry instead."
        return None
    return _geometry(spec, where, allow_rect)


def validate(name, spec):
    """Check one expression. Returns a list of problems, empty when it is fine."""
    problems = []
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", name or ""):
        problems.append(
            f"name {name!r} must be lowercase letters, digits and underscores, "
            f"start with a letter, and be at most 32 characters — it is what a "
            f"model sends to spc_expression."
        )
    if not isinstance(spec, dict):
        return problems + [f"{name}: the file must contain a JSON object"]

    eyes = spec.get("eyes")
    if not isinstance(eyes, dict) or "left" not in eyes or "right" not in eyes:
        problems.append(f"{name}: needs an \"eyes\" object with both \"left\" and \"right\" — "
                        f"name the same shape twice for a symmetric face.")
    else:
        for side in ("left", "right"):
            err = _part(eyes[side], f"{name}.eyes.{side}", EYE_SHAPES, allow_rect=True)
            if err:
                problems.append(err)

    if "brow" not in spec:
        problems.append(f"{name}: needs a \"brow\" — use \"none\" for a face without them.")
    else:
        err = _part(spec["brow"], f"{name}.brow", BROW_SHAPES)
        if err:
            problems.append(err)

    if "mouth" not in spec:
        problems.append(f"{name}: needs a \"mouth\".")
    else:
        err = _part(spec["mouth"], f"{name}.mouth", MOUTH_SHAPES)
        if err:
            problems.append(err)

    gaze = spec.get("gaze")
    if gaze is not None and gaze not in GAZES:
        problems.append(f"{name}.gaze is {gaze!r}; use one of: {', '.join(GAZES)}")

    ink = spec.get("ink")
    if ink is not None and not (isinstance(ink, str) and _HEX_COLOR.match(ink)):
        problems.append(f"{name}.ink is {ink!r}; it must be a hex colour like \"#ffb347\"")

    if "blink" in spec and not isinstance(spec["blink"], bool):
        problems.append(f"{name}.blink must be true or false")

    for key in ("label", "emoji", "description"):
        if key in spec and not isinstance(spec[key], str):
            problems.append(f"{name}.{key} must be a string")

    return problems


def _normalise(name, spec):
    """Fill in the optional fields so every consumer sees the same shape."""
    out = copy.deepcopy(spec)
    out["name"] = name
    out.setdefault("label", name.replace("_", " ").title())
    out.setdefault("emoji", "")
    out.setdefault("description", "")
    out.setdefault("gaze", "center")
    out.setdefault("ink", None)
    # Both renderers idle-blink so the panel never reads as crashed. Closed or
    # crossed-out eyes have nothing to blink, which used to be a hardcoded
    # `expression != "sleeping"` in each of them; it is a field now so a user's
    # own resting face can opt out too.
    out.setdefault("blink", True)
    return out


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def search_dirs():
    """Where to look, in increasing order of precedence.

    SPC_EXPRESSIONS_DIR replaces the list rather than adding to it, so a test or
    a demo can run against exactly one directory and know nothing else leaked in.
    It accepts several paths separated by os.pathsep, same order rule.
    """
    override = os.environ.get("SPC_EXPRESSIONS_DIR")
    if override:
        return [os.path.expanduser(p) for p in override.split(os.pathsep) if p]
    here = os.path.dirname(os.path.abspath(__file__))
    return [
        os.path.join(here, "expressions"),
        "/etc/spc/expressions",
        os.path.expanduser("~/.spc/expressions"),
    ]


class Catalog:
    """Every expression this device can draw, and everything that went wrong.

    `problems` is not an error path. One malformed file must not take the face
    down with it — the bad expression is dropped, the rest load, and the message
    surfaces in /expressions and on the picker page where whoever wrote the file
    is looking.
    """

    def __init__(self, expressions, problems, sources):
        self.expressions = expressions
        self.problems = problems
        self.sources = sources          # name -> the file it came from, or "builtin"

    def names(self):
        return sorted(self.expressions)

    def get(self, name):
        return self.expressions.get(name)

    def __contains__(self, name):
        return name in self.expressions

    def to_json(self):
        return {
            "expressions": [self.expressions[n] for n in self.names()],
            "gazes": list(GAZES),
            "shapes": {
                "eyes": list(EYE_SHAPES),
                "brows": list(BROW_SHAPES),
                "mouths": list(MOUTH_SHAPES),
            },
            "sources": self.sources,
            "dirs": search_dirs(),
            "problems": self.problems,
        }


def load(dirs=None):
    """Build the catalog: the builtins, then every readable directory over them."""
    expressions = {n: _normalise(n, s) for n, s in BUILTIN.items()}
    sources = {n: "builtin" for n in expressions}
    problems = []

    for directory in (search_dirs() if dirs is None else dirs):
        if not os.path.isdir(directory):
            continue
        for path in sorted(glob.glob(os.path.join(directory, "*.json"))):
            name = os.path.splitext(os.path.basename(path))[0]
            try:
                with open(path, encoding="utf-8") as fh:
                    spec = json.load(fh)
            except json.JSONDecodeError as err:
                problems.append(f"{path}: not valid JSON — {err}")
                continue
            except OSError as err:
                problems.append(f"{path}: could not be read — {err}")
                continue

            # The filename wins over any "name" inside, so two files can never
            # claim one name and the picker can tell you which file to edit.
            if isinstance(spec, dict) and spec.get("name") not in (None, name):
                problems.append(
                    f"{path}: says \"name\": {spec['name']!r} but the file is {name}.json. "
                    f"The filename is what counts — rename the file or drop the field."
                )

            bad = validate(name, spec)
            if bad:
                problems.extend(f"{path}: {p}" for p in bad)
                continue

            expressions[name] = _normalise(name, spec)
            sources[name] = path

    return Catalog(expressions, problems, sources)
