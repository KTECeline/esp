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
import { existsSync } from "node:fs";
import { tmpdir, homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Bonjour } from "bonjour-service";
import { loadConfig, loadRawConfig, writeConfig, ESP_ROOT } from "./config.js";
import { BoxRegistry, asciiOneline, sendCaption, sendAudio, sendDisplay, sendSessionOverride, sendSettings, setFleetToken, isCgnat } from "./boxes.js";
import { createMcpServer } from "./mcp-tools.js";
import { startWsHub, setWsFleetToken, wsHas } from "./ws-hub.js";
import { createSpeechEngine, needsLocalEngine } from "./speech.js";
import { captureJpeg, scanQr, describeDevice } from "./vision.js";
import { createSpcRegistry, probeSpcDevices } from "./spc.js";
import { BoxDiscovery } from "./discovery.js";
import { createSettings, SETTING_SCOPES } from "./settings.js";

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

// Behaviour knobs that used to be constants scattered across three languages —
// see settings.js for why these are a separate file from config.json. Changing
// one that lives on hardware pushes it there; pushSettingsToFleet is a hoisted
// declaration further down, so it is safe to reference before its definition.
const settings = createSettings({
  specPath: path.join(ESP_ROOT, "mcp-core", "settings-spec.json"),
  valuePath: process.env.MCP_CORE_SETTINGS || path.join(ESP_ROOT, "settings.json"),
  onChange: ({ scopes, revision }) => pushSettingsToFleet(scopes, revision)
});

// The OrangePi side of the fleet. Deliberately NOT merged into BoxRegistry —
// see the header of spc.js for why a box and a Pi stay separate transports.
// Empty unless config.json has a `devices` block, and an empty registry
// registers no spc_* tools at all.
const spc = createSpcRegistry(config.devices, () => settings.all());
// Listens for boxes announcing themselves on the LAN. Purely observational —
// what it finds is a candidate list, not the fleet; adopting one is an explicit
// authenticated action. Shares MDNS_DISABLE with the advertiser: a network that
// blocks multicast one way blocks it both ways.
const discovery = new BoxDiscovery({
  enabled: process.env.MDNS_DISABLE !== "1",
  // Read through a getter, not copied: discovery.stale_ms is compared against
  // on every list, so a change applies to the next request with no restart.
  // requery_ms is the exception — it arms one interval at startup — and the
  // catalog marks it as restart-required so nobody is told otherwise.
  staleMs: () => settings.get("discovery.stale_ms"),
  requeryMs: () => settings.get("discovery.requery_ms")
});
const MCP_SERVER_PATH = path.join(ESP_ROOT, "voice-mcp-server", "dist", "index.js");
const LOG_PATH = process.env.INTERACTION_LOG || path.join(ESP_ROOT, "mcp-core", "interaction_log.jsonl");

// esp_listen's plumbing. There is no firmware command for "start recording
// now" — the box decides, on a tap or a presence wake — so listening from the
// outside means waiting for the recording the box chooses to make, and taking
// a copy of the transcript as it goes past.
//
// A copy, not a handoff: the tap-to-confirm flow below is completely unaware
// this exists and still routes the turn to the backend exactly as before. An
// MCP client observing a live box must never swallow the turn out from under
// the customer standing in front of it.
const transcriptWaiters = new Map();   // box.id -> Set of resolve callbacks

// Resolves with the next transcript from this box, or null if the timeout wins.
// Never rejects: a timeout is silence, which is an ANSWER, not a failure.
function waitForTranscript(boxId, timeoutMs) {
  return new Promise((resolve) => {
    let waiters = transcriptWaiters.get(boxId);
    if (!waiters) {
      waiters = new Set();
      transcriptWaiters.set(boxId, waiters);
    }
    const deliver = (text) => { cleanup(); resolve(text); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    // Every exit path unregisters. Without this the set grows by one entry per
    // timed-out esp_listen call, and a long-running server slowly leaks a
    // closure for every question anyone ever asked and nobody answered.
    function cleanup() {
      clearTimeout(timer);
      waiters.delete(deliver);
      if (waiters.size === 0) transcriptWaiters.delete(boxId);
    }
    waiters.add(deliver);
  });
}

// Broadcast, not first-come: two clients both listening to the same box should
// both hear what was said. Iterated over a copy because each callback removes
// itself from the live set.
function notifyTranscript(boxId, text) {
  const waiters = transcriptWaiters.get(boxId);
  if (!waiters) return;
  for (const deliver of [...waiters]) deliver(text);
}

// Plain-chat history for the local_llm backend only (the agent keeps its own
// session state behind the webhook). Capped so a long chat can't grow the
// prompt without bound.
const llmHistoryByBox = new Map(); // box.id -> [{role, content}]

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
  // voice-mcp-server otherwise falls back to its own ~/esp/whisper.cpp guess,
  // which breaks the moment this tree lives anywhere else — it would still find
  // the model (we pass that explicitly above) but not the whisper-cli binary.
  // Handing it our resolved root keeps both halves on the same install.
  if (!env.WHISPER_DIR) env.WHISPER_DIR = path.join(ESP_ROOT, "whisper.cpp");
  // Lets speech.tts.url repoint local MOSS without editing voice-mcp-server.
  if (config.speech.tts.type === "moss_local" && config.speech.tts.url) {
    env.TTS_URL = config.speech.tts.url;
  }
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

// Which engines actually run is a config decision (see speech.js). mcpClient is
// read through a getter because it is assigned later, in main() — and only when
// a local provider is configured at all.
const USES_LOCAL_ENGINE = needsLocalEngine(config.speech);
const speech = createSpeechEngine(config.speech, {
  get mcpClient() { return mcpClient; },
  extractStructured,
  // Same three-tier fallback as greetingText() above: an untouched setting
  // (empty string) defers to config.json's boot-time value, so existing
  // installs that already customized speech.stt.language see no change
  // until something — the agent, or a human — actually sets speech.language.
  getLanguage: () => settings.get("speech.language") || config.speech.stt.language || "auto"
});

// Bound once so the tool layer never sees camera flags — null when no camera is
// configured, which is what keeps the vision tools unregistered.
const visionApi = config.vision
  ? {
      width: config.vision.width,
      height: config.vision.height,
      captureJpeg: () => captureJpeg(config.vision),
      scanQr: () => scanQr(config.vision)
    }
  : null;

// Quiet / far-from-mic recordings transcribe as garbage unless normalized
// first (confirmed with the ESP32-S3-BOX-3's mic). "norm -3" brings the peak
// up to -3 dBFS.
async function sttFromBuffer(audioBuffer) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-core-"));
  const rawPath = path.join(tempDir, "input_raw.wav");
  const normPath = path.join(tempDir, "input.wav");
  await writeFile(rawPath, audioBuffer);
  await runCommand("sox", [rawPath, normPath, "norm", "-3"]);
  // Normalization stays here rather than inside a provider: it's a property of
  // this microphone, so every engine wants it applied the same way.
  return await speech.transcribe(normPath);
}

// text -> 48kHz WAV (MOSS-TTS) -> 22.05kHz mono for the box. The box's
// speaker is mono, and sending full stereo over WiFi takes ~4x longer for
// identical-sounding audio.
async function ttsForBox(text) {
  const wav = await speech.synthesize(text);
  // Providers hand back WAV bytes at whatever rate they like; the box needs
  // 22.05kHz mono 16-bit. Staging through a temp file keeps this as one sox
  // invocation regardless of which engine produced the audio.
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-core-tts-"));
  const rawPath = path.join(tempDir, "reply_raw.wav");
  const boxPath = path.join(tempDir, "reply_box.wav");
  await writeFile(rawPath, wav);
  await runCommand("sox", [rawPath, "-r", "22050", "-c", "1", "-b", "16", boxPath]);
  return await readFile(boxPath);
}

// ---- Wake / greeting --------------------------------------------------------
// The greeting is synthesized ONCE and cached in memory — a live TTS call on
// every tap would blow the "1-2s from tap to greeting" latency target for no
// reason, since it's the same phrase every time. Overridable so this stays
// reusable for non-restaurant projects, per the README's design goal.
//
// Three sources, most specific first: the greeting.text setting (changeable at
// runtime, including by the agent), then config.json, then a neutral fallback
// so a fresh install still speaks.
const greetingText = () =>
  settings.get("greeting.text") || config.greetingText || "Hi! How can I help you today?";
// Keyed by the text it was synthesized from, not a bare boolean — that is what
// makes the cache self-invalidating when the greeting is changed. A stale WAV
// here would have the box cheerfully speaking the old greeting forever, with
// the settings endpoint reporting the new one: a change that appears to work
// and doesn't.
let cachedGreeting = { text: null, wav: null };
async function getGreetingAudio() {
  const text = greetingText();
  if (cachedGreeting.text !== text) {
    console.log(`Pre-caching greeting audio: "${text}"`);
    const t0 = nowMs();
    cachedGreeting = { text, wav: await ttsForBox(text) };
    console.log(`Greeting cached (${nowMs() - t0}ms, reused for every wake).`);
  }
  return cachedGreeting.wav;
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
  await sendAudio(box, wav, { replyText: greetingText() });
}

// ---- Backend router --------------------------------------------------------
// Both backends return the same shape:
//   { reply: string, display: [{path, body, headers}]|null, end_session: bool }

// Both take their own config, so any number of backends of the same type can
// coexist (agent + cloud_llm + local_llm + ...). Nothing is keyed by name.

// A webhook backend is a service on a port, and "it's only on localhost" stops
// being true the moment the host joins a tailnet — so it gets the same shared
// secret treatment as everything else. Configured exactly like an LLM backend's
// credential (token_env in config.json), and omitted entirely when none is set
// so existing installs keep working.
function webhookHeaders(bc) {
  const headers = { "Content-Type": "application/json" };
  if (bc.token) headers["Authorization"] = "Bearer " + bc.token;
  return headers;
}

async function askWebhook(name, bc, box, text) {
  const res = await fetch(bc.webhook_url, {
    method: "POST",
    headers: webhookHeaders(bc),
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
  // Read per call, so lowering it on a slow local model shortens the very next
  // prompt instead of only affecting conversations started after a restart.
  const historyMax = settings.get("chat.history_max");
  if (history.length > historyMax) history = history.slice(-historyMax);

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
// Shared by the upload-driven flow (handleUpload) and the esp_speak MCP tool —
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
    // The status is checked, not discarded. The box has a real reason to refuse
    // a clip — ws_client.c acks 503 when /play arrives while the previous one is
    // still finishing, and drops the audio on the floor. Ignoring that reported
    // "spoken: true" for speech nobody heard, which is the worst possible
    // failure for a voice tool: the model believes it has been understood and
    // keeps going. A box stuck in that state refuses every clip, so bail on the
    // first refusal instead of pushing the rest into a device discarding them.
    const status = await sendAudio(box, wav, { quiet: true, final: i + 1 === sentences.length });
    if (typeof status === "number" && (status < 200 || status > 299)) {
      throw new Error(
        `box refused audio chunk ${i + 1}/${sentences.length} with status ${status}` +
        (status === 503
          ? " — it was still finishing the previous clip. A box that refuses every clip is stuck; reboot it (tap RST)."
          : "")
      );
    }
  }
  return { chunks: sentences.length, firstAudioMs, ttsStart, ttsEnd, playbackStart, playbackEnd: nowMs() };
}

// Recording arrives -> STT -> straight to backend -> caption -> chunked TTS
// -> display. No tap-to-confirm gate any more: the box already gave the
// customer a chance to end the turn early (a screen tap while recording), so
// once the upload lands it goes straight through. Mishearings get corrected
// conversationally by the agent instead of a screen tap.
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
      record.outcome = "no_speech";
      return;
    }

    // Hand a copy to anyone waiting on esp_listen. Placed after the non-speech
    // filter so an MCP client sees the same "real speech" the box does, and
    // before the caption so a listening client is not held up by the box's
    // display round trip. Nothing is notified on the silence path above: a
    // caller waiting to hear something wants to keep waiting through a cough,
    // not be told "heard nothing" and give up while the customer is still
    // clearing their throat.
    notifyTranscript(box.id, transcript);

    // Show what was heard while the backend call is in flight.
    await sendCaption(box, transcript, { who: "YOU" });

    const turnAt = nowMs();
    console.log(`[${box.name}] -> backend: ${JSON.stringify(transcript)}`);
    stages.llm_start = nowMs();
    const { reply, display, end_session, backend, llm_ms } = await routeText(box, transcript);
    stages.llm_end = nowMs();
    console.log(`[${box.name}] ${backend}: ${JSON.stringify(reply)} [${llm_ms}ms]`);

    // Caption first: the customer READS the answer while the first sentence
    // is still being synthesized.
    await sendCaption(box, reply, { who: "BOX" });

    // Chunked TTS + playback (see speakToBox).
    const spoken = await speakToBox(box, reply, { sinceMs: turnAt });
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

    const totalMs = playbackEnd - turnAt;
    console.log(`[${box.name}] ${spoken.chunks} chunks played. first audio at ${firstAudioMs}ms, done at ${totalMs}ms\n`);
    record.reply = reply;
    record.backend = backend;
    record.display_entries = (display || []).length;
    record.stages_epoch_ms = stages;
    record.latency_ms = { llm: llm_ms, first_audio_after_upload: firstAudioMs, upload_to_done: totalMs };
    record.outcome = "done";
  } catch (err) {
    console.error(`[${box.name}] turn failed: ${err.message}`);
    record.error = err.message;
    await sendCaption(box, "SORRY - SOMETHING BROKE, TRY AGAIN", { who: "BOX" });
  } finally {
    await logInteraction(record);
  }
}

// ---- Pay flow ---------------------------------------------------------------
// Reached when the customer taps END + PAY on the order screen. This is the
// touch equivalent of speaking a confirmation, and it exists because the spoken
// path could not be made reliable: "yes" is the shortest utterance of the whole
// conversation, and sub-second clips come back from Whisper as "[BLANK_AUDIO]".
// A tap cannot be misheard.

// How long to watch the counter camera for a payment QR, how often to look,
// and how long PAID sits on screen afterwards — all runtime settings now
// (pay.*), because the right answer depends on the queue, not on the code.
// Read at each use so a change mid-service applies to the next customer.

// The payment prompt reuses the order screen's line protocol — NOTE replaces
// the itemized rows, so no new firmware screen was needed for this.
function payScreen(title, note, total) {
  const lines = [`TITLE|${title}`, `NOTE|${note}`];
  if (total) lines.push(`TOTAL|${total}`);
  return { path: "/order", body: lines.join("\n") };
}

// Webhook backends keep their own per-session state keyed by the box id we pass
// as session_id. Used by both /session-end and the end of the pay flow.
async function resetBackendSessions(box) {
  for (const name of config.priority) {
    const bc = config.backends[name];
    if (bc.type !== "webhook") continue;
    try {
      await fetch(new URL("/reset", bc.webhook_url), {
        method: "POST",
        headers: webhookHeaders(bc),
        body: JSON.stringify({ session_id: box.id }),
        signal: AbortSignal.timeout(3000)
      });
    } catch { /* backend may be down; local state is cleared regardless */ }
  }
}

// Watch the counter camera until a QR decodes or we run out of patience. Errors
// from a single frame are non-fatal (the webcam can be transiently busy) —
// scanQr already retries internally, and giving up on one bad frame would end
// the flow for no reason.
async function waitForPaymentQr(box) {
  // Snapshotted for the duration of one scan: re-reading the deadline every
  // loop would let a mid-flow change move the finish line under a customer who
  // is already holding their phone up.
  const scanIntervalMs = settings.get("pay.scan_interval_ms");
  const deadline = nowMs() + settings.get("pay.scan_timeout_ms");
  while (nowMs() < deadline) {
    try {
      const found = await scanQr(config.vision);
      if (found) return found;
    } catch (err) {
      console.warn(`       (QR scan frame failed: ${err.message})`);
    }
    await new Promise((r) => setTimeout(r, scanIntervalMs));
  }
  return null;
}

async function handleOrderAction(box, action) {
  if (action !== "end") return { status: 400 };

  // Finalize against the first webhook backend that has an open order. The
  // order is already priced from menu truth there; the core deliberately does
  // not compute or re-derive it.
  let finalized = null;
  for (const name of config.priority) {
    const bc = config.backends[name];
    if (bc.type !== "webhook") continue;
    try {
      const res = await fetch(new URL("/finalize", bc.webhook_url), {
        method: "POST",
        headers: webhookHeaders(bc),
        body: JSON.stringify({ session_id: box.id }),
        signal: AbortSignal.timeout(5000)
      });
      if (res.status === 409) continue;          // nothing open on this backend
      if (res.ok) { finalized = await res.json(); break; }
    } catch (err) {
      console.warn(`[${box.name}] finalize via ${name} failed: ${err.message}`);
    }
  }
  if (!finalized) {
    console.log(`[${box.name}] END + PAY but no open order to finalize`);
    return { status: 409 };
  }

  const total = finalized.order?.total != null
    ? `${finalized.order.currency || "RM"}${finalized.order.total.toFixed(2)}`
    : null;
  console.log(`[${box.name}] order finalized by touch, total ${total} — payment prompt up`);

  // Ack the box first, then run the payment watch in the background: the scan
  // can take a minute and a half, and the box's HTTP client times out in 8s.
  (async () => {
    const record = { timestamp: new Date().toISOString(), box: box.name,
                     outcome: "awaiting_payment", total };
    try {
      if (!config.vision) {
        // No camera configured: show the prompt and leave it to staff. Still a
        // complete flow, just without the automatic PAID confirmation.
        await sendDisplay(box, payScreen("PAY NOW", "PAY AT THE COUNTER", total));
        record.outcome = "awaiting_payment_no_camera";
        return;
      }
      await sendDisplay(box, payScreen("PAY NOW", "POINT YOUR PAYMENT QR CODE TO THE CAMERA", total));
      const qr = await waitForPaymentQr(box);
      if (qr) {
        console.log(`[${box.name}] payment QR read (${qr.slice(0, 40)}) — marking paid`);
        await sendDisplay(box, payScreen("PAID", "THANK YOU - SEE YOU AGAIN", total));
        record.outcome = "paid";
        record.qr = qr.slice(0, 200);
      } else {
        console.log(`[${box.name}] no payment QR within ${settings.get("pay.scan_timeout_ms") / 1000}s`);
        await sendDisplay(box, payScreen("PAY AT COUNTER", "SORRY - NO QR DETECTED", total));
        record.outcome = "payment_timeout";
      }
      // Either way the customer is done at this box. Let the closing screen sit
      // long enough to read, then hand the box to the next person.
      await new Promise((r) => setTimeout(r, settings.get("pay.paid_linger_ms")));
      llmHistoryByBox.delete(box.id);
      await resetBackendSessions(box);
      await sendSessionOverride(box, false);
    } catch (err) {
      console.error(`[${box.name}] pay flow failed: ${err.message}`);
      record.error = err.message;
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
      const mcp = createMcpServer({
        boxes, speakToBox, vision: visionApi, spc,
        // Both listen tools transcribe through the SAME function the box flow
        // uses, so a Pi's microphone and a box's microphone get the identical
        // model, the identical normalization and the identical Manglish bias
        // prompt. Two devices in one restaurant disagreeing about what a
        // customer said would be a bug nobody could reproduce.
        transcribe: sttFromBuffer,
        waitForTranscript,
        // The store itself, not a copy: a tool that changed a snapshot would
        // report success and change nothing.
        settings,
        // So fleet_settings_list can say whether a change actually landed on
        // the hardware rather than only in this process.
        settingsSync: () => boxes.boxes.map((b) => ({
          id: b.id, name: b.name, in_sync: b.settingsRev === settings.revision
        }))
      });
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
      // `speech` reports the configured engines; mcpConnected is about the local
      // engine subprocess specifically, so it is null — not false — when no local
      // provider is configured. false would read as "the thing that should be up
      // is down", which for an all-hosted deployment is simply wrong.
      const base = {
        status: "ok",
        mcpConnected: USES_LOCAL_ENGINE ? mcpClient !== null : null,
        speech: { stt: config.speech.stt.type, tts: config.speech.tts.type },
        backends: config.priority
      };
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

    // ---- Runtime settings ---------------------------------------------------
    // The whole point of settings.js, over HTTP. Four routes:
    //
    //   GET   /settings              everything, with type/range/meaning
    //   GET   /settings?scope=box    one scope's plain values — what hardware polls
    //   PATCH /settings              change some keys
    //   POST  /settings/reset        drop overrides, back to shipped defaults
    //
    // Authenticated with the FLEET token, not the MCP one, because both
    // audiences need it: an agent tuning a timeout, and a box or a Pi fetching
    // what it should be running after a reboot. Anyone who can drive the
    // hardware can already do far more than change a timeout, so a third
    // credential would be ceremony rather than security.
    if (req.url === "/settings" || req.url.startsWith("/settings?")) {
      if (!fleetAuthed()) return denyFleet();
      const scope = new URL(req.url, "http://x").searchParams.get("scope");
      if (scope && !SETTING_SCOPES.includes(scope)) {
        return json(400, { error: `unknown scope "${scope}" — valid: ${SETTING_SCOPES.join(", ")}` });
      }

      if (req.method === "GET") {
        // With a scope: the lean {revision, settings} payload hardware applies
        // directly. Without: the full catalog, which is what a human or a model
        // needs before deciding what to change.
        if (scope) return json(200, settings.payload(scope));
        return json(200, {
          revision: settings.revision,
          spec_version: settings.specVersion,
          settings: settings.describe(),
          // So a caller can see at a glance whether a change it made has
          // actually reached the hardware, without a second request.
          boxes: boxes.boxes.map((b) => ({
            id: b.id, name: b.name,
            settings_rev: b.settingsRev,
            in_sync: b.settingsRev === settings.revision
          }))
        });
      }

      if (req.method === "PATCH" || req.method === "POST") {
        let patch;
        try {
          patch = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        } catch (err) {
          return json(400, { error: `body must be JSON of { key: value }: ${err.message}` });
        }
        // Accept both {settings:{...}} and a bare {...}, since the GET reply
        // wraps values in `settings` and round-tripping it is the obvious move.
        if (patch && typeof patch === "object" && patch.settings && typeof patch.settings === "object") {
          patch = patch.settings;
        }
        try {
          const result = await settings.set(patch, { actor: "HTTP" });
          return json(200, { revision: result.revision, changed: result.changed,
                             unchanged: result.unchanged ?? [] });
        } catch (err) {
          // 400, not 500: a rejected value is the caller's mistake, and the
          // message names the key and its range so it can be fixed and retried.
          return json(400, { error: err.message });
        }
      }
      return json(405, { error: "use GET to read settings, PATCH to change them" });
    }

    if (req.method === "POST" && req.url === "/settings/reset") {
      if (!fleetAuthed()) return denyFleet();
      let body = {};
      try {
        body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      } catch (err) {
        return json(400, { error: `body must be JSON of { keys: [...] } or { all: true }: ${err.message}` });
      }
      // Deliberately no "reset everything" by omission: an empty body resetting
      // the entire fleet's tuning would be a very easy accident to have.
      if (!body.all && !Array.isArray(body.keys)) {
        return json(400, { error: 'send { "keys": ["a.b"] } for specific keys, or { "all": true } to clear every override' });
      }
      try {
        const result = await settings.reset(body.all ? "all" : body.keys, { actor: "HTTP" });
        return json(200, { revision: result.revision, changed: result.changed });
      } catch (err) {
        return json(400, { error: err.message });
      }
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
      // anything, it moves straight into playing the greeting once the Mac
      // pushes it, which happens async below.
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

    // Order-screen button press. Body is the action ("end"); ADD ORDER is
    // handled entirely on the box, since "keep the order open and go back to
    // idle" needs nothing from the server.
    if (req.method === "POST" && req.url === "/order-action") {
      if (!fleetAuthed()) return denyFleet();
      const box = boxes.fromId(req);
      if (!box) {
        return json(400, { error: "missing X-Box-Id header — flash current firmware" });
      }
      const action = (await readBody(req)).toString("utf8").trim();
      const { status } = await handleOrderAction(box, action);
      return json(status, status === 200 ? { ok: true } : { error: "no open order" });
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
      const { box_id, name, ip, fw, fw_sha, slot, pending_verify, settings_rev } = parsed;
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

      // A box that just rebooted is the most likely one to be holding stale
      // tuning, and this is the earliest moment we hear from it. Recording what
      // it says it has lets the sweep decide, and pushing right now — rather
      // than waiting up to a minute for the sweep — means the first customer of
      // the day gets the tuned box, not yesterday's.
      const b = boxes.byId(box_id);
      if (b) {
        b.settingsRev = Number.isInteger(settings_rev) ? settings_rev : null;
        if (b.settingsRev !== settings.revision) {
          // Deliberately not awaited: the box is blocked on this response
          // during its own boot, and it cannot accept the settings push until
          // it has finished handling this request.
          sendSettings(b, settings.payload("box"))
            .then(() => { b.settingsRev = settings.revision; })
            .catch(() => { /* the sweep retries */ });
        }
      }
      return json(200, { ok: true, box_id, name: name || box_id, ip, action,
                         settings_rev: settings.revision });
    }

    // What boxes are on this network right now, from mDNS. The complement of
    // /register: /register is a box that already knows where we are announcing
    // itself, this is finding the ones that DON'T. Read-only — it touches no
    // hardware — but still authenticated, because the reply is an inventory of
    // every box on the LAN with its address, which is precisely the target list
    // for an attack on the fleet (same reasoning as /health's box list).
    if (req.method === "GET" && req.url === "/discover") {
      if (!fleetAuthed()) return denyFleet();
      const known = new Set(boxes.boxes.map((b) => b.id));
      const found = discovery.list(known);
      return json(200, {
        // Distinguishes "discovery is broken on this network" from "discovery
        // works and there is nothing here" — identical-looking empty lists that
        // call for completely different next steps. Multicast being dropped is
        // the normal case on the managed WiFi this project keeps meeting.
        mdns: discovery.enabled ? (discovery.error ? "failed" : "ok") : "disabled",
        mdnsError: discovery.error,
        boxes: found,
        // Echoed so the setup page can show what a box WOULD be pointed at, and
        // so "why did adopt fail" is answerable without reading server logs.
        serverUrl: lanIp() ? `http://${lanIp()}:${config.listenPort}/upload` : null
      });
    }

    // Take a discovered box into the fleet: add it to the registry and tell it
    // to talk to us. Deliberately one step — a box in config.json that has not
    // been pointed here is a box that shows NO SERVER, which is the exact
    // half-configured state this whole feature exists to remove.
    //
    // `ip` may be supplied directly, so a box on a subnet where multicast never
    // arrives can still be added by hand from the same page.
    if (req.method === "POST" && req.url === "/adopt") {
      if (!fleetAuthed()) return denyFleet();
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req)).toString("utf8"));
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const { box_id, ip, name } = parsed;
      if (typeof box_id !== "string" || !box_id) {
        return json(400, { error: "box_id is required" });
      }
      // Trust the discovered address over a client-supplied one when we have
      // it: the page's copy can be a stale render, mDNS is what answered most
      // recently. A box not in the discovery cache must supply its own ip.
      const discovered = discovery.list().find((b) => b.id === box_id);
      const addr = discovered?.ip || (typeof ip === "string" ? ip.trim() : "");
      if (!addr) {
        return json(404, { error: `box "${box_id}" is not visible on the network — supply its ip explicitly` });
      }
      if (isCgnat(addr)) {
        // The lanIp() landmine from the other direction. A box entry must hold
        // a LAN address because every push dials it directly; storing a tunnel
        // address would break /play, /caption and /order for that box until
        // someone edited config.json by hand.
        return json(400, { error: `${addr} is a tailnet/CGNAT address — a box entry must hold its LAN address` });
      }
      // Name precedence: explicit request body, then whatever the box itself
      // announced over mDNS, then upsert()'s own fallback to the id. A client
      // that just clicks "Add" on the setup page sends no name at all, and
      // without this the box's real TXT-advertised name is thrown away for
      // its id — which is exactly the "192.168.1.x" opacity this feature
      // exists to fix.
      const resolvedName = (typeof name === "string" && name) ? name : (discovered?.name || null);
      const action = boxes.upsert(box_id, resolvedName, addr);
      const box = boxes.byId(box_id);
      try {
        const serverUrl = await pointBoxAtUs(box, "adopt");
        console.log(`Box adopted: ${box_id} @ ${addr} [${action}]`);
        return json(200, { ok: true, box_id, name: box.name, ip: addr, action, serverUrl });
      } catch (err) {
        // The registry entry stays: the box is real and was seen, the push just
        // didn't land (asleep mid-recording, old firmware without /server). The
        // 60s adoption sweep will keep retrying it, so reporting a hard failure
        // and rolling back would be less true than saying what happened.
        return json(502, {
          ok: false, box_id, ip: addr, action,
          error: `added to the fleet, but could not reach it to point it here: ${err.message}. ` +
                 "It will be retried automatically every 60s."
        });
      }
    }

    // Drop a box from the fleet. The registry is persisted to config.json, so
    // without this a box adopted by mistake (or a decommissioned one) can only
    // be removed by hand-editing a file the server rewrites underneath you.
    if (req.method === "POST" && req.url === "/forget") {
      if (!fleetAuthed()) return denyFleet();
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req)).toString("utf8"));
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const { box_id } = parsed;
      if (typeof box_id !== "string" || !box_id) {
        return json(400, { error: "box_id is required" });
      }
      if (!boxes.remove(box_id)) return json(404, { error: `no box "${box_id}" in the fleet` });
      console.log(`Box forgotten: ${box_id}`);
      // Note what is NOT done here: the box keeps its stored server URL and
      // will go on uploading to us, and fromId() would auto-register it again
      // on its next request. Removing it from our list is not the same as
      // telling it to forget us — that needs a re-provision at the hardware.
      return json(200, { ok: true, box_id });
    }

    // The setup page itself. Open on purpose: it is a static shell containing
    // no fleet data and no secrets — every byte it displays comes from the
    // authenticated endpoints above, which it calls with a token the operator
    // supplies. Serving it openly means someone locked out can still reach the
    // screen that explains what to do.
    if (req.method === "GET" && (req.url === "/setup" || req.url === "/setup/")) {
      let page;
      try {
        page = await readFile(path.join(ESP_ROOT, "mcp-core", "setup.html"));
      } catch {
        return json(404, { error: "setup.html is missing from this install" });
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
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
      // Webhook backends keep their own per-session state, keyed by the same
      // box id we pass as session_id. Ask them to drop just this one.
      await resetBackendSessions(box);
      console.log(`[${box.name}] session ended (customer left) — conversation reset`);
      return json(200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/reset") {
      if (!fleetAuthed()) return denyFleet();
      llmHistoryByBox.clear();
      // Reset every webhook backend, not just one called "agent" — backends are
      // arbitrarily named now, and only webhooks hold their own session state.
      for (const name of config.priority) {
        const bc = config.backends[name];
        if (bc.type !== "webhook") continue;
        try {
          await fetch(new URL("/reset", bc.webhook_url), {
            method: "POST",
            headers: webhookHeaders(bc)
          });
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
// Inside a container, every address networkInterfaces() reports belongs to a
// virtual network the boxes cannot route to (Docker's default bridge hands out
// 172.17.x.x). That address is not merely useless: adoptKnownBoxes() pushes it
// to every box every 60s and the box PERSISTS it, so one containerized start
// would strand the whole fleet until each box is physically re-provisioned —
// the same failure the CGNAT filter exists to prevent, arriving through a
// different door.
//
// Blanket-filtering 172.16/12 would be wrong (plenty of real LANs live there),
// so this detects the container instead and refuses to guess. Set `lan_ip` in
// config.json to the HOST's LAN address, or run with host networking.
const IN_CONTAINER =
  process.env.MCP_CORE_IN_CONTAINER === "1" || existsSync("/.dockerenv");
let warnedNoLanIp = false;

function lanIp() {
  // Explicit override always wins — for when the heuristics below guess wrong.
  if (config.lanIp) return config.lanIp;

  if (IN_CONTAINER) {
    if (!warnedNoLanIp) {
      warnedNoLanIp = true;
      console.error(
        "Running in a container with no LAN address configured.\n" +
        "  Refusing to guess: the container's own address is unroutable from the boxes,\n" +
        "  and adoption would persist it on each box until it is re-provisioned by hand.\n" +
        "  Fix, in order of preference:\n" +
        "    Linux            run with --network host (mDNS works too)\n" +
        "    macOS            LAN_IP=$(ipconfig getifaddr en0) docker compose up\n" +
        "    Windows (PS)     $env:LAN_IP=(...IPv4 address...); docker compose up\n" +
        "    any              set \"lan_ip\" in config.json (pins it to one machine)\n" +
        "  Until then, box adoption, the reverse-channel URL and OTA are disabled."
      );
    }
    return null;   // adoptKnownBoxes()/pushFirmware() both no-op safely on null
  }

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
// One box's worth of that push. Split out so the manual adopt path (POST
// /adopt, from the setup page) delivers byte-identical headers to the periodic
// sweep — the token hand-off, the reverse-channel URL and the help URL are easy
// to half-remember at a second call site, and a box adopted with any of them
// missing fails later in ways that look like unrelated bugs.
//
// Throws on failure rather than swallowing, so an operator who just clicked
// "Add" gets told why; the periodic sweep catches and ignores.
async function pointBoxAtUs(box, reason) {
  const ip = lanIp();
  if (!ip) throw new Error("no usable LAN address for this machine (see startup log; set lan_ip in config.json)");
  const url = `http://${ip}:${config.listenPort}/upload`;
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
  const res = await fetch(`http://${box.ip}/server`, {
    method: "POST", body: url, headers, signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) throw new Error(`box answered HTTP ${res.status}`);
  console.log(`Pointed ${box.name} @ ${box.ip} at ${url} (${reason})`);
  return url;
}

async function adoptKnownBoxes(reason) {
  if (!lanIp()) return;
  for (const b of boxes.boxes) {
    try {
      await pointBoxAtUs(b, reason);
    } catch { /* offline / old firmware / different subnet — nothing to do */ }
  }
}

// ---- Getting a changed setting onto the hardware ---------------------------
// server-scoped keys need none of this: they are read straight out of the store
// at the point of use. box and device keys live on other machines, so a change
// here is only half of the change.
//
// Best-effort by design, and the reason is the same one that made adoption a
// repeating sweep rather than a one-shot: at any moment some box is asleep,
// mid-recording, or on a network we cannot reach. Refusing the change because
// one box out of five did not answer would mean the fleet can only be tuned
// when it is perfectly healthy. So the store is the source of truth, the push
// is an optimisation, and settingsSweep() below re-delivers to whoever missed
// it. Each box also asks for the current settings when it registers, which
// covers a box that was simply switched off for the whole conversation.
async function pushSettingsToBoxes(reason) {
  const payload = settings.payload("box");
  const results = [];
  for (const b of boxes.boxes) {
    try {
      await sendSettings(b, payload);
      b.settingsRev = payload.revision;
      results.push({ box: b.id, ok: true });
    } catch (err) {
      // Cleared, not left stale: a failed push means we no longer know what
      // this box is running, and the sweep must retry it.
      b.settingsRev = null;
      results.push({ box: b.id, ok: false, error: err.message });
      console.warn(`(settings push to ${b.name} failed: ${err.message} — will retry)`);
    }
  }
  if (results.length) {
    const ok = results.filter((r) => r.ok).length;
    console.log(`Settings rev ${payload.revision} pushed to ${ok}/${results.length} boxes (${reason})`);
  }
  return results;
}

async function pushSettingsToDevices(reason) {
  const payload = settings.payload("device");
  const results = [];
  for (const d of spc.devices) {
    try {
      await spc.pushSettings(d, payload);
      results.push({ device: d.id, ok: true });
    } catch (err) {
      results.push({ device: d.id, ok: false, error: err.message });
      console.warn(`(settings push to ${d.id} failed: ${err.message} — will retry)`);
    }
  }
  if (results.length) {
    const ok = results.filter((r) => r.ok).length;
    console.log(`Settings rev ${payload.revision} pushed to ${ok}/${results.length} devices (${reason})`);
  }
  return results;
}

// The store's onChange hook. Only the scopes that actually changed are pushed,
// so tuning a pay timeout does not wake every box on the network.
async function pushSettingsToFleet(scopes, revision) {
  if (scopes.includes("box")) await pushSettingsToBoxes(`rev ${revision}`);
  if (scopes.includes("device")) await pushSettingsToDevices(`rev ${revision}`);
}

// Catch-up for hardware that was unreachable when a change landed. Cheap: a box
// already on the current revision is skipped entirely, so a healthy idle fleet
// costs nothing per round.
async function settingsSweep() {
  const stale = boxes.boxes.filter((b) => b.settingsRev !== settings.revision);
  if (stale.length === 0) return;
  const payload = settings.payload("box");
  for (const b of stale) {
    try {
      await sendSettings(b, payload);
      b.settingsRev = payload.revision;
      console.log(`Settings rev ${payload.revision} caught ${b.name} up`);
    } catch { /* still unreachable — try again next round */ }
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
  startWsHub(server, {
    path: "/ws",
    throttleSettings: () => ({
      windowMs: settings.get("wshub.fail_window_ms"),
      max: settings.get("wshub.fail_max")
    })
  });
  // The whole point of the hosted providers: an all-hosted config never spawns
  // voice-mcp-server, so that deployment needs neither whisper.cpp compiled nor
  // MOSS-TTS installed — the two steps the setup guide calls genuinely hard.
  if (USES_LOCAL_ENGINE) {
    mcpClient = await connectToMcpServer();
  } else {
    console.log("Speech: all providers are hosted — voice-mcp-server not started.");
  }
  server.listen(config.listenPort, () => {
    console.log(`mcp-core listening on port ${config.listenPort}`);
    // Every relative path in config.json hangs off this, so a wrong root turns
    // into "model not found" three layers down. Same reason lanIp is logged.
    console.log(`Project root: ${ESP_ROOT}  (config: ${config.configPath})`);
    console.log(`Backends (priority order): ${config.priority.join(" -> ")}`);
    console.log(`Speech: ${speech.describe()}`);
    if (!config.vision) {
      console.log("Camera: none configured (vision tools not registered)");
    } else {
      // Resolved by NAME, not just echoed back: "device 1" tells you nothing
      // about which lens is pointed where, and pointing at the wrong camera is
      // a privacy problem rather than something you notice in a log later.
      describeDevice(config.vision).then((d) => {
        console.log(`Camera: "${d.name}" @ ${config.vision.width}x${config.vision.height}` +
                    ` (esp_look, esp_scan_qr)`);
        if (d.warning) console.warn(`  WARNING: ${d.warning}`);
      }).catch(() => {
        console.log(`Camera: device ${config.vision.device} (could not enumerate to confirm which)`);
      });
    }
    console.log(`Boxes: ${boxes.boxes.map((b) => `${b.name}@${b.ip}`).join(", ")}`);
    if (spc.devices.length === 0) {
      console.log("SPC devices: none configured (no spc_* tools registered)");
    } else {
      // Fire-and-forget: a Pi that is powered off must not hold up the server
      // that the boxes are already trying to reach. The probe only prints.
      probeSpcDevices(spc).catch((err) => console.warn(`SPC probe failed: ${err.message}`));
    }
    // Logged explicitly: this is the address pushed to every box, and a wrong
    // pick (e.g. a VPN interface) is otherwise invisible until the fleet breaks.
    console.log(`LAN address boxes are told to use: ${lanIp() || "(none found)"}`);
    console.log(`Fleet auth: ${config.fleetToken ? "ON" : "OFF (set fleet_token_env to enable)"}`
              + ` | /mcp auth: ${config.mcpToken ? "ON" : "OFF"}`);
    startMdnsAdvertiser();
    // Both directions of mDNS start together: we announce ourselves so boxes
    // can find us, and listen so we can find them.
    discovery.start();
    console.log(`Setup page: http://${lanIp() || "localhost"}:${config.listenPort}/setup`);
    // Immediately, then on a slow timer: a box that booted before us, or that
    // is pointed at a stale address after this machine changed networks, gets
    // corrected without anyone typing an IP or re-provisioning. 60s is well
    // inside the firmware's own retry backoff, so a lost box recovers on its
    // own within about a minute of mcp-core being up.
    adoptKnownBoxes("startup");
    const sweepMs = settings.get("adopt.sweep_ms");
    setInterval(() => adoptKnownBoxes("periodic"), sweepMs);
    // Runtime settings ride the same sweep. A box that was asleep when a knob
    // changed is caught up here rather than running yesterday's tuning until
    // someone notices; a box already on the current revision costs nothing.
    console.log(`Runtime settings: ${Object.keys(settings.all()).length} knobs, ` +
                `rev ${settings.revision} — GET /settings`);
    pushSettingsToBoxes("startup").catch(() => {});
    pushSettingsToDevices("startup").catch(() => {});
    setInterval(() => { settingsSweep().catch(() => {}); }, sweepMs);
  });
  // Pre-warm the greeting cache so the FIRST wake tap of the day is fast too,
  // not just the second one. Failure here isn't fatal — getGreetingAudio()
  // will just retry on the first real wake — so don't crash startup over it.
  getGreetingAudio().catch((err) => console.warn(`(greeting pre-cache failed, will retry on first wake: ${err.message})`));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    discovery.stop();
    bonjour?.unpublishAll(() => process.exit(0));
    // Fallback in case unpublishAll's callback never fires (e.g. no network).
    setTimeout(() => process.exit(0), 1000);
  });
}

main().catch((err) => {
  console.error("Fatal error starting mcp-core:", err.message);
  process.exit(1);
});
