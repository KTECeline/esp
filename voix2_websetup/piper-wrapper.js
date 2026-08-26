'use strict';

// Persistent OpenAI-compatible TTS wrapper, backed by the real `piper` CLI.
// Started (nohup, detached) by setup-server.js's /api/download/tts route
// after it confirms Piper actually synthesizes. Matches exactly what
// mcp-core/speech.js's `ttsOpenAI()` sends and expects: POST JSON
// { input, voice, model, response_format }, raw audio bytes back on 200,
// short plain-text body on non-2xx.
//
// mcp-core sends one fixed `voice` (config.json's speech.tts.voice) on
// every request — it has no per-request language detection, and it's
// shared team code we don't own, so that logic lives here instead: we
// detect the language of `input` ourselves and pick a matching Piper
// voice, treating the requested voice as a fallback default only.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = process.env.PIPER_WRAPPER_PORT || 5001;
const VOICES_DIR = process.env.PIPER_VOICES_DIR || path.join(os.homedir(), 'esp', 'piper', 'voices');
// Spawned by bare name, 'piper' resolves via PATH — but PATH isn't reliably
// inherited once this runs as a nohup'd background process, so it must be
// the full absolute path instead (pip installs console-scripts here by
// default: https://pip.pypa.io/en/stable/user_guide/#user-installs).
const PIPER_BIN = process.env.PIPER_BIN || path.join(os.homedir(), '.local', 'bin', 'piper');

if (!fs.existsSync(PIPER_BIN)){
  console.error(`piper-wrapper: piper binary not found at ${PIPER_BIN}`);
  console.error('Install it with: pip install piper-tts --break-system-packages');
  console.error('(or set PIPER_BIN to the correct path if it lives somewhere else)');
  process.exit(1);
}

function listAvailableVoices(){
  try {
    return fs.readdirSync(VOICES_DIR)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.slice(0, -'.onnx'.length));
  } catch (e) {
    return [];
  }
}

// mcp-core defaults to voice "alloy" (an OpenAI voice name) when config.json
// doesn't say otherwise — that will never match a Piper voice id, so an
// unrecognized/missing voice falls back to whatever was actually downloaded
// rather than failing every request. Used as the last-resort fallback by
// pickVoiceForText() below, and directly if language detection can't run.
function resolveVoicePath(requestedVoice){
  const available = listAvailableVoices();
  if (available.length === 0) return null;
  if (requestedVoice && available.includes(requestedVoice)){
    return path.join(VOICES_DIR, `${requestedVoice}.onnx`);
  }
  return path.join(VOICES_DIR, `${available[0]}.onnx`);
}

const EN_VOICE = 'en_US-lessac-medium';
const ZH_VOICE = 'zh_CN-huayan-medium';

// Common CJK Unicode blocks — covers ordinary Chinese text (CJK Unified
// Ideographs, its Extension A block, and the CJK Compatibility Ideographs
// block used by some legacy characters). Deliberately not trying to be a
// full script-detection library; this is a two-way English/Chinese switch.
const CJK_RANGE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;

// A request needs a real share of CJK characters, not just one, before we
// call it Chinese — a single stray CJK character (e.g. a quoted term
// inside an English sentence) shouldn't flip the whole utterance's voice.
const CJK_RATIO_THRESHOLD = 0.2;

function detectLanguage(text){
  const chars = String(text == null ? '' : text).replace(/\s+/g, '').split('');
  if (chars.length === 0) return 'en';
  const cjkCount = chars.filter((c) => CJK_RANGE.test(c)).length;
  return (cjkCount / chars.length) >= CJK_RATIO_THRESHOLD ? 'zh' : 'en';
}

function voiceFileExists(voiceName){
  return fs.existsSync(path.join(VOICES_DIR, `${voiceName}.onnx`));
}

// Startup check only (visibility before any request relies on this) — the
// actual fallback happens per-request in pickVoiceForText().
for (const v of [EN_VOICE, ZH_VOICE]){
  if (!voiceFileExists(v)){
    console.warn(`piper-wrapper: expected voice "${v}" not found in ${VOICES_DIR} — language-based selection will fall back to another voice when ${v === ZH_VOICE ? 'Chinese' : 'English'} text is detected`);
  }
}

// Picks a voice by detecting the language of `text`, ignoring the fixed
// `requestedVoice` mcp-core sent except as a last-resort fallback if the
// language-appropriate voice file isn't actually present on disk.
function pickVoiceForText(text, requestedVoice){
  const lang = detectLanguage(text);
  const preferred = lang === 'zh' ? ZH_VOICE : EN_VOICE;

  if (voiceFileExists(preferred)){
    console.log(`piper-wrapper: voice=${preferred} reason=detected-language(${lang})`);
    return path.join(VOICES_DIR, `${preferred}.onnx`);
  }

  console.error(`piper-wrapper: preferred voice "${preferred}" (detected language=${lang}) missing from ${VOICES_DIR}, falling back`);
  const fallback = resolveVoicePath(requestedVoice);
  if (fallback){
    console.log(`piper-wrapper: voice=${path.basename(fallback, '.onnx')} reason=fallback(missing ${preferred})`);
  }
  return fallback;
}

// SOUL.md already tells the model not to produce markdown ("no headings, no
// bullet points, no asterisks or any other markdown") for replies meant to
// be spoken aloud, but real trajectory logs show that instruction isn't
// followed 100% of the time — **bold**/bullet dashes have shown up in text
// sent here for synthesis. This is the technical backstop: strip syntax
// that would otherwise get read aloud literally (Piper has no idea "**" or
// "- " isn't meant to be spoken). Deliberately conservative — only clear
// markdown syntax is touched; a hyphen inside a word or a genuine "?"/"."
// is left alone.
function sanitizeMarkdown(text){
  let out = String(text == null ? '' : text);
  // Leading "- " / "* " bullet marker, one per line (indentation kept).
  out = out.replace(/^([ \t]*)[-*][ \t]+/gm, '$1');
  // Leading "#" ATX heading marker, one per line (indentation kept).
  out = out.replace(/^([ \t]*)#{1,6}[ \t]+/gm, '$1');
  // **bold** — must run before *italic* below, or "**x**" parses as two
  // adjacent empty italic spans instead of one bold span.
  out = out.replace(/\*\*(.+?)\*\*/g, '$1');
  // *italic*
  out = out.replace(/\*(.+?)\*/g, '$1');
  // Backticks — inline `code` and ```fenced``` blocks alike.
  out = out.replace(/`+/g, '');
  return out;
}

function synthesize(text, modelPath){
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `piper-out-${crypto.randomBytes(8).toString('hex')}.wav`);
    const child = execFile(
      PIPER_BIN,
      ['--model', modelPath, '--output_file', outPath],
      { maxBuffer: 1024 * 1024 * 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').toString().trim() || 'piper failed'));
        fs.readFile(outPath, (readErr, buf) => {
          fs.unlink(outPath, () => {});
          if (readErr) return reject(readErr);
          resolve(buf);
        });
      }
    );
    // Text goes to piper's stdin directly (never through a shell string) —
    // this carries live customer speech transcriptions, not fixed input.
    child.stdin.write(text == null ? '' : String(text));
    child.stdin.end();
  });
}

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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health'){
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'POST' && req.url === '/v1/audio/speech'){
    try {
      const body = await readJsonBody(req);
      const text = body.input;
      if (!text || !String(text).trim()){
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Missing "input" text');
      }
      const modelPath = pickVoiceForText(text, body.voice);
      if (!modelPath){
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end(`No Piper voice available in ${VOICES_DIR}`);
      }
      // Sanitize after language detection (above), not before — markdown
      // syntax is ASCII-only and stripping it first could shift the CJK
      // ratio detectLanguage() relies on for no real reason.
      const rawText = String(text);
      const sanitizedText = sanitizeMarkdown(rawText);
      if (sanitizedText !== rawText){
        console.log(`piper-wrapper: sanitized markdown from text (before=${rawText.length} chars, after=${sanitizedText.length} chars)`);
      }
      const audio = await synthesize(sanitizedText, modelPath);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length });
      return res.end(audio);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end(String(e.message || e).slice(0, 500));
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`piper-wrapper listening on http://0.0.0.0:${PORT}`);
});
