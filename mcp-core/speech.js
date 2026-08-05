// Speech providers — the same "dispatch by type, not by name" shape as the
// backend router in config.js, applied to STT and TTS.
//
// WHY THIS EXISTS: the backend router was pluggable from day one, but the
// speech layer was welded to two local engines — whisper.cpp compiled from
// source, and a MOSS-TTS server on a fixed port. Swapping either meant editing
// TypeScript in voice-mcp-server, which put "use a hosted engine instead"
// firmly out of reach of a config edit. That was also the single biggest chunk
// of the install: the two steps the setup guide itself calls "genuinely
// difficult". A hosted deployment now needs neither.
//
// The local providers deliberately still route through voice-mcp-server over
// stdio rather than reimplementing whisper/MOSS here. That server is its own
// MCP surface (any client can use its tools, not just mcp-core), and the local
// path is the one that is known-good on hardware — this refactor must not put
// a scratch on it.
//
// Providers deal ONLY in "text <-> WAV bytes". Peak-normalizing the mic
// recording and downsampling replies to the box's mono speaker stay in
// server.js: those are box-format concerns, identical for every provider, and
// duplicating them per-provider is how they drift.
import { readFile } from "node:fs/promises";

// ---- STT ------------------------------------------------------------------

// Local whisper.cpp, via voice-mcp-server's existing MCP tool. Byte-for-byte
// the path that shipped — the model and bias prompt still travel as env vars
// on the stdio transport (see connectToMcpServer).
async function sttWhisperLocal(wavPath, cfg, { mcpClient, extractStructured }) {
  if (!mcpClient) {
    throw new Error("whisper_local needs voice-mcp-server, which is not running");
  }
  const result = await mcpClient.callTool({
    name: "voice_transcribe_audio",
    arguments: { audio_file_path: wavPath, language: cfg.language || "auto" }
  });
  if (result.isError) throw new Error("transcribe failed: " + JSON.stringify(result.content));
  return (extractStructured(result).text || "").trim();
}

// Any OpenAI-compatible /v1/audio/transcriptions endpoint — OpenAI, Groq,
// or a self-hosted faster-whisper. Multipart, because that is what the API
// takes; FormData/Blob are global in Node 18+, which is already the floor.
async function sttOpenAI(wavPath, cfg) {
  const audio = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  form.append("model", cfg.model || "whisper-1");
  // "auto" is this project's word for "don't force one"; the API expresses
  // that by omitting the field entirely, not by sending the string "auto".
  if (cfg.language && cfg.language !== "auto") form.append("language", cfg.language);
  if (cfg.prompt) form.append("prompt", cfg.prompt);

  const res = await fetch(cfg.url, {
    method: "POST",
    headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  if (!res.ok) {
    throw new Error(`STT endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  return (body.text || "").trim();
}

// ---- TTS ------------------------------------------------------------------

// Local MOSS-TTS, via voice-mcp-server. The tool writes a file and hands back
// its path (it can also play locally, which mcp-core suppresses with
// PLAY_AUDIO=false — the audio belongs on the box, not this machine's speaker).
async function ttsMossLocal(text, cfg, { mcpClient, extractStructured }) {
  if (!mcpClient) {
    throw new Error("moss_local needs voice-mcp-server, which is not running");
  }
  const result = await mcpClient.callTool({
    name: "voice_speak_text",
    arguments: { text, voice: cfg.voice || "default" }
  });
  if (result.isError) throw new Error("speak failed: " + JSON.stringify(result.content));
  const audioPath = extractStructured(result).audio_file_path;
  if (!audioPath) throw new Error("speak tool returned no audio file path");
  return await readFile(audioPath);
}

// Any OpenAI-compatible /v1/audio/speech endpoint. response_format=wav on
// purpose: the box plays PCM WAV, and asking for mp3 here would only mean
// decoding it back again before the downsample.
async function ttsOpenAI(text, cfg) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {})
    },
    body: JSON.stringify({
      model: cfg.model || "tts-1",
      input: text,
      voice: cfg.voice || "alloy",
      response_format: "wav"
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  if (!res.ok) {
    throw new Error(`TTS endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- registry --------------------------------------------------------------

// Adding an engine means adding one row here and one default URL in config.js.
// `local` marks the providers that need voice-mcp-server spawned — an
// all-hosted config skips that subprocess, and with it whisper.cpp and MOSS
// entirely.
export const STT_PROVIDERS = {
  whisper_local: { fn: sttWhisperLocal, local: true },
  openai_whisper: { fn: sttOpenAI, local: false }
};

export const TTS_PROVIDERS = {
  moss_local: { fn: ttsMossLocal, local: true },
  openai_tts: { fn: ttsOpenAI, local: false }
};

export const STT_TYPES = Object.keys(STT_PROVIDERS);
export const TTS_TYPES = Object.keys(TTS_PROVIDERS);

// True when either half needs the local engine subprocess.
export function needsLocalEngine(speech) {
  return (
    STT_PROVIDERS[speech.stt.type]?.local === true ||
    TTS_PROVIDERS[speech.tts.type]?.local === true
  );
}

// Bound once at startup so call sites stay `transcribe(path)` / `synthesize(text)`
// and never branch on provider type.
export function createSpeechEngine(speech, deps) {
  const stt = STT_PROVIDERS[speech.stt.type];
  const tts = TTS_PROVIDERS[speech.tts.type];
  return {
    transcribe: (wavPath) => stt.fn(wavPath, speech.stt, deps),
    synthesize: (text) => tts.fn(text, speech.tts, deps),
    describe: () => `stt=${speech.stt.type} tts=${speech.tts.type}`
  };
}
