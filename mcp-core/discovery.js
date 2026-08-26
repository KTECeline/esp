// LAN discovery of ESP boxes over mDNS.
//
// This is the missing half of a symmetry the codebase already had on one side:
// mcp-core has always advertised ITSELF ("mcp-core.local", see
// startMdnsAdvertiser in server.js) so a box can find the server. Nothing
// listened in the other direction, so finding the BOXES meant ARP-scanning the
// subnet for Espressif MAC prefixes (point_box_at_me.sh) — which guesses from a
// vendor OUI, can't see a box one subnet over, and tells you nothing about the
// box it found beyond "something Espressif answered here".
//
// A box now advertises `_espbox._tcp` with its identity in TXT records, so
// discovery returns the box's real id, name and firmware instead of an IP that
// might be a box. Nothing here touches a box: it only listens. Deciding to
// adopt one is a separate, authenticated step (POST /adopt).
//
// The registry (boxes.js) remains the source of truth for the fleet. This is a
// candidate list — what is on the network right now, whether or not it is ours.

import { Bonjour } from "bonjour-service";

// Must match the type the firmware advertises (listen_v2.c, start_mdns).
// mDNS service types are capped at 15 characters, hence the abbreviation.
export const SERVICE_TYPE = "espbox";

// A box that vanishes without sending an mDNS goodbye (unplugged, crashed, out
// of WiFi range) would otherwise sit in the browser's cache indefinitely and be
// offered as an adoptable device forever. Anything not seen in this long is
// dropped from the list — long enough to ride out a couple of missed re-query
// rounds, short enough that a page refresh reflects reality.
// Default only — the running value comes from the discovery.stale_ms setting.
const STALE_MS = 90_000;

// How often to re-ask the network. Boxes announce themselves unprompted when
// they boot, so this is only a backstop for announcements lost to multicast
// flakiness (which the campus/hotspot networks in this project's history drop
// routinely).
// Default only — the running value comes from the discovery.requery_ms setting.
const REQUERY_MS = 30_000;

// Prefer a real IPv4: every push to a box (`http://${box.ip}/play`) dials this,
// and the registry stores it. IPv6 link-local addresses carry a zone index that
// won't survive the round trip through config.json, so they are not a usable
// substitute here.
function pickAddress(service) {
  const addrs = Array.isArray(service.addresses) ? service.addresses : [];
  const v4 = addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (v4) return v4;
  // The referer is the interface the announcement actually arrived on, which is
  // by definition routable from here — a better fallback than an AAAA record.
  const ref = service.referer && service.referer.address;
  if (ref && /^\d+\.\d+\.\d+\.\d+$/.test(ref)) return ref;
  return null;
}

// TXT values arrive as Buffers or strings depending on the responder; both are
// normal. Anything else (a malformed record from a device that is not ours) is
// treated as absent rather than stringified into garbage.
function txtValue(txt, key) {
  if (!txt) return null;
  const v = txt[key];
  if (v === undefined || v === null) return null;
  if (Buffer.isBuffer(v)) return v.toString("utf8") || null;
  if (typeof v === "string") return v || null;
  return null;
}

// One mDNS announcement -> one candidate entry, or null if it isn't a box we
// can do anything with. Pure and exported so the parsing can be tested without
// a network: everything interesting here is about tolerating responders that
// don't behave (Buffer vs string TXT values, an IPv6-only announcement, a
// device that answers on this service type but carries no id).
export function normalizeService(service) {
  if (!service) return null;
  const ip = pickAddress(service);
  const id = txtValue(service.txt, "id");
  // No id means this is not one of our boxes (or is on firmware predating the
  // TXT records). Without an id there is nothing to key on and nothing to tell
  // the operator, so it is not offered as a candidate — adopting it would write
  // a nameless entry that never matches the box's real X-Box-Id.
  if (!id || !ip) return null;
  return {
    id,
    name: txtValue(service.txt, "name") || id,
    ip,
    port: service.port || 80,
    fw: txtValue(service.txt, "fw"),
    lastSeen: Date.now()
  };
}

export class BoxDiscovery {
  // staleMs/requeryMs are functions, not numbers, so a runtime settings change
  // reaches this without rebuilding the browser. staleMs is consulted on every
  // list() and so applies immediately; requeryMs arms one interval at start()
  // and genuinely cannot change without a restart — the settings catalog marks
  // it as such rather than letting a change look like it took.
  constructor({ enabled = true, staleMs = () => STALE_MS, requeryMs = () => REQUERY_MS } = {}) {
    this.enabled = enabled;
    this.staleMs = staleMs;
    this.requeryMs = requeryMs;
    this.bonjour = null;
    this.browser = null;
    this.timer = null;
    // id -> { id, name, ip, port, fw, lastSeen }. Keyed by box id (not by IP or
    // mDNS instance name) for the same reason boxes.js is: the id is the only
    // stable thing about a box. A box that reboots onto a new DHCP lease must
    // update its entry, not appear twice.
    this.seen = new Map();
    this.error = null;
  }

  start() {
    if (!this.enabled) {
      console.log("Box discovery disabled (MDNS_DISABLE=1) — GET /discover will return an empty list.");
      return;
    }
    // Same hazard as the advertiser, and the same reason it is wrapped: on a
    // network that blocks multicast, the underlying dgram socket throws
    // (EADDRNOTAVAIL 224.0.0.251:5353). Discovery is a convenience; it must
    // never be able to take down STT/LLM/TTS routing with it.
    try {
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" });
      this.browser.on("up", (s) => this.#record(s));
      this.browser.on("srv-update", (s) => this.#record(s));
      this.browser.on("txt-update", (s) => this.#record(s));
      this.browser.on("down", (s) => this.#forget(s));
      // Seed from anything the browser already collected between construction
      // and the listeners being attached.
      for (const s of this.browser.services || []) this.#record(s);
      this.timer = setInterval(() => {
        try {
          this.browser.update();
        } catch { /* transient multicast failure; the next tick retries */ }
      }, this.requeryMs());
      this.timer.unref?.();
      console.log(`Discovering ESP boxes via mDNS (_${SERVICE_TYPE}._tcp)`);
    } catch (err) {
      // Recorded, not just logged: GET /discover reports this so the setup page
      // can say "discovery is not working on this network" instead of showing
      // an empty list that looks identical to "no boxes here".
      this.error = err.message;
      console.warn(`Box discovery failed to start (${err.message}) — continuing without it. ` +
                   "Boxes can still be added by IP.");
    }
  }

  #record(service) {
    const entry = normalizeService(service);
    // Keyed by box id, so a box that reboots onto a new DHCP lease updates its
    // entry instead of appearing twice under two addresses.
    if (entry) this.seen.set(entry.id, entry);
  }

  #forget(service) {
    const id = txtValue(service.txt, "id");
    if (id) this.seen.delete(id);
  }

  // Everything currently visible on the LAN, freshest first. `knownIds` marks
  // the ones already in the fleet registry, so the caller can distinguish "a
  // box you own that moved" from "a box you have never adopted" — the two need
  // opposite handling and look identical otherwise.
  list(knownIds = new Set()) {
    const cutoff = Date.now() - this.staleMs();
    const out = [];
    for (const [id, entry] of this.seen) {
      if (entry.lastSeen < cutoff) {
        this.seen.delete(id);
        continue;
      }
      out.push({ ...entry, registered: knownIds.has(id) });
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    try {
      this.browser?.stop();
      this.bonjour?.destroy();
    } catch { /* shutting down anyway */ }
  }
}
