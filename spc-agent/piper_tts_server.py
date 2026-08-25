#!/usr/bin/env python3
"""
OpenAI-compatible /v1/audio/speech served by Piper. Local TTS, no API key.

Adapted from ~/piper/piper_tts_server.py (left untouched) with four fixes:
  * PORT from env, default 5002 -- the original hardcoded 8080, which is
    spc-agent's port, so it could never actually bind.
  * A unique temp file per request. The original wrote every synthesis to the
    same /tmp/piper_output.wav; mcp-core splits replies into sentences and
    speaks them as separate calls, so a shared path is a corruption race.
  * ThreadingHTTPServer + allow_reuse_address, so one slow synthesis does not
    block the next and a restart does not trip over TIME_WAIT.
  * The voice is picked from the TEXT's script, not trusted from the request.
    Every caller (mcp-core's speech.js, spc_tts.py) sends whatever single
    static voice its config.json has -- "alloy" always, regardless of
    whether the reply that request turned out to be is English or Chinese.
    Piper phonemizes through espeak-ng, and espeak-ng's fallback for a
    character it cannot phonemize in the current voice's language is to
    announce the *Unicode block name* out loud, once per character -- for
    Han text through the English voice, that is "Chinese character" said
    once per Han glyph in the reply: a genuinely infinite-sounding loop for
    anything more than a short sentence. Detecting Han script in `text`
    itself and overriding to zh_CN-huayan-medium fixes every caller at once,
    instead of teaching each one to pick voices per-request.
"""
import http.server
import json
import os
import subprocess
import tempfile

PORT = int(os.environ.get("PIPER_PORT", "5002"))
PIPER_DIR = os.path.expanduser("~/piper/piper")
VOICES_DIR = os.path.expanduser("~/piper/voices")
DEFAULT_VOICE = "en_US-lessac-medium"

# "alloy" is mapped because mcp-core's openai_tts provider sends whatever voice
# name is in config.json, and the OpenAI default names mean nothing to piper.
# Only consulted as a fallback now -- see has_han() / do_POST for why the
# request's `voice` field is not trusted as the primary signal.
VOICE_MAP = {
    "default": "en_US-lessac-medium",
    "en": "en_US-lessac-medium",
    "english": "en_US-lessac-medium",
    "alloy": "en_US-lessac-medium",
    "zh": "zh_CN-huayan-medium",
    "chinese": "zh_CN-huayan-medium",
}


def has_han(text):
    """True if text contains any CJK Unified Ideograph. A reply is
    essentially always wholly one language or the other, so one Han
    character is enough signal -- no real language detector needed."""
    return any("一" <= ch <= "鿿" for ch in text)


class PiperHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)

    def _send(self, code, ctype, payload):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path in ("/health", "/"):
            body = json.dumps({
                "status": "ok",
                "service": "piper-tts",
                "voices": sorted(set(VOICE_MAP.values())),
            }).encode()
            self._send(200, "application/json", body)
        else:
            self._send(404, "application/json", b'{"error":"no route"}')

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            self._send(404, "application/json", b'{"error":"no route"}')
            return

        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:
            self._send(400, "application/json",
                       json.dumps({"error": "bad JSON: %s" % e}).encode())
            return

        text = (data.get("input") or "").strip()
        if not text:
            self._send(400, "application/json", b'{"error":"no input text"}')
            return

        # The text decides the voice, not the caller's request: see the module
        # docstring for why trusting a static "voice" field sends Chinese
        # replies to the English model and gets espeak-ng's per-character
        # "Chinese character" fallback instead of actual speech.
        if has_han(text):
            voice = "zh_CN-huayan-medium"
        else:
            voice = VOICE_MAP.get(data.get("voice", "default"), DEFAULT_VOICE)
        model_path = os.path.join(VOICES_DIR, voice + ".onnx")
        if not os.path.exists(model_path):
            model_path = os.path.join(VOICES_DIR, DEFAULT_VOICE + ".onnx")

        fd, out = tempfile.mkstemp(prefix="piper-", suffix=".wav")
        os.close(fd)
        try:
            env = os.environ.copy()
            env["LD_LIBRARY_PATH"] = PIPER_DIR
            proc = subprocess.run(
                [os.path.join(PIPER_DIR, "piper"),
                 "--model", model_path,
                 "--output_file", out],
                input=text.encode("utf-8"),
                capture_output=True,
                cwd=PIPER_DIR,
                env=env,
            )
            if proc.returncode != 0:
                self._send(500, "application/json",
                           json.dumps({"error": proc.stderr.decode()[:300]}).encode())
                return
            with open(out, "rb") as f:
                audio = f.read()
            self._send(200, "audio/wav", audio)
        except Exception as e:
            self._send(500, "application/json", json.dumps({"error": str(e)}).encode())
        finally:
            try:
                os.remove(out)
            except OSError:
                pass


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print("Piper TTS on :%d  ->  /v1/audio/speech" % PORT, flush=True)
    Server(("127.0.0.1", PORT), PiperHandler).serve_forever()
