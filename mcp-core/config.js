// Loads and validates ~/esp/config.json — the single external parameter file.
// The core holds NO hardcoded IPs, URLs, models, or prompts: everything comes
// from here. Startup fails loudly if no usable backend is configured, because
// a router with nothing to route to is a bug waiting to look like silence.
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STT_TYPES, TTS_TYPES } from "./speech.js";

// The project root. config.json, whisper.cpp, the firmware image and
// voice-mcp-server are all resolved relative to it.
//
// Derived from THIS file's own location (mcp-core/config.js -> up one) rather
// than a hardcoded ~/esp, so the tree works wherever it is cloned. The old
// constant assumed ~/esp silently: anyone who put it elsewhere got "cannot read
// config file", which points at the wrong problem entirely. Set ESP_ROOT to
// override — a container or a split code/data layout needs that.
export const ESP_ROOT =
  process.env.ESP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.MCP_CORE_CONFIG || path.join(ESP_ROOT, "config.json");

// Relative paths in the config resolve against ~/esp so the file stays
// machine-portable (no /Users/<name>/ anywhere in it).
function resolvePath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(ESP_ROOT, p);
}

// Explicit `type` wins; otherwise infer from shape so existing configs (which
// have no type field) keep working with no migration.
function inferBackendType(cfg) {
  if (cfg.type) return cfg.type;
  if (cfg.webhook_url) return "webhook";
  if (cfg.url && cfg.model) return "openai_chat";
  return null;
}

// Secrets belong in the environment, not on disk: `token_env` names a variable
// to read at startup. A real WiFi password already leaked out of this repo once
// via a committed file, so a cloud API key sitting in config.json is a risk
// worth designing away. Plain `token` still works for local backends that need
// no real secret (Ollama ignores it).
function resolveToken(name, bc) {
  if (!bc.token_env) return bc.token ? { token: bc.token } : {};
  const fromEnv = process.env[bc.token_env];
  if (!fromEnv) {
    // Loud, because the alternative is a baffling 401 mid-conversation later.
    console.warn(`Backend "${name}": token_env "${bc.token_env}" is not set in the environment — ` +
                 `calls will likely fail with an auth error. Export it, or remove token_env.`);
    return {};
  }
  return { token: fromEnv };
}

// A hanging backend is indistinguishable from a crash to someone standing at
// the box, so the old blanket 120s is wrong for anything network-facing.
// Webhooks keep it (the agent is local and trusted); LLM calls get a voice-
// appropriate default. Either can be overridden per backend.
function backendTimeout(bc, type) {
  if (Number.isFinite(bc.timeout_ms)) return bc.timeout_ms;
  return type === "webhook" ? 120000 : 10000;
}

// Secrets are read from the environment only, never from config.json — a real
// credential already leaked out of this repo once via a committed file.
// `warning` says what degrades if the variable is missing, so an unset token is
// loud at startup instead of a confusing 401 later.
function envToken(envName, key, warning) {
  if (!envName) return null;
  const v = process.env[envName];
  if (!v) {
    console.warn(`${key} "${envName}" is not set in the environment — ${warning}. ` +
                 `Export it, or remove ${key}.`);
  }
  return v || null;
}

// The untouched parsed JSON — for callers that need to WRITE the config back
// (box self-registration). loadConfig() below returns a derived/validated
// shape that drops fields; round-tripping that would silently lose them.
export function loadRawConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    console.error(`Cannot read config file at ${CONFIG_PATH}: ${err.message}`);
    console.error("Copy config.example.json to config.json and edit it.");
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Config file ${CONFIG_PATH} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

// Atomic write: temp file + rename, so a crash mid-write can never leave a
// truncated config.json behind.
export async function writeConfig(rawCfg) {
  const tmp = CONFIG_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(rawCfg, null, 2) + "\n");
  await rename(tmp, CONFIG_PATH);
}

// Endpoint defaults per provider, so a hosted config only has to name a type
// and a token_env. Overridable with `url` — the OpenAI-compatible types point
// at plenty of things that are not OpenAI (Groq, a local faster-whisper).
const SPEECH_DEFAULT_URL = {
  openai_whisper: "https://api.openai.com/v1/audio/transcriptions",
  openai_tts: "https://api.openai.com/v1/audio/speech",
  moss_local: "http://localhost:8080/v1/audio/speech"
};

// Same rule as backends: a hang reads as a crash to whoever is standing at the
// box, so anything over a network gets a voice-appropriate timeout. Local
// engines are trusted and can be genuinely slow on a cold model load.
const speechTimeout = (sc, isLocal) =>
  Number.isFinite(sc.timeout_ms) ? sc.timeout_ms : (isLocal ? 120000 : 30000);

// Explicit `type` always wins. Inference exists so the legacy top-level `stt`
// block keeps working untouched, and so a half-written hosted block still does
// the obvious thing rather than failing on a missing field.
function inferSpeechType(sc, kind) {
  if (sc.type) return sc.type;
  if (sc.token_env || sc.token) return kind === "stt" ? "openai_whisper" : "openai_tts";
  return kind === "stt" ? "whisper_local" : "moss_local";
}

function resolveSpeechSide(sc, kind, validTypes, legacy) {
  const type = inferSpeechType(sc, kind);
  if (!validTypes.includes(type)) {
    console.error(`speech.${kind}.type "${type}" is not a known provider.`);
    console.error(`Valid ${kind} types: ${validTypes.join(", ")}`);
    console.error("Refusing to run: a box with no voice is worse than a clear error.");
    process.exit(1);
  }
  const isLocal = type.endsWith("_local");
  const token = sc.token_env
    ? envToken(sc.token_env, `speech.${kind}.token_env`, `${type} calls will fail with an auth error`)
    : (sc.token || null);
  if (!isLocal && !token) {
    // Not fatal — a self-hosted OpenAI-compatible endpoint legitimately needs
    // no key — but silence here turns into a 401 mid-conversation.
    console.warn(`speech.${kind}: "${type}" has no token_env set. Fine for an open endpoint, ` +
                 `an auth failure against a real provider.`);
  }
  return {
    type,
    url: sc.url || SPEECH_DEFAULT_URL[type] || null,
    // Local whisper takes a filesystem path; hosted takes a model NAME. Only
    // resolve against the project root when it looks like a path, or a hosted
    // config naming "whisper-1" would be rewritten into a bogus absolute path.
    model: isLocal ? resolvePath(sc.model ?? legacy.model) : (sc.model || null),
    voice: sc.voice || null,
    language: sc.language || legacy.language || "auto",
    promptFile: resolvePath(sc.prompt_file ?? legacy.prompt_file),
    token,
    timeoutMs: speechTimeout(sc, isLocal)
  };
}

// The `speech` block, with the pre-speech-block config shape as the fallback.
// An existing config.json that only has a top-level `stt` section resolves to
// exactly the engines it used before this existed — no migration, no edit.
function resolveSpeech(cfg, legacyStt) {
  const speech = cfg.speech || {};
  const stt = resolveSpeechSide(speech.stt || {}, "stt", STT_TYPES, legacyStt);
  const tts = resolveSpeechSide(speech.tts || {}, "tts", TTS_TYPES, {});
  // Bias prompt is a file path in config but a string on the wire for hosted
  // providers, which have no access to this filesystem. Read it once here.
  if (stt.promptFile && !stt.type.endsWith("_local")) {
    try {
      stt.prompt = readFileSync(stt.promptFile, "utf8").trim();
    } catch (err) {
      console.warn(`speech.stt.prompt_file "${stt.promptFile}" could not be read (${err.message}) — ` +
                   "continuing without accent/vocabulary bias.");
    }
  }
  return { stt, tts };
}

export function loadConfig() {
  const cfg = loadRawConfig();

  // Boxes may register themselves at boot (POST /register with their box_id),
  // so an empty list is fine now — it just means no box has shown up yet.
  const boxes = Array.isArray(cfg.boxes) ? cfg.boxes.filter((b) => b && b.ip) : [];

  // Backends are dispatched by TYPE, not by name. The old code hardcoded an
  // allowlist of exactly "agent" and "local_llm", so any third backend was
  // silently dropped here as unknown *and* misrouted to the local LLM's config
  // by the router — a trap that had to be fixed in two places at once.
  //
  // An explicit `type` always wins, so future kinds ("gemini", "ollama") just
  // work; inference is the fallback so every existing config.json keeps loading
  // untouched, with no migration.
  const backends = cfg.backends || {};
  const declared = Array.isArray(backends.priority) ? backends.priority : [];
  const priority = [];
  const resolved = {};
  for (const name of declared) {
    const bc = backends[name];
    if (!bc) {
      console.warn(`Backend "${name}" listed in priority but not defined — skipped.`);
      continue;
    }
    const type = inferBackendType(bc);
    if (!type) {
      console.warn(`Backend "${name}" has no recognizable shape (need webhook_url, or url+model) — skipped.`);
      continue;
    }
    if (type === "webhook" && !bc.webhook_url) {
      console.warn(`Backend "${name}" is type webhook but has no webhook_url — skipped.`);
      continue;
    }
    if (type === "openai_chat" && !(bc.url && bc.model)) {
      console.warn(`Backend "${name}" is type openai_chat but missing url/model — skipped.`);
      continue;
    }
    if (type !== "webhook" && type !== "openai_chat") {
      console.warn(`Backend "${name}" has unsupported type "${type}" — skipped.`);
      continue;
    }
    resolved[name] = { ...bc, type, ...resolveToken(name, bc), timeoutMs: backendTimeout(bc, type) };
    priority.push(name);
  }
  if (priority.length === 0) {
    console.error("No usable backend configured. Define at least one entry under \"backends\"");
    console.error("with either webhook_url (an agent) or url+model (an OpenAI-compatible LLM),");
    console.error("and list its name in backends.priority.");
    console.error("Refusing to run: there is nothing to route speech to.");
    process.exit(1);
  }

  const stt = cfg.stt || {};
  return {
    boxes,
    priority,
    backends: resolved,
    stt: {
      language: stt.language || "auto",
      promptFile: resolvePath(stt.prompt_file),
      model: resolvePath(stt.model)
    },
    speech: resolveSpeech(cfg, stt),
    listenPort: cfg.listen_port || 8000,
    // Spoken once, cached, and replayed on every wake tap — see server.js's
    // getGreetingAudio(). null lets the caller apply its own default text.
    greetingText: cfg.greeting_text || null,
    // Gates /mcp when set — see server.js. Same env-var-only rule as backend
    // tokens: a real credential already leaked out of this repo once via a
    // committed file, so this is never read from config.json directly.
    mcpToken: envToken(cfg.mcp_token_env, "mcp_token_env", "/mcp will run WITHOUT auth"),
    // Shared secret between this server and the boxes, sent as X-Fleet-Token.
    // DIFFERENT audience from mcpToken on purpose: mcpToken authenticates your
    // MCP *clients* (Claude, agents), fleetToken authenticates your *hardware*.
    // One leaking must not grant the other.
    fleetToken: envToken(cfg.fleet_token_env, "fleet_token_env",
                         "boxes and box-facing routes will run WITHOUT auth"),
    // Explicit override for which local address boxes should be told to reach
    // us on. Normally auto-detected (see lanIp() in server.js) — set this when
    // the machine has several interfaces and the guess is wrong.
    //
    // The LAN_IP env var wins over the config file because this is per-MACHINE,
    // not per-deployment: the same config.json is meant to run on a Linux
    // server, a Mac and a Windows box, and only Linux can use host networking.
    // Baking one machine's address into a shared file makes the file wrong
    // everywhere else, and stale the moment DHCP moves. A start-time env var is
    // recomputed on every boot instead — see docker-compose.yml.
    lanIp: process.env.LAN_IP || cfg.lan_ip || null,
    // Where boxes should dial their reverse channel. Empty = derive
    // ws://<lanIp>:<port>/ws, which only helps boxes on this LAN. Point it at
    // a public relay (Tailscale Funnel) to reach boxes on any network.
    wsUrl: cfg.ws_url || null,
    // Where the box's help QR points (tap RST twice). Empty = boxes keep the
    // fallback compiled into firmware. Set this to the guide's public URL —
    // a link that demands a login is worse than no QR at all.
    helpUrl: cfg.help_url || null,
    configPath: CONFIG_PATH
  };
}
