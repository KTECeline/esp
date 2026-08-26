'use strict';

// Minimal setup-server: serves index.html and the /api/* routes it calls.
// No external dependencies — Node built-ins only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const INDEX_PATH = path.join(ROOT_DIR, 'index.html');
const WIFI_SETUP_PATH = path.join(ROOT_DIR, 'wifi-setup.html');
const PORT = process.env.PORT || 3000;
const MCP_PORT = 8000;
const MCP_TOKEN_ENV_NAME = 'MCP_ACCESS_KEY';
// Which SBC this box's brain is running on. Persisted so the rest of this
// server (and anything reading .env.systemd, e.g. future board-specific
// branches in the download/setup handlers) can key off it instead of
// assuming OrangePi the way the systemd unit files used to (they hardcoded
// /home/orangepi/esp — now %h, see systemd/*.service).
const BRAIN_DEVICE_ENV_NAME = 'BRAIN_DEVICE';
const VALID_BRAIN_DEVICES = new Set(['orangepi', 'radxa']);
const REPO_URL = process.env.SETUP_REPO_URL || 'https://github.com/KTECeline/esp.git';
const PROTECTED_ROOT_FILES = new Set(['setup-server.js', 'index.html', 'wifi-setup.html', 'config.json', '.env', 'piper-wrapper.js', 'openclaw-agent-bridge.js', 'kokoro_server.py']);

// ---------- WiFi provisioning (Radxa hotspot) ----------
// This box ships with no WiFi configured and no screen — so unlike a
// device that can show a generated QR code or one-time password, there is
// no way to display fresh credentials to whoever unboxes it. A fixed,
// known SSID/password is the only thing usable by a customer with no SSH
// or terminal access. These MUST end up printed on a physical sticker/
// manual affixed to the device during assembly, alongside the setup
// address (http://<WIFI_HOTSPOT_GATEWAY>:<PORT>/, see below) — that's a
// packaging decision for whoever assembles these boxes, outside this
// file's scope, but this is where they need to look up the current values.
const WIFI_HOTSPOT_SSID = 'VoiceKiosk-Setup';
const WIFI_HOTSPOT_PASSWORD = 'setupvoice123'; // 13 chars — satisfies WPA2's 8-char minimum
// nmcli's connection profile name for the hotspot — lets later code tell
// "we're broadcasting our own setup hotspot" apart from "we're associated
// to a real network" (nmcli reports STATE=connected for both), and lets it
// bring the profile down/up by name instead of guessing.
const WIFI_HOTSPOT_CON_NAME = 'VoiceKioskHotspot';
// NetworkManager's own documented default gateway/subnet for `nmcli device
// wifi hotspot` (its "shared" IPv4 method hands out 10.42.0.0/24 unless
// told otherwise) — not something this code sets explicitly. Belongs on
// the same sticker as the SSID/password above. Re-verify on the real
// device: this couldn't be exercised in this sandbox (no nmcli/Linux here).
const WIFI_HOTSPOT_GATEWAY = '10.42.0.1';
// How long a single `nmcli device wifi connect` attempt gets before this
// code gives up and restores the hotspot — matches the ~20s the frontend
// tells the customer to expect.
const WIFI_CONNECT_TIMEOUT_SEC = 20;

const PIPER_WRAPPER_PATH = path.join(ROOT_DIR, 'piper-wrapper.js');
const PIPER_WRAPPER_PORT = process.env.PIPER_WRAPPER_PORT || 5001;
const PIPER_VOICES_DIR = process.env.PIPER_VOICES_DIR || path.join(os.homedir(), 'esp', 'piper', 'voices');
// Full path, not a bare 'piper' PATH lookup — same reasoning as
// piper-wrapper.js: PATH isn't a safe assumption in this environment, so
// every spot that spawns piper (here and in piper-wrapper.js) resolves it
// the same way instead of duplicating the derivation.
const PIPER_BIN = process.env.PIPER_BIN || path.join(os.homedir(), '.local', 'bin', 'piper');
// rhasspy/piper-voices on Hugging Face. 'en' has long been the known-good
// default; 'zh' was HEAD-verified to exist at this path during development
// (2026-08-13) — re-check if Hugging Face ever reorganizes this repo.
const PIPER_VOICE_MAP = {
  en: 'en_US-lessac-medium',
  zh: 'zh_CN-huayan-medium',
};

// ---------- Kokoro TTS (github.com/hexgrad/kokoro, real PyPI `kokoro`) ----------
// Replaces the earlier MOSS-TTS-Nano attempt: that engine's
// `pip install -r requirements.txt` failed compiling WeTextProcessing/pynini
// on this ARM box (a real failed build, not guessed — pynini routinely has
// no prebuilt wheel outside Conda on non-x86 platforms, per the real README
// and github.com/OpenMOSS/MOSS-TTS-Nano/issues/6). Kokoro avoids that whole
// dependency class: confirmed from its own pyproject.toml and misaki's
// (2026-08-19) that its Chinese support (`misaki[zh]`) pulls in only
// jieba/pypinyin/cn2an/pypinyin-dict/ordered-set — all pure-Python wheels,
// nothing that needs compiling from source. torch itself also ships real
// manylinux aarch64 wheels (confirmed on pypi.org/project/torch, glibc
// 2.28+), so nothing here should hit a source build on this box either.
//
// Picked the official `kokoro` PyPI package (PyTorch-based) over the
// community `kokoro-onnx` runtime, despite this box being CPU-only ARM —
// see the setup diff summary for the full reasoning. Short version:
// kokoro-onnx's Chinese support requires a SEPARATE .onnx export
// (kokoro-v1.1-zh.onnx, distinct from its English v1.0.onnx) plus a
// community-maintained `misaki-fork[zh]`, i.e. two loaded models and two
// G2P stacks for one bilingual voice. The official `kokoro` package instead
// loads ONE checkpoint (hexgrad/Kokoro-82M-v1.1-zh) that natively covers
// both English and Mandarin via upstream `misaki[en]`/`misaki[zh]`, which
// matches this file's "load once" requirement far more directly. Both
// packages' heavy runtime deps (torch vs. onnxruntime) have real aarch64
// Linux wheels, so that tradeoff was not the deciding factor.
//
// No separate "engine" + "wrapper" split like MOSS-TTS-Nano needed: unlike
// app_onnx.py's multipart-in/base64-JSON-out API, kokoro_server.py (a real
// FastAPI app, confirmed FastAPI can return raw bytes directly) speaks the
// openai_tts shape itself — POST JSON in, raw audio bytes out — so
// setup-server.js starts it directly, same role piper-wrapper.js already
// has for Piper.
const KOKORO_DIR = process.env.KOKORO_TTS_DIR || path.join(ROOT_DIR, 'kokoro-tts');
const KOKORO_VENV_PYTHON = path.join(KOKORO_DIR, '.venv', 'bin', 'python');
const KOKORO_VENV_PIP = path.join(KOKORO_DIR, '.venv', 'bin', 'pip');
const KOKORO_SERVER_PATH = path.join(ROOT_DIR, 'kokoro_server.py');
// Doesn't collide with any port already in use on this box (setup-server
// 3000, mcp-core 8000, piper-wrapper 5001, openclaw-agent-bridge 4000,
// Ollama 11434, OpenClaw Gateway 18789). Also matches the port the
// community Kokoro-FastAPI project defaults to, though kokoro_server.py
// here is our own implementation, not that project's code.
const KOKORO_PORT = process.env.KOKORO_PORT || 8880;
// lang -> real Kokoro voice id, confirmed from hexgrad/Kokoro-82M-v1.1-zh's
// own samples/make_en.py + samples/make_zh.py on Hugging Face (2026-08-19)
// — this checkpoint has no lang-neutral default voice, and this is
// setup-server.js's copy of kokoro_server.py's own VOICE_MAP (kept
// identical there since that's the process that actually loads the model;
// this copy only decides what "en"/"zh" get set as speech.tts.voice in
// config.json).
const KOKORO_VOICE_MAP = {
  en: 'af_maple',
  zh: 'zf_001',
};

const OPENCLAW_BRIDGE_PATH = path.join(ROOT_DIR, 'openclaw-agent-bridge.js');
// Same env var name openclaw-agent-bridge.js itself reads — an override set
// on this process's environment reaches the spawned child for free.
const OPENCLAW_BRIDGE_PORT = process.env.OPENCLAW_BRIDGE_PORT || 4000;
const START_VOICE_ASSISTANT_SCRIPT = path.join(ROOT_DIR, 'start_voice_assistant.sh');

// whisper.cpp is gitignored on purpose (HANDOVER.md) — it is genuinely not
// part of the cloned repo or any package manager, and must be compiled from
// source. $ROOT/whisper.cpp is check_setup.sh's own default WHISPER_DIR.
const WHISPER_DIR = process.env.WHISPER_DIR || path.join(ROOT_DIR, 'whisper.cpp');
// check_setup.sh's own need_file check (and voice-mcp-server's WHISPER_BIN
// default): build/bin/whisper-cli, not the old pre-CMake `main` binary name.
const WHISPER_CLI_BIN = path.join(WHISPER_DIR, 'build', 'bin', 'whisper-cli');
// ggerganov/whisper.cpp redirects here (org rename, HEAD-verified 2026-08-14)
// — using the canonical URL directly instead of relying on the redirect.
const WHISPER_REPO_URL = 'https://github.com/ggml-org/whisper.cpp.git';
// Ships inside whisper.cpp's own repo (confirmed via the GitHub API — a real
// committed file, not LFS/gitignored) and is the exact file its own README
// quickstart uses to prove a build works.
const WHISPER_SAMPLE_AUDIO = path.join(WHISPER_DIR, 'samples', 'jfk.wav');
// Matches config.example.json's own default speech.stt.prompt_file exactly
// — a static asset already in the cloned repo, not something downloaded here.
const WHISPER_PROMPT_FILE = 'voice-mcp-server/manglish_prompt.txt';
// Frontend sends 'whisper-base' | 'whisper-small' | 'whisper-medium' |
// 'custom' (index.html's sttModel) — the multilingual (non-`.en`) tiers,
// matching config.example.json's own default (ggml-small.bin, not small.en).
const WHISPER_TIER_MAP = {
  'whisper-base': 'base',
  'whisper-small': 'small',
  'whisper-medium': 'medium',
};

// ---------- config.json ----------
function readConfig(){
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}
function writeConfig(config){
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
// Shallow merge: adds keys present in `source` but missing from `target`.
// Existing values in `target` always win. Returns true if anything changed.
function mergeMissingKeys(target, source){
  let changed = false;
  for (const key of Object.keys(source)){
    if (!Object.prototype.hasOwnProperty.call(target, key)){
      target[key] = source[key];
      changed = true;
    }
  }
  return changed;
}

// ---------- .env (bash-export style, e.g. `export MCP_ACCESS_KEY=...`) ----------
function readEnvFile(){
  const vars = {};
  if (!fs.existsSync(ENV_PATH)) return vars;
  for (const rawLine of fs.readFileSync(ENV_PATH, 'utf8').split('\n')){
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))){
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}
function appendEnvVar(name, value){
  fs.appendFileSync(ENV_PATH, `export ${name}=${value}\n`);
}
// Updates/creates exactly one `export KEY=value` line, preserving every
// other line verbatim — same reasoning as upsertOpenclawEnvVar() below, just
// for THIS project's own bash-export-style .env. Needed for values (like
// BRAIN_DEVICE) the customer can change their mind about and re-save,
// unlike appendEnvVar()'s callers which only ever write their key once.
function upsertEnvVar(name, value){
  const lines = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8').split('\n')
    : [];
  let replaced = false;
  const nextLines = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return rawLine;
    const withoutExport = line.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');
    if (eq === -1 || withoutExport.slice(0, eq).trim() !== name) return rawLine;
    replaced = true;
    return `export ${name}=${value}`;
  });
  if (!replaced) nextLines.push(`export ${name}=${value}`);
  while (nextLines.length && nextLines[nextLines.length - 1] === '') nextLines.pop();
  fs.writeFileSync(ENV_PATH, nextLines.join('\n') + '\n');
}

// ---------- Brain device (OrangePi / Radxa) ----------
function getBrainDevice(){
  const value = readEnvFile()[BRAIN_DEVICE_ENV_NAME];
  return VALID_BRAIN_DEVICES.has(value) ? value : null;
}

// ---------- MCP access key: generate once, persist, reuse ----------
function getOrCreateMcpAccessKey(){
  const config = readConfig();
  if (config.mcp_token_env !== MCP_TOKEN_ENV_NAME){
    config.mcp_token_env = MCP_TOKEN_ENV_NAME;
    writeConfig(config);
  }

  const envVars = readEnvFile();
  if (envVars[MCP_TOKEN_ENV_NAME]){
    return envVars[MCP_TOKEN_ENV_NAME];
  }

  const key = crypto.randomBytes(24).toString('hex'); // same strength as `openssl rand -hex 24`
  appendEnvVar(MCP_TOKEN_ENV_NAME, key);
  return key;
}

// ---------- Box address: prefer Tailscale, fall back to LAN IPv4 ----------
function detectTailscaleIPv4(callback){
  execFile('tailscale', ['ip', '-4'], { timeout: 3000 }, (err, stdout) => {
    if (err) return callback(null);
    const ip = stdout.trim().split('\n')[0].trim();
    callback(ip || null);
  });
}
function detectLanIPv4(){
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)){
    for (const iface of ifaces[name] || []){
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal){
        return iface.address;
      }
    }
  }
  return null;
}
function detectBoxAddress(callback){
  detectTailscaleIPv4((tailscaleIp) => {
    if (tailscaleIp) return callback(tailscaleIp);
    callback(detectLanIPv4());
  });
}

// ---------- /api/mcp-connection-info ----------
function handleMcpConnectionInfo(req, res){
  let key;
  try {
    key = getOrCreateMcpAccessKey();
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message || String(e) });
  }
  detectBoxAddress((address) => {
    if (!address){
      return sendJson(res, 200, {
        success: false,
        error: "Could not determine this box's network address (no Tailscale IP and no LAN IPv4 found).",
      });
    }
    sendJson(res, 200, { success: true, url: `http://${address}:${MCP_PORT}/mcp`, key });
  });
}

// ---------- /api/lan-address ----------
// Opposite priority from /api/mcp-connection-info above: an ESP32 entering
// this address during its WiFi captive-portal setup can only resolve a
// bare LAN IPv4 — it has no Tailscale client, so handing it a Tailscale
// address (as detectBoxAddress() would prefer, when available) would have
// it silently fail to connect. This always uses detectLanIPv4() directly,
// skipping Tailscale detection entirely.
function handleLanAddress(req, res){
  const address = detectLanIPv4();
  if (!address){
    return sendJson(res, 200, {
      success: false,
      error: "Could not determine this box's LAN IPv4 address (no non-internal IPv4 network interface found).",
    });
  }
  sendJson(res, 200, { success: true, address });
}

// ---------- WiFi provisioning: nmcli helpers ----------
// Confirmed on this box: nmcli (NetworkManager) is available, no wpa_cli or
// /etc/network/interfaces — every WiFi operation below goes through nmcli.
function execFileAsync(cmd, args, options){
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options || {}, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().trim() || err.message));
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// nmcli's terse (-t) mode escapes a literal ':' inside a field as '\:', but
// none of the fields read here (device names, 'wifi', 'connected', or our
// own fixed WIFI_HOTSPOT_CON_NAME) can legitimately contain one — a plain
// split keeps this simple instead of writing a full terse-format unescaper.
async function listWifiDevices(){
  let stdout;
  try {
    ({ stdout } = await execFileAsync('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'], { timeout: 5000 }));
  } catch (e) {
    return [];
  }
  return stdout.trim().split('\n').filter(Boolean)
    .map((line) => {
      const [device, type, state, connection] = line.split(':');
      return { device, type, state, connection };
    })
    .filter((row) => row.type === 'wifi');
}

// Assumes a single WiFi radio — true of every box this targets.
async function getPrimaryWifiDevice(){
  const devices = await listWifiDevices();
  return devices[0] || null;
}

// True only when associated to a real network. A device currently running
// OUR OWN hotspot also reports STATE=connected (to its own AP it's hosting)
// — that case is told apart by connection profile name, not state alone.
async function isConnectedToRealWifi(){
  const device = await getPrimaryWifiDevice();
  if (!device) return false;
  return device.state === 'connected' && device.connection !== WIFI_HOTSPOT_CON_NAME;
}

async function startHotspot(){
  const device = await getPrimaryWifiDevice();
  if (!device){
    throw new Error('No WiFi device found on this box (checked via `nmcli device status`).');
  }

  // Best-effort: clears out a stale profile from an earlier run/attempt so
  // `con-name` below always creates a fresh one, instead of failing on a
  // name collision with a leftover profile. Not a real failure if there was
  // nothing to delete (the expected case on first run).
  try {
    await execFileAsync('nmcli', ['connection', 'delete', WIFI_HOTSPOT_CON_NAME], { timeout: 5000 });
  } catch (e) { /* no pre-existing profile — fine */ }

  await execFileAsync('nmcli', [
    'device', 'wifi', 'hotspot',
    'ifname', device.device,
    'con-name', WIFI_HOTSPOT_CON_NAME,
    'ssid', WIFI_HOTSPOT_SSID,
    'password', WIFI_HOTSPOT_PASSWORD,
  ], { timeout: 20000 });

  return device.device;
}

// Always best-effort: called both to tear the hotspot down for good on a
// successful customer WiFi connection, and to restore it after a failed
// one — in both cases "already down" or "never existed" isn't a failure.
async function stopHotspot(){
  try {
    await execFileAsync('nmcli', ['connection', 'down', WIFI_HOTSPOT_CON_NAME], { timeout: 10000 });
  } catch (e) { /* already down / never existed */ }
}

// Runs once at process startup (see server.listen below) and again on
// demand via POST /api/wifi/hotspot/start, so the hotspot can be
// re-triggered for testing without rebooting the box.
async function ensureHotspotIfNeeded(){
  if (await isConnectedToRealWifi()){
    return { started: false, alreadyConnected: true };
  }
  const iface = await startHotspot();
  return { started: true, alreadyConnected: false, iface };
}

async function handleWifiHotspotStart(req, res){
  try {
    const result = await ensureHotspotIfNeeded();
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e) });
  }
}

async function nmcliDeviceField(iface, field){
  try {
    const { stdout } = await execFileAsync('nmcli', ['-g', field, 'device', 'show', iface], { timeout: 5000 });
    return stdout.trim();
  } catch (e) {
    return '';
  }
}

// True only once the interface actually has an IPv4 address AND a default
// gateway — nmcli reporting the `connect` command itself as successful
// isn't enough proof: association can succeed while DHCP silently fails
// (seen with some drivers on a wrong password, reported late rather than
// as an immediate error). Two separate -g calls instead of one multi-field
// call: `-g FIELD1,FIELD2` interleaves values without labels when a field
// is multi-valued (e.g. multiple IP4.ADDRESS entries), which would be
// ambiguous to parse reliably — this couldn't be verified hands-on in this
// sandbox (no nmcli/Linux here), so it's written defensively.
async function verifyRealWifiConnectivity(iface){
  const [address, gateway] = await Promise.all([
    nmcliDeviceField(iface, 'IP4.ADDRESS'),
    nmcliDeviceField(iface, 'IP4.GATEWAY'),
  ]);
  return !!address && !!gateway;
}

// Ties the whole customer-facing flow together for POST /api/wifi/connect
// below. Throws on any failure; the caller is responsible for restoring
// the hotspot around this call so a failed attempt never leaves the box
// with neither the hotspot nor working WiFi.
async function connectToWifi(ssid, password){
  const device = await getPrimaryWifiDevice();
  if (!device){
    throw new Error('No WiFi device found on this box.');
  }

  const args = ['-w', String(WIFI_CONNECT_TIMEOUT_SEC), 'device', 'wifi', 'connect', ssid];
  if (password) args.push('password', password);
  args.push('ifname', device.device);

  // This necessarily disrupts the hotspot if it was active: a single WiFi
  // radio can't run as an AP and as a client at the same time, so
  // NetworkManager tears down the hotspot connection as soon as this
  // command starts, regardless of whether the new network ends up working.
  await execFileAsync('nmcli', args, { timeout: (WIFI_CONNECT_TIMEOUT_SEC + 5) * 1000 });

  const ok = await verifyRealWifiConnectivity(device.device);
  if (!ok){
    throw new Error(`nmcli reported success connecting to "${ssid}", but no IP address/gateway was found on ${device.device} afterward — the network may be unreachable, or the password may be wrong.`);
  }
}

async function handleWifiConnect(req, res){
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message });
  }

  const ssid = body && String(body.ssid || '').trim();
  const password = body && String(body.password || '');
  if (!ssid){
    return sendJson(res, 200, { success: false, error: 'No network name (SSID) provided.' });
  }
  if (password && password.length < 8){
    return sendJson(res, 200, { success: false, error: 'Password must be at least 8 characters (WPA2 minimum), or blank for an open network.' });
  }

  // Recorded before the attempt: connectToWifi() always disrupts an active
  // hotspot (see its own comment), so this is what decides whether that
  // disruption needs undoing afterward, on both the failure and success
  // paths below.
  const deviceBefore = await getPrimaryWifiDevice();
  const hotspotWasActive = !!deviceBefore && deviceBefore.connection === WIFI_HOTSPOT_CON_NAME;

  try {
    await connectToWifi(ssid, password);
  } catch (e) {
    // Failure: never leave the box with neither the hotspot nor working
    // WiFi. If it wasn't running the hotspot before this attempt (e.g. this
    // was a later network change, not initial setup), it's left as-is —
    // reconnecting to whatever network it had previously is a further step
    // this endpoint doesn't attempt.
    if (hotspotWasActive){
      try { await startHotspot(); } catch (restoreErr) {
        return sendJson(res, 200, {
          success: false,
          error: `Could not connect to "${ssid}" (${e.message}), and restoring the setup hotspot afterward also failed (${restoreErr.message || restoreErr}). The box may currently have no network at all — a manual check is needed.`,
        });
      }
    }
    return sendJson(res, 200, { success: false, error: `Could not connect to "${ssid}": ${e.message || e}` });
  }

  const address = detectLanIPv4();
  if (!address){
    // Connected, but this box's own address can't be determined — nothing
    // useful to hand back to redirect the customer to.
    return sendJson(res, 200, {
      success: false,
      error: `Connected to "${ssid}", but could not determine this box's new LAN address afterward.`,
    });
  }

  // Only now, once the new connection is confirmed genuinely working, tear
  // the hotspot down for good.
  await stopHotspot();
  sendJson(res, 200, { success: true, newAddress: address });
}

// ---------- /api/boxes & /api/test: talk to mcp-core's fleet endpoints ----------
// mcp-core/server.js's /health handler is fully open when config.json's
// fleet_token_env is empty (the current state on this box) — no token
// needed, and it already returns full box detail. If fleet_token_env DOES
// name a set env var, mcp-core expects it as X-Fleet-Token; read from .env
// the same way getOrCreateMcpAccessKey() does, not process.env, since .env
// is this project's single source of truth for these tokens.
function getFleetToken(){
  const config = readConfig();
  const envVarName = config.fleet_token_env;
  if (!envVarName) return null;
  return readEnvFile()[envVarName] || null;
}
function fleetHeaders(){
  const token = getFleetToken();
  return token ? { 'X-Fleet-Token': token } : {};
}

async function fetchFleetHealth(){
  const res = await fetch(`http://localhost:${MCP_PORT}/health`, {
    headers: fleetHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`mcp-core /health returned HTTP ${res.status}`);
  return res.json();
}

// mcp-core's own code (`channel: wsHas(b.id) ? "ws" : "lan"`) only ever
// returns one of these two values for any REGISTERED box — there is no
// third state for "registered but unreachable". So `channel` says which
// push mechanism would be used (reverse WebSocket vs. direct LAN push to
// the box's IP), not whether the box is actually reachable — both are
// working connection types. Confirmed wrong by BOX-C0C0: channel "lan",
// yet a full voice conversation (STT, agent reply, browser order
// placement, TTS reply) worked end-to-end through it. Any box mcp-core's
// /health returns at all is a registered, known box — that's the signal.
async function handleGetBoxes(req, res){
  try {
    const health = await fetchFleetHealth();
    const boxes = Array.isArray(health.boxes) ? health.boxes : [];
    sendJson(res, 200, {
      success: true,
      boxes: boxes.map((b) => ({ id: b.id, name: b.name, online: true })),
    });
  } catch (e) {
    sendJson(res, 200, { success: false, error: `Could not reach mcp-core on http://localhost:${MCP_PORT}: ${e.message || e}` });
  }
}

async function handleTest(req, res){
  const logs = [];
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message, logs });
  }

  const boxIds = Array.isArray(body && body.boxIds) ? body.boxIds : [];
  if (!boxIds.length){
    return sendJson(res, 200, { success: false, error: 'No boxIds provided.', logs });
  }

  try {
    // Fresh /health call, not a cached one — a box can appear or disappear
    // from mcp-core's registry between when the box list was loaded and
    // when Test is clicked.
    const health = await fetchFleetHealth();
    const boxesById = new Map((Array.isArray(health.boxes) ? health.boxes : []).map((b) => [b.id, b]));

    for (const id of boxIds){
      const box = boxesById.get(id);
      if (!box){
        throw new Error(`Box "${id}" is not registered with mcp-core (missing from /health).`);
      }

      // No pre-check on box.channel here — see handleGetBoxes's comment:
      // 'ws' vs 'lan' is which push mechanism mcp-core would use, not a
      // reachability signal, and gating on channel === 'ws' previously
      // blocked waking boxes (confirmed via BOX-C0C0) that work fine. The
      // /wake HTTP response below is the real signal now.
      const wakeRes = await fetch(`http://localhost:${MCP_PORT}/wake`, {
        method: 'POST',
        headers: { ...fleetHeaders(), 'X-Box-Id': id },
        signal: AbortSignal.timeout(5000),
      });
      if (!wakeRes.ok){
        throw new Error(`mcp-core rejected the wake request for "${box.name || id}" (HTTP ${wakeRes.status}).`);
      }
      logs.push(`✓ Sent wake request for ${box.name || id} — mcp-core accepted it (HTTP 200)`);
    }

    logs.push('Note: HTTP 200 here means mcp-core accepted the wake request, not proof the box audibly spoke — confirm by listening at the box.');
    sendJson(res, 200, { success: true, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  }
}

// ---------- /api/connect: bootstrap the project into ROOT_DIR ----------
function runCommand(cmd, args, options, logs, label){
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...options, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err){
        logs.push(`✕ ${label} failed: ${(stderr || err.message).trim()}`);
        return reject(err);
      }
      logs.push(`✓ ${label}`);
      resolve({ stdout, stderr });
    });
  });
}

// Recursively copies srcDir's contents into destDir. At the repo root,
// entries in PROTECTED_ROOT_FILES are left alone if they already exist in
// destDir, so a fresh clone never clobbers this running server, the page
// it serves, or an already-configured config.json/.env.
function mergeCopyDir(srcDir, destDir, isRoot, logs){
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })){
    if (isRoot && entry.name === '.git') continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (isRoot && PROTECTED_ROOT_FILES.has(entry.name) && fs.existsSync(destPath)){
      logs.push(`- kept existing ${entry.name} (not overwritten)`);
      continue;
    }
    if (entry.isDirectory()){
      mergeCopyDir(srcPath, destPath, false, logs);
    } else if (entry.isFile()){
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function npmInstallIfPresent(dir, logs){
  const label = path.relative(ROOT_DIR, dir) || path.basename(dir);
  if (!fs.existsSync(path.join(dir, 'package.json'))){
    logs.push(`- skipped npm install in ${label} (no package.json found)`);
    return;
  }
  const isWin = process.platform === 'win32';
  await runCommand(isWin ? 'npm.cmd' : 'npm', ['install'], { cwd: dir, shell: isWin }, logs, `npm install (${label})`);
}

function hasNpmScript(dir, scriptName){
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!(pkg.scripts && pkg.scripts[scriptName]);
  } catch (e) {
    return false;
  }
}

// voice-mcp-server is TypeScript — `npm install` alone doesn't produce the
// dist/index.js that mcp-core requires at runtime; `npm run build` (tsc)
// does. mcp-core itself has no build script, so this is a no-op there.
async function npmBuildIfPresent(dir, logs){
  const label = path.relative(ROOT_DIR, dir) || path.basename(dir);
  if (!hasNpmScript(dir, 'build')){
    logs.push(`- skipped build in ${label} (no build script found)`);
    return;
  }
  const isWin = process.platform === 'win32';
  await runCommand(isWin ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: dir, shell: isWin }, logs, `Building ${label}`);
}

async function handleConnect(req, res){
  const logs = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voix-clone-'));
  try {
    await runCommand('git', ['clone', '--depth', '1', REPO_URL, tmpDir], {}, logs, `Cloned ${REPO_URL}`);

    mergeCopyDir(tmpDir, ROOT_DIR, true, logs);
    logs.push(`✓ Merged project files into ${ROOT_DIR}`);

    const exampleConfigPath = path.join(ROOT_DIR, 'config.example.json');
    if (!fs.existsSync(exampleConfigPath)){
      logs.push('- config.example.json not found in cloned repo, skipped config.json setup');
    } else {
      let exampleConfig = null;
      try {
        exampleConfig = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf8'));
      } catch (e) {
        logs.push(`- skipped config.json merge: config.example.json is invalid JSON (${e.message})`);
      }
      if (exampleConfig){
        if (!fs.existsSync(CONFIG_PATH)){
          writeConfig(exampleConfig);
          logs.push('✓ Created config.json from config.example.json');
        } else {
          const existingConfig = readConfig();
          if (mergeMissingKeys(existingConfig, exampleConfig)){
            writeConfig(existingConfig);
            logs.push('✓ Filled in missing fields in config.json from config.example.json (existing fields kept)');
          } else {
            logs.push('- config.json already has every field from config.example.json, left unchanged');
          }
        }
      }
    }

    await npmInstallIfPresent(path.join(ROOT_DIR, 'mcp-core'), logs);
    const voiceMcpDir = path.join(ROOT_DIR, 'voice-mcp-server');
    if (fs.existsSync(voiceMcpDir)){
      await npmInstallIfPresent(voiceMcpDir, logs);
      await npmBuildIfPresent(voiceMcpDir, logs);
    } else {
      logs.push('- voice-mcp-server not present, skipped');
    }

    sendJson(res, 200, { success: true, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------- /api/download/tts (piper) ----------
function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// --break-system-packages (PEP 668) doesn't exist before pip ~23.0 — Ubuntu
// 22.04's pip 22.0.2 rejects it with "no such option", so it can't be passed
// unconditionally. Checking `pip install --help` for the flag (rather than
// parsing/comparing a version number) is robust to distros that backport it.
async function pipSupportsBreakSystemPackages(){
  try {
    const { stdout } = await execFileAsync('pip', ['install', '--help']);
    return stdout.includes('--break-system-packages');
  } catch (e) {
    return false;
  }
}

async function ensurePiperInstalled(logs){
  if (fs.existsSync(PIPER_BIN)){
    logs.push('✓ Piper already installed');
    return;
  }
  const args = ['install', 'piper-tts'];
  if (await pipSupportsBreakSystemPackages()) args.push('--break-system-packages');
  await runCommand('pip', args, {}, logs, 'Installed piper-tts via pip');
}

// voiceId like 'en_US-lessac-medium' -> .../en/en_US/lessac/medium/en_US-lessac-medium.<ext>
function piperVoiceHfUrl(voiceId, ext){
  const [langRegion, name, quality] = voiceId.split('-');
  const lang = langRegion.split('_')[0];
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${langRegion}/${name}/${quality}/${voiceId}.${ext}`;
}

async function downloadFile(url, destPath){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// Runs cmd/args, writing `stdinText` to the child's stdin (never through a
// shell string — this is how synthesis text reaches piper, safely).
function execWithStdin(cmd, args, options, stdinText){
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { ...options, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().trim() || err.message));
      resolve({ stdout, stderr });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

// Proves the downloaded model actually synthesizes — a file that exists but
// doesn't produce audio isn't a working voice.
async function testPiperSynthesis(modelPath, logs){
  const tmpWav = path.join(os.tmpdir(), `piper-test-${crypto.randomBytes(4).toString('hex')}.wav`);
  try {
    await execWithStdin(PIPER_BIN, ['--model', modelPath, '--output_file', tmpWav], {}, 'test');
    const stat = fs.statSync(tmpWav);
    if (!stat.size) throw new Error('Piper produced an empty output file');
    logs.push(`✓ Synthesis test passed for ${path.basename(modelPath)} (${stat.size} bytes)`);
  } finally {
    fs.rmSync(tmpWav, { force: true });
  }
}

async function isPiperWrapperRunning(){
  try {
    const res = await fetch(`http://localhost:${PIPER_WRAPPER_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Same nohup pattern as start_voice_assistant.sh: detached, logged to /tmp,
// survives after this request (and this server) exits.
async function ensurePiperWrapperRunning(logs){
  if (await isPiperWrapperRunning()){
    logs.push('✓ piper-wrapper.js already running');
    return;
  }
  if (!fs.existsSync(PIPER_WRAPPER_PATH)){
    throw new Error(`piper-wrapper.js not found at ${PIPER_WRAPPER_PATH}`);
  }
  const logPath = '/tmp/piper-wrapper.log';
  await new Promise((resolve, reject) => {
    execFile('sh', ['-c', `nohup node "${PIPER_WRAPPER_PATH}" > ${logPath} 2>&1 &`], { cwd: ROOT_DIR }, (err) => {
      if (err) return reject(new Error(`Failed to launch piper-wrapper.js: ${err.message}`));
      resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!(await isPiperWrapperRunning())){
    throw new Error(`piper-wrapper.js did not come up on port ${PIPER_WRAPPER_PORT} — check ${logPath}`);
  }
  logs.push(`✓ Started piper-wrapper.js on port ${PIPER_WRAPPER_PORT} (nohup, log: ${logPath})`);
}

function setSpeechTts(ttsBlock){
  const config = readConfig();
  if (!config.speech || typeof config.speech !== 'object') config.speech = {};
  config.speech.tts = ttsBlock;
  writeConfig(config);
}

// mcp-core's server.js reads WHISPER_MODEL from the LEGACY top-level
// `stt.model` unconditionally — not `speech.stt.model` — regardless of
// whether `speech` is present (confirmed against mcp-core/server.js's
// connectToMcpServer(), despite config.example.json's own _stt_help saying
// legacy stt is only used when `speech` is absent). Both blocks share the
// same field names (language/prompt_file/model — no `type` on the legacy
// side, per config.example.json), so every real download must keep them in
// sync or mcp-core silently loads a stale/undownloaded model.
function setSpeechStt(sttBlock){
  const config = readConfig();
  if (!config.speech || typeof config.speech !== 'object') config.speech = {};
  config.speech.stt = sttBlock;
  if (!config.stt || typeof config.stt !== 'object') config.stt = {};
  if (sttBlock.model !== undefined) config.stt.model = sttBlock.model;
  if (sttBlock.prompt_file !== undefined) config.stt.prompt_file = sttBlock.prompt_file;
  if (sttBlock.language !== undefined) config.stt.language = sttBlock.language;
  writeConfig(config);
}

// Same merge style as setSpeechTts: only backends.agent.webhook_url is
// touched, so a hand-tuned backends.agent.timeout_ms or backends.priority
// order already in config.json survives.
function setAgentWebhookUrl(webhookUrl){
  const config = readConfig();
  if (!config.backends || typeof config.backends !== 'object') config.backends = {};
  if (!config.backends.agent || typeof config.backends.agent !== 'object') config.backends.agent = {};
  config.backends.agent.webhook_url = webhookUrl;
  writeConfig(config);
}

// ---------- openclaw-agent-bridge.js orchestration (Save & Restart) ----------
// mcp-core never calls the agent's GET /health (only POST /agent — see
// mcp-core/server.js's askWebhook), so this response shape is ours to define
// freely. The `service` field is what lets us tell OUR bridge apart from the
// demo restaurant agent below, which ALSO listens on :4000 and ALSO answers
// GET /health 200 (with a body shaped like {status, restaurant, sessions}
// instead) — confirmed by reading both files, not assumed.
async function checkOpenclawBridgeHealth(){
  try {
    const res = await fetch(`http://localhost:${OPENCLAW_BRIDGE_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body && body.service === 'openclaw-agent-bridge');
  } catch (e) {
    return false;
  }
}

// start_voice_assistant.sh (read directly — see its own "Stopping any old
// instances" and "Starting restaurant agent" steps) has no flag or env var
// to skip auto-starting agents/restaurant/agent.js, and that demo agent
// binds the same :4000 our bridge needs. Best-effort cleanup, not fatal:
// pkill exits 1 when nothing matched, which isn't a real failure here, and
// if pkill itself is missing we still want to attempt starting our own
// bridge (the health check after that will surface a real port conflict).
function killDemoRestaurantAgent(logs){
  return new Promise((resolve) => {
    execFile('pkill', ['-f', 'agents/restaurant/agent.js'], (err, stdout, stderr) => {
      if (!err){
        logs.push('✓ Stopped demo restaurant agent that was occupying port ' + OPENCLAW_BRIDGE_PORT);
      } else if (err.code === 1){
        logs.push('- no demo restaurant agent was running on port ' + OPENCLAW_BRIDGE_PORT);
      } else {
        logs.push(`- could not check/stop the demo restaurant agent (${(stderr || err.message).trim()}) — continuing anyway`);
      }
      resolve();
    });
  });
}

// Same nohup pattern as ensurePiperWrapperRunning. Called BEFORE
// start_voice_assistant.sh runs (see wireLocalAgentBridge) specifically so
// mcp-core never comes up pointed at a port that's still held by the demo
// agent instead of us — that race would let a live customer's speech hit
// the demo restaurant agent's own order-taking flow instead of OpenClaw.
async function ensureOpenclawBridgeRunning(logs){
  if (await checkOpenclawBridgeHealth()){
    logs.push('✓ openclaw-agent-bridge.js already running');
    return;
  }

  await killDemoRestaurantAgent(logs);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (!fs.existsSync(OPENCLAW_BRIDGE_PATH)){
    throw new Error(`openclaw-agent-bridge.js not found at ${OPENCLAW_BRIDGE_PATH}`);
  }
  const logPath = '/tmp/openclaw-agent-bridge.log';
  await new Promise((resolve, reject) => {
    execFile('sh', ['-c', `nohup node "${OPENCLAW_BRIDGE_PATH}" > ${logPath} 2>&1 &`], { cwd: ROOT_DIR }, (err) => {
      if (err) return reject(new Error(`Failed to launch openclaw-agent-bridge.js: ${err.message}`));
      resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!(await checkOpenclawBridgeHealth())){
    throw new Error(
      `openclaw-agent-bridge.js did not come up healthy on port ${OPENCLAW_BRIDGE_PORT} — check ${logPath} ` +
      '(it needs gateway.auth.token in ~/.openclaw/openclaw.json, with the Gateway itself running and its ' +
      'OpenResponses endpoint enabled).'
    );
  }
  logs.push(`✓ Started openclaw-agent-bridge.js on port ${OPENCLAW_BRIDGE_PORT} (nohup, log: ${logPath})`);
}

async function restartVoiceAssistantStack(logs){
  if (!fs.existsSync(START_VOICE_ASSISTANT_SCRIPT)){
    throw new Error(`start_voice_assistant.sh not found at ${START_VOICE_ASSISTANT_SCRIPT}`);
  }
  await runCommand('bash', [START_VOICE_ASSISTANT_SCRIPT], { cwd: ROOT_DIR }, logs, 'Restarted the voice assistant stack (start_voice_assistant.sh)');
  logs.push(
    `- start_voice_assistant.sh also tries to start the demo restaurant agent on :${OPENCLAW_BRIDGE_PORT} as part ` +
    'of its normal run; that bind harmlessly fails since openclaw-agent-bridge.js already holds the port by now ' +
    '(see /tmp/restaurant-agent.log if you want to confirm)'
  );
}

// Ties the whole thing together for /api/save. Bridge is brought up (and
// verified healthy) BEFORE the stack restart, not after — see
// ensureOpenclawBridgeRunning's comment for why that ordering matters.
async function wireLocalAgentBridge(state, logs){
  if (state.agentMode !== 'local'){
    logs.push("- agentMode is 'remote' — skipping local OpenClaw agent bridge wiring.");
    return;
  }

  const webhookUrl = `http://localhost:${OPENCLAW_BRIDGE_PORT}/agent`;
  setAgentWebhookUrl(webhookUrl);
  logs.push(`✓ config.json updated (backends.agent.webhook_url -> ${webhookUrl})`);

  await ensureOpenclawBridgeRunning(logs);
  await restartVoiceAssistantStack(logs);
}

async function handleDownloadTtsPiper(body, logs){
  await ensurePiperInstalled(logs);

  const languages = Array.isArray(body.languages) && body.languages.length ? body.languages : ['en'];
  const voices = {}; // lang -> { voiceId, onnxPath }
  for (const lang of languages){
    const voiceId = PIPER_VOICE_MAP[lang];
    if (!voiceId){
      logs.push(`- skipped "${lang}" (no known Piper voice mapping)`);
      continue;
    }
    const onnxPath = path.join(PIPER_VOICES_DIR, `${voiceId}.onnx`);
    const jsonPath = path.join(PIPER_VOICES_DIR, `${voiceId}.onnx.json`);
    await downloadFile(piperVoiceHfUrl(voiceId, 'onnx'), onnxPath);
    logs.push(`✓ Downloaded ${voiceId}.onnx`);
    await downloadFile(piperVoiceHfUrl(voiceId, 'onnx.json'), jsonPath);
    logs.push(`✓ Downloaded ${voiceId}.onnx.json`);
    voices[lang] = { voiceId, onnxPath };
  }

  const downloadedLangs = Object.keys(voices);
  if (downloadedLangs.length === 0){
    throw new Error('No requested language has a known Piper voice mapping.');
  }

  for (const lang of downloadedLangs){
    await testPiperSynthesis(voices[lang].onnxPath, logs);
  }

  await ensurePiperWrapperRunning(logs);

  // languages[0] (or whichever requested language actually downloaded)
  // decides the default voice mcp-core gets when it doesn't ask for one
  // by name — its openai_tts client falls back to "alloy" otherwise,
  // which no Piper model matches.
  const primaryLang = languages.find((l) => voices[l]) || downloadedLangs[0];
  const primaryVoiceId = voices[primaryLang].voiceId;
  setSpeechTts({
    type: 'openai_tts',
    url: `http://localhost:${PIPER_WRAPPER_PORT}/v1/audio/speech`,
    voice: primaryVoiceId,
  });
  logs.push(`✓ config.json updated (speech.tts -> openai_tts, voice=${primaryVoiceId})`);
  logs.push('⚠ config.json updated — restart the voice assistant to apply.');
}

// ---------- Kokoro TTS setup (github.com/hexgrad/kokoro, real PyPI `kokoro`) ----------
// See the KOKORO_DIR/KOKORO_VOICE_MAP block above for the full kokoro vs
// kokoro-onnx / MOSS-TTS-Nano reasoning. kokoro_server.py is a real,
// unmodified-by-this-code FastAPI app checked into this project (same tier
// as piper-wrapper.js) — this section only installs its Python deps, starts
// it, and proves it actually produces audio in both languages this
// business needs.
function isKokoroVenvReady(){
  return fs.existsSync(KOKORO_VENV_PYTHON);
}

// espeak-ng is a real, documented system dependency of `misaki[en]`'s
// `phonemizer-fork` (confirmed on pypi.org/project/kokoro: "espeak-ng —
// system dependency for English OOD fallback and some non-English
// languages") — a system package installed via apt, not something pip
// compiles, so this is unrelated to the pynini/OpenFst problem MOSS-TTS-Nano
// hit. Still needs root the same way installOllama's apt/install.sh calls
// do, so this reuses the same isRunningAsRoot()/canSudoNonInteractively()
// guard for the same reason: an unprimed `sudo apt-get install` from a
// process with no TTY would hang forever instead of failing fast.
async function isEspeakNgInstalled(){
  return new Promise((resolve) => {
    execFile('which', ['espeak-ng'], (err) => resolve(!err));
  });
}
async function ensureEspeakNgInstalled(logs){
  if (await isEspeakNgInstalled()){
    logs.push('✓ espeak-ng already installed');
    return;
  }
  if (isRunningAsRoot()){
    logs.push('✓ Running as root — apt-get will not need sudo');
  } else if (await canSudoNonInteractively()){
    logs.push('✓ Passwordless sudo available for this user');
  } else {
    throw new Error(
      "espeak-ng isn't installed, and installing it needs root. This process has no TTY for sudo to prompt " +
      'on, so an unprimed sudo call would hang rather than fail — this is a box provisioning issue, not ' +
      'something to fix per-request. Either run setup-server.js as root, or grant this user passwordless sudo ' +
      '(visudo, NOPASSWD) for apt-get ahead of time, then retry. Manual install: `sudo apt-get install -y espeak-ng`.'
    );
  }
  const useSudo = !isRunningAsRoot();
  const cmd = useSudo ? 'sudo' : 'apt-get';
  const args = useSudo
    ? ['-n', 'apt-get', 'install', '-y', 'espeak-ng']
    : ['install', '-y', 'espeak-ng'];
  await runCommand(cmd, args, { timeout: 5 * 60 * 1000 }, logs, 'Installed espeak-ng (apt-get)');
  if (!(await isEspeakNgInstalled())){
    throw new Error('apt-get reported success, but `which espeak-ng` still fails — check the command output above.');
  }
}

// kokoro_server.py's own imports (fastapi, uvicorn, kokoro, misaki[zh],
// soundfile) — deliberately plain `uvicorn`, not `uvicorn[standard]`: the
// [standard] extra pulls in uvloop/httptools, which is unneeded speed for a
// single-worker loopback server and one more compiled-from-source risk to
// rule out after the pynini experience, when it isn't needed here at all.
async function ensureKokoroVenvAndDeps(logs){
  if (isKokoroVenvReady()){
    logs.push('✓ Kokoro venv already exists');
    return;
  }
  fs.mkdirSync(KOKORO_DIR, { recursive: true });
  await runCommand('python3', ['-m', 'venv', '.venv'], { cwd: KOKORO_DIR }, logs, 'Created Kokoro venv');
  await runCommand(
    KOKORO_VENV_PIP, ['install', 'kokoro', 'misaki[zh]', 'soundfile', 'fastapi', 'uvicorn'],
    { cwd: KOKORO_DIR, timeout: 20 * 60 * 1000 }, logs, 'Installed kokoro, misaki[zh], soundfile, fastapi, uvicorn'
  );
}

async function isKokoroServerUp(){
  try {
    const res = await fetch(`http://localhost:${KOKORO_PORT}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// kokoro_server.py loads its model at module scope, before uvicorn.run()
// binds the port (see its own comment) — first run also transparently
// triggers a Hugging Face download of the model weights AND (via misaki) a
// pip-installed spacy `en_core_web_sm` pipeline, both before the port opens.
// So, same reasoning as MOSS-TTS-Nano's engine wait: "wait for the port to
// open" already covers all of that, not just process startup — a first run
// on a slow connection or a slow SBC can legitimately take several minutes.
async function waitForKokoroServerReady(logs, { timeoutMs = 10 * 60 * 1000, intervalMs = 3000 } = {}){
  const deadline = Date.now() + timeoutMs;
  let loggedWaiting = false;
  while (Date.now() < deadline){
    if (await isKokoroServerUp()) return;
    if (!loggedWaiting){
      logs.push('- Kokoro server is starting (downloading model weights on first run can take several minutes)…');
      loggedWaiting = true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Kokoro server did not become ready within ${Math.round(timeoutMs / 1000)}s — check /tmp/kokoro-server.log. ` +
    'First run downloads model weights from Hugging Face before the port even opens; a slow connection needs a ' +
    'longer wait, or confirm huggingface.co is actually reachable from this box.'
  );
}

// Same nohup pattern as ensurePiperWrapperRunning, running kokoro_server.py
// under its own venv's python directly — no separate engine/wrapper split
// needed here (see the setup comment above).
async function ensureKokoroServerRunning(logs){
  if (await isKokoroServerUp()){
    logs.push('✓ kokoro_server.py already running');
    return;
  }
  if (!fs.existsSync(KOKORO_SERVER_PATH)){
    throw new Error(`kokoro_server.py not found at ${KOKORO_SERVER_PATH}`);
  }
  const logPath = '/tmp/kokoro-server.log';
  await new Promise((resolve, reject) => {
    const cmd = `nohup "${KOKORO_VENV_PYTHON}" "${KOKORO_SERVER_PATH}" > ${logPath} 2>&1 &`;
    execFile('sh', ['-c', cmd], { cwd: ROOT_DIR, env: { ...process.env, KOKORO_PORT: String(KOKORO_PORT) } }, (err) => {
      if (err) return reject(new Error(`Failed to launch kokoro_server.py: ${err.message}`));
      resolve();
    });
  });
  logs.push(`- Launched kokoro_server.py (nohup, log: ${logPath}), waiting for it to load…`);
  await waitForKokoroServerReady(logs);
  logs.push(`✓ Kokoro server ready on http://localhost:${KOKORO_PORT}`);
}

// Proves the server actually produces audio in BOTH languages this business
// needs — not just that the process exists. English and Mandarin go through
// genuinely different code paths inside kokoro_server.py (separate
// KPipeline lang_codes, separate G2P stacks via misaki), so a passing
// English test alone would not prove Mandarin works.
async function testKokoroSynthesisOnce(voice, text, logs){
  const res = await fetch(`http://localhost:${KOKORO_PORT}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice, model: 'tts-1', response_format: 'wav' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok){
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Synthesis test failed for voice="${voice}": kokoro_server.py returned HTTP ${res.status}: ${detail}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length){
    throw new Error(`Synthesis test failed for voice="${voice}": kokoro_server.py returned an empty response body`);
  }
  logs.push(`✓ Synthesis test passed for voice="${voice}" (${audio.length} bytes of real audio came back)`);
}
async function testKokoroSynthesis(logs){
  await testKokoroSynthesisOnce('kokoro-en', 'Order confirmed, thank you.', logs);
  await testKokoroSynthesisOnce('kokoro-zh', '订单确认，谢谢惠顾。', logs);
}

async function handleDownloadTtsKokoro(body, logs){
  await ensureEspeakNgInstalled(logs);
  await ensureKokoroVenvAndDeps(logs);
  await ensureKokoroServerRunning(logs);
  await testKokoroSynthesis(logs);

  const languages = Array.isArray(body.languages) && body.languages.length ? body.languages : ['en'];
  for (const lang of languages){
    if (!KOKORO_VOICE_MAP[lang]) logs.push(`- skipped "${lang}" (no known Kokoro voice mapping)`);
  }
  const primaryLang = languages.find((l) => KOKORO_VOICE_MAP[l]) || 'en';
  setSpeechTts({
    type: 'openai_tts',
    url: `http://localhost:${KOKORO_PORT}/v1/audio/speech`,
    voice: `kokoro-${primaryLang}`,
  });
  logs.push(`✓ config.json updated (speech.tts -> openai_tts via kokoro_server.py, voice=kokoro-${primaryLang})`);
  logs.push('⚠ config.json updated — restart the voice assistant to apply.');
}

async function handleDownloadTts(req, res){
  const logs = [];
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message, logs });
  }

  try {
    if (body.model === 'piper'){
      await handleDownloadTtsPiper(body, logs);
    } else if (body.model === 'kokoro'){
      await handleDownloadTtsKokoro(body, logs);
    } else {
      throw new Error(`Unknown TTS model "${body.model}" (expected "piper" or "kokoro").`);
    }
    sendJson(res, 200, { success: true, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  }
}

// ---------- /api/download/stt (whisper.cpp) ----------
// Build command confirmed from THIS project's own check_setup.sh fix-hint
// (`compile whisper.cpp: cmake -B build && cmake --build build -j`) — the
// same command it tells an operator to run by hand if whisper-cli is
// missing — cross-checked against whisper.cpp's own README quickstart
// (2026-08-14), which uses the same cmake invocation. Not `make`: current
// whisper.cpp builds via CMake.
async function ensureWhisperCppBuilt(logs){
  if (fs.existsSync(WHISPER_CLI_BIN)){
    logs.push('✓ whisper.cpp already built (whisper-cli found)');
    return;
  }

  // This box has had whisper.cpp manually installed before in an earlier,
  // since-lost setup — don't assume a missing binary means a missing clone.
  if (fs.existsSync(WHISPER_DIR)){
    logs.push('- whisper.cpp/ already present (from an earlier install), building it');
  } else {
    await runCommand('git', ['clone', '--depth', '1', WHISPER_REPO_URL, WHISPER_DIR], {}, logs, `Cloned ${WHISPER_REPO_URL}`);
  }

  await runCommand('cmake', ['-B', 'build'], { cwd: WHISPER_DIR, timeout: 5 * 60 * 1000 }, logs, 'Configured whisper.cpp build (cmake -B build)');
  // Compiling whisper.cpp + ggml from source is the heaviest install step in
  // this whole wizard — minutes, not seconds, especially on an SBC (OrangePi/
  // RPi), hence the long timeout.
  await runCommand('cmake', ['--build', 'build', '-j'], { cwd: WHISPER_DIR, timeout: 30 * 60 * 1000 }, logs, 'Built whisper.cpp (cmake --build build -j)');

  if (!fs.existsSync(WHISPER_CLI_BIN)){
    throw new Error(`Build finished but whisper-cli was not found at ${WHISPER_CLI_BIN} — check the command output above.`);
  }
  logs.push('✓ whisper.cpp built successfully');
}

function ggmlModelPath(tier){
  return path.join(WHISPER_DIR, 'models', `ggml-${tier}.bin`);
}

// download-ggml-model.sh (confirmed real, from check_setup.sh's fix-hint)
// resolves its OWN directory via `dirname "$(realpath "$0")"` and downloads
// there regardless of cwd, and already refuses to re-download an existing
// ggml-<model>.bin itself — the fs.existsSync check here is what lets US
// skip the run entirely and report it cleanly, instead of relying on paying
// for the script startup and its own internal skip message. Several hundred
// MB per tier, so this matters: don't re-download just because the same
// tier was clicked twice.
async function ensureWhisperModel(tier, logs){
  const modelPath = ggmlModelPath(tier);
  const filename = path.basename(modelPath);
  if (fs.existsSync(modelPath)){
    logs.push(`✓ ${filename} already downloaded`);
    return modelPath;
  }

  const downloadScript = path.join(WHISPER_DIR, 'models', 'download-ggml-model.sh');
  if (!fs.existsSync(downloadScript)){
    throw new Error(`download-ggml-model.sh not found at ${downloadScript}.`);
  }
  await runCommand('sh', [downloadScript, tier], { cwd: WHISPER_DIR, timeout: 20 * 60 * 1000 }, logs, `Downloaded ${filename} (download-ggml-model.sh ${tier})`);
  if (!fs.existsSync(modelPath)){
    throw new Error(`download-ggml-model.sh reported success but ${filename} was not found at ${modelPath}.`);
  }
  return modelPath;
}

// 'custom' isn't covered by download-ggml-model.sh at all — only a direct
// .bin/.gguf URL is handled here (reusing the same downloadFile() helper
// Piper voices use). A bare HuggingFace repo id has no reliable, universal
// filename convention to guess at, so that case is refused with a clear
// message instead of guessing wrong.
async function ensureCustomWhisperModel(source, logs){
  // Allows a trailing query string — HuggingFace's own download links are
  // routinely shaped like ".../ggml-model.bin?download=true".
  if (!/^https?:\/\/\S+\.(bin|gguf)(\?\S*)?$/i.test(source)){
    throw new Error(
      'Custom HuggingFace repo IDs are not supported yet — paste a direct .bin/.gguf file URL instead ' +
      '(e.g. from that repo\'s "Files" tab).'
    );
  }
  const pathOnly = source.split('?')[0].toLowerCase();
  const ext = pathOnly.endsWith('.gguf') ? 'gguf' : 'bin';
  const modelPath = path.join(WHISPER_DIR, 'models', `ggml-custom.${ext}`);
  if (fs.existsSync(modelPath)){
    logs.push(`✓ ggml-custom.${ext} already downloaded`);
    return modelPath;
  }
  await downloadFile(source, modelPath);
  logs.push(`✓ Downloaded custom model from ${source}`);
  return modelPath;
}

// Proves whisper-cli + the downloaded model actually transcribe, not just
// that the files exist. samples/jfk.wav ships inside whisper.cpp's own repo
// (confirmed real — a committed file, not LFS/gitignored, via the GitHub
// API) and is the same file its own README quickstart uses. Invocation
// flags (-m -f -nt -l) match voice-mcp-server's own real whisper-cli call
// (src/index.ts) — -nt suppresses timestamps so stdout is just the
// transcript text.
async function testWhisperTranscription(modelPath, logs){
  if (!fs.existsSync(WHISPER_SAMPLE_AUDIO)){
    throw new Error(`Sample audio not found at ${WHISPER_SAMPLE_AUDIO} — whisper.cpp's own samples/ directory is missing.`);
  }
  const { stdout } = await runCommand(
    WHISPER_CLI_BIN, ['-m', modelPath, '-f', WHISPER_SAMPLE_AUDIO, '-nt', '-l', 'en'],
    { cwd: WHISPER_DIR, timeout: 2 * 60 * 1000 }, logs, 'Ran whisper-cli against samples/jfk.wav'
  );
  const text = (stdout || '').replace(/\n/g, ' ').trim();
  if (!text){
    throw new Error('whisper-cli ran but produced no transcribed text — the build or model is likely broken.');
  }
  logs.push(`✓ Transcription test passed: "${text.slice(0, 120)}"`);
}

async function handleDownloadStt(req, res){
  const logs = [];
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message, logs });
  }

  const requestedModel = body && body.model;
  const isCustom = requestedModel === 'custom';
  const tier = isCustom ? null : WHISPER_TIER_MAP[requestedModel];
  const customSource = isCustom ? String(body.source || '').trim() : null;

  if (isCustom && !customSource){
    return sendJson(res, 200, { success: false, error: 'No model source provided for custom STT model.', logs });
  }
  if (!isCustom && !tier){
    return sendJson(res, 200, { success: false, error: `Unknown STT model "${requestedModel}".`, logs });
  }

  try {
    await ensureWhisperCppBuilt(logs);

    const modelPath = isCustom
      ? await ensureCustomWhisperModel(customSource, logs)
      : await ensureWhisperModel(tier, logs);

    await testWhisperTranscription(modelPath, logs);

    // Relative to ROOT_DIR, matching config.example.json's own convention
    // ("whisper.cpp/models/ggml-small.bin") — mcp-core hands this straight
    // through to voice-mcp-server as WHISPER_MODEL with no path joining of
    // its own, so it only resolves correctly when read relative to ROOT_DIR,
    // exactly like every other path already in config.json.
    const relativeModelPath = path.relative(ROOT_DIR, modelPath).split(path.sep).join('/');
    setSpeechStt({
      type: 'whisper_local',
      model: relativeModelPath,
      prompt_file: WHISPER_PROMPT_FILE,
      language: 'en',
    });
    logs.push(`✓ config.json updated (speech.stt -> whisper_local, model=${relativeModelPath})`);

    sendJson(res, 200, { success: true, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  }
}

// ---------- /api/models/download (local Ollama) ----------
// This is local Ollama (provider id 'ollama', http://127.0.0.1:11434) —
// entirely separate from Ollama Cloud (provider id 'ollama-cloud', wired
// up in /api/verify-key above via an auth profile). Nothing here touches
// OLLAMA_API_KEY or the ollama-cloud:default auth profile: local Ollama is
// enabled purely through OpenClaw's config (models.providers.ollama.apiKey),
// which docs.openclaw.ai/providers/ollama confirms is an independent path
// from both the OLLAMA_API_KEY env var and the ollama-cloud provider.
function isOllamaInstalled(){
  return new Promise((resolve) => {
    execFile('which', ['ollama'], (err) => resolve(!err));
  });
}

// Node's process.getuid is POSIX-only; this file already assumes a Unix
// box elsewhere (sh -c, nohup, /tmp), so this follows the same convention.
function isRunningAsRoot(){
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// `sudo -n` refuses to prompt — it fails immediately instead of blocking
// on a password nothing can supply, which is exactly what's needed to
// probe this safely from a request handler.
function canSudoNonInteractively(){
  return new Promise((resolve) => {
    execFile('sudo', ['-n', 'true'], (err) => resolve(!err));
  });
}

// The official Ollama installer shells out to `sudo` internally for
// several steps (installing the binary, creating the ollama user/group,
// registering the systemd service) whenever it isn't already running as
// root. Spawned from here, there's no TTY for sudo to prompt on, so an
// unprimed sudo call doesn't fail — it blocks forever reading a password
// that will never arrive (confirmed hanging on the real box). This must
// never be "fixed" by injecting a password or auto-elevating; the actual
// fix is provisioning this box so the fix either isn't needed (already
// root) or never prompts (passwordless sudo configured ahead of time) —
// so this only ever detects which of those is true and fails fast,
// loudly, and immediately otherwise.
async function installOllama(logs){
  if (isRunningAsRoot()){
    logs.push('✓ Running as root — install.sh will not need sudo');
  } else if (await canSudoNonInteractively()){
    logs.push('✓ Passwordless sudo available for this user');
  } else {
    throw new Error(
      "Ollama isn't installed, and installing it needs root: install.sh calls sudo internally, and this " +
      'process has no TTY for sudo to prompt on, so an unprimed sudo call would hang rather than fail. This ' +
      'is a box provisioning issue, not something to fix per-request — either run setup-server.js as root, ' +
      'or grant this user passwordless sudo (visudo, NOPASSWD) for the install ahead of time, then retry.'
    );
  }

  // The precheck above can't guarantee every individual command
  // install.sh runs internally is covered by that passwordless rule — a
  // bounded timeout is a backstop so an edge case still fails within
  // minutes instead of hanging the request indefinitely. It's not the
  // actual fix; the precheck and the error above are.
  await runCommand(
    'sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
    { timeout: 5 * 60 * 1000 }, logs, 'Installed Ollama (official install.sh)'
  );
}

// Resolves true/false when systemctl exists and has an opinion, or null
// when there's no systemd on this box at all (so the caller should fall
// back to the HTTP check instead of treating this as "not running").
function checkOllamaServiceViaSystemd(){
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', 'ollama'], (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(null);
      resolve((stdout || '').trim() === 'active');
    });
  });
}

async function isOllamaHttpUp(){
  try {
    const res = await fetch('http://127.0.0.1:11434', { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function ensureOllamaServiceRunning(logs){
  const systemdActive = await checkOllamaServiceViaSystemd();
  if (systemdActive === true){
    logs.push('✓ Ollama service is active (systemctl)');
    return;
  }
  // Also used as a second opinion when systemd exists but says inactive —
  // can only reduce false failures, never mask a real problem, since a
  // pull right after this would fail on its own if nothing is listening.
  if (await isOllamaHttpUp()){
    logs.push('✓ Ollama is responding on http://127.0.0.1:11434');
    return;
  }
  throw new Error(systemdActive === false
    ? '`systemctl is-active ollama` reports the service is not active, and nothing is responding on http://127.0.0.1:11434.'
    : 'No systemd on this box, and nothing is responding on http://127.0.0.1:11434.');
}

async function handleDownloadLocalModel(req, res){
  const logs = [];
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message, logs });
  }

  const model = body && String(body.model || '').trim();
  if (!model){
    return sendJson(res, 200, { success: false, error: 'No model provided.', logs });
  }

  try {
    if (await isOllamaInstalled()){
      logs.push('✓ Ollama already installed');
    } else {
      logs.push('- Ollama not found, installing…');
      await installOllama(logs);
    }

    await ensureOllamaServiceRunning(logs);

    await runCommand('ollama', ['pull', model], {}, logs, `Pulled ${model}`);

    await runCommand(
      'openclaw',
      ['config', 'set', 'models.providers.ollama.apiKey', 'ollama-local'],
      {}, logs, 'Enabled local Ollama as an OpenClaw provider'
    );

    // Deliberately does NOT run `openclaw models set` here — that switches
    // OpenClaw's live active model, and this route can run well before the
    // customer clicks "Save & Restart" on the Review & Save screen. That
    // decision belongs to /api/save, once the full final state is known.
    sendJson(res, 200, { success: true, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  }
}

// ---------- /api/verify-key ----------
// The ids index.html's PROVIDERS[] can send. Credentials are set through
// `openclaw models auth paste-api-key`, not an env var write — for at
// least 'ollama-cloud', OpenClaw resolves credentials from a SQLite-backed
// auth profile ("kind": "profiles"), which takes priority over any env
// var, so writing e.g. OLLAMA_API_KEY to ~/.openclaw/.env is silently
// ignored for that provider. Going through OpenClaw's own auth command
// sets the credential the way OpenClaw itself expects regardless of which
// kind a given provider resolves through.
const KNOWN_PROVIDER_IDS = new Set(['ollama-cloud', 'openai', 'anthropic', 'google', 'groq', 'openrouter']);

// docs.openclaw.ai/cli/models: paste-api-key's own default profile id is
// `<provider>:manual`, but `<provider>:default` is documented elsewhere as
// a common, valid profile id shape — passed explicitly via --profile-id so
// every provider lands on the same convention instead of each command's
// own default. Flag if a provider turns up that rejects this id shape.
function profileIdFor(providerId){
  return `${providerId}:default`;
}

// The key must never appear as a CLI argument (visible in the local
// process list even without a shell) or get shell-interpolated — docs.openclaw.ai
// explicitly calls this out and has automation pipe the key on stdin instead.
function setOpenclawAuthProfile(providerId, key){
  return execWithStdin(
    'openclaw',
    ['models', 'auth', 'paste-api-key', '--provider', providerId, '--profile-id', profileIdFor(providerId)],
    {},
    `${key}\n`
  );
}

// Default text for each documented `openclaw models status --probe-provider`
// status bucket, used only when the probe result itself carries no
// human-readable message/reason/detail field to surface instead. Only
// 'ok' has been confirmed hands-on (see findProbeResult below) — the rest
// are docs.openclaw.ai's documented bucket set for this same command.
const PROBE_STATUS_MESSAGES = {
  auth: 'OpenClaw reached the provider and the key was rejected (authentication failed).',
  rate_limit: 'The provider rate-limited the verification request. The key may still be valid — try again shortly.',
  billing: 'The provider reports a billing/quota problem on this account.',
  timeout: 'Verification timed out waiting for a response from the provider.',
  format: "The key isn't in a format this provider accepts.",
  unknown: 'OpenClaw returned an unrecognized probe result for this provider.',
  no_model: 'OpenClaw could not find a model to test this provider with.',
};

// Confirmed by manual testing against a real box (2026-08-14): with both
// --probe and --probe-provider, results land at `auth.probes.results`, as
// objects shaped like { status: 'ok', latencyMs: ... }. --probe-provider
// alone (no --probe) does NOT trigger a live request — it only scopes an
// already-enabled probe — so runOpenclawProbe below always passes both.
// Since --probe-provider scopes the array to the requested provider, this
// isn't a full-tree search anymore: it prefers a result that identifies
// itself as this provider/profile if one is present, else falls back to
// the single entry (the normal case, since verify-key only ever creates
// one profile — `<provider>:default` — per provider).
function findProbeResult(statusJson, providerId){
  const results = statusJson && statusJson.auth && statusJson.auth.probes && statusJson.auth.probes.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const profileId = profileIdFor(providerId);
  const matched = results.find((r) => r && (
    r.provider === providerId || r.providerId === providerId || r.id === providerId ||
    r.profile === profileId || r.profileId === profileId
  ));
  if (matched) return matched;

  return results.length === 1 ? results[0] : null;
}

function runOpenclawProbe(providerId){
  return new Promise((resolve, reject) => {
    execFile(
      'openclaw',
      ['models', 'status', '--probe', '--probe-provider', providerId, '--probe-timeout', '15000', '--json'],
      { timeout: 25000, maxBuffer: 1024 * 1024 * 10 },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Could not parse \`openclaw models status --json\` output: ${e.message}`));
        }
      }
    );
  });
}

async function handleVerifyKey(req, res){
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message });
  }

  const provider = body && body.provider;
  const key = body && String(body.key || '').trim();
  if (!KNOWN_PROVIDER_IDS.has(provider)){
    return sendJson(res, 200, { success: false, error: `Unknown provider "${provider}".` });
  }
  if (!key){
    return sendJson(res, 200, { success: false, error: 'No key provided.' });
  }
  if (/[\r\n]/.test(key)){
    return sendJson(res, 200, { success: false, error: 'Key must not contain line breaks.' });
  }

  const profileId = profileIdFor(provider);
  try {
    await setOpenclawAuthProfile(provider, key);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: `Could not set auth profile ${profileId}: ${e.message || e}` });
  }

  let statusJson;
  try {
    statusJson = await runOpenclawProbe(provider);
  } catch (e) {
    const message = (e.message || String(e));
    if (/lock|busy|exclusive/i.test(message)){
      return sendJson(res, 200, {
        success: false,
        error: `${profileId} was saved, but OpenClaw's state directory is locked (likely a running Gateway). ` +
          'Run `openclaw gateway stop`, then verify again — this endpoint will not stop it for you.',
      });
    }
    return sendJson(res, 200, { success: false, error: `${profileId} was saved, but \`openclaw models status --probe-provider\` failed: ${message}` });
  }

  const probeResult = findProbeResult(statusJson, provider);
  if (!probeResult){
    return sendJson(res, 200, {
      success: false,
      error: `${profileId} was saved, but no probe result for "${provider}" was found in \`openclaw models status --json\` output.`,
    });
  }
  if (probeResult.status === 'ok'){
    return sendJson(res, 200, { success: true });
  }

  const reason = probeResult.message || probeResult.reason || probeResult.detail || PROBE_STATUS_MESSAGES[probeResult.status] || `status: ${probeResult.status}`;
  sendJson(res, 200, { success: false, error: reason });
}

// ---------- /api/save ----------
// Default model per cloud provider, used only because the Cloud Model
// screen collects a provider (state.cloudProvider) but never a specific
// model — "Choose your LLM" is a Cloud-vs-Local choice for non-technical
// customers, not a model catalog browser. Each ref below was confirmed
// against two independent sources — docs.openclaw.ai/providers/<id> and
// the openclaw/openclaw GitHub docs source — on 2026-08-14, except
// ollama-cloud's kimi-k2.6, which is from the team's own hands-on testing.
// Provider catalogs move fast; these are dated confirmations, not a live
// lookup, so re-verify if this is revisited much later.
const PROVIDER_DEFAULT_MODELS = {
  'ollama-cloud': 'ollama-cloud/kimi-k2.6',
  openai: 'openai/gpt-5.6-sol',
  // Sonnet tier, not Opus: this is real-time order-taking conversation for
  // cost-conscious restaurant customers already paying monthly, not a task
  // needing Anthropic's most expensive frontier-reasoning tier. Bare
  // `sonnet` alias resolves to this ref today per docs.openclaw.ai.
  anthropic: 'anthropic/claude-sonnet-5',
  google: 'google/gemini-3.1-pro-preview',
  groq: 'groq/openai/gpt-oss-120b',
  openrouter: 'openrouter/auto',
};

// Just the "commit to a model" piece of Save & Restart: given the final
// posted state, decides which model OpenClaw should actually run and
// switches to it via `openclaw models set` — the one live-switching
// action in this whole flow, which is why it belongs here and not in
// /api/download/tts, /api/models/download, or /api/verify-key, all of
// which only prepare things ahead of the customer clicking Save.
async function commitActiveModel(state, logs){
  if (state.agentMode !== 'local'){
    logs.push("- agentMode is 'remote' — OpenClaw isn't this box's brain, nothing to switch.");
    return;
  }

  let modelRef;
  if (state.aiMode === 'local'){
    if (!state.localModelDownloaded){
      throw new Error('aiMode is local but localModelDownloaded is not true — download the model before saving.');
    }
    const model = state.localModel && String(state.localModel).trim();
    if (!model) throw new Error('aiMode is local but no localModel is set.');
    modelRef = `ollama/${model}`;
  } else if (state.aiMode === 'cloud'){
    if (!state.apiKeyVerified){
      throw new Error('aiMode is cloud but apiKeyVerified is not true — verify the key before saving.');
    }
    modelRef = PROVIDER_DEFAULT_MODELS[state.cloudProvider];
    if (!modelRef) throw new Error(`No default model configured for cloud provider "${state.cloudProvider}".`);
  } else {
    throw new Error(`agentMode is 'local' but aiMode is "${state.aiMode}" (expected 'local' or 'cloud').`);
  }

  await runCommand('openclaw', ['models', 'set', modelRef], {}, logs, `Set ${modelRef} as the active model`);
}

// For agentMode === 'local', this now does a real restart: config.json is
// pointed at openclaw-agent-bridge.js, the bridge is brought up (or
// confirmed already up), and start_voice_assistant.sh actually runs — see
// wireLocalAgentBridge. It still does not (yet) apply STT/TTS settings or
// push config for agentMode === 'remote', which has no backend wiring of
// its own yet.
async function handleSave(req, res){
  const logs = [];
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 200, { success: false, error: e.message, logs });
  }

  try {
    await commitActiveModel(body || {}, logs);
    await wireLocalAgentBridge(body || {}, logs);
    sendJson(res, 200, { success: true, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  }
}

// ---------- /api/setup-openclaw ----------
function checkOpenclawVersion(){
  return new Promise((resolve) => {
    execFile('openclaw', ['--version'], (err, stdout, stderr) => {
      if (err) return resolve(null);
      resolve(stdout.trim() || stderr.trim() || 'unknown');
    });
  });
}

// ---------- OpenClaw <-> mcp-core MCP connection ----------
// Registers mcp-core as an MCP server OpenClaw itself connects to as a
// CLIENT, giving OpenClaw the esp_list_boxes/esp_speak/esp_display tools
// (mcp-core/server.js) to call proactively — the opposite direction from
// openclaw-agent-bridge.js, which lets OpenClaw ANSWER live customer speech.
// Confirmed working command shape (tested by hand over SSH, 2026-08-19):
//   openclaw mcp set voix-kiosk '{"url":"http://localhost:8000/mcp",
//   "transport":"streamable-http","headers":{"Authorization":"Bearer <key>"}}'
// The <key> there is now an env-var REFERENCE, not a literal — see the
// OpenClaw global .env section right below for why and how.
const MCP_SERVER_NAME = 'voix-kiosk';

// ---------- OpenClaw's own global .env (dotenv format) ----------
// A literal secret in a header value is exactly what `openclaw mcp doctor`
// flags: docs.openclaw.ai/cli/mcp — "Sensitive values in `url` (userinfo)
// and `headers` are redacted in logs and status output. `openclaw mcp
// doctor` warns when sensitive-looking `headers` or `env` entries contain
// literal values, so operators can move those values out of committed
// config." Same class of risk this project avoids everywhere else (see
// config.json's mcp_token_env — only ever the NAME of an env var, never the
// key itself).
//
// The documented fix, confirmed directly from docs.openclaw.ai (not
// guessed, and not the several unofficial "openclaw docs" mirror domains a
// web search surfaces alongside it — this only ever cites the real
// docs.openclaw.ai):
//   - docs.openclaw.ai/gateway/configuration: "Reference env vars in any
//     config string value with `${VAR_NAME}`" — a general mechanism for ANY
//     config string (confirmed via its own example, `"${BASE}/v1"` ->
//     `"https://api.example.com/v1"`, a SUBSTRING interpolation, not a
//     whole-value-only match) — not something special-cased to
//     gateway.auth.token alone (the one other place this project already
//     relies on the same `${VAR}` shape — see openclaw-agent-bridge.js's
//     resolveTokenValue()). So `"Bearer ${MCP_ACCESS_KEY}"` is a valid
//     header value, stored literally as that placeholder string in
//     openclaw.json and resolved only when OpenClaw actually reads it.
//   - docs.openclaw.ai/help/environment: OpenClaw resolves `${VAR_NAME}`
//     from five sources in precedence order, each only filling in what's
//     still missing (process env wins outright): (1) the process
//     environment the Gateway was launched with, (2) a `.env` in its CWD,
//     (3) **the global `.env` at `~/.openclaw/.env` (aka
//     `$OPENCLAW_STATE_DIR/.env`)**, (4) an `env` block inside
//     openclaw.json itself, (5) an opt-in login-shell import. This project
//     has no way to reach into OpenClaw Gateway's own process environment
//     or CWD from here, so (3) — a real file OpenClaw itself documents and
//     owns — is the one place this can reliably write to. Confirmed
//     genuinely distinct from THIS project's own ~/esp/.env (ENV_PATH
//     above): different path, different owner, and — per the same page's
//     "dotenv default" wording — a different LINE FORMAT. ~/esp/.env is
//     deliberately bash `export KEY=value` style (see readEnvFile()'s own
//     comment) because it's sourced by shell/systemd; a dotenv-style file
//     is plain `KEY=value` with no `export`, and standard dotenv parsers
//     don't strip a leading "export " token — reusing readEnvFile()'s
//     export-aware parser or appendEnvVar()'s export-writing format here
//     would silently leave MCP_ACCESS_KEY unresolved in OpenClaw's file
//     (the exact class of bug voix-mcp-core.service's own comment already
//     had to work around for systemd's EnvironmentFile=), so this gets its
//     own plain-format reader/writer instead of reusing those.
//
// Not confirmed hands-on: whether an already-running Gateway daemon (as
// opposed to the fresh `openclaw` CLI invocations this file itself makes,
// which read this file at their own startup either way) re-reads
// ~/.openclaw/.env without a restart. openclaw-agent-bridge.js's own
// GATEWAY_URL comment already flags the same kind of "config written but
// the running process never reread it" gap for `config set` — if
// `openclaw mcp doctor --probe` still reports this server unreachable after
// this fix, `openclaw gateway restart` is the first thing to try by hand.
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
const OPENCLAW_ENV_PATH = path.join(OPENCLAW_STATE_DIR, '.env');

function readOpenclawEnvFile(){
  const vars = {};
  if (!fs.existsSync(OPENCLAW_ENV_PATH)) return vars;
  for (const rawLine of fs.readFileSync(OPENCLAW_ENV_PATH, 'utf8').split('\n')){
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))){
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// Updates/creates exactly one `KEY=value` line, preserving every other line
// verbatim — OpenClaw itself may already keep other credentials in this
// file, and this must never clobber them. Never blindly appends: a stale
// duplicate earlier in the file would keep winning under dotenv's
// first-occurrence-wins parsing, so an existing line for `name` is replaced
// in place instead.
function upsertOpenclawEnvVar(name, value){
  const lines = fs.existsSync(OPENCLAW_ENV_PATH)
    ? fs.readFileSync(OPENCLAW_ENV_PATH, 'utf8').split('\n')
    : [];
  let replaced = false;
  const nextLines = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return rawLine;
    const eq = line.indexOf('=');
    if (eq === -1 || line.slice(0, eq).trim() !== name) return rawLine;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) nextLines.push(`${name}=${value}`);
  while (nextLines.length && nextLines[nextLines.length - 1] === '') nextLines.pop();
  fs.mkdirSync(OPENCLAW_STATE_DIR, { recursive: true });
  fs.writeFileSync(OPENCLAW_ENV_PATH, nextLines.join('\n') + '\n');
}

// Ensures OpenClaw's own global .env has the current access key under
// MCP_TOKEN_ENV_NAME ('MCP_ACCESS_KEY') — the SAME name (and value)
// getOrCreateMcpAccessKey() already persists into THIS project's ~/esp/.env
// for mcp-core's own use, just mirrored into OpenClaw's separate file so
// `${MCP_ACCESS_KEY}` resolves to it too. Idempotent: leaves the file
// untouched if it's already correct.
function ensureOpenclawEnvHasMcpKey(key, logs){
  const current = readOpenclawEnvFile();
  if (current[MCP_TOKEN_ENV_NAME] === key){
    logs.push(`✓ ${MCP_TOKEN_ENV_NAME} already set correctly in ${OPENCLAW_ENV_PATH}`);
    return;
  }
  upsertOpenclawEnvVar(MCP_TOKEN_ENV_NAME, key);
  logs.push(`✓ Wrote ${MCP_TOKEN_ENV_NAME} into ${OPENCLAW_ENV_PATH} (OpenClaw's own global .env)`);
}

// localhost, not the Tailscale/LAN address handleMcpConnectionInfo() hands
// a genuinely remote OpenClaw — OpenClaw and mcp-core both run on this same
// box, so this always targets the loopback URL regardless of how this box
// is otherwise reached from outside. headers.Authorization is a
// `${MCP_TOKEN_ENV_NAME}` reference, not the literal key — see above.
function buildOpenclawMcpConfigJson(){
  return JSON.stringify({
    url: `http://localhost:${MCP_PORT}/mcp`,
    transport: 'streamable-http',
    headers: { Authorization: 'Bearer ${' + MCP_TOKEN_ENV_NAME + '}' },
  });
}

// docs.openclaw.ai/cli/mcp confirms `doctor --json`'s top-level shape:
// { ok, path, servers: [{ name, ok, issues }] } — servers[] holds every
// checked server, so this finds our own entry by name rather than assuming
// index 0 (harmless here since only one name is ever passed, but matches
// what the real shape actually is).
function findMcpDoctorServerResult(doctorJson, name){
  const servers = doctorJson && Array.isArray(doctorJson.servers) ? doctorJson.servers : [];
  return servers.find((s) => s && s.name === name) || null;
}

// docs.openclaw.ai/cli/mcp confirms bare `openclaw mcp probe --json` returns
// discovered tool names at a top-level "tools" array (e.g.
// ["docs__read_page", "docs__search"]), and that "doctor --probe adds the
// same live connection proof as probe" — but does NOT show a worked example
// of exactly where that array lands inside doctor's own
// { ok, path, servers: [...] } wrapper when combined with --probe. Checked
// defensively in both plausible places rather than assuming one; if neither
// has it, the connection is still trusted as reachable (that's what
// ok/exit-code already proved — see connectOpenclawMcp below), just
// reported with an empty tool list instead of guessing a wrong field path.
function findMcpToolNames(doctorJson, server){
  const fromServer = server && Array.isArray(server.tools) ? server.tools : null;
  const fromTop = doctorJson && Array.isArray(doctorJson.tools) ? doctorJson.tools : null;
  const list = fromServer || fromTop || [];
  return list.map((t) => (typeof t === 'string' ? t : (t && t.name))).filter(Boolean);
}

// Same "tolerate a nonzero exit as long as real JSON came back" shape as
// runOpenclawProbe below: per docs.openclaw.ai, "`doctor --json` exits
// nonzero when any enabled checked server has an error-level issue" — that's
// a legitimate diagnostic result to parse, not a command failure.
function runOpenclawMcpDoctorProbe(){
  return new Promise((resolve, reject) => {
    execFile(
      'openclaw',
      ['mcp', 'doctor', MCP_SERVER_NAME, '--probe', '--json'],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 10 },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Could not parse \`openclaw mcp doctor --json\` output: ${e.message}`));
        }
      }
    );
  });
}

// Ties the whole thing together: save the definition, then PROVE it
// connects — a saved definition on disk isn't proof by itself, the probe
// result is. Reused by both /api/connect-openclaw directly and
// handleSetupOpenclaw below (so this self-heals on every OpenClaw setup
// run, not just the first). Throws on failure; callers decide whether that
// should be fatal (see handleSetupOpenclaw's try/catch around this).
async function connectOpenclawMcp(logs){
  const key = getOrCreateMcpAccessKey();
  // Must land in OpenClaw's own .env BEFORE `mcp set`/`mcp doctor` run
  // below — both are fresh `openclaw` CLI invocations that resolve
  // ${MCP_ACCESS_KEY} at their own startup, so the value has to already be
  // there by the time either one reads it.
  ensureOpenclawEnvHasMcpKey(key, logs);
  const configJson = buildOpenclawMcpConfigJson();

  // Real argv array, not a shell string built by concatenation — configJson
  // (which now embeds only a ${MCP_ACCESS_KEY} reference, never the literal
  // key — see the OpenClaw global .env section above) reaches openclaw as
  // one argv element with no shell parsing in between, so nothing in it can
  // break out of the JSON string either way.
  await runCommand(
    'openclaw', ['mcp', 'set', MCP_SERVER_NAME, configJson], {}, logs,
    `Registered ${MCP_SERVER_NAME} as an OpenClaw MCP client (http://localhost:${MCP_PORT}/mcp)`
  );

  const doctorJson = await runOpenclawMcpDoctorProbe();
  const server = findMcpDoctorServerResult(doctorJson, MCP_SERVER_NAME);
  const issues = (server && Array.isArray(server.issues)) ? server.issues : [];
  const hasErrorIssue = issues.some((i) => i && i.level === 'error');
  const reachable = !!server && server.ok !== false && doctorJson.ok !== false && !hasErrorIssue;
  if (!reachable){
    const issueText = issues.length ? issues.map((i) => i.message || i.level).join('; ') : 'no further detail was returned';
    throw new Error(`\`openclaw mcp doctor ${MCP_SERVER_NAME} --probe\` reports it is not reachable: ${issueText}`);
  }

  // The command can still exit 0/ok:true with non-fatal warning-level
  // issues attached (per docs.openclaw.ai/cli/mcp, only error-level issues
  // fail the command) — surfaced rather than silently dropped so a
  // regression back to a literal-value warning (e.g. a typo in the env var
  // name, or ${MCP_ACCESS_KEY} not actually resolving) would be visible
  // here instead of hiding behind an otherwise-successful connection.
  for (const issue of issues){
    if (issue && issue.level !== 'error'){
      logs.push(`⚠ openclaw mcp doctor: ${issue.message || issue.level}`);
    }
  }

  const tools = findMcpToolNames(doctorJson, server);
  logs.push(tools.length
    ? `✓ Verified ${MCP_SERVER_NAME} is reachable — ${tools.length} tool(s) discovered: ${tools.join(', ')}`
    : `✓ Verified ${MCP_SERVER_NAME} is reachable (doctor --probe reported no issues; no tool list found in its output to enumerate)`);
  return tools;
}

// Non-fatal wrapper for handleSetupOpenclaw below: a failure here (e.g.
// mcp-core isn't running yet) shouldn't fail the whole "Setup OpenClaw" step
// the way a real install failure would — installing OpenClaw and deploying
// the workspace templates are independent successes even when this
// particular wiring isn't ready yet. Same "keep going" philosophy as
// ensureOpenclawBrowserConfig above. /api/connect-openclaw itself (below)
// does NOT use this wrapper — a direct, explicit call to that endpoint is
// exactly where a real failure should be reported, not swallowed.
async function ensureOpenclawMcpConnected(logs){
  try {
    await connectOpenclawMcp(logs);
  } catch (e) {
    logs.push(
      `⚠ Could not connect ${MCP_SERVER_NAME} as an OpenClaw MCP client yet: ${e.message || e} — ` +
      'retry from the box-tools connection status once mcp-core is running.'
    );
  }
}

// ---------- /api/connect-openclaw ----------
async function handleConnectOpenclaw(req, res){
  const logs = [];
  try {
    const tools = await connectOpenclawMcp(logs);
    sendJson(res, 200, { success: true, tools, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  }
}

async function handleSetupOpenclaw(req, res){
  const logs = [];
  try {
    const existingVersion = await checkOpenclawVersion();
    if (existingVersion){
      logs.push(`✓ OpenClaw already installed (${existingVersion})`);
      deployWorkspaceTemplates(logs);
      await ensureOpenclawBrowserTool(logs);
      await ensureOpenclawSessionResetConfig(logs);
      await ensureOpenclawMcpConnected(logs);
      return sendJson(res, 200, { success: true, alreadyInstalled: true, version: existingVersion, logs });
    }

    logs.push('- OpenClaw not found, installing…');
    try {
      await runCommand('npm', ['install', '-g', 'openclaw'], {}, logs, 'Installed openclaw via npm');
    } catch (e) {
      const message = (e.message || '').toLowerCase();
      if (message.includes('eacces') || message.includes('permission denied')){
        return sendJson(res, 200, {
          success: false,
          error:
            "npm install -g openclaw failed with a permission error. This usually means npm's global " +
            'install directory needs elevated access on this machine — run `sudo npm install -g openclaw` ' +
            "manually once (or reconfigure npm's global prefix to a directory your user owns), then retry " +
            'this step. This process will not escalate its own privileges automatically.',
          logs,
        });
      }
      throw e;
    }

    // Confirm it's actually callable now, not just that npm exited 0.
    const version = await checkOpenclawVersion();
    if (!version){
      return sendJson(res, 200, {
        success: false,
        error: 'npm reported openclaw installed, but `openclaw --version` still fails — it may not be on PATH, or the install did not complete correctly.',
        logs,
      });
    }
    logs.push(`✓ Confirmed openclaw --version -> ${version}`);
    deployWorkspaceTemplates(logs);
    await ensureOpenclawBrowserTool(logs);
    await ensureOpenclawSessionResetConfig(logs);
    await ensureOpenclawMcpConnected(logs);
    sendJson(res, 200, { success: true, alreadyInstalled: false, version, logs });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e), logs });
  }
}

// ---------- OpenClaw workspace templates (SOUL.md, skills/) ----------
// SOUL.md and the food-ordering skill used to be hand-typed onto the box
// over SSH — that doesn't survive a fresh OpenClaw install (confirmed: a
// hand-typed skill vanished after a reinstall). Both now ship as template
// files in ROOT_DIR/templates and get deployed into OpenClaw's workspace
// right after handleSetupOpenclaw confirms OpenClaw itself is installed.
const OPENCLAW_WORKSPACE_DIR = path.join(os.homedir(), '.openclaw', 'workspace');
const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');
// Sidecar record of the hash we last WROTE for each destination. This is
// what lets deployTemplateFile tell "this file still holds whatever we
// deployed last time (safe to refresh)" apart from "someone hand-edited
// this directly on the box" (never touch that) — a plain content-equality
// check against the CURRENT template isn't enough on its own, since the
// template's own content can change between versions of this project, and
// a destination matching an older deployed version is still ours to
// update, not a manual edit.
const TEMPLATE_MANIFEST_PATH = path.join(OPENCLAW_WORKSPACE_DIR, '.voix-template-manifest.json');

const WORKSPACE_TEMPLATES = [
  { src: path.join(TEMPLATES_DIR, 'SOUL.md'), dest: path.join(OPENCLAW_WORKSPACE_DIR, 'SOUL.md'), key: 'SOUL.md' },
  {
    src: path.join(TEMPLATES_DIR, 'skills', 'food-ordering', 'SKILL.md'),
    dest: path.join(OPENCLAW_WORKSPACE_DIR, 'skills', 'food-ordering', 'SKILL.md'),
    key: 'skills/food-ordering/SKILL.md',
  },
  {
    src: path.join(TEMPLATES_DIR, 'skills', 'supabase-ordering', 'SKILL.md'),
    dest: path.join(OPENCLAW_WORKSPACE_DIR, 'skills', 'supabase-ordering', 'SKILL.md'),
    key: 'skills/supabase-ordering/SKILL.md',
  },
  {
    src: path.join(TEMPLATES_DIR, 'skills', 'menu-importer', 'SKILL.md'),
    dest: path.join(OPENCLAW_WORKSPACE_DIR, 'skills', 'menu-importer', 'SKILL.md'),
    key: 'skills/menu-importer/SKILL.md',
  },
];

function sha256(text){
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readTemplateManifest(){
  try {
    return JSON.parse(fs.readFileSync(TEMPLATE_MANIFEST_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}
function writeTemplateManifest(manifest){
  fs.mkdirSync(path.dirname(TEMPLATE_MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(TEMPLATE_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

// Deploys one template -> destination. Refuses to touch a destination that
// exists and doesn't match either the current template content or a hash
// this tool itself recorded from a past deployment — that's the "someone
// customized this on the box" case, and it only ever gets a warning, never
// a silent overwrite.
function deployTemplateFile(template, manifest, logs){
  const templateContent = fs.readFileSync(template.src, 'utf8');
  const templateHash = sha256(templateContent);

  if (!fs.existsSync(template.dest)){
    fs.mkdirSync(path.dirname(template.dest), { recursive: true });
    fs.writeFileSync(template.dest, templateContent);
    manifest[template.key] = templateHash;
    logs.push(`✓ Deployed ${template.key} -> ${template.dest}`);
    return;
  }

  const destContent = fs.readFileSync(template.dest, 'utf8');
  const destHash = sha256(destContent);
  if (destHash === templateHash){
    manifest[template.key] = templateHash;
    logs.push(`- ${template.key} already up to date at ${template.dest}, left unchanged`);
    return;
  }
  if (manifest[template.key] && manifest[template.key] === destHash){
    fs.writeFileSync(template.dest, templateContent);
    manifest[template.key] = templateHash;
    logs.push(`✓ Updated ${template.key} -> ${template.dest} (matched our own previous deployment, no manual edits found)`);
    return;
  }

  logs.push(
    `⚠ ${template.dest} differs from the ${template.key} template and wasn't deployed by this tool — ` +
    'left unchanged so a manual customization never gets silently overwritten. If you actually want the ' +
    `template applied here, back up or remove ${template.dest} and re-run setup.`
  );
}

// Runs once handleSetupOpenclaw has confirmed OpenClaw is installed (either
// branch — already-present or freshly-installed).
//
// NOTE: OpenClaw only reads SOUL.md and skills/ off disk at Gateway
// startup, so none of this takes effect until `openclaw gateway restart`
// runs. A gateway restart is service-affecting (same category of decision
// as the Ollama Cloud probe/Gateway conflict elsewhere in this file, where
// this codebase deliberately never stops a running service without the
// operator asking for it), so it is NOT triggered automatically here — the
// operator is told to run it instead.
function deployWorkspaceTemplates(logs){
  const manifest = readTemplateManifest();
  for (const template of WORKSPACE_TEMPLATES){
    if (!fs.existsSync(template.src)){
      logs.push(`- skipped ${template.key} (template not found at ${template.src})`);
      continue;
    }
    deployTemplateFile(template, manifest, logs);
  }
  writeTemplateManifest(manifest);
  logs.push('⚠ Workspace templates deployed — run `openclaw gateway restart` on the box to pick up SOUL.md/skill changes.');
}

// ---------- OpenClaw browser tool config ----------
// The food-ordering skill (templates/skills/food-ordering/SKILL.md) tells
// the agent to "place the order using the browser tool," but a real run had
// no browser tool available at all and, instead of saying so, faked a
// completed order (exec'd a made-up confirmation message, then printed a
// hardcoded fake price via Python).
//
// Root cause, confirmed against the on-box docs
// (/usr/lib/node_modules/openclaw/docs/tools/browser.md): this project sets
// tools.profile to "coding", and the "coding" profile explicitly excludes
// the full browser tool (only web_search/web_fetch ship with it) — so
// browser was never in the trajectory's tool list regardless of
// browser.enabled, which already defaults to true and was never the
// problem. The fix is tools.alsoAllow: ["browser"] at the top level, which
// adds browser back on top of the "coding" profile without abandoning the
// profile's other curated defaults (confirmed: docs.openclaw.ai/tools/browser).
//
// browser.enabled write from an earlier version of this function is gone —
// it was already true by default, a harmless no-op, not a fix.
//
// noSandbox history: an earlier fix guessed it might be needed on this
// class of hardware, but that was never confirmed, so it was dropped from
// this list rather than carried forward speculatively. It's back now for a
// different, confirmed reason — see below.
//
// attachOnly/noSandbox (new): live testing on the box found the real root
// cause of the browser tool still not working even with tools.alsoAllow
// fixed — this box's chromium package has no headless ozone platform
// compiled in at all, so any launch OpenClaw attempts itself (headless by
// construction, see browser.headless below) fails outright with "FATAL:
// Invalid ozone platform: headless". The fix confirmed live is to stop
// having OpenClaw launch chromium itself: run it separately under Xvfb
// (systemd/voix-xvfb.service + systemd/voix-browser.service) in normal
// (non-headless) X11 mode, and have OpenClaw attach to that already-running
// instance instead via browser.attachOnly. noSandbox: true is not
// speculative this time — docs.openclaw.ai/tools/browser-linux-troubleshooting's
// "Solution 2" pattern specifies both attachOnly and noSandbox together for
// this exact setup, and that's the pattern voix-browser.service's
// --no-sandbox flag was launched with when this was confirmed working.
//
// executablePath and headless stay unchanged: this box's chromium lives at
// a non-default path (/usr/bin/chromium) regardless of launch mode, and
// headless staying 'true' here is harmless now that OpenClaw isn't the one
// launching chromium (attachOnly skips its own launch step entirely) —
// changing it wasn't asked for and isn't needed to fix this.
const BROWSER_TOOL_CONFIG = [
  ['browser.executablePath', '/usr/bin/chromium'],
  ['browser.headless', 'true'],
  ['browser.attachOnly', 'true'],
  ['browser.noSandbox', 'true'],
];

function getOpenclawConfigValue(key){
  return new Promise((resolve) => {
    execFile('openclaw', ['config', 'get', key], (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

// tools.alsoAllow is an array, not a scalar, and it's a shared list — other
// entries may get added to it later by hand or by some other step, so this
// reads the existing array and appends "browser" rather than overwriting
// the path outright. (--merge wouldn't help here even if we wanted it:
// per docs.openclaw.ai's CLI reference, "objects merge recursively; arrays
// and scalar values replace the target" — --merge only changes how objects
// at a fixed list of protected paths behave, e.g. agents.defaults.models,
// and tools.alsoAllow isn't one of them. Doing the merge ourselves in JS and
// writing the full resulting array is the only way an existing entry
// survives.) The array is written with --strict-json, matching
// docs.openclaw.ai's own array-set example (`config set
// channels.whatsapp.groups '["*"]' --strict-json`).
async function ensureBrowserInAlsoAllow(logs){
  const raw = await getOpenclawConfigValue('tools.alsoAllow');
  let current = [];
  if (raw){
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) current = parsed;
    } catch (e) {
      // Not parseable as JSON (path absent, or some other value entirely)
      // — treat as "nothing to preserve" rather than guessing at its shape.
    }
  }

  if (current.includes('browser')){
    logs.push('- tools.alsoAllow already includes "browser", left unchanged');
    return;
  }

  const next = [...current, 'browser'];
  try {
    const { stdout } = await runCommand(
      'openclaw',
      ['config', 'set', 'tools.alsoAllow', JSON.stringify(next), '--strict-json'],
      {},
      logs,
      `Added "browser" to tools.alsoAllow (-> ${JSON.stringify(next)})`
    );
    const hint = stdout && stdout.trim();
    if (hint) logs.push(`  ${hint}`);
  } catch (e) {
    // runCommand already logged the failure.
  }
}

// Plain `config set <path> <value>`, no --strict-json/--merge — these are
// scalar booleans/strings, not objects on a protected path, so a bare
// `config set` is the documented shape (confirmed against
// docs.openclaw.ai's CLI reference).
//
// Each key is checked before being written (never blindly overwritten) both
// to avoid needless log noise on a rerun and because `config set` prints a
// restart-applicability hint on stdout that's only useful signal the first
// time a value actually changes — same "read the hint, don't assume either
// way" rule this project already follows for gateway.http.endpoints.responses
// in openclaw-agent-bridge.js.
async function ensureOpenclawBrowserConfig(logs){
  for (const [key, value] of BROWSER_TOOL_CONFIG){
    const current = await getOpenclawConfigValue(key);
    if (current === value){
      logs.push(`- ${key} already ${value}, left unchanged`);
      continue;
    }
    try {
      const { stdout } = await runCommand('openclaw', ['config', 'set', key, value], {}, logs, `Set ${key} = ${value}`);
      const hint = stdout && stdout.trim();
      if (hint) logs.push(`  ${hint}`);
    } catch (e) {
      // runCommand already logged the failure. Keep going so one bad key
      // doesn't block the other.
    }
  }
}

// Entry point called from handleSetupOpenclaw: the actual fix
// (tools.alsoAllow) runs first, then the supporting browser.* config that
// only matters once the tool is actually reachable.
async function ensureOpenclawBrowserTool(logs){
  await ensureBrowserInAlsoAllow(logs);
  await ensureOpenclawBrowserConfig(logs);
}

// session.reset.mode/idleMinutes: sessionKey is derived from box_id alone
// (agent:main:openresponses-user:<box_id>), and this box's fleet already
// has more than one registered box, so without an idle-based reset a
// session never expires on its own — the next customer at the same box can
// land in whatever conversation (and order) the previous customer left
// open. Confirmed live: a stale session sat open 2+ hours with an old
// order still attached. This pair was previously set by hand via `openclaw
// config set` directly on a running box and was never wired into this
// file (confirmed: `grep -n "session\." ~/esp/setup-server.js` returned
// nothing), so a re-flash + fresh wizard setup would come up with no idle
// reset at all — the same state that caused that debugging session.
//
// Both keys are written with --strict-json, values as literal JSON. mode
// needs this: a bare (non-strict-json) `config set session.reset.mode
// idle` was confirmed live to fail — the CLI needs the literal JSON
// string `"idle"`, not a bare word. idleMinutes is passed the same way for
// consistency. `openclawValueMatches` below JSON-decodes each side before
// comparing so this stays idempotent regardless of whether `config get`
// echoes the bare scalar or its JSON form.
const SESSION_RESET_CONFIG = [
  ['session.reset.mode', '"idle"'],
  ['session.reset.idleMinutes', '5'],
];

function openclawValueMatches(current, jsonValue){
  if (current === null) return false;
  const expected = JSON.parse(jsonValue);
  if (current === String(expected)) return true;
  try {
    return JSON.parse(current) === expected;
  } catch (e) {
    return false;
  }
}

// Same idempotency approach as ensureOpenclawBrowserConfig above: read
// first, skip with a "-" line if already correct, set + log otherwise.
async function ensureOpenclawSessionResetConfig(logs){
  for (const [key, jsonValue] of SESSION_RESET_CONFIG){
    const current = await getOpenclawConfigValue(key);
    const display = JSON.parse(jsonValue);
    if (openclawValueMatches(current, jsonValue)){
      logs.push(`- ${key} already ${display}, left unchanged`);
      continue;
    }
    try {
      const { stdout } = await runCommand(
        'openclaw',
        ['config', 'set', key, jsonValue, '--strict-json'],
        {},
        logs,
        `Set ${key} = ${display}`
      );
      const hint = stdout && stdout.trim();
      if (hint) logs.push(`  ${hint}`);
    } catch (e) {
      // runCommand already logged the failure. Keep going so one bad key
      // doesn't block the other.
    }
  }
}

// ---------- /api/status: cheap "what's already configured" check ----------
// Lets the frontend restore already-completed wizard steps after a hard
// refresh instead of assuming nothing's done. Every check here is a file
// existence check or a single quick command — no live re-probing (that's
// what each section's own "Verify"/"Test" button is still for).

// mcp-core is npm-installed straight into ROOT_DIR by /api/connect
// (handleConnect above) — node_modules existing is the same proxy that
// function's own success already implies, without re-running it.
function checkVoiceEngineReady(){
  return fs.existsSync(path.join(ROOT_DIR, 'mcp-core', 'node_modules'));
}

// Highest tier wins when multiple ggml-*.bin files are present (e.g. the
// customer upgraded from Base to Small later). ggmlModelPath() is the same
// helper ensureWhisperModel() uses, so this checks the exact paths that
// path can produce.
function checkSttModel(){
  const tierToId = { medium: 'whisper-medium', small: 'whisper-small', base: 'whisper-base' };
  for (const tier of ['medium', 'small', 'base']){
    if (fs.existsSync(ggmlModelPath(tier))) return tierToId[tier];
  }
  if (fs.existsSync(path.join(WHISPER_DIR, 'models', 'ggml-custom.bin')) ||
      fs.existsSync(path.join(WHISPER_DIR, 'models', 'ggml-custom.gguf'))){
    return 'custom';
  }
  return null;
}

// config.example.json's default speech.tts.type was 'moss_local' — only
// setSpeechTts() (via handleDownloadTtsPiper/handleDownloadTtsKokoro's
// success paths) ever changes it to 'openai_tts'. Both engines write that
// same type (kokoro_server.py speaks openai_tts directly, same reason
// piper-wrapper.js does — see the Kokoro TTS setup comment above), so
// telling them apart needs the url's port, not just the type string.
function checkTtsModel(){
  const config = readConfig();
  const tts = config.speech && config.speech.tts;
  if (!tts || tts.type !== 'openai_tts') return null;
  const url = String(tts.url || '');
  if (url.includes(`:${KOKORO_PORT}`)) return 'kokoro';
  if (url.includes(`:${PIPER_WRAPPER_PORT}`)) return 'piper';
  return null;
}

// backends.agent.webhook_url is only ever written by wireLocalAgentBridge
// (via /api/save), and only when agentMode was 'local' at save time — its
// presence is the only signal on disk that distinguishes a completed local
// setup from the wizard's 'remote' default.
function checkAgentMode(){
  const config = readConfig();
  const webhookUrl = config.backends && config.backends.agent && config.backends.agent.webhook_url;
  return webhookUrl === `http://localhost:${OPENCLAW_BRIDGE_PORT}/agent` ? 'local' : 'remote';
}

function runOpenclawModelsStatus(){
  return new Promise((resolve, reject) => {
    execFile('openclaw', ['models', 'status', '--json'], { timeout: 10000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

// Confirmed against a real box's plain (non--probe) `openclaw models
// status --json` output: the active model is a top-level "resolvedDefault"
// string, falling back to "defaultModel" if that's ever absent — both
// shaped like "<provider>/<model>" (e.g. "ollama-cloud/kimi-k2.6"), the
// same ref shape commitActiveModel() itself writes via `openclaw models
// set`. This is a different top-level shape than openclaw.json's own
// config file (which nests the active model under "model": {"primary":
// ...}) — the two must not be conflated. The --probe shape
// (statusJson.auth.probes.results) is separate and confirmed independently
// via findProbeResult, above.
function findActiveModelRef(statusJson){
  const ref = statusJson && (statusJson.resolvedDefault || statusJson.defaultModel);
  return typeof ref === 'string' && ref.includes('/') ? ref : null;
}

// The only way this app ever makes a cloud provider "active" is
// commitActiveModel() (/api/save), which itself refuses to run unless
// /api/verify-key's probe already succeeded — so an active cloud provider
// ref found here stands in for "verified" without re-probing it live.
async function checkActiveCloudProvider(){
  try {
    const statusJson = await runOpenclawModelsStatus();
    const ref = findActiveModelRef(statusJson);
    const providerId = ref ? ref.split('/')[0] : null;
    if (providerId && KNOWN_PROVIDER_IDS.has(providerId)){
      return { cloudProvider: providerId, apiKeyVerified: true };
    }
    return { cloudProvider: null, apiKeyVerified: false };
  } catch (e) {
    return { cloudProvider: null, apiKeyVerified: false };
  }
}

// Independent of the check above: asks Ollama itself (not OpenClaw) which
// models are actually pulled, since a model can be downloaded via
// /api/models/download well before /api/save ever makes it OpenClaw's
// active model.
function checkLocalModelDownloaded(){
  return new Promise((resolve) => {
    execFile('ollama', ['list'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ localModel: null, localModelDownloaded: false });
      const names = (stdout || '').split('\n').slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (!names.length) return resolve({ localModel: null, localModelDownloaded: false });
      const model = names.includes('qwen2.5:3b') ? 'qwen2.5:3b' : names[0];
      resolve({ localModel: model, localModelDownloaded: true });
    });
  });
}

// ---------- /api/set-device: which board this box's brain runs on ----------
// Asked first in the wizard (before anything else is installed) so every
// later step can branch on it instead of assuming OrangePi. Writes straight
// to .env — regenerate .env.systemd (`sed 's/^export //' .env >
// .env.systemd`) and restart voix-mcp-core same as any other .env change,
// per README.md section 3.
async function handleSetDevice(req, res){
  try {
    const body = await readJsonBody(req);
    const device = String(body.device || '').trim();
    if (!VALID_BRAIN_DEVICES.has(device)){
      return sendJson(res, 200, { success: false, error: `device must be one of: ${[...VALID_BRAIN_DEVICES].join(', ')}` });
    }
    upsertEnvVar(BRAIN_DEVICE_ENV_NAME, device);
    sendJson(res, 200, { success: true, device });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e) });
  }
}

async function handleStatus(req, res){
  try {
    const voiceEngineReady = checkVoiceEngineReady();
    const sttModel = checkSttModel();
    const ttsModel = checkTtsModel();
    const agentMode = checkAgentMode();

    const [openclawVersion, cloudInfo, localInfo] = await Promise.all([
      checkOpenclawVersion(),
      agentMode === 'local' ? checkActiveCloudProvider() : Promise.resolve({ cloudProvider: null, apiKeyVerified: false }),
      checkLocalModelDownloaded(),
    ]);

    sendJson(res, 200, {
      success: true,
      brainDevice: getBrainDevice(),
      voiceEngineReady,
      sttModel,
      ttsModel,
      agentMode,
      openclawReady: !!openclawVersion,
      cloudProvider: cloudInfo.cloudProvider,
      apiKeyVerified: cloudInfo.apiKeyVerified,
      localModel: localInfo.localModel,
      localModelDownloaded: localInfo.localModelDownloaded,
    });
  } catch (e) {
    sendJson(res, 200, { success: false, error: e.message || String(e) });
  }
}

// ---------- HTTP plumbing ----------
function sendJson(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveHtmlFile(res, filePath, label){
  fs.readFile(filePath, (err, data) => {
    if (err){
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end(`Failed to load ${label}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/mcp-connection-info'){
    return handleMcpConnectionInfo(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/lan-address'){
    return handleLanAddress(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/wifi/hotspot/start'){
    return handleWifiHotspotStart(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/wifi/connect'){
    return handleWifiConnect(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/status'){
    return handleStatus(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/set-device'){
    return handleSetDevice(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/boxes'){
    return handleGetBoxes(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/test'){
    return handleTest(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/connect'){
    return handleConnect(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/download/tts'){
    return handleDownloadTts(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/download/stt'){
    return handleDownloadStt(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/models/download'){
    return handleDownloadLocalModel(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/verify-key'){
    return handleVerifyKey(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/setup-openclaw'){
    return handleSetupOpenclaw(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/connect-openclaw'){
    return handleConnectOpenclaw(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/save'){
    return handleSave(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/index.html'){
    return serveHtmlFile(res, INDEX_PATH, 'index.html');
  }

  if (req.method === 'GET' && url.pathname === '/wifi-setup.html'){
    return serveHtmlFile(res, WIFI_SETUP_PATH, 'wifi-setup.html');
  }

  // Bare '/' is the one route whoever is provisioning the box actually
  // visits (it's what goes on the physical sticker/manual, see
  // WIFI_HOTSPOT_SSID above) — so it's the one place that decides between
  // the two pages based on current connection state, sparing the sticker
  // from needing to spell out a specific path. Explicit '/index.html' and
  // '/wifi-setup.html' above always serve their own page regardless of
  // state, for direct testing. Fails open to the main wizard if the check
  // itself errors, rather than ever locking a working, connected box out
  // of its own setup page.
  if (req.method === 'GET' && url.pathname === '/'){
    return isConnectedToRealWifi()
      .catch(() => true)
      .then((connected) => serveHtmlFile(res, connected ? INDEX_PATH : WIFI_SETUP_PATH, connected ? 'index.html' : 'wifi-setup.html'));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`setup-server listening on http://0.0.0.0:${PORT}`);
});

// Runs after the HTTP server is already listening — a box with no WiFi
// configured still gets a server it can reach as soon as the hotspot comes
// up, instead of waiting on nmcli before accepting any connections at all.
ensureHotspotIfNeeded()
  .then((result) => {
    if (result.alreadyConnected){
      console.log('WiFi already connected — setup hotspot not needed.');
    } else {
      console.log(`Started setup hotspot "${WIFI_HOTSPOT_SSID}" on ${result.iface} (http://${WIFI_HOTSPOT_GATEWAY}:${PORT}/).`);
    }
  })
  .catch((e) => {
    console.error(`Could not start setup hotspot: ${e.message || e}`);
  });
