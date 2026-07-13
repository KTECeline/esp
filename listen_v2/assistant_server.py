#!/usr/bin/env python3
"""Voice assistant bridge for the ESP32-S3-BOX-3.

Press BOOT on the box -> it records 5s and POSTs the WAV here (port 8000).
This server then:
  1. transcribes it with whisper.cpp
  2. asks Ollama (llama3.2:3b) for a short spoken-style reply
  3. synthesizes the reply with MOSS-TTS (port 8080)
  4. POSTs the reply WAV back to the box, which speaks it

Run:  python3 assistant_server.py [box_ip]
      (box_ip defaults to 192.168.68.142 — check the box's screen)

Prerequisites already running: `ollama serve`, MOSS uvicorn on :8080.
Each recording is also saved here as recNNN_<time>.wav.
"""
import http.server, socketserver, datetime, subprocess, sys, os, json, urllib.request

PORT        = 8000
BOX_IP      = sys.argv[1] if len(sys.argv) > 1 else "192.168.68.142"
WHISPER_BIN = os.path.expanduser("~/esp/whisper.cpp/build/bin/whisper-cli")
WHISPER_MOD = os.path.expanduser("~/esp/whisper.cpp/models/ggml-base.bin")
OLLAMA_URL  = "http://localhost:11434/api/generate"
OLLAMA_MODEL= "llama3.2:3b"
TTS_URL     = "http://localhost:8080/v1/audio/speech"
SYSTEM_PROMPT = ("You are a helpful voice assistant having a spoken conversation. "
                 "Keep replies short and natural, like a real person talking, "
                 "1-2 sentences maximum. Do not use lists, bullet points, or long "
                 "explanations unless specifically asked. Reply in the same language "
                 "the person spoke in, without mixing in other languages.")

count = 0

LANG = "en"   # force English: auto-detect mishears accented English as Malay.
              # Change to "ms" for Malay, or "auto" to let whisper guess.

def transcribe(wav_path):
    # Normalize volume first — quiet far-from-mic takes otherwise transcribe
    # as garbage. norm -3 brings peaks up to -3 dBFS.
    subprocess.run(["sox", wav_path, "/tmp/stt_norm.wav", "norm", "-3"],
                   check=True, timeout=60)
    out = subprocess.run(
        [WHISPER_BIN, "-m", WHISPER_MOD, "-f", "/tmp/stt_norm.wav",
         "-ng", "-nt", "-l", LANG],
        capture_output=True, text=True, timeout=120)
    return out.stdout.strip()

def think(text):
    body = json.dumps({"model": OLLAMA_MODEL, "system": SYSTEM_PROMPT,
                       "prompt": text, "stream": False}).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["response"].strip()

def speak(text):
    body = json.dumps({"model": "tts-1", "input": text, "voice": "default"}).encode()
    req = urllib.request.Request(TTS_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()   # WAV bytes (48k stereo from MOSS)
    # Downmix to 16-bit mono 22.05k — the box's ES8311 speaker is mono and
    # this keeps the WiFi transfer small.
    with open("/tmp/tts_raw.wav", "wb") as f:
        f.write(raw)
    subprocess.run(["sox", "/tmp/tts_raw.wav", "-r", "22050", "-c", "1",
                    "-b", "16", "/tmp/tts_box.wav"], check=True, timeout=60)
    with open("/tmp/tts_box.wav", "rb") as f:
        return f.read()

def send_to_box(wav_bytes):
    req = urllib.request.Request(f"http://{BOX_IP}/play", data=wav_bytes, method="POST",
                                 headers={"Content-Type": "audio/wav"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global count
        if self.path != "/upload":
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        count += 1
        ts = datetime.datetime.now().strftime("%H%M%S")
        fn = f"rec{count:03d}_{ts}.wav"
        with open(fn, "wb") as f:
            f.write(data)
        print(f"\n[1/4] received {fn} ({len(data)} bytes)")
        # Reply to the box immediately so its screen shows SENT and it goes
        # back to READY (the /play POST needs the box out of the send state).
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")

        try:
            text = transcribe(fn)
            print(f"[2/4] you said: {text!r}")
            if not text:
                print("      (nothing understood — skipping)")
                return
            reply = think(text)
            print(f"[3/4] assistant: {reply!r}")
            wav = speak(reply)
            print(f"[4/4] speech ready ({len(wav)} bytes) -> sending to box {BOX_IP}")
            status = send_to_box(wav)
            print(f"      box replied {status} — it should be talking now.\n")
        except Exception as e:
            print(f"      pipeline failed: {e}")

    def log_message(self, *a): pass

if __name__ == "__main__":
    for path, name in [(WHISPER_BIN, "whisper-cli"), (WHISPER_MOD, "whisper model")]:
        if not os.path.exists(path):
            sys.exit(f"missing {name} at {path}")
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Assistant bridge on 0.0.0.0:{PORT} -> box at {BOX_IP}")
        print("Press BOOT on the box and ask it something. Ctrl-C to stop.")
        try: httpd.serve_forever()
        except KeyboardInterrupt: print("\nstopped.")
