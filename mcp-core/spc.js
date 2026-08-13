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
export const SPC_CAPABILITIES = ["look", "speak", "sense", "listen"];

// Per-call budgets. These differ by an order of magnitude on purpose:
// /speak blocks until the audio has finished playing out of the speaker, so a
// long sentence legitimately takes tens of seconds, while /sense reading a GPIO
// pin has no excuse to take more than a moment. One shared timeout would have
// to be the largest of them, which turns a dead Pi into a 60s hang on a tool
// the model expected to be instant.
const TIMEOUTS = {
  health: 4000,
  look: 20000,
  speak: 60000,
  sense: 6000
};

// /listen is the exception: its duration is an argument, not a constant. The Pi
// is recording for up to timeout_s before it can answer at all, so the deadline
// has to be derived per call. The margin covers the WAV upload on a slow link.
const LISTEN_MARGIN_MS = 15000;

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
      const body = await requestJson(device, "/health", { timeoutMs: TIMEOUTS.health });
      return { online: true, ...body };
    } catch (err) {
      return { online: false, error: err.message };
    }
  };

  // A JPEG frame, returned as a Buffer so the tool layer can hand it straight
  // to an image content block without a round trip through base64 and back.
  device.look = async () => {
    const res = await request(device, "/look", { timeoutMs: TIMEOUTS.look });
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
      timeoutMs: TIMEOUTS.speak
    });

  device.sense = async () => await requestJson(device, "/sense", { timeoutMs: TIMEOUTS.sense });

  // Returns raw WAV bytes, NOT a transcript, and that is the important part of
  // this whole file. Speech-to-text stays on mcp-core, where whisper.cpp and
  // the Manglish bias prompt already live, so the Pi and the boxes are
  // transcribed by the identical model with the identical prompt. Putting STT
  // on the Pi would give two devices in one restaurant two different accents'
  // worth of accuracy, and would make the Manglish tuning work in one place
  // only — for a mic that is, in the end, just a microphone.
  device.listen = async ({ timeoutS = 10, silenceS = 1.2 } = {}) => {
    const res = await request(device, "/listen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout_s: timeoutS, silence_s: silenceS }),
      timeoutMs: timeoutS * 1000 + LISTEN_MARGIN_MS
    });
    // 204 is the contract's "nobody said anything" — a normal outcome of
    // listening, not a failure, so it must not throw.
    if (res.status === 204) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 44) return null;   // header-only WAV = silence
    return buf;
  };

  return device;
}

// Small registry mirroring boxes.js's shape, so the tool layer can resolve an
// spc device the same way it resolves a box.
export function createSpcRegistry(deviceConfigs) {
  const devices = deviceConfigs.map(createSpcDevice);
  return {
    devices,
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
