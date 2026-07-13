#!/usr/bin/env node
import http from "node:http";
import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const PORT = process.env.BRIDGE_PORT || 3000;
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || path.join(homedir(), "esp", "voice-mcp-server", "dist", "index.js");
// Points at Ollama's OpenAI-compatible endpoint by default (no OpenClaw needed).
// Swap OPENCLAW_URL/MODEL/TOKEN later to point at real OpenClaw or any other
// OpenAI-compatible LLM — nothing else in this file needs to change.
const OPENCLAW_URL = process.env.OPENCLAW_URL || "http://localhost:11434/v1/chat/completions";
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || "llama3.2:3b";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || "";
const SYSTEM_PROMPT = process.env.OPENCLAW_SYSTEM_PROMPT ||
  "You are a helpful voice assistant having a spoken conversation. Keep replies " +
  "short and natural, like a real person talking, 1-2 sentences maximum. Do not " +
  "use lists, bullet points, or long explanations unless specifically asked. " +
  "Reply in the same language the person spoke in, without mixing in other languages.";
const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || "en";

let mcpClient = null;

async function connectToMcpServer() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    // StdioClientTransport does NOT inherit the parent's env by default —
    // explicitly pass it through, otherwise voice-mcp-server never sees
    // PLAY_AUDIO and always plays replies on the Mac in addition to the box.
    env: { ...process.env, PLAY_AUDIO: process.env.PLAY_AUDIO || "false" }
  });

  const client = new Client({ name: "bridge-server", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to voice-mcp-server at", MCP_SERVER_PATH);
  return client;
}

// Quiet / far-from-mic recordings transcribe as garbage unless normalized
// first (confirmed with the ESP32-S3-BOX-3's mic — same fix as the standalone
// pipeline used). "norm -3" brings the peak up to -3 dBFS.
function normalizeAudio(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("sox", [inPath, outPath, "norm", "-3"]);
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error("sox normalize failed, code " + code))));
  });
}

function extractStructured(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const textBlock = result.content && result.content.find((c) => c.type === "text");
  if (textBlock) {
    try {
      return JSON.parse(textBlock.text);
    } catch (e) {
      return { text: textBlock.text };
    }
  }
  return {};
}

async function transcribeViaMcp(audioFilePath) {
  const result = await mcpClient.callTool({
    name: "voice_transcribe_audio",
    arguments: { audio_file_path: audioFilePath, language: TRANSCRIBE_LANGUAGE }
  });
  if (result.isError) {
    throw new Error("MCP transcribe tool failed: " + JSON.stringify(result.content));
  }
  const data = extractStructured(result);
  return data.text || "";
}

async function speakViaMcp(text) {
  const result = await mcpClient.callTool({
    name: "voice_speak_text",
    arguments: { text, voice: "default" }
  });
  if (result.isError) {
    throw new Error("MCP speak tool failed: " + JSON.stringify(result.content));
  }
  const data = extractStructured(result);
  if (!data.audio_file_path) {
    throw new Error("MCP speak tool did not return an audio file path");
  }
  return await readFile(data.audio_file_path);
}

async function askOpenClaw(text) {
  const response = await fetch(OPENCLAW_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + OPENCLAW_TOKEN
    },
    body: JSON.stringify({
      model: OPENCLAW_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("OpenClaw returned status " + response.status + ": " + errText.slice(0, 300));
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mcpConnected: mcpClient !== null }));
    return;
  }

  if (req.method === "POST" && req.url === "/talk") {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const audioBuffer = Buffer.concat(chunks);

      if (audioBuffer.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No audio data received" }));
        return;
      }

      const t0 = Date.now();
      const tempDir = await mkdtemp(path.join(tmpdir(), "bridge-"));
      const rawPath = path.join(tempDir, "input_raw.wav");
      const audioPath = path.join(tempDir, "input.wav");
      await writeFile(rawPath, audioBuffer);
      await normalizeAudio(rawPath, audioPath);
      const t1 = Date.now();

      console.log("Received audio, transcribing via MCP...");
      const transcript = await transcribeViaMcp(audioPath);
      const t2 = Date.now();
      console.log("Transcript:", transcript, `[STT ${t2 - t1}ms]`);

      if (!transcript) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No speech detected" }));
        return;
      }

      console.log("Asking OpenClaw...");
      const reply = await askOpenClaw(transcript);
      const t3 = Date.now();
      console.log("Reply:", reply, `[LLM ${t3 - t2}ms]`);

      console.log("Generating speech via MCP...");
      const audioReply = await speakViaMcp(reply);
      const t4 = Date.now();
      console.log(`[TTS ${t4 - t3}ms] [total bridge ${t4 - t0}ms]`);

      res.writeHead(200, {
        "Content-Type": "audio/wav",   // MOSS-TTS returns WAV, not mp3
        "X-Transcript": encodeURIComponent(transcript),
        "X-Reply-Text": encodeURIComponent(reply),
        "X-Latency-Normalize-Ms": String(t1 - t0),
        "X-Latency-STT-Ms": String(t2 - t1),
        "X-Latency-LLM-Ms": String(t3 - t2),
        "X-Latency-TTS-Ms": String(t4 - t3),
        "X-Latency-Total-Ms": String(t4 - t0),
        // Absolute epoch-ms so the caller can build one unified stage
        // timeline (Node's Date.now() and Python's time.time()*1000 share
        // the same epoch on the same machine, so these line up directly).
        "X-Ts-Stt-Start": String(t1),
        "X-Ts-Stt-End": String(t2),
        "X-Ts-Llm-Start": String(t2),
        "X-Ts-Llm-End": String(t3),
        "X-Ts-Tts-Start": String(t3),
        "X-Ts-Tts-End": String(t4)
      });
      res.end(audioReply);
    } catch (err) {
      console.error("Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

async function main() {
  mcpClient = await connectToMcpServer();
  server.listen(PORT, () => {
    console.log("Bridge server listening on port " + PORT);
    console.log("POST audio (wav) to /talk to test");
  });
}

main().catch((err) => {
  console.error("Fatal error starting bridge server:", err.message);
  process.exit(1);
});
