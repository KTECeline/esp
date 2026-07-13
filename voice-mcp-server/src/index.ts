#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const WHISPER_DIR = process.env.WHISPER_DIR || path.join(homedir(), "esp", "whisper.cpp");
const WHISPER_BIN = process.env.WHISPER_BIN || path.join(WHISPER_DIR, "build", "bin", "whisper-cli");
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(WHISPER_DIR, "models", "ggml-base.bin");
// Optional initial-prompt to bias decoding toward menu / Manglish vocabulary.
// WHISPER_PROMPT_FILE points at a text file; WHISPER_PROMPT is an inline string.
const WHISPER_PROMPT = (() => {
  if (process.env.WHISPER_PROMPT_FILE) {
    try {
      return readFileSync(process.env.WHISPER_PROMPT_FILE, "utf8").trim();
    } catch {
      return "";
    }
  }
  return process.env.WHISPER_PROMPT || "";
})();
const TTS_URL = process.env.TTS_URL || "http://localhost:8080/v1/audio/speech";
const PLAY_AUDIO = process.env.PLAY_AUDIO !== "false";

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error("Command failed (exit " + code + "): " + stderr.slice(0, 500)));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const server = new McpServer({
  name: "voice-mcp-server",
  version: "1.0.0"
});

const TranscribeInputSchema = z
  .object({
    audio_file_path: z
      .string()
      .min(1)
      .describe("Absolute path to a local audio file (wav recommended) to transcribe"),
    language: z
      .string()
      .default("auto")
      .describe("Language code to force (e.g. 'en', 'zh', 'ms'), or 'auto' to detect automatically")
  })
  .strict();

type TranscribeInput = z.infer<typeof TranscribeInputSchema>;

server.registerTool(
  "voice_transcribe_audio",
  {
    title: "Transcribe Audio to Text",
    description: "Converts a local audio file to text using a local Whisper model (whisper.cpp). Runs fully offline, no internet or external API required.\n\nArgs:\n  - audio_file_path (string): absolute path to the audio file (wav recommended, other ffmpeg-readable formats generally work)\n  - language (string): language code to force ('en', 'zh', 'ms', etc.), or 'auto' to auto-detect (default: 'auto')\n\nReturns:\n  { \"text\": string, \"language_hint\": string }\n\nExamples:\n  - Use when: you have a recorded voice message and need its text content\n  - Don't use when: input is already plain text\n\nError Handling:\n  - Returns an error if the audio file cannot be found or whisper-cli fails\n  - Returns an empty-result message if no speech was detected",
    inputSchema: TranscribeInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params: TranscribeInput) => {
    try {
      // NOTE: no "-ng" — we WANT the Metal GPU on Apple Silicon (M4). It cuts
      // encode time ~3.7x (672ms -> 180ms) and roughly halves total STT. Add
      // "-ng" back only if debugging a Metal-specific issue on another machine.
      const args = ["-m", WHISPER_MODEL, "-f", params.audio_file_path, "-nt", "-l", params.language || "auto"];
      if (WHISPER_PROMPT) {
        // carry-initial-prompt keeps the bias on every 30s window, not just the first
        args.push("--prompt", WHISPER_PROMPT, "--carry-initial-prompt");
      }

      const { stdout } = await runCommand(WHISPER_BIN, args);
      const text = stdout.replace(/\n/g, "").trim();

      if (!text) {
        return {
          content: [{ type: "text" as const, text: "No speech detected in the provided audio file." }]
        };
      }

      const output = { text, language_hint: params.language };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: "Error: transcription failed - " + message }],
        isError: true
      };
    }
  }
);
const SpeakInputSchema = z
  .object({
    text: z.string().min(1).max(2000).describe("The text to convert to speech and play out loud"),
    voice: z.string().default("default").describe("Voice/reference profile to use for synthesis (default: 'default')")
  })
  .strict();

type SpeakInput = z.infer<typeof SpeakInputSchema>;

server.registerTool(
  "voice_speak_text",
  {
    title: "Speak Text Out Loud",
    description: "Converts text to speech using a local MOSS-TTS server and plays it out loud on this machine's speaker. Requires the MOSS-TTS server to be running locally.\n\nArgs:\n  - text (string): the text to speak, 1-2000 characters\n  - voice (string): voice profile name (default: 'default')\n\nReturns:\n  { \"audio_file_path\": string, \"played\": boolean }\n\nExamples:\n  - Use when: you have a reply ready and need to say it out loud to the person\n  - Don't use when: you only need the text, not spoken audio\n\nError Handling:\n  - Returns an error if the MOSS-TTS server is unreachable or returns a non-audio response",
    inputSchema: SpeakInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params: SpeakInput) => {
    try {
      const response = await fetch(TTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tts-1", input: params.text, voice: params.voice })
      });

      if (!response.ok) {
        throw new Error("TTS server returned status " + response.status);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const tempDir = await mkdtemp(path.join(tmpdir(), "voice-mcp-"));
      // MOSS-TTS actually returns WAV bytes (server.py was patched to return
      // FileResponse of its .wav output) — name the file to match.
      const outputPath = path.join(tempDir, "reply.wav");
      await writeFile(outputPath, buffer);

      let played = false;
      if (PLAY_AUDIO) {
        await runCommand("afplay", [outputPath]);
        played = true;
      }

      const output = { audio_file_path: outputPath, played };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: "Error: speech generation failed - " + message }],
        isError: true
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("voice-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
