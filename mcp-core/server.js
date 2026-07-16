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
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, ESP_ROOT } from "./config.js";
import { BoxRegistry, asciiOneline, sendCaption, sendAudio, sendDisplay } from "./boxes.js";

const config = loadConfig();
const boxes = new BoxRegistry(config.boxes);
const MCP_SERVER_PATH = path.join(ESP_ROOT, "voice-mcp-server", "dist", "index.js");
const LOG_PATH = process.env.INTERACTION_LOG || path.join(ESP_ROOT, "mcp-core", "interaction_log.jsonl");

// Confirm-before-LLM flow: after STT, the transcript is shown on the box and
// nothing reaches a backend until the customer tap-confirms (box POSTs
// /confirm). One pending turn per box; the box enforces its own shorter tap
// window (~8s), this longer window just garbage-collects stale turns.
const PENDING_WINDOW_S = 25;
const pendingByBox = new Map();   // box.name -> { transcript, expires, stages }

// Plain-chat history for the local_llm backend only (the agent keeps its own
// session state behind the webhook). Capped so a long chat can't grow the
// prompt without bound.
const llmHistoryByBox = new Map(); // box.name -> [{role, content}]
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

// ---- Backend router --------------------------------------------------------
// Both backends return the same shape:
//   { reply: string, display: [{path, body, headers}]|null, end_session: bool }

async function askAgent(box, text) {
  const res = await fetch(config.agent.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: box.name, text }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`agent webhook returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.reply) throw new Error("agent webhook returned no reply");
  return { reply: data.reply, display: data.display || null, end_session: !!data.end_session };
}

async function askLocalLlm(box, text) {
  let history = llmHistoryByBox.get(box.name) || [];
  history.push({ role: "user", content: text });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);

  const res = await fetch(config.localLlm.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + (config.localLlm.token || "")
    },
    body: JSON.stringify({
      model: config.localLlm.model,
      messages: [
        ...(config.localLlm.system_prompt ? [{ role: "system", content: config.localLlm.system_prompt }] : []),
        ...history
      ]
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`local_llm returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const reply = (data.choices?.[0]?.message?.content || "").trim();
  if (!reply) throw new Error("local_llm returned an empty reply");
  history.push({ role: "assistant", content: reply });
  llmHistoryByBox.set(box.name, history);
  return { reply, display: null, end_session: false };
}

// Try backends in config priority order; a failed backend falls through to
// the next one so a dead webhook degrades to plain chat instead of silence.
async function routeText(box, text) {
  let lastErr = null;
  for (const name of config.priority) {
    try {
      const t0 = nowMs();
      const result = name === "agent" ? await askAgent(box, text) : await askLocalLlm(box, text);
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
      pendingByBox.delete(box.name);
      record.outcome = "no_speech";
      return;
    }

    // Show what was heard and arm the box's tap-to-confirm window. No backend
    // is called until /confirm arrives.
    await sendCaption(box, transcript, { who: "TAP = SEND", confirm: true });
    pendingByBox.set(box.name, { transcript, expires: nowMs() + PENDING_WINDOW_S * 1000, stages });
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
  const pending = pendingByBox.get(box.name);
  if (!pending || nowMs() > pending.expires) {
    console.log(`[${box.name}] /confirm arrived but nothing pending (or expired)`);
    return { status: 410 };
  }
  pendingByBox.delete(box.name); // consume it — one confirm per turn
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

      // Sentence-chunked TTS pipeline: synthesize sentence N+1 while the box
      // plays sentence N. MOSS generates ~2.8x faster than realtime, so after
      // the first chunk there are no gaps — and first audio starts after ONE
      // sentence of TTS instead of the whole reply.
      const sentences = splitSentences(reply);
      let firstAudioMs = null;
      stages.tts_start = nowMs();
      let nextChunk = ttsForBox(sentences[0]);
      const playbackStart = nowMs();
      for (let i = 0; i < sentences.length; i++) {
        const wav = await nextChunk;
        if (i + 1 < sentences.length) nextChunk = ttsForBox(sentences[i + 1]);
        if (firstAudioMs === null) {
          firstAudioMs = nowMs() - confirmAt;
          // First chunk done = the latency-critical TTS span (later chunks
          // overlap playback and don't delay anything).
          stages.tts_end = nowMs();
        }
        await sendAudio(box, wav, { quiet: true, final: i + 1 === sentences.length });
      }
      const playbackEnd = nowMs();
      stages.playback_start = playbackStart;
      stages.playback_end = playbackEnd;

      // Backend-supplied display payloads (e.g. the order screen) take over
      // as the resting state. Passthrough only — the core never builds these.
      for (const entry of display || []) {
        await sendDisplay(box, entry);
      }

      if (end_session) llmHistoryByBox.delete(box.name);

      const totalMs = playbackEnd - confirmAt;
      console.log(`[${box.name}] ${sentences.length} chunks played. first audio at ${firstAudioMs}ms, done at ${totalMs}ms\n`);
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

  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(200, {
        status: "ok",
        mcpConnected: mcpClient !== null,
        backends: config.priority,
        boxes: boxes.boxes.map((b) => b.name)
      });
    }

    if (req.method === "POST" && req.url === "/upload") {
      const box = boxes.fromRequest(req);
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

    if (req.method === "POST" && req.url === "/confirm") {
      const box = boxes.fromRequest(req);
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

    // Manual session reset between customers / demo runs.
    if (req.method === "POST" && req.url === "/reset") {
      llmHistoryByBox.clear();
      pendingByBox.clear();
      if (config.priority.includes("agent")) {
        try {
          await fetch(new URL("/reset", config.agent.webhook_url), { method: "POST" });
        } catch { /* agent may be down; local state is cleared regardless */ }
      }
      return json(200, { ok: true });
    }

    json(404, { error: "Not found" });
  } catch (err) {
    console.error("Error:", err.message);
    if (!res.headersSent) json(500, { error: err.message });
  }
});

async function main() {
  mcpClient = await connectToMcpServer();
  server.listen(config.listenPort, () => {
    console.log(`mcp-core listening on port ${config.listenPort}`);
    console.log(`Backends (priority order): ${config.priority.join(" -> ")}`);
    console.log(`Boxes: ${boxes.boxes.map((b) => `${b.name}@${b.ip}`).join(", ")}`);
  });
}

main().catch((err) => {
  console.error("Fatal error starting mcp-core:", err.message);
  process.exit(1);
});
