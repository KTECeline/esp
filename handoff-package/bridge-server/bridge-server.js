#!/usr/bin/env node
import http from "node:http";
import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = process.env.BRIDGE_PORT || 3000;
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || path.join(homedir(), "voice-mcp-server", "dist", "index.js");
const OPENCLAW_URL = process.env.OPENCLAW_URL || "http://localhost:18789/v1/chat/completions";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || "";

let mcpClient = null;

async function connectToMcpServer() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH]
  });

  const client = new Client({ name: "bridge-server", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to voice-mcp-server at", MCP_SERVER_PATH);
  return client;
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
    arguments: { audio_file_path: audioFilePath, language: "auto" }
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
      model: "openclaw",
      messages: [{ role: "user", content: text }]
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

      const tempDir = await mkdtemp(path.join(tmpdir(), "bridge-"));
      const audioPath = path.join(tempDir, "input.wav");
      await writeFile(audioPath, audioBuffer);

      console.log("Received audio, transcribing via MCP...");
      const transcript = await transcribeViaMcp(audioPath);
      console.log("Transcript:", transcript);

      if (!transcript) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No speech detected" }));
        return;
      }

      console.log("Asking OpenClaw...");
      const reply = await askOpenClaw(transcript);
      console.log("Reply:", reply);

      console.log("Generating speech via MCP...");
      const audioReply = await speakViaMcp(reply);

      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "X-Transcript": encodeURIComponent(transcript),
        "X-Reply-Text": encodeURIComponent(reply)
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
