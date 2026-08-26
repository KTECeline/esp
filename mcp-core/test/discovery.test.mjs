// Tests for LAN box discovery.
//
// What is worth testing here is not "does mDNS work" — that needs a network and
// would be a test of bonjour-service, not of this code. It is the parsing and
// the bookkeeping, which is where the failures are silent: a box that shows up
// twice under two addresses, a box that stays on the setup page hours after it
// was unplugged, or a TXT value that arrives as a Buffer and gets rendered as
// "[object Object]" on the page. None of those throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoxDiscovery, normalizeService, SERVICE_TYPE } from "../discovery.js";

// The shape bonjour-service hands to an 'up' listener.
function announcement(over = {}) {
  return {
    name: "BOX-C3B4",
    type: SERVICE_TYPE,
    protocol: "tcp",
    port: 80,
    addresses: ["192.168.1.50"],
    referer: { address: "192.168.1.50", family: "IPv4", port: 5353, size: 1 },
    txt: { id: "BOX-C3B4", name: "Front counter", fw: "v2.1" },
    ...over
  };
}

test("a normal announcement becomes a candidate", () => {
  const e = normalizeService(announcement());
  assert.equal(e.id, "BOX-C3B4");
  assert.equal(e.name, "Front counter");
  assert.equal(e.ip, "192.168.1.50");
  assert.equal(e.port, 80);
  assert.equal(e.fw, "v2.1");
});

// Responders differ on whether TXT values arrive decoded. Both are normal, and
// a Buffer that reached the page unconverted would render as garbage.
test("TXT values are accepted as Buffers as well as strings", () => {
  const e = normalizeService(announcement({
    txt: { id: Buffer.from("BOX-AAAA"), name: Buffer.from("Drive-thru"), fw: Buffer.from("v3") }
  }));
  assert.equal(e.id, "BOX-AAAA");
  assert.equal(e.name, "Drive-thru");
  assert.equal(e.fw, "v3");
});

test("a box with no id is not offered as a candidate", () => {
  // Something else on the network answering this service type, or firmware
  // predating the TXT records. Adopting it would write an entry keyed on a
  // name that never matches the box's real X-Box-Id.
  assert.equal(normalizeService(announcement({ txt: { name: "mystery" } })), null);
});

test("name falls back to the id rather than showing an empty label", () => {
  const e = normalizeService(announcement({ txt: { id: "BOX-9" } }));
  assert.equal(e.name, "BOX-9");
  assert.equal(e.fw, null);   // absent, not "undefined"
});

test("an IPv4 address is preferred over IPv6", () => {
  // Every push dials http://<ip>/… and the address is persisted to config.json.
  // An IPv6 link-local carries a zone index that does not survive that trip.
  const e = normalizeService(announcement({
    addresses: ["fe80::1c2b:3d4e:5f60:7a8b", "10.0.0.7"]
  }));
  assert.equal(e.ip, "10.0.0.7");
});

test("falls back to the interface the announcement arrived on", () => {
  const e = normalizeService(announcement({
    addresses: ["fe80::1c2b:3d4e:5f60:7a8b"],
    referer: { address: "10.0.0.9", family: "IPv4", port: 5353, size: 1 }
  }));
  assert.equal(e.ip, "10.0.0.9");
});

test("an announcement with no usable address is skipped", () => {
  assert.equal(normalizeService(announcement({ addresses: [], referer: undefined })), null);
});

// --- bookkeeping --------------------------------------------------------

function offline() {
  // enabled:false keeps the constructor from touching the network; the map and
  // list() logic under test are independent of the browser.
  return new BoxDiscovery({ enabled: false });
}

test("a box that moved to a new address updates instead of duplicating", () => {
  const d = offline();
  d.seen.set("BOX-1", { id: "BOX-1", name: "A", ip: "192.168.1.5", port: 80, fw: null, lastSeen: Date.now() });
  // Same id, new DHCP lease — this is the everyday case, not an edge case.
  const moved = normalizeService(announcement({
    txt: { id: "BOX-1", name: "A" }, addresses: ["192.168.1.77"]
  }));
  d.seen.set(moved.id, moved);
  const list = d.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].ip, "192.168.1.77");
});

test("a box not seen for a long time drops off the list", () => {
  // A box unplugged mid-session sends no mDNS goodbye, so without this it would
  // be offered as adoptable forever.
  const d = offline();
  d.seen.set("GONE", { id: "GONE", name: "G", ip: "1.2.3.4", port: 80, fw: null, lastSeen: Date.now() - 10 * 60_000 });
  d.seen.set("HERE", { id: "HERE", name: "H", ip: "1.2.3.5", port: 80, fw: null, lastSeen: Date.now() });
  const list = d.list();
  assert.deepEqual(list.map((b) => b.id), ["HERE"]);
  assert.equal(d.seen.has("GONE"), false, "stale entry should be evicted, not just hidden");
});

test("already-registered boxes are marked, not hidden", () => {
  // The setup page needs both: an unknown box is something to add, a known box
  // that is visible is confirmation it is alive. Filtering here would lose the
  // second, and they are indistinguishable from an address alone.
  const d = offline();
  d.seen.set("KNOWN", { id: "KNOWN", name: "K", ip: "1.2.3.4", port: 80, fw: null, lastSeen: Date.now() });
  d.seen.set("NEW", { id: "NEW", name: "N", ip: "1.2.3.5", port: 80, fw: null, lastSeen: Date.now() });
  const byId = Object.fromEntries(d.list(new Set(["KNOWN"])).map((b) => [b.id, b.registered]));
  assert.deepEqual(byId, { KNOWN: true, NEW: false });
});

test("discovery disabled yields an empty list and never throws", () => {
  const d = offline();
  d.start();
  assert.deepEqual(d.list(), []);
  d.stop();
});
