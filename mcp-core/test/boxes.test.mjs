// Tests for the fleet registry's add/remove bookkeeping.
//
// Focused on remove(): it is the only operation here that DELETES persisted
// state (the registry is written straight back to config.json), and it is
// reachable from a button on the setup page. Everything it gets wrong is
// quiet — dropping the wrong box, or reporting a deletion that didn't happen
// and leaving the page showing a box the server still has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoxRegistry } from "../boxes.js";

function registry(entries = [{ id: "BOX-1", name: "Front", ip: "192.168.1.5" }]) {
  let writes = 0;
  const r = new BoxRegistry(entries, () => { writes++; });
  return { r, writes: () => writes };
}

test("remove drops the named box and persists", () => {
  const { r, writes } = registry([
    { id: "BOX-1", name: "Front", ip: "192.168.1.5" },
    { id: "BOX-2", name: "Back", ip: "192.168.1.6" }
  ]);
  assert.equal(r.remove("BOX-1"), true);
  assert.deepEqual(r.boxes.map((b) => b.id), ["BOX-2"]);
  assert.equal(writes(), 1, "removal must be written back to config.json");
});

test("removing an unknown box reports false and writes nothing", () => {
  // The caller 404s on this. Returning true would report a deletion that never
  // happened, and an unconditional persist would rewrite config.json on every
  // stray request.
  const { r, writes } = registry();
  assert.equal(r.remove("NOPE"), false);
  assert.equal(r.boxes.length, 1);
  assert.equal(writes(), 0);
});

test("remove takes the box with that id, not the one at that position", () => {
  const { r } = registry([
    { id: "BOX-1", name: "A", ip: "10.0.0.1" },
    { id: "BOX-2", name: "B", ip: "10.0.0.2" },
    { id: "BOX-3", name: "C", ip: "10.0.0.3" }
  ]);
  r.remove("BOX-2");
  assert.deepEqual(r.boxes.map((b) => b.id), ["BOX-1", "BOX-3"]);
});

test("a removed box can be re-adopted, and comes back clean", () => {
  // The realistic sequence behind the setup page's Forget then Add: the entry
  // must be rebuilt, not resurrected with stale live state attached.
  const { r } = registry();
  r.setOccupied("BOX-1", true);
  r.remove("BOX-1");
  assert.equal(r.upsert("BOX-1", "Front", "192.168.1.99"), "added");
  const b = r.byId("BOX-1");
  assert.equal(b.ip, "192.168.1.99");
  assert.equal(b.occupied ?? null, null, "presence must not survive a remove/re-add");
});

test("toConfig after a remove is what gets written to config.json", () => {
  const { r } = registry([
    { id: "BOX-1", name: "Front", ip: "192.168.1.5" },
    { id: "BOX-2", name: "Back", ip: "192.168.1.6" }
  ]);
  r.remove("BOX-2");
  assert.deepEqual(r.toConfig(), [{ id: "BOX-1", name: "Front", ip: "192.168.1.5" }]);
});
