// Contract tests for the speech provider layer.
//
// These cover the seam that config.json is allowed to move: swapping an engine
// must not change what the rest of mcp-core sees. The local providers are the
// known-good production path, so their assertions are deliberately about the
// EXACT arguments voice-mcp-server receives — that is what a refactor here is
// most likely to break silently.
//
// No network and no engines required: hosted providers are pointed at a local
// mock, local providers at a stub stdio client. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSpeechEngine, needsLocalEngine, STT_TYPES, TTS_TYPES } from "../speech.js";

// A valid 16-bit mono WAV, built by hand so the tests need no sox and no
// fixture file on disk.
function makeWav(samples = 160) {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 8)), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const TONE = makeWav();

// ---- local providers -------------------------------------------------------

function stubStdio(wavPath) {
  const calls = [];
  const client = {
    callTool: async (req) => {
      calls.push(req);
      if (req.name === "voice_transcribe_audio") {
        return { content: [{ type: "text", text: JSON.stringify({ text: " roti canai satu " }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ audio_file_path: wavPath }) }] };
    }
  };
  // Mirrors server.js's extractStructured.
  const extractStructured = (r) => {
    if (r.structuredContent) return r.structuredContent;
    const t = r.content?.find((c) => c.type === "text");
    if (t) { try { return JSON.parse(t.text); } catch { return { text: t.text }; } }
    return {};
  };
  return { calls, deps: { get mcpClient() { return client; }, extractStructured } };
}

test("whisper_local calls voice-mcp-server with the configured language and path", async () => {
  const { calls, deps } = stubStdio();
  const speech = createSpeechEngine(
    { stt: { type: "whisper_local", language: "en", timeoutMs: 1000 }, tts: { type: "moss_local", timeoutMs: 1000 } },
    deps
  );
  const text = await speech.transcribe("/tmp/input.wav");
  assert.equal(calls[0].name, "voice_transcribe_audio");
  assert.equal(calls[0].arguments.audio_file_path, "/tmp/input.wav");
  assert.equal(calls[0].arguments.language, "en");
  assert.equal(text, "roti canai satu", "transcript must be trimmed");
});

test("whisper_local sends 'auto' when no language is configured", async () => {
  const { calls, deps } = stubStdio();
  const speech = createSpeechEngine(
    { stt: { type: "whisper_local", timeoutMs: 1000 }, tts: { type: "moss_local", timeoutMs: 1000 } },
    deps
  );
  await speech.transcribe("/tmp/x.wav");
  assert.equal(calls[0].arguments.language, "auto");
});

test("moss_local returns the WAV bytes the tool pointed at", async (t) => {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "speech-test-"));
  const wavPath = path.join(dir, "reply.wav");
  await writeFile(wavPath, TONE);

  const { calls, deps } = stubStdio(wavPath);
  const speech = createSpeechEngine(
    { stt: { type: "whisper_local", timeoutMs: 1000 }, tts: { type: "moss_local", timeoutMs: 1000 } },
    deps
  );
  const wav = await speech.synthesize("dua ringgit");
  assert.equal(calls[0].name, "voice_speak_text");
  assert.equal(calls[0].arguments.text, "dua ringgit");
  assert.equal(calls[0].arguments.voice, "default");
  assert.ok(wav.equals(TONE), "must return the file's bytes unchanged");
});

test("a local provider without voice-mcp-server fails loudly", async () => {
  const speech = createSpeechEngine(
    { stt: { type: "whisper_local", timeoutMs: 1000 }, tts: { type: "moss_local", timeoutMs: 1000 } },
    { get mcpClient() { return null; }, extractStructured: () => ({}) }
  );
  await assert.rejects(() => speech.transcribe("/tmp/x.wav"), /voice-mcp-server/);
});

// ---- hosted providers ------------------------------------------------------

// One mock standing in for any OpenAI-compatible endpoint.
async function withMock(handler) {
  const seen = {};
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === "/boom") { res.writeHead(500); return res.end("upstream exploded"); }
    if (req.url.endsWith("/transcriptions")) {
      seen.stt = {
        auth: req.headers.authorization,
        multipart: (req.headers["content-type"] || "").startsWith("multipart/form-data"),
        hasLanguage: body.includes('name="language"'),
        hasPrompt: body.includes('name="prompt"'),
        carriedWav: body.includes(Buffer.from("RIFF"))
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ text: "  hello from the mock  " }));
    }
    seen.tts = { auth: req.headers.authorization, ...JSON.parse(body.toString()) };
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(TONE);
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await handler(base, seen); } finally { srv.close(); }
}

// Written to a temp file because the hosted STT provider takes a path — the
// same path sox hands it in production.
async function tempWav() {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "speech-test-"));
  const p = path.join(dir, "in.wav");
  await writeFile(p, TONE);
  return p;
}

test("openai_whisper uploads multipart with auth, model and bias prompt", async () => {
  await withMock(async (base, seen) => {
    const speech = createSpeechEngine({
      stt: { type: "openai_whisper", url: `${base}/v1/audio/transcriptions`, model: "whisper-1",
             language: "en", prompt: "roti canai, teh tarik", token: "sk-mock", timeoutMs: 5000 },
      tts: { type: "openai_tts", url: `${base}/v1/audio/speech`, token: "sk-mock", timeoutMs: 5000 }
    }, {});
    const text = await speech.transcribe(await tempWav());
    assert.ok(seen.stt.multipart, "must be multipart/form-data");
    assert.equal(seen.stt.auth, "Bearer sk-mock");
    assert.ok(seen.stt.hasLanguage);
    assert.ok(seen.stt.hasPrompt, "bias prompt must survive to the hosted engine");
    assert.ok(seen.stt.carriedWav, "real audio bytes must be attached");
    assert.equal(text, "hello from the mock");
  });
});

test("openai_whisper omits language when set to 'auto'", async () => {
  await withMock(async (base, seen) => {
    const speech = createSpeechEngine({
      stt: { type: "openai_whisper", url: `${base}/v1/audio/transcriptions`, model: "whisper-1",
             language: "auto", token: "t", timeoutMs: 5000 },
      tts: { type: "openai_tts", url: `${base}/v1/audio/speech`, token: "t", timeoutMs: 5000 }
    }, {});
    await speech.transcribe(await tempWav());
    // "auto" is this project's word, not the API's — sending it literally makes
    // the provider try to transcribe Auto, which is not a language.
    assert.equal(seen.stt.hasLanguage, false);
  });
});

test("openai_tts requests wav and returns the bytes verbatim", async () => {
  await withMock(async (base, seen) => {
    const speech = createSpeechEngine({
      stt: { type: "openai_whisper", url: `${base}/v1/audio/transcriptions`, token: "t", timeoutMs: 5000 },
      tts: { type: "openai_tts", url: `${base}/v1/audio/speech`, model: "tts-1",
             voice: "alloy", token: "sk-mock", timeoutMs: 5000 }
    }, {});
    const wav = await speech.synthesize("order up");
    assert.equal(seen.tts.auth, "Bearer sk-mock");
    assert.equal(seen.tts.input, "order up");
    assert.equal(seen.tts.voice, "alloy");
    // The box plays PCM WAV; anything else would need decoding before sox.
    assert.equal(seen.tts.response_format, "wav");
    assert.ok(wav.equals(TONE));
  });
});

test("an upstream error names the status and the body", async () => {
  await withMock(async (base) => {
    const speech = createSpeechEngine({
      stt: { type: "openai_whisper", url: `${base}/boom`, token: "t", timeoutMs: 5000 },
      tts: { type: "openai_tts", url: `${base}/boom`, token: "t", timeoutMs: 5000 }
    }, {});
    const wavPath = await tempWav();
    await assert.rejects(() => speech.transcribe(wavPath), /500.*upstream exploded/s);
    await assert.rejects(() => speech.synthesize("hi"), /500.*upstream exploded/s);
  });
});

// ---- gating ----------------------------------------------------------------

test("needsLocalEngine decides whether voice-mcp-server is spawned", () => {
  assert.equal(needsLocalEngine({ stt: { type: "whisper_local" }, tts: { type: "moss_local" } }), true);
  assert.equal(needsLocalEngine({ stt: { type: "openai_whisper" }, tts: { type: "openai_tts" } }), false);
  // Either half being local is enough to need the subprocess.
  assert.equal(needsLocalEngine({ stt: { type: "openai_whisper" }, tts: { type: "moss_local" } }), true);
  assert.equal(needsLocalEngine({ stt: { type: "whisper_local" }, tts: { type: "openai_tts" } }), true);
});

test("every registered provider type is reachable through the engine", () => {
  // Guards against a provider added to the registry but misspelled in the
  // config validator's allowlist — the two must stay in lockstep.
  for (const t of STT_TYPES) {
    assert.doesNotThrow(() =>
      createSpeechEngine({ stt: { type: t }, tts: { type: TTS_TYPES[0] } }, {}));
  }
  for (const t of TTS_TYPES) {
    assert.doesNotThrow(() =>
      createSpeechEngine({ stt: { type: STT_TYPES[0] }, tts: { type: t } }, {}));
  }
});
