#!/usr/bin/env node
// mcp-core: thin, dumb, standalone voice router for ESP boxes.
//
// It knows how to do exactly three things:
//   1. speech <-> text (via voice-mcp-server over MCP stdio)
//   2. hand text to a configured brain (agent webhook or a local LLM), in
//      config-priority order
//   3. push audio + display payloads back to the box that spoke
//
// Everything smart — persona, menus, pricing, what to draw on the screen —
// lives behind the agent webhook. This file must stay project-agnostic.
//
// Replaces both bridge-server/bridge-server.js and
// listen_v2/assistant_via_bridge.py (one service instead of two hops).
import http from "node:http";
import { writeFile, readFile, mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir, homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Bonjour } from "bonjour-service";
import { loadConfig, loadRawConfig, writeConfig, ESP_ROOT } from "./config.js";
import { BoxRegistry, asciiOneline, sendCaption, sendAudio, sendDisplay, setFleetToken, isCgnat } from "./boxes.js";
import { createMcpServer } from "./mcp-tools.js";
import { startWsHub, setWsFleetToken, wsHas } from "./ws-hub.js";

const config = loadConfig();
// The raw parsed config is kept for round-tripping: box self-registration
// mutates only its .boxes array and writes the rest back untouched (the
// derived `config` object drops fields and must never be re-serialized).
const rawCfg = loadRawConfig();
let cfgWriteChain = Promise.resolve();
function persistBoxes() {
  rawCfg.boxes = boxes.toConfig();
  // Serialize writes: two boxes registering in the same tick must not
  // interleave temp-file writes. A promise chain is lock enough here.
  cfgWriteChain = cfgWriteChain
    .then(() => writeConfig(rawCfg))
    .catch((err) => console.warn("(config.json write failed: " + err.message + ")"));
}
const boxes = new BoxRegistry(config.boxes, persistBoxes);
const MCP_SERVER_PATH = path.join(ESP_ROOT, "voice-mcp-server", "dist", "index.js");
const LOG_PATH = process.env.INTERACTION_LOG || path.join(ESP_ROOT, "mcp-core", "interaction_log.jsonl");

// Confirm-before-LLM flow: after STT, the transcript is shown on the box and
// nothing reaches a backend until the customer tap-confirms (box POSTs
// /confirm). One pending turn per box; the box enforces its own shorter tap
// window (~8s), this longer window just garbage-collects stale turns.
const PENDING_WINDOW_S = 25;
const pendingByBox = new Map();   // box.id -> { transcript, expires, stages }

// Plain-chat history for the local_llm backend only (the agent keeps its own
// session state behind the webhook). Capped so a long chat can't grow the
// prompt without bound.
const llmHistoryByBox = new Map(); // box.id -> [{role, content}]
const HISTORY_MAX = 12;

const nowMs = () => Date.now();

async function logInteraction(record) {
  try {
    await appendFile(LOG_PATH, JSON.stringify(record) + "\n");
  } catch (err) {
    console.warn("(interaction log write failed: " + err.message + ")");
  }
}

// ---- STT / TTS via voice-mcp-server (MCP over stdio) ----------------------

let mcpClient = null;

async function connectToMcpServer() {
  const env = { ...process.env, PLAY_AUDIO: "false" };
  // The whisper model + bias prompt are config-file settings now, delivered to
  // voice-mcp-server through the env it already understands.
  if (config.stt.model) env.WHISPER_MODEL = config.stt.model;
  if (config.stt.promptFile) env.WHISPER_PROMPT_FILE = config.stt.promptFile;
  const transport = new StdioClientTransport({ command: "node", args: [MCP_SERVER_PATH], env });
  const client = new Client({ name: "mcp-core", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to voice-mcp-server at", MCP_SERVER_PATH);
  return client;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (exit ${code}): ${stderr.slice(0, 300)}`)));
  });
}

function extractStructured(result) {
  if (result.structuredContent) return result.structuredContent;
  const textBlock = result.content && result.content.find((c) => c.type === "text");
  if (textBlock) {
    try { return JSON.parse(textBlock.text); } catch { return { text: textBlock.text }; }
  }
  return {};
}

// Quiet / far-from-mic recordings transcribe as garbage unless normalized
// first (confirmed with the ESP32-S3-BOX-3's mic). "norm -3" brings the peak
// up to -3 dBFS.
async function sttFromBuffer(audioBuffer) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-core-"));
  const rawPath = path.join(tempDir, "input_raw.wav");
  const normPath = path.join(tempDir, "input.wav");
  await writeFile(rawPath, audioBuffer);
  await runCommand("sox", [rawPath, normPath, "norm", "-3"]);
  const result = await mcpClient.callTool({
    name: "voice_transcribe_audio",
    arguments: { audio_file_path: normPath, language: config.stt.language }
  });
  if (result.isError) throw new Error("MCP transcribe failed: " + JSON.stringify(result.content));
  return (extractStructured(result).text || "").trim();
}

// text -> 48kHz WAV (MOSS-TTS) -> 22.05kHz mono for the box. The box's
// speaker is mono, and sending full stereo over WiFi takes ~4x longer for
// identical-sounding audio.
async function ttsForBox(text) {
  const result = await mcpClient.callTool({
    name: "voice_speak_text",
    arguments: { text, voice: "default" }
  });
  if (result.isError) throw new Error("MCP speak failed: " + JSON.stringify(result.content));
  const rawPath = extractStructured(result).audio_file_path;
  if (!rawPath) throw new Error("MCP speak tool did not return an audio file path");
  const boxPath = rawPath.replace(/\.wav$/, "_box.wav");
  await runCommand("sox", [rawPath, "-r", "22050", "-c", "1", "-b", "16", boxPath]);
  return await readFile(boxPath);
}

// ---- Wake / greeting --------------------------------------------------------
// GREETING_TEXT is synthesized ONCE and cached in memory — a live TTS call on
// every tap would blow the "1-2s from tap to greeting" latency target for no
// reason, since it's the same phrase every time. Config-overridable so this
// stays reusable for non-restaurant projects, per the README's design goal.
const GREETING_TEXT = config.greetingText || "Hi! How can I help you today?";
let cachedGreetingWav = null;
async function getGreetingAudio() {
  if (!cachedGreetingWav) {
    console.log(`Pre-caching greeting audio: "${GREETING_TEXT}"`);
    const t0 = nowMs();
    cachedGreetingWav = await ttsForBox(GREETING_TEXT);
    console.log(`Greeting cached (${nowMs() - t0}ms, reused for every wake).`);
  }
  return cachedGreetingWav;
}

// Greet on approach: the box's presence radar saw someone walk up, so speak
// the (pre-cached) greeting. Greeting ONLY — deliberately no autoListen: the
// customer orders by tapping the screen, which records immediately. Starting a
// recording here instead would capture the room while they're still deciding.
async function handleWake(box) {
  // A presence-triggered wake IS a session start — mark it here rather than
  // adding a second round-trip, since the box is already calling us for the
  // greeting audio anyway.
  boxes.setOccupied(box.id, true);
  const t0 = nowMs();
  const wav = await getGreetingAudio();
  console.log(`[${box.name}] greeting ready at +${nowMs() - t0}ms, sending to box...`);
  await sendAudio(box, wav, { replyText: GREETING_TEXT });
}

// ---- Backend router --------------------------------------------------------
// Both backends return the same shape:
//   { reply: string, display: [{path, body, headers}]|null, end_session: bool }

// Both take their own config, so any number of backends of the same type can
// coexist (agent + cloud_llm + local_llm + ...). Nothing is keyed by name.

async function askWebhook(name, bc, box, text) {
  const res = await fetch(bc.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: box.id, text }),
    signal: AbortSignal.timeout(bc.timeoutMs)
  });
  if (!res.ok) throw new Error(`${name} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.reply) throw new Error(`${name} returned no reply`);
  return { reply: data.reply, display: data.display || null, end_session: !!data.end_session };
}

// Any OpenAI-compatible chat-completions endpoint — Ollama locally, or OpenAI/
// Groq/OpenRouter/Together/vLLM in the cloud. Same wire format, so one function.
async function askOpenAiChat(name, bc, box, text) {
  // History is keyed by box ONLY, never by backend: if the cloud dies mid-chat
  // and we fall through to local llama, the customer's conversation continues
  // instead of restarting.
  let history = llmHistoryByBox.get(box.id) || [];
  history.push({ role: "user", content: text });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);

  const res = await fetch(bc.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + (bc.token || "")
    },
    body: JSON.stringify({
      model: bc.model,
      messages: [
        ...(bc.system_prompt ? [{ role: "system", content: bc.system_prompt }] : []),
        ...history
      ]
    }),
    signal: AbortSignal.timeout(bc.timeoutMs)
  });
  if (!res.ok) throw new Error(`${name} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const reply = (data.choices?.[0]?.message?.content || "").trim();
  if (!reply) throw new Error(`${name} returned an empty reply`);
  history.push({ role: "assistant", content: reply });
  llmHistoryByBox.set(box.id, history);
  return { reply, display: null, end_session: false };
}

// Try backends in config priority order; a failed backend falls through to the
// next one so a dead webhook (or an unreachable cloud) degrades to plain local
// chat instead of silence.
async function routeText(box, text) {
  let lastErr = null;
  for (const name of config.priority) {
    const bc = config.backends[name];
    try {
      const t0 = nowMs();
      const result = bc.type === "webhook"
        ? await askWebhook(name, bc, box, text)
        : await askOpenAiChat(name, bc, box, text);
      return { ...result, backend: name, llm_ms: nowMs() - t0 };
    } catch (err) {
      console.warn(`Backend "${name}" failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error("no backend configured");
}

// ---- Turn handling ---------------------------------------------------------

function splitSentences(text) {
  const parts = text.trim().split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

// Speak `text` on `box` via the sentence-chunked TTS pipeline: synthesize
// sentence N+1 while the box is still playing sentence N. MOSS generates
// ~2.8x faster than realtime, so after the first chunk there are no gaps —
// and first audio starts after ONE sentence of TTS instead of the whole reply.
//
// `sinceMs` anchors firstAudioMs to an earlier moment (e.g. the tap-confirm)
// so the caller can report true end-to-end latency; defaults to this call's
// own start. Timestamps are returned rather than written to a shared object,
// so the caller decides what to log.
//
// Shared by the tap-driven flow (handleConfirm) and the esp_speak MCP tool —
// one implementation, so the two paths can't drift apart.
async function speakToBox(box, text, { sinceMs } = {}) {
  const t0 = sinceMs ?? nowMs();
  const sentences = splitSentences(text);
  let firstAudioMs = null;
  let ttsEnd = null;
  const ttsStart = nowMs();
  let nextChunk = ttsForBox(sentences[0]);
  const playbackStart = nowMs();
  for (let i = 0; i < sentences.length; i++) {
    const wav = await nextChunk;
    if (i + 1 < sentences.length) nextChunk = ttsForBox(sentences[i + 1]);
    if (firstAudioMs === null) {
      firstAudioMs = nowMs() - t0;
      // First chunk done = the latency-critical TTS span (later chunks
      // overlap playback and don't delay anything).
      ttsEnd = nowMs();
    }
    await sendAudio(box, wav, { quiet: true, final: i + 1 === sentences.length });
  }
  return { chunks: sentences.length, firstAudioMs, ttsStart, ttsEnd, playbackStart, playbackEnd: nowMs() };
}

// Phase 1: recording arrives -> STT only -> show transcript, arm tap-confirm.
async function handleUpload(box, audioBuffer) {
  const uploadEnd = nowMs();
  // record_start is derived from the WAV's own length (16kHz mono 16-bit).
  const recordMs = audioBuffer.length > 44 ? Math.round((audioBuffer.length - 44) / (16000 * 2) * 1000) : 0;
  const record = { timestamp: new Date().toISOString(), box: box.name, recording_bytes: audioBuffer.length };
  const stages = { record_start: uploadEnd - recordMs, record_end: uploadEnd, audio_upload_end: uploadEnd };

  try {
    const t0 = nowMs();
    let transcript = await sttFromBuffer(audioBuffer);
    stages.stt_start = t0;
    stages.stt_end = nowMs();
    console.log(`[${box.name}] heard: ${JSON.stringify(transcript)} [STT ${stages.stt_end - t0}ms]`);
    record.transcript = transcript;

    // Whisper annotates non-speech as "(upbeat music)", "[door slams]" etc.
    // If nothing remains once bracketed annotations are stripped, there was
    // no real speech — treat it the same as silence.
    if (transcript.replace(/[\(\[].*?[\)\]]/g, "").replace(/^[\s.,!?]+|[\s.,!?]+$/g, "") === "") {
      transcript = "";
    }
    if (!transcript) {
      // Nothing intelligible — never bother a backend, just ask again.
      await sendCaption(box, "DIDN'T CATCH THAT - SPEAK AGAIN", { who: "TRY AGAIN" });
      pendingByBox.delete(box.id);
      record.outcome = "no_speech";
      return;
    }

    // Show what was heard and arm the box's tap-to-confirm window. No backend
    // is called until /confirm arrives.
    // The box draws CANCEL/SEND buttons on any confirm caption, so the bar
    // just poses the question — it must not say "TAP = SEND" any more.
    await sendCaption(box, transcript, { who: "CONFIRM?", confirm: true });
    pendingByBox.set(box.id, { transcript, expires: nowMs() + PENDING_WINDOW_S * 1000, stages });
    record.outcome = "awaiting_confirm";
    console.log(`[${box.name}] waiting for tap-confirm (window ${PENDING_WINDOW_S}s)...`);
  } catch (err) {
    console.error(`[${box.name}] phase-1 failed: ${err.message}`);
    record.error = err.message;
  } finally {
    await logInteraction(record);
  }
}

// Phase 2: box tap-confirmed -> backend -> caption -> chunked TTS -> display.
async function handleConfirm(box) {
  const pending = pendingByBox.get(box.id);
  if (!pending || nowMs() > pending.expires) {
    console.log(`[${box.name}] /confirm arrived but nothing pending (or expired)`);
    return { status: 410 };
  }
  pendingByBox.delete(box.id); // consume it — one confirm per turn
  const { transcript, stages } = pending;
  const record = { timestamp: new Date().toISOString(), box: box.name, confirmed_transcript: transcript };

  // The turn continues after we ack the box's /confirm request.
  (async () => {
    try {
      const confirmAt = nowMs();
      console.log(`[${box.name}] confirmed -> backend: ${JSON.stringify(transcript)}`);
      stages.llm_start = nowMs();
      const { reply, display, end_session, backend, llm_ms } = await routeText(box, transcript);
      stages.llm_end = nowMs();
      console.log(`[${box.name}] ${backend}: ${JSON.stringify(reply)} [${llm_ms}ms]`);

      // Caption first: the customer READS the answer while the first sentence
      // is still being synthesized.
      await sendCaption(box, reply, { who: "BOX" });

      // Chunked TTS + playback (see speakToBox). firstAudioMs is anchored to
      // the tap-confirm so it reports what the customer actually waited.
      const spoken = await speakToBox(box, reply, { sinceMs: confirmAt });
      const firstAudioMs = spoken.firstAudioMs;
      const playbackEnd = spoken.playbackEnd;
      stages.tts_start = spoken.ttsStart;
      stages.tts_end = spoken.ttsEnd;
      stages.playback_start = spoken.playbackStart;
      stages.playback_end = spoken.playbackEnd;

      // Backend-supplied display payloads (e.g. the order screen) take over
      // as the resting state. Passthrough only — the core never builds these.
      for (const entry of display || []) {
        await sendDisplay(box, entry);
      }

      if (end_session) llmHistoryByBox.delete(box.id);

      const totalMs = playbackEnd - confirmAt;
      console.log(`[${box.name}] ${spoken.chunks} chunks played. first audio at ${firstAudioMs}ms, done at ${totalMs}ms\n`);
      record.reply = reply;
      record.backend = backend;
      record.display_entries = (display || []).length;
      record.stages_epoch_ms = stages;
      record.latency_ms = { llm: llm_ms, first_audio_after_confirm: firstAudioMs, confirm_to_done: totalMs };
    } catch (err) {
      console.error(`[${box.name}] phase-2 failed: ${err.message}`);
      record.error = err.message;
      await sendCaption(box, "SORRY - SOMETHING BROKE, TRY AGAIN", { who: "BOX" });
    } finally {
      await logInteraction(record);
    }
  })();

  return { status: 200 };
}

// ---- HTTP surface -----------------------------------------------------------

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // Shared-secret gate for the box-facing surface. Note X-Box-Id is NOT auth:
  // it's MAC-derived, logged, and fromId() auto-registers unknown ids — it
  // says who you claim to be, not that you're allowed. This is the check that
  // stops a stranger on the same WiFi driving the hardware.
  //
  // Open until fleet_token_env is configured, so an existing deployment keeps
  // running until the token is deliberately rolled out to the boxes.
  const fleetAuthed = () =>
    !config.fleetToken || req.headers["x-fleet-token"] === config.fleetToken;
  const denyFleet = () =>
    json(401, { error: "unauthorized — missing or wrong X-Fleet-Token" });

  try {
    // MCP tool surface (Streamable HTTP). Must be routed BEFORE any readBody()
    // — the transport needs the raw, unconsumed request stream.
    //
    // A fresh server+transport per request, on purpose: the SDK's example
    // shares one stateless transport, but mcp-core is a long-running daemon
    // taking concurrent requests, where a shared transport risks request-id
    // collisions between clients. Registering three tools costs microseconds,
    // and all real state (box registry, sessions) lives outside MCP anyway.
    if (req.url === "/mcp") {
      // Optional bearer-token gate. Off by default (a trusted LAN doesn't
      // need it), but a one-line config turn-on for anyone exposing this
      // past their own network — the /mcp surface combines device discovery
      // with speaker/display control, which shouldn't be open to strangers.
      if (config.mcpToken && req.headers.authorization !== `Bearer ${config.mcpToken}`) {
        return json(401, { error: "unauthorized — missing or wrong Bearer token" });
      }
      const mcp = createMcpServer({ boxes, speakToBox });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      // Liveness stays open so check_health.sh works with no secrets, but the
      // box inventory is exactly the target list for an attack on the boxes
      // (id + IP for each), so it's only returned to an authenticated caller.
      const base = { status: "ok", mcpConnected: mcpClient !== null, backends: config.priority };
      if (!fleetAuthed()) return json(200, { ...base, boxCount: boxes.boxes.length });
      return json(200, {
        ...base,
        // `channel` tells you HOW a box is reachable — "ws" means it holds a
        // reverse channel and can be pushed to from any network; "lan" means
        // pushes only work while it shares this machine's network.
        boxes: boxes.boxes.map((b) => ({
          id: b.id, name: b.name, ip: b.ip, channel: wsHas(b.id) ? "ws" : "lan",
          occupied: b.occupied   // null = box hasn't reported a session event yet
        }))
      });
    }

    // The firmware image a box downloads during an update. Authenticated like
    // every other box-facing route: this is the exact byte stream that becomes
    // the code running on the hardware, so it is not served to strangers.
    if (req.method === "GET" && req.url === "/firmware") {
      if (!fleetAuthed()) return denyFleet();
      let image;
      try {
        image = await readFile(FIRMWARE_PATH);
      } catch {
        return json(404, { error: `no firmware at ${FIRMWARE_PATH} — run \`idf.py build\` first` });
      }
      // Content-Length matters: the box compares it against what it received
      // and refuses a short read rather than flashing a truncated image.
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": image.length,
      });
      return res.end(image);
    }

    // Start a firmware update. `?box=<id>` targets one box; otherwise all of
    // them. Returns as soon as the boxes have accepted the job — see
    // pushFirmware() on why that isn't the same as "the update worked".
    if (req.method === "POST" && req.url.startsWith("/ota")) {
      if (!fleetAuthed()) return denyFleet();
      const only = new URL(req.url, "http://x").searchParams.get("box");
      const result = await pushFirmware(only);
      if (result.error) return json(400, result);
      return json(200, { started: result.ok, failed: result.failed });
    }

    if (req.method === "POST" && req.url === "/upload") {
      if (!fleetAuthed()) return denyFleet();
      const box = boxes.fromId(req);
      if (!box) {
        // No silent IP-based guessing: a request without an identity is a bug
        // to surface (old firmware, or something that isn't a box at all).
        return json(400, { error: "missing X-Box-Id header — flash current firmware" });
      }
      const audio = await readBody(req);
      if (audio.length === 0) return json(400, { error: "No audio data received" });
      // Ack the box immediately (matches the old adapter's behavior), then
      // transcribe; the transcript arrives on the box via /caption.
      res.writeHead(200, { "Content-Length": "2" });
      res.end("ok");
      console.log(`\n[${box.name}] received recording (${audio.length} bytes)`);
      await handleUpload(box, audio);
      return;
    }

    if (req.method === "POST" && req.url === "/wake") {
      if (!fleetAuthed()) return denyFleet();
      const box = boxes.fromId(req);
      if (!box) {
        return json(400, { error: "missing X-Box-Id header — flash current firmware" });
      }
      await readBody(req);
      // Ack immediately — the box is not waiting on this response for
      // anything (unlike /confirm), it moves straight into playing the
      // greeting once the Mac pushes it, which happens async below.
      res.writeHead(200, { "Content-Length": "2" });
      res.end("ok");
      console.log(`\n[${box.name}] presence detected — greeting`);
      handleWake(box).catch((err) => console.warn(`       (greeting failed: ${err.message})`));
      return;
    }

    // Touch/BOOT-started sessions skip the greeting on purpose (the customer
    // is already engaging), so unlike a presence start there's no /wake call
    // to piggyback occupied-status on — this is that missing signal.
    if (req.method === "POST" && req.url === "/session-start") {
      if (!fleetAuthed()) return denyFleet();
      const box = boxes.fromId(req);
      if (!box) {
        return json(400, { error: "missing X-Box-Id header — flash current firmware" });
      }
      await readBody(req);
      boxes.setOccupied(box.id, true);
      console.log(`[${box.name}] session started (touch/BOOT)`);
      return json(200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/confirm") {
      if (!fleetAuthed()) return denyFleet();
      const box = boxes.fromId(req);
      if (!box) {
        return json(400, { error: "missing X-Box-Id header — flash current firmware" });
      }
      await readBody(req);
      const { status } = await handleConfirm(box);
      if (status === 200) {
        res.writeHead(200, { "Content-Length": "2" });
        res.end("ok");
      } else {
        res.writeHead(status);
        res.end();
      }
      return;
    }

    // Box self-registration: fired by the firmware right after it gets an IP,
    // so config.json learns/refreshes the box without manual editing.
    if (req.method === "POST" && req.url === "/register") {
      if (!fleetAuthed()) return denyFleet();
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req)).toString("utf8"));
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const { box_id, name, ip, fw, fw_sha, slot, pending_verify } = parsed;
      if (typeof box_id !== "string" || !box_id || typeof ip !== "string" || !ip) {
        return json(400, { error: "box_id and ip are required strings" });
      }
      const action = boxes.upsert(box_id, typeof name === "string" && name ? name : null, ip);
      // Optional: boxes on pre-OTA firmware don't send these, and must keep
      // registering exactly as before rather than being rejected for it.
      if (typeof fw === "string") {
        boxes.setFirmware(box_id, {
          fw, fw_sha: fw_sha ?? null, slot: slot ?? null,
          pending_verify: pending_verify === true
        });
      }
      const fwNote = typeof fw === "string"
        ? ` fw=${fw}/${fw_sha ?? "?"} slot=${slot ?? "?"}${pending_verify === true ? " PENDING-VERIFY" : ""}`
        : "";
      console.log(`Box registered: ${box_id} ("${name || box_id}") @ ${ip} [${action}]${fwNote}`);
      return json(200, { ok: true, box_id, name: name || box_id, ip, action });
    }

    // Manual session reset between customers / demo runs.
    // One customer walked away — the box's presence radar noticed and is
    // telling us to forget them. Scoped to THAT box (unlike /reset, which
    // wipes the whole fleet), so one kiosk clearing does not disturb another.
    if (req.method === "POST" && req.url === "/session-end") {
      if (!fleetAuthed()) return denyFleet();
      const box = boxes.fromId(req);
      if (!box) {
        return json(400, { error: "missing X-Box-Id header — flash current firmware" });
      }
      await readBody(req);
      boxes.setOccupied(box.id, false);
      llmHistoryByBox.delete(box.id);
      pendingByBox.delete(box.id);
      // Webhook backends keep their own per-session state, keyed by the same
      // box id we pass as session_id. Ask them to drop just this one.
      for (const name of config.priority) {
        const bc = config.backends[name];
        if (bc.type !== "webhook") continue;
        try {
          await fetch(new URL("/reset", bc.webhook_url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: box.id }),
            signal: AbortSignal.timeout(3000)
          });
        } catch { /* backend may be down; local state is cleared regardless */ }
      }
      console.log(`[${box.name}] session ended (customer left) — conversation reset`);
      return json(200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/reset") {
      if (!fleetAuthed()) return denyFleet();
      llmHistoryByBox.clear();
      pendingByBox.clear();
      // Reset every webhook backend, not just one called "agent" — backends are
      // arbitrarily named now, and only webhooks hold their own session state.
      for (const name of config.priority) {
        const bc = config.backends[name];
        if (bc.type !== "webhook") continue;
        try {
          await fetch(new URL("/reset", bc.webhook_url), { method: "POST" });
        } catch { /* backend may be down; local state is cleared regardless */ }
      }
      return json(200, { ok: true });
    }

    json(404, { error: "Not found" });
  } catch (err) {
    console.error("Error:", err.message);
    if (!res.headersSent) json(500, { error: err.message });
  }
});

// Advertises this machine as "mcp-core.local" over mDNS so a box's
// provisioning form never needs a raw LAN IP typed in — the firmware
// resolves the fixed hostname itself after joining WiFi.
// This machine's primary LAN IPv4 — the address a box on the same WiFi should
// be sending its recordings to.
//
// This must NEVER return a tailnet address. adoptKnownBoxes() pushes whatever
// this returns to every box every 60s and the box persists it to NVS; boxes are
// not on the tailnet, so a 100.x here would silently brick the whole fleet's
// upload path and need a physical re-provision per box to undo. The old version
// returned the first non-internal IPv4 in enumeration order, which becomes a
// coin flip the moment a VPN interface exists.
function lanIp() {
  // Explicit override always wins — for when the heuristics below guess wrong.
  if (config.lanIp) return config.lanIp;

  const candidates = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (isCgnat(ni.address)) continue;   // Tailscale et al — boxes can't route here
      candidates.push({ name, address: ni.address });
    }
  }
  if (candidates.length === 0) return null;

  // Prefer an address on the same /24 as a box we already know about — that's
  // provably the interface that can reach the fleet, not a guess.
  for (const c of candidates) {
    const prefix = c.address.slice(0, c.address.lastIndexOf(".") + 1);
    if (boxes.boxes.some((b) => b.host.startsWith(prefix))) return c.address;
  }
  return candidates[0].address;
}

// Tell every known box where we actually are, right now.
//
// A box stores its server address on-device. When this machine moves networks
// or gets a new DHCP lease, that stored address goes stale and the box sits on
// "NO SERVER" forever — and mDNS (mcp-core.local), which exists precisely to
// avoid hardcoded IPs, is silently blocked on plenty of managed/campus WiFi.
// So we push instead of hoping to be discovered: plain unicast to the box's
// own HTTP server, which the firmware now brings up BEFORE it waits for us,
// exactly so it can still be reached while it's lost. Best-effort and quiet —
// a box that's offline, on old firmware, or on another network just fails.
async function adoptKnownBoxes(reason) {
  const ip = lanIp();
  if (!ip) return;
  const url = `http://${ip}:${config.listenPort}/upload`;
  for (const b of boxes.boxes) {
    try {
      // The adopt push doubles as token delivery (trust-on-first-use): a box
      // with no token stored accepts and saves this one, and only starts
      // enforcing afterwards. That's why a box can never lock us out — the
      // token it enforces is one we handed it.
      const headers = config.fleetToken ? { "X-Fleet-Token": config.fleetToken } : {};
      // Same push also hands over the reverse-channel URL, so a box learns
      // where to dial without a separate provisioning step. Defaults to this
      // machine on the LAN; set ws_url in config.json to a public relay
      // (e.g. a Tailscale Funnel wss:// address) to make boxes reachable from
      // networks that have no route to this LAN at all.
      headers["X-Ws-Url"] = config.wsUrl || `ws://${ip}:${config.listenPort}/ws`;
      // Target of the box's help QR (tap RST twice). Pushed rather than baked
      // into firmware so the guide can move hosts without reflashing. Omitted
      // when unset, which leaves the box on its built-in fallback.
      if (config.helpUrl) headers["X-Help-Url"] = config.helpUrl;
      const res = await fetch(`http://${b.ip}/server`, {
        method: "POST", body: url, headers, signal: AbortSignal.timeout(3000)
      });
      if (res.ok) console.log(`Pointed ${b.name} @ ${b.ip} at ${url} (${reason})`);
    } catch { /* offline / old firmware / different subnet — nothing to do */ }
  }
}

// The firmware image this server hands out, built by `idf.py build`.
const FIRMWARE_PATH = path.join(ESP_ROOT, "listen_v2", "build", "listen_v2.bin");

// Tell boxes to update themselves.
//
// Same shape as adoptKnownBoxes(): plain unicast to each box's own HTTP server,
// carrying a URL pointing back at GET /firmware here. The box downloads it into
// its spare app slot and reboots. `only` limits the push to one box id; without
// it every known box updates.
//
// Deliberately NOT automatic. Adoption runs every 60s because pointing a box at
// the right server is always safe; reflashing every box the moment a build
// appears is not — a bad build would roll through the entire fleet unattended.
// Firmware moves when a human asks for it.
async function pushFirmware(only) {
  const ip = lanIp();
  if (!ip) return { ok: [], failed: [], error: "no LAN address to serve firmware from" };
  const url = `http://${ip}:${config.listenPort}/firmware`;
  const targets = only ? boxes.boxes.filter((b) => b.id === only) : boxes.boxes;
  if (only && targets.length === 0) return { ok: [], failed: [], error: `no box with id ${only}` };

  const ok = [], failed = [];
  for (const b of targets) {
    try {
      const headers = config.fleetToken ? { "X-Fleet-Token": config.fleetToken } : {};
      const res = await fetch(`http://${b.ip}/ota`, {
        method: "POST", body: url, headers, signal: AbortSignal.timeout(5000)
      });
      // Only the request to START the update is confirmed here. The download,
      // the reboot and the health check all happen after this returns — watch
      // the box's own log, or /health, to see whether it came back.
      if (res.ok) { ok.push(b.name); console.log(`Told ${b.name} @ ${b.ip} to update from ${url}`); }
      else { failed.push(`${b.name}: HTTP ${res.status}`); }
    } catch (err) {
      failed.push(`${b.name}: ${err.message}`);
    }
  }
  return { ok, failed };
}

let bonjour = null;
function startMdnsAdvertiser() {
  // Some networks (seen on a campus/managed WiFi) block or drop multicast for
  // wireless clients. bonjour-service's underlying dgram socket then emits an
  // 'error' that, unhandled, crashes the ENTIRE process (took down STT/LLM/
  // TTS routing too, not just mDNS) — observed live: `EADDRNOTAVAIL
  // 224.0.0.251:5353`. mDNS is a convenience (lets a box use "mcp-core.local"
  // instead of a raw IP); it must never be able to take the whole server down.
  // process.env.MDNS_DISABLE=1 skips it outright for networks known to block it.
  if (process.env.MDNS_DISABLE === "1") {
    console.log("mDNS advertising disabled (MDNS_DISABLE=1) — use a raw IP in the box's provisioning form.");
    return;
  }
  try {
    bonjour = new Bonjour();
    bonjour.publish({ name: "mcp-core", type: "http", host: "mcp-core.local", port: config.listenPort });
    console.log("Advertising mcp-core.local via mDNS");
  } catch (err) {
    console.warn(`mDNS advertising failed to start (${err.message}) — continuing without it. ` +
                 "Boxes must use a raw IP in their provisioning form.");
  }
}

async function main() {
  setFleetToken(config.fleetToken);
  setWsFleetToken(config.fleetToken);
  // Shares the main HTTP server (one port, one thing to expose). Started before
  // listen() so no box can race the upgrade handler.
  startWsHub(server, { path: "/ws" });
  mcpClient = await connectToMcpServer();
  server.listen(config.listenPort, () => {
    console.log(`mcp-core listening on port ${config.listenPort}`);
    console.log(`Backends (priority order): ${config.priority.join(" -> ")}`);
    console.log(`Boxes: ${boxes.boxes.map((b) => `${b.name}@${b.ip}`).join(", ")}`);
    // Logged explicitly: this is the address pushed to every box, and a wrong
    // pick (e.g. a VPN interface) is otherwise invisible until the fleet breaks.
    console.log(`LAN address boxes are told to use: ${lanIp() || "(none found)"}`);
    console.log(`Fleet auth: ${config.fleetToken ? "ON" : "OFF (set fleet_token_env to enable)"}`
              + ` | /mcp auth: ${config.mcpToken ? "ON" : "OFF"}`);
    startMdnsAdvertiser();
    // Immediately, then on a slow timer: a box that booted before us, or that
    // is pointed at a stale address after this machine changed networks, gets
    // corrected without anyone typing an IP or re-provisioning. 60s is well
    // inside the firmware's own retry backoff, so a lost box recovers on its
    // own within about a minute of mcp-core being up.
    adoptKnownBoxes("startup");
    setInterval(() => adoptKnownBoxes("periodic"), 60000);
  });
  // Pre-warm the greeting cache so the FIRST wake tap of the day is fast too,
  // not just the second one. Failure here isn't fatal — getGreetingAudio()
  // will just retry on the first real wake — so don't crash startup over it.
  getGreetingAudio().catch((err) => console.warn(`(greeting pre-cache failed, will retry on first wake: ${err.message})`));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    bonjour?.unpublishAll(() => process.exit(0));
    // Fallback in case unpublishAll's callback never fires (e.g. no network).
    setTimeout(() => process.exit(0), 1000);
  });
}

main().catch((err) => {
  console.error("Fatal error starting mcp-core:", err.message);
  process.exit(1);
});
