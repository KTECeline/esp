// Runtime settings: the knobs that used to be constants.
//
// Before this existed, "how long before the box stops listening" was
// VAD_SILENCE_HOLD_MS in listen_v2.c, "how long to watch for a payment QR" was
// PAY_SCAN_TIMEOUT_MS in server.js, and "how long will the food take" was a
// sentence inside a prompt. Tuning any of them meant editing source — and for
// the box ones, a reflash — so in practice nobody tuned them, and a value
// measured once in one room stayed the fleet's answer everywhere.
//
// Two files, on purpose:
//   settings-spec.json  the SCHEMA — every key, its type, range, default and
//                       what it means. Ships with the code, read-only.
//   settings.json       the OVERRIDES — only the keys someone changed.
//
// Storing only overrides is the load-bearing part. If this saved every value,
// the first save would freeze that day's defaults forever, and a default
// improved in a later release would never reach an install that had once
// touched anything. Instead an untouched key follows the code.
//
// This is NOT config.json, and the split matters. config.json is wiring:
// addresses, tokens, which backend, which camera. Getting it wrong takes the
// fleet offline, so it is a human's file. These are behaviour knobs — safe to
// change mid-conversation, reversible, range-checked — which is exactly why the
// agent is allowed to change them itself.
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";

// Every value that arrives from the network is a string sometimes (a form post,
// a query param) and a real type other times (JSON from an MCP client). Coerce
// once, here, so no consumer ever has to wonder which it got.
function coerce(spec, raw) {
  const name = `"${spec.key}"`;
  switch (spec.type) {
    case "int":
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) {
        return { error: `${name} must be a number, got ${JSON.stringify(raw)}.` };
      }
      if (spec.type === "int" && !Number.isInteger(n)) {
        return { error: `${name} must be a whole number, got ${n}.` };
      }
      if (spec.min !== undefined && n < spec.min) {
        return { error: `${name} must be at least ${spec.min}${spec.unit ? " " + spec.unit : ""}, got ${n}.` };
      }
      if (spec.max !== undefined && n > spec.max) {
        return { error: `${name} must be at most ${spec.max}${spec.unit ? " " + spec.unit : ""}, got ${n}.` };
      }
      return { value: n };
    }
    case "bool": {
      if (typeof raw === "boolean") return { value: raw };
      const s = String(raw).trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return { value: true };
      if (["false", "0", "no", "off"].includes(s)) return { value: false };
      return { error: `${name} must be true or false, got ${JSON.stringify(raw)}.` };
    }
    case "string": {
      const s = String(raw ?? "");
      if (spec.max_length !== undefined && s.length > spec.max_length) {
        return { error: `${name} must be at most ${spec.max_length} characters, got ${s.length}.` };
      }
      return { value: s };
    }
    case "enum": {
      const s = String(raw ?? "");
      if (!spec.values.includes(s)) {
        return { error: `${name} must be one of: ${spec.values.join(", ")}. Got ${JSON.stringify(raw)}.` };
      }
      return { value: s };
    }
    default:
      return { error: `${name} has unsupported type "${spec.type}" in settings-spec.json.` };
  }
}

// A wrong key is the most likely mistake a model makes here, and the least
// useful thing to answer with is "unknown key". Cheap edit distance over the
// key list turns that into "did you mean listen.silence_hold_ms".
function nearest(key, keys) {
  const dist = (a, b) => {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length];
  };
  const scored = keys
    .map((k) => ({ k, d: dist(key.toLowerCase(), k.toLowerCase()) }))
    .sort((a, b) => a.d - b.d);
  // A suggestion that shares almost nothing with what was typed is noise.
  return scored.filter((s) => s.d <= Math.max(3, Math.floor(key.length / 2))).slice(0, 3).map((s) => s.k);
}

export const SETTING_SCOPES = ["server", "box", "device", "agent"];

// The spec ships next to this file, so its absence means a broken install
// rather than a missing option — and a store that came up anyway would be
// inventing its own idea of what is tunable. Same hard-fail rule as
// face-spec.json in mcp-tools.js.
export function loadSpec(specPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Cannot read the settings catalog at ${specPath}: ${err.message}. ` +
      `It ships next to settings.js — restore it from the repo rather than ` +
      `hardcoding knob names here.`
    );
  }
  if (!Array.isArray(parsed.settings) || parsed.settings.length === 0) {
    throw new Error(`${specPath} has no non-empty "settings" array.`);
  }
  const byKey = new Map();
  for (const s of parsed.settings) {
    if (!s.key) throw new Error(`${specPath}: a setting has no "key".`);
    if (byKey.has(s.key)) throw new Error(`${specPath}: duplicate key "${s.key}".`);
    if (!SETTING_SCOPES.includes(s.scope)) {
      throw new Error(`${specPath}: "${s.key}" has scope "${s.scope}"; valid: ${SETTING_SCOPES.join(", ")}.`);
    }
    if (s.default === undefined) throw new Error(`${specPath}: "${s.key}" has no default.`);
    // Validating the default against its own rules catches a spec edit that
    // puts the shipped value outside the range it advertises — which would
    // otherwise only surface as an unresettable key months later.
    const check = coerce(s, s.default);
    if (check.error) throw new Error(`${specPath}: default for ${check.error}`);
    byKey.set(s.key, s);
  }
  return { version: parsed.version ?? 1, byKey, list: parsed.settings };
}

export function createSettings({ specPath, valuePath, persist, onChange } = {}) {
  const spec = loadSpec(specPath);

  // Missing is normal and means "nothing has been changed yet". Malformed is
  // not fatal either: refusing to start because a behaviour file got truncated
  // would take the whole fleet down over a knob, so it is loud and ignored.
  let overrides = {};
  if (valuePath) {
    try {
      const parsed = JSON.parse(readFileSync(valuePath, "utf8"));
      if (parsed && typeof parsed === "object") overrides = parsed.settings ?? parsed;
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn(`Settings file ${valuePath} could not be read (${err.message}) — ` +
                     `continuing with defaults. It will be rewritten on the next change.`);
      }
    }
  }
  // A stored key that the spec no longer has is kept in the file but ignored
  // here, so a downgrade-then-upgrade does not silently lose someone's tuning.
  for (const key of Object.keys(overrides)) {
    if (!spec.byKey.has(key)) {
      console.warn(`Settings file has "${key}", which is not in the catalog — ignored (kept on disk).`);
    }
  }

  // Bumped on every accepted change. Boxes and Pis poll this instead of the
  // whole payload: one integer comparison tells them whether to bother.
  let revision = 0;

  const get = (key) => {
    const s = spec.byKey.get(key);
    if (!s) throw new Error(`Unknown setting "${key}".`);
    const raw = overrides[key];
    if (raw === undefined) return s.default;
    const c = coerce(s, raw);
    // An override that no longer validates (the spec tightened a range under
    // it) falls back to the default rather than propagating a bad value into a
    // timer. Silent, because this is read on hot paths.
    return c.error ? s.default : c.value;
  };

  const all = (scope) => {
    const out = {};
    for (const s of spec.list) {
      if (scope && s.scope !== scope) continue;
      out[s.key] = get(s.key);
    }
    return out;
  };

  const describe = (scope) =>
    spec.list
      .filter((s) => !scope || s.scope === scope)
      .map((s) => ({
        key: s.key,
        scope: s.scope,
        type: s.type,
        value: get(s.key),
        default: s.default,
        ...(s.min !== undefined ? { min: s.min } : {}),
        ...(s.max !== undefined ? { max: s.max } : {}),
        ...(s.max_length !== undefined ? { max_length: s.max_length } : {}),
        ...(s.values ? { values: s.values } : {}),
        ...(s.unit ? { unit: s.unit } : {}),
        ...(s.restart ? { takes_effect: "on the next mcp-core restart" } : {}),
        modified: overrides[s.key] !== undefined,
        summary: s.summary,
        ...(s.guidance ? { guidance: s.guidance } : {})
      }));

  async function save() {
    if (!valuePath) return;
    const body = JSON.stringify(
      {
        _comment:
          "Runtime setting OVERRIDES only. Anything absent here follows the default in " +
          "mcp-core/settings-spec.json, which is where the meaning and valid range of each " +
          "key is documented. Written by mcp-core (PATCH /settings, or the fleet_settings_set " +
          "tool); safe to hand-edit while the server is stopped.",
        settings: overrides
      },
      null,
      2
    ) + "\n";
    // Temp file + rename, same rule as config.json: a crash mid-write must not
    // leave a truncated file that reads as "all defaults" on the next boot.
    const tmp = valuePath + ".tmp";
    await writeFile(tmp, body);
    await rename(tmp, valuePath);
  }

  // All-or-nothing. A patch of five keys where the third is out of range must
  // not leave the first two applied — half-applied tuning is worse than none,
  // because the caller is told it failed and has no idea what stuck.
  async function set(patch, { actor = "unknown" } = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Settings patch must be an object of { key: value }.");
    }
    const entries = Object.entries(patch);
    if (entries.length === 0) throw new Error("Settings patch is empty — nothing to change.");

    const staged = [];
    const errors = [];
    for (const [key, raw] of entries) {
      const s = spec.byKey.get(key);
      if (!s) {
        const near = nearest(key, [...spec.byKey.keys()]);
        errors.push(
          `Unknown setting "${key}".` +
          (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
          ` List them all with fleet_settings_list.`
        );
        continue;
      }
      const c = coerce(s, raw);
      if (c.error) { errors.push(c.error); continue; }
      staged.push({ spec: s, key, value: c.value, from: get(key) });
    }
    if (errors.length) {
      throw new Error(
        `${errors.length === 1 ? "" : `${errors.length} problems — nothing was changed.\n`}` +
        errors.join("\n")
      );
    }

    const changed = [];
    for (const st of staged) {
      // Comparing against the effective value, not against the stored
      // override, so re-sending the current value is a no-op instead of a
      // pointless push to every box on the network.
      if (st.from === st.value) continue;
      overrides[st.key] = st.value;
      changed.push({ key: st.key, scope: st.spec.scope, from: st.from, to: st.value,
                     ...(st.spec.restart ? { takes_effect: "on the next mcp-core restart" } : {}) });
    }
    if (changed.length === 0) return { revision, changed: [], unchanged: staged.map((s) => s.key) };

    revision++;
    if (persist !== false) await save();
    const scopes = [...new Set(changed.map((c) => c.scope))];
    console.log(`Settings changed by ${actor} (rev ${revision}): ` +
                changed.map((c) => `${c.key} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join(", "));
    // Fired after the write, so a listener that pushes to hardware can never
    // deliver a value that is not yet durable here.
    if (onChange) await onChange({ scopes, changed, revision });
    return { revision, changed, unchanged: staged.filter((s) => !changed.some((c) => c.key === s.key)).map((s) => s.key) };
  }

  // Reset is a distinct verb rather than "set it back to the default you read
  // a moment ago", because the point of an untouched key is that it FOLLOWS the
  // default. Writing today's default as an override would pin it forever.
  async function reset(keys, { actor = "unknown" } = {}) {
    const targets = keys === "all" || keys === undefined ? Object.keys(overrides) : keys;
    if (!Array.isArray(targets)) throw new Error('reset takes an array of keys, or "all".');
    const changed = [];
    for (const key of targets) {
      const s = spec.byKey.get(key);
      if (!s) {
        const near = nearest(key, [...spec.byKey.keys()]);
        throw new Error(`Unknown setting "${key}".` + (near.length ? ` Did you mean: ${near.join(", ")}?` : ""));
      }
      if (overrides[key] === undefined) continue;
      const from = get(key);
      delete overrides[key];
      if (from !== s.default) changed.push({ key, scope: s.scope, from, to: s.default });
    }
    if (changed.length === 0) return { revision, changed: [] };
    revision++;
    if (persist !== false) await save();
    const scopes = [...new Set(changed.map((c) => c.scope))];
    console.log(`Settings reset by ${actor} (rev ${revision}): ${changed.map((c) => c.key).join(", ")}`);
    if (onChange) await onChange({ scopes, changed, revision });
    return { revision, changed };
  }

  return {
    get,
    all,
    describe,
    set,
    reset,
    keys: () => [...spec.byKey.keys()],
    has: (key) => spec.byKey.has(key),
    specVersion: spec.version,
    get revision() { return revision; },
    // The exact payload a box or a Pi is sent. Kept here rather than at the
    // call site so the wire shape has one definition and one revision number.
    payload: (scope) => ({ revision, settings: all(scope) })
  };
}
