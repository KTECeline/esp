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

  // A backend earns a slot in the effective priority list only if its required
  // fields are present; misconfigured entries are skipped with a warning so a
  // typo degrades to the next backend instead of crashing mid-conversation.
  const backends = cfg.backends || {};
  const declared = Array.isArray(backends.priority) ? backends.priority : [];
  const priority = [];
  for (const name of declared) {
    if (name === "agent") {
      if (backends.agent && backends.agent.webhook_url) priority.push("agent");
      else console.warn("Backend \"agent\" listed in priority but has no webhook_url — skipped.");
    } else if (name === "local_llm") {
      if (backends.local_llm && backends.local_llm.url && backends.local_llm.model) priority.push("local_llm");
      else console.warn("Backend \"local_llm\" listed in priority but missing url/model — skipped.");
    } else {
      console.warn(`Unknown backend "${name}" in priority — skipped.`);
    }
  }
  if (priority.length === 0) {
    console.error("No usable backend configured. Set backends.agent.webhook_url and/or");
    console.error("backends.local_llm.{url,model}, and list them in backends.priority.");
    console.error("Refusing to run: there is nothing to route speech to.");
    process.exit(1);
  }

  const stt = cfg.stt || {};
  return {
    boxes,
    priority,
    agent: backends.agent || {},
    localLlm: backends.local_llm || {},
    stt: {
      language: stt.language || "auto",
      promptFile: resolvePath(stt.prompt_file),
      model: resolvePath(stt.model)
    },
    listenPort: cfg.listen_port || 8000,
    configPath: CONFIG_PATH
  };
}
