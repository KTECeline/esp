// Loads and validates ~/esp/config.json — the single external parameter file.
// The core holds NO hardcoded IPs, URLs, models, or prompts: everything comes
// from here. Startup fails loudly if no usable backend is configured, because
// a router with nothing to route to is a bug waiting to look like silence.
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const ESP_ROOT = path.join(homedir(), "esp");
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
    lanIp: cfg.lan_ip || null,
    // Where boxes should dial their reverse channel. Empty = derive
    // ws://<lanIp>:<port>/ws, which only helps boxes on this LAN. Point it at
    // a public relay (Tailscale Funnel) to reach boxes on any network.
    wsUrl: cfg.ws_url || null,
    configPath: CONFIG_PATH
  };
}
