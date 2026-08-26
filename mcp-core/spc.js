// The OrangePi side of the fleet. "spc" = single-board computer.
//
// A box and a Pi are deliberately NOT the same kind of thing, and this file
// exists so they never have to pretend to be. An ESP box is firmware that dials
// in, registers itself at boot and is driven by pushes it cannot refuse; a Pi is
// a Linux machine running a small HTTP service that we call out to, on a
// Tailscale name that resolves from anywhere. Forcing both through boxes.js
// would grow an "...unless it's the Pi" branch inside every single box
// function. So the two transports live side by side and meet only at the MCP
// tool layer, where the model sees one fleet with two namespaces.
//
// The contract this speaks is documented — and implemented — in spc-agent/.
// Anything that answers those five routes is a valid spc device; the reference
// service is a convenience, not a requirement.

// Every capability a Pi may declare. Order matters only for log output.
export const SPC_CAPABILITIES = ["look", "speak", "sense", "listen", "screen", "volume"];

// Per-call budgets. These differ by an order of magnitude on purpose:
// /speak blocks until the audio has finished playing out of the speaker, so a
// long sentence legitimately takes tens of seconds, while /sense reading a GPIO
// pin has no excuse to take more than a moment. One shared timeout would have
// to be the largest of them, which turns a dead Pi into a 60s hang on a tool
// the model expected to be instant.
//
// These are the FALLBACKS. The ones a running mcp-core actually uses come from
// the settings store (spc.timeout_*), which is wired in by createSpcRegistry —
// so a Pi on a slow link can be given more room without a code change. They
// stay here as literals so this module still works standalone: a test, or any
// other importer of createSpcDevice, gets sane numbers without a store.
const TIMEOUT_DEFAULTS = {
  health: 4000,
  look: 20000,
  speak: 60000,
  sense: 6000,
  screen: 6000,
  volume: 6000,
  // /listen is the exception: its duration is an argument, not a constant. The
  // Pi is recording for up to timeout_s before it can answer at all, so the
  // deadline is derived per call. This margin covers the WAV upload afterwards.
  listenMargin: 15000
};

// Set once by createSpcRegistry. A getter rather than a copied object so a
// change to a timeout applies to the very next call, with no restart and no
// need to rebuild the device objects.
let fleetSettings = () => ({});

// Settings keys are named for what they configure (spc.timeout_look_ms), not
// for this table's shorthand, so the mapping is spelled out rather than
// string-built — a typo'd key would otherwise silently fall back to the default
// forever, and look exactly like a setting that does nothing.
const TIMEOUT_KEYS = {
  look: "spc.timeout_look_ms",
  speak: "spc.timeout_speak_ms",
  screen: "spc.timeout_screen_ms",
  listenMargin: "spc.listen_margin_ms"
};

function timeoutFor(kind) {
  const key = TIMEOUT_KEYS[kind];
  const v = key ? fleetSettings()[key] : undefined;
  return Number.isFinite(v) ? v : TIMEOUT_DEFAULTS[kind];
}

// Failures reach a language model as prose, so they say what to DO. "fetch
// failed" is the single least useful string Node produces — it covers DNS
// failure, connection refused and TLS errors identically, and a model shown it
// will usually just retry the same call.
function reachError(device, err) {
  const why =
    err?.name === "TimeoutError" || err?.name === "AbortError"
      ? "it did not answer in time"
      : `the connection failed (${err?.message || err})`;
  return new Error(
    `Could not reach ${device.id} at ${device.baseUrl} — ${why}. ` +
    `Check the Pi is powered on, that spc-agent is running on it, and that its Tailscale name still resolves.`
  );
}

async function request(device, path, { method = "GET", body, headers = {}, timeoutMs } = {}) {
  const url = `${device.baseUrl}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(device.fleetToken ? { "X-Fleet-Token": device.fleetToken } : {}),
        ...headers
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw reachError(device, err);
  }
  // A 401 here is worth calling out by name. It means the Pi IS running and
  // reachable — the single hardest part of this setup — and only the shared
  // secret is wrong, which is a two-minute fix rather than a hardware hunt.
  if (res.status === 401) {
    throw new Error(
      `${device.id} rejected our X-Fleet-Token. The Pi is up; the secret just doesn't match. ` +
      `Set the same value in ESP_FLEET_TOKEN here and in spc-agent's environment.`
    );
  }
  // 501 is how the contract says "I don't have that hardware". Distinct from a
  // crash: nothing is broken, the part simply isn't plugged in.
  if (res.status === 501) {
    throw new Error(
      `${device.id} has no hardware for this — it did not declare the capability. ` +
      `Check GET ${device.baseUrl}/health to see what it actually has.`
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${device.id} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return res;
}

async function requestJson(device, path, opts) {
  const res = await request(device, path, opts);
  try {
    return await res.json();
  } catch {
    throw new Error(`${device.id} answered ${path} with something that is not JSON.`);
  }
}

// One configured OrangePi. Capabilities come from config (see config.js for why
// they are declared rather than discovered) — `probe` only checks that claim
// against reality and reports the difference.
export function createSpcDevice(cfg) {
  const device = {
    id: cfg.id,
    name: cfg.name || cfg.id,
    baseUrl: cfg.baseUrl,
    capabilities: cfg.capabilities,
    fleetToken: cfg.fleetToken || null
  };

  device.has = (cap) => device.capabilities.includes(cap);

  // Liveness + the Pi's own view of its hardware. Never throws for an offline
  // Pi — "is it up" is precisely the question being asked, so an exception
  // would make every caller wrap it in a try just to learn "no".
  device.health = async () => {
    try {
      const body = await requestJson(device, "/health", { timeoutMs: timeoutFor("health") });
      return { online: true, ...body };
    } catch (err) {
      return { online: false, error: err.message };
    }
  };

  // A JPEG frame, returned as a Buffer so the tool layer can hand it straight
  // to an image content block without a round trip through base64 and back.
  device.look = async () => {
    const res = await request(device, "/look", { timeoutMs: timeoutFor("look") });
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) {
      throw new Error(`${device.id} answered /look with "${type || "no content-type"}" instead of an image.`);
    }
    return Buffer.from(await res.arrayBuffer());
  };

  // Blocks until playback finishes. That is a choice the contract makes, not an
  // accident: a model that says "your order is ready" and immediately says
  // something else would talk over itself, and only the Pi knows when its own
  // speaker went quiet.
  device.speak = async (text) =>
    await requestJson(device, "/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      timeoutMs: timeoutFor("speak")
    });

  device.sense = async () => await requestJson(device, "/sense", { timeoutMs: timeoutFor("sense") });

  // Playback loudness, 0-100. Read and write are separate calls rather than one
  // "set and tell me" because a UI wants to draw the slider on load without
  // moving anything, and an agent asked to "turn it down a bit" needs to know
  // where it currently is before it can pick a smaller number.
  device.getVolume = async () => await requestJson(device, "/volume", { timeoutMs: timeoutFor("volume") });

  device.setVolume = async (level) =>
    await requestJson(device, "/volume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
      timeoutMs: timeoutFor("volume")
    });

  // Changes what is on the Pi's screen. The opposite of speak: it returns as
  // soon as the Pi has stored the new state, NOT when the glass has repainted.
  // Waiting for a browser to finish an animation would turn every face change
  // into a pause in the conversation, and the panel is meant to keep up with
  // the talking, not the other way round.
  //
  // Keys left out are left alone — the Pi merges. That is what lets a caller
  // change the eyes without blanking a QR code someone is mid-scan of.
  device.display = async (patch) =>
    await requestJson(device, "/display", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      timeoutMs: timeoutFor("screen")
    });

  // Returns raw WAV bytes, NOT a transcript, and that is the important part of
  // this whole file. Speech-to-text stays on mcp-core, where whisper.cpp and
  // the Manglish bias prompt already live, so the Pi and the boxes are
  // transcribed by the identical model with the identical prompt. Putting STT
  // on the Pi would give two devices in one restaurant two different accents'
  // worth of accuracy, and would make the Manglish tuning work in one place
  // only — for a mic that is, in the end, just a microphone.
  //
  // Both durations are optional here and NOT defaulted to a constant: leaving
  // them out means "use the Pi's own configured defaults" (spc.listen_*, pushed
  // to it as device settings), so the auto-stop tuning has one home instead of
  // a number here quietly overriding the one someone set on the device.
  device.listen = async ({ timeoutS, silenceS } = {}) => {
    const body = {};
    if (Number.isFinite(timeoutS)) body.timeout_s = timeoutS;
    if (Number.isFinite(silenceS)) body.silence_s = silenceS;
    // The deadline still needs a number even when the Pi picks the duration.
    // Falling back to the device-scoped setting keeps mcp-core's patience and
    // the Pi's recording length moving together.
    const budgetS = Number.isFinite(timeoutS)
      ? timeoutS
      : (fleetSettings()["spc.listen_timeout_s"] ?? 12);
    const res = await request(device, "/listen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: budgetS * 1000 + timeoutFor("listenMargin")
    });
    // 204 is the contract's "nobody said anything" — a normal outcome of
    // listening, not a failure, so it must not throw.
    if (res.status === 204) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 44) return null;   // header-only WAV = silence
    return buf;
  };

  // Hand the Pi the device-scoped runtime settings (its own listen auto-stop,
  // its own per-command kill timeouts). JSON here, unlike the box's line
  // protocol, because the other end is Python and parsing JSON is free there —
  // the box's format is a concession to firmware with no JSON parser, not a
  // style the whole fleet has to share.
  //
  // A Pi on old spc-agent answers 404, which surfaces as a plain HTTP error
  // rather than something alarming: it simply keeps its built-in defaults.
  device.pushSettings = async ({ revision, settings }) =>
    await requestJson(device, "/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, settings }),
      timeoutMs: timeoutFor("screen")
    });

  return device;
}

// Small registry mirroring boxes.js's shape, so the tool layer can resolve an
// spc device the same way it resolves a box.
//
// `getSettings` returns the whole settings map and is stashed module-wide, not
// per device: every timeout here is a property of this server's patience, not
// of one Pi, so per-device copies would be four places to keep in sync for no
// gain. Optional — without it every timeout falls back to TIMEOUT_DEFAULTS.
export function createSpcRegistry(deviceConfigs, getSettings) {
  if (typeof getSettings === "function") fleetSettings = getSettings;
  const devices = deviceConfigs.map(createSpcDevice);
  return {
    devices,
    pushSettings: (device, payload) => device.pushSettings(payload),
    byId: (id) => devices.find((d) => d.id === id) || null,
    // Any device declaring a capability. Tool registration is gated on this:
    // no Pi with a mic means no spc_listen tool at all, rather than a tool that
    // exists to fail.
    withCapability: (cap) => devices.filter((d) => d.has(cap)),
    any: (cap) => devices.some((d) => d.has(cap))
  };
}

// Startup reconciliation. Config decides which tools exist; the Pi decides what
// is really plugged in. When those disagree the mismatch is printed rather than
// resolved, because either side could be the wrong one — a missing capability
// might be an unplugged camera OR a stale config line, and silently trusting
// /health would make tools appear and vanish across restarts depending on
// whether a USB device happened to enumerate in time.
export async function probeSpcDevices(registry) {
  for (const device of registry.devices) {
    const health = await device.health();
    if (!health.online) {
      console.log(`SPC ${device.id} @ ${device.baseUrl}: OFFLINE, tools [${device.capabilities.join(", ")}]`);
      // Not a warning. A Pi that is simply switched off at boot is an expected
      // state, and the tools deliberately stay registered so it can be turned
      // on later without restarting mcp-core.
      console.log(`  Its tools stay registered and will work as soon as it answers.`);
      continue;
    }
    const reported = Array.isArray(health.capabilities) ? health.capabilities : [];
    const declared = device.capabilities;
    const missing = declared.filter((c) => !reported.includes(c));
    const extra = reported.filter((c) => !declared.includes(c));
    console.log(`SPC ${device.id} @ ${device.baseUrl}: online, tools [${declared.join(", ") || "none"}]`);
    if (missing.length) {
      console.warn(`  WARNING: config claims [${missing.join(", ")}] but the Pi reports it cannot do that.`);
      console.warn(`  Those tools are registered and WILL fail. Fix the hardware, or drop them from devices[].capabilities.`);
    }
    if (extra.length) {
      console.log(`  Note: the Pi also offers [${extra.join(", ")}], not enabled in config. Add to devices[].capabilities to expose.`);
    }
  }
}
