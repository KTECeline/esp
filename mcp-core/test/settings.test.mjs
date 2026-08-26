// Tests for the runtime settings store.
//
// Focused on the three things that are quiet when they go wrong:
//
//   1. ATOMICITY. A patch is all-or-nothing. A half-applied patch reports an
//      error and leaves the fleet in a state the caller cannot infer, which is
//      strictly worse than a rejected one.
//   2. OVERRIDES-ONLY PERSISTENCE. Saving every value would freeze that day's
//      defaults forever, so a better default in a later release could never
//      reach an install that had once touched anything. Nothing about the API
//      makes this visible — only the file contents do.
//   3. PUSH NOTIFICATION. A box-scoped change that does not fire onChange is a
//      value that is correct on the server and wrong on the hardware, with the
//      server reporting success. That is the failure this whole mechanism
//      exists to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSettings, loadSpec } from "../settings.js";

const SPEC = join(dirname(fileURLToPath(import.meta.url)), "..", "settings-spec.json");

function store(opts = {}) {
  const events = [];
  const s = createSettings({
    specPath: SPEC,
    persist: false,
    onChange: (e) => events.push(e),
    ...opts
  });
  return { s, events };
}

test("the shipped catalog is well formed", () => {
  // Runs the same validation the server does at startup, so a bad edit to
  // settings-spec.json fails here rather than at 6am on a box.
  const spec = loadSpec(SPEC);
  assert.ok(spec.byKey.size > 0);
  for (const [key, entry] of spec.byKey) {
    assert.match(key, /^[a-z0-9_]+\.[a-z0-9_]+$/, `${key} should be group.name`);
    assert.ok(entry.summary, `${key} has no summary — the tool description is all a model sees`);
  }
});

test("box-scoped keys fit the firmware's 512-byte body", () => {
  // The box reads a settings push into a 512-byte static buffer and truncates
  // silently past it, applying a prefix and mangling the line that straddles
  // the cut. boxes.js refuses to send an oversized body, so exceeding this
  // turns every box push into a hard failure — caught here at the moment a key
  // is added, rather than on the hardware.
  const { s } = store();
  const body = Object.entries(s.all("box"))
    .map(([k, v]) => `${k}|${v}`)
    .join("\n");
  assert.ok(body.length <= 511,
            `box settings body is ${body.length} bytes; the firmware buffer is 512`);
});

test("a value in range is applied and reported", async () => {
  const { s, events } = store();
  const before = s.get("listen.silence_hold_ms");
  const res = await s.set({ "listen.silence_hold_ms": 1800 });
  assert.equal(s.get("listen.silence_hold_ms"), 1800);
  assert.deepEqual(res.changed, [{ key: "listen.silence_hold_ms", scope: "box", from: before, to: 1800 }]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].scopes, ["box"]);
});

test("an out-of-range value is rejected and nothing in the patch is applied", async () => {
  // The important half is the SECOND assertion. Rejecting the bad key is
  // obvious; leaving the good key in the same patch untouched is what makes the
  // error safe to retry.
  const { s, events } = store();
  await assert.rejects(
    () => s.set({ "listen.silence_peak": 900, "pay.scan_timeout_ms": 1 }),
    /pay\.scan_timeout_ms.*at least 5000/
  );
  assert.equal(s.get("listen.silence_peak"), 1500, "the valid key must not have been applied");
  assert.equal(events.length, 0, "a rejected patch must not notify the hardware");
});

test("an unknown key is rejected with a suggestion", async () => {
  // A model that gets "unknown key" retries the same wrong key. One that gets
  // the near-match fixes it.
  const { s } = store();
  await assert.rejects(
    () => s.set({ "listen.silence_hold": 900 }),
    /Did you mean.*listen\.silence_hold_ms/
  );
});

test("setting a key to its current value is a no-op, not a push", async () => {
  // A box asleep on the far side of a network does not deserve to be woken
  // because someone re-sent a value it already has.
  const { s, events } = store();
  const res = await s.set({ "listen.silence_hold_ms": s.get("listen.silence_hold_ms") });
  assert.deepEqual(res.changed, []);
  assert.equal(events.length, 0);
  assert.equal(s.revision, 0, "revision must not move when nothing changed");
});

test("only overrides are written to disk, so untouched keys follow the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "espset-"));
  const file = join(dir, "settings.json");
  const { s } = store({ persist: true, valuePath: file });
  await s.set({ "listen.silence_hold_ms": 1800 });

  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved.settings), ["listen.silence_hold_ms"],
                   "writing every value would freeze today's defaults forever");
});

test("a reset removes the override rather than writing the default as a value", async () => {
  // The distinction that makes reset worth having as its own verb: a reset key
  // FOLLOWS the default from then on. Writing the number back would pin it, and
  // a better default in a later release would never reach this install.
  const dir = mkdtempSync(join(tmpdir(), "espset-"));
  const file = join(dir, "settings.json");
  const { s } = store({ persist: true, valuePath: file });
  await s.set({ "listen.silence_hold_ms": 1800 });
  await s.reset(["listen.silence_hold_ms"]);

  assert.equal(s.get("listen.silence_hold_ms"), 1200);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.settings, {}, "the key must be absent, not set to its default");
});

test("resetting a key that was never changed reports nothing and does not notify", async () => {
  const { s, events } = store();
  const res = await s.reset(["listen.silence_hold_ms"]);
  assert.deepEqual(res.changed, []);
  assert.equal(events.length, 0);
});

test("a stored override outside the spec's range falls back to the default", () => {
  // The case where a release tightens a range under a value someone had already
  // saved. Propagating it into a timer is the bad outcome; the default is the
  // safe one, and it is read on hot paths so it cannot throw.
  const dir = mkdtempSync(join(tmpdir(), "espset-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ settings: { "listen.silence_hold_ms": 999999 } }));
  const { s } = store({ valuePath: file });
  assert.equal(s.get("listen.silence_hold_ms"), 1200);
});

test("a corrupt settings file does not stop the store from loading", () => {
  // Taking the whole fleet offline over a truncated behaviour file would turn a
  // cosmetic problem into an outage. Loud and ignored is the right trade.
  const dir = mkdtempSync(join(tmpdir(), "espset-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, "{ not json");
  const { s } = store({ valuePath: file });
  assert.equal(s.get("listen.silence_hold_ms"), 1200);
});

test("a missing settings file is normal, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "espset-"));
  const file = join(dir, "never-written.json");
  assert.equal(existsSync(file), false);
  const { s } = store({ valuePath: file });
  assert.equal(s.get("listen.silence_hold_ms"), 1200);
});

test("scoped payloads carry only their own scope, plus the revision", async () => {
  const { s } = store();
  await s.set({ "listen.silence_hold_ms": 1800 });
  const box = s.payload("box");
  assert.equal(box.revision, 1);
  assert.ok("listen.silence_hold_ms" in box.settings);
  assert.ok(!("pay.scan_timeout_ms" in box.settings), "a box has no business knowing server timings");
});

test("a patch spanning scopes notifies each affected scope once", async () => {
  const { s, events } = store();
  await s.set({ "listen.silence_hold_ms": 1800, "pay.paid_linger_ms": 6000 });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].scopes.sort(), ["box", "server"]);
});

test("booleans and numbers survive arriving as strings", async () => {
  // Query params and form posts deliver strings; MCP clients deliver real
  // types. Coercing in one place means no consumer has to know which it got.
  const { s } = store();
  await s.set({ "order.confirm_required": "false", "pay.paid_linger_ms": "6000" });
  assert.equal(s.get("order.confirm_required"), false);
  assert.equal(s.get("pay.paid_linger_ms"), 6000);
});

test("a non-integer value for an int key is rejected", async () => {
  const { s } = store();
  await assert.rejects(() => s.set({ "chat.history_max": 4.5 }), /whole number/);
});
