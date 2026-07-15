#!/usr/bin/env python3
"""Voice assistant for the ESP32-S3-BOX-3 — routed through the MCP bridge.

This is the "swappable backend" version: instead of calling whisper/Ollama/MOSS
directly (see assistant_server.py), every recording is forwarded to
bridge-server.js's /talk endpoint, which itself talks to:
  - voice-mcp-server (MCP protocol) for STT + TTS
  - an OpenAI-compatible LLM endpoint for the reply (currently Ollama's
    /v1/chat/completions — swap OPENCLAW_URL/MODEL later for real OpenClaw
    or any other backend, no code changes needed here or in bridge-server.js)

Box's firmware is unchanged: it still POSTs to /upload here, and still expects
a later POST to its own /play with the reply audio.

Run:  python3 assistant_via_bridge.py [box_ip]
Requires already running: ollama serve, MOSS uvicorn (:8080), bridge-server.js (:3000)
    (bridge-server.js auto-starts voice-mcp-server as a subprocess over stdio)
"""
import http.server, socketserver, datetime, sys, os, time, json, subprocess, urllib.request, urllib.parse

PORT       = 8000
BOX_IP     = sys.argv[1] if len(sys.argv) > 1 else "192.168.68.142"
BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://localhost:3000/talk")
LOG_PATH   = os.environ.get("INTERACTION_LOG", "interaction_log.jsonl")
SAMPLE_RATE_BOX = 16000   # box always records at 16kHz mono 16-bit

count = 0

def now_ms():
    return int(time.time() * 1000)

def bridge_talk(wav_bytes):
    req = urllib.request.Request(BRIDGE_URL, data=wav_bytes, method="POST",
                                 headers={"Content-Type": "audio/wav"})
    with urllib.request.urlopen(req, timeout=120) as r:
        transcript = urllib.parse.unquote(r.headers.get("X-Transcript", ""))
        reply = urllib.parse.unquote(r.headers.get("X-Reply-Text", ""))
        latencies = {k[10:].lower(): int(v) for k, v in r.headers.items()
                    if k.lower().startswith("x-latency-")}
        # Absolute epoch-ms stage boundaries bridge-server measured itself.
        stages = {k[5:].lower().replace("-", "_"): int(v) for k, v in r.headers.items()
                 if k.lower().startswith("x-ts-")}
        return r.read(), transcript, reply, latencies, stages

def downmix_for_box(wav_bytes):
    # MOSS-TTS returns 48kHz stereo; the box's speaker is mono, and sending
    # full stereo over WiFi takes ~4x longer for identical-sounding audio.
    with open("/tmp/bridge_tts_raw.wav", "wb") as f:
        f.write(wav_bytes)
    subprocess.run(["sox", "/tmp/bridge_tts_raw.wav", "-r", "22050", "-c", "1",
                    "-b", "16", "/tmp/bridge_tts_box.wav"], check=True, timeout=60)
    with open("/tmp/bridge_tts_box.wav", "rb") as f:
        return f.read()

# The box font is ASCII-only (renders uppercase); HTTP headers must be latin-1
# and single-line — strip anything else so captions don't corrupt the request.
def _ascii_oneline(s, limit=200):
    s = (s or "").replace("\n", " ").replace("\r", " ")
    return s.encode("ascii", "ignore").decode("ascii")[:limit]

def send_caption(text, who="YOU"):
    try:
        req = urllib.request.Request(f"http://{BOX_IP}/caption",
                                     data=_ascii_oneline(text).encode("ascii"),
                                     method="POST", headers={"X-Speaker": who})
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except Exception as e:
        print(f"       (caption to box failed: {e})")
        return None

def send_to_box(wav_bytes, reply_text=""):
    headers = {"Content-Type": "audio/wav"}
    if reply_text:
        headers["X-Reply-Text"] = _ascii_oneline(reply_text)
    req = urllib.request.Request(f"http://{BOX_IP}/play", data=wav_bytes, method="POST",
                                 headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global count
        if self.path != "/upload":
            self.send_response(404); self.end_headers(); return

        # audio_upload_start: connection accepted, about to read the body.
        # The box streams mic samples into this same HTTP POST as it records
        # (record_and_post() in the firmware reads+writes interleaved), so
        # record_end and audio_upload_end are effectively simultaneous —
        # there's no separate "recording finished, now uploading" phase.
        audio_upload_start = now_ms()
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        audio_upload_end = now_ms()
        # record_start is derived, not measured: read the ACTUAL recorded
        # duration from the WAV's own header (box now records variable-length
        # via press-to-start/press-to-stop, not a fixed duration) — box always
        # sends 16kHz mono 16-bit, so byte_rate is constant.
        data_bytes = len(data) - 44
        actual_record_ms = int(data_bytes / (SAMPLE_RATE_BOX * 2) * 1000) if len(data) > 44 else 0
        record_start = audio_upload_end - actual_record_ms
        record_end = audio_upload_end

        count += 1
        ts = datetime.datetime.now().strftime("%H%M%S")
        fn = f"rec{count:03d}_{ts}.wav"
        with open(fn, "wb") as f:
            f.write(data)
        print(f"\n[1/3] received {fn} ({len(data)} bytes)")
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")

        record = {"timestamp": datetime.datetime.now().isoformat(), "recording": fn,
                  "recording_bytes": len(data)}
        stages = {
            "record_start": record_start, "record_end": record_end,
            "audio_upload_start": audio_upload_start, "audio_upload_end": audio_upload_end,
        }
        try:
            print(f"[2/3] forwarding to bridge ({BRIDGE_URL})...")
            reply_wav, transcript, reply, bridge_lat, bridge_stages = bridge_talk(data)
            stages.update(bridge_stages)   # stt_start/end, llm_start/end, tts_start/end
            print(f"       you said: {transcript!r}")
            print(f"       assistant: {reply!r}")
            print(f"       [bridge breakdown: {bridge_lat}]")

            # Show what was heard on the box immediately (before TTS finishes).
            if transcript:
                send_caption(transcript, "YOU")

            box_wav = downmix_for_box(reply_wav)
            # playback_start: about to POST the reply to the box's /play.
            # Since the box's play_handler streams incoming bytes straight
            # into esp_codec_dev_write() as they arrive, actual speaker
            # output begins almost immediately after this — playback_end is
            # when /play responds, i.e. after everything has been written
            # (and, since esp_codec_dev_write blocks on the I2S buffer, that
            # also means fully played).
            playback_start = now_ms()
            print(f"[3/3] sending reply ({len(box_wav)} bytes, downmixed from {len(reply_wav)}) -> box {BOX_IP}")
            status = send_to_box(box_wav, reply_text=reply)
            playback_end = now_ms()
            stages["playback_start"] = playback_start
            stages["playback_end"] = playback_end

            total_ms = playback_end - record_start
            playback_wall_ms = playback_end - playback_start
            # Box WAV is fixed 22050Hz/mono/16-bit (see downmix_for_box).
            expected_audio_ms = int(len(box_wav) / (22050 * 2) * 1000)
            stutter_risk = playback_wall_ms > expected_audio_ms + 500
            print(f"       box replied {status} — it should be talking now. [end-to-end: {total_ms}ms]")
            print(f"       playback took {playback_wall_ms}ms for {expected_audio_ms}ms of audio"
                 f"{'  <-- possible stutter/underrun' if stutter_risk else ''}\n")

            record.update({
                "transcript": transcript, "reply": reply, "box_status": status,
                "stages_epoch_ms": stages,
                "expected_audio_ms": expected_audio_ms,
                "playback_wall_ms": playback_wall_ms,
                "stutter_risk": stutter_risk,
                "latency_ms": {
                    "record_to_upload_end": stages["audio_upload_end"] - stages["record_start"],
                    "stt": stages["stt_end"] - stages["stt_start"],
                    "llm": stages["llm_end"] - stages["llm_start"],
                    "tts": stages["tts_end"] - stages["tts_start"],
                    "playback": playback_wall_ms,
                    "end_to_end": total_ms,
                    **{f"bridge_{k}": v for k, v in bridge_lat.items()},
                },
            })
        except Exception as e:
            print(f"       pipeline failed: {e}")
            record["error"] = str(e)
        finally:
            with open(LOG_PATH, "a") as logf:
                logf.write(json.dumps(record) + "\n")

    def log_message(self, *a): pass

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Bridge-routed assistant on 0.0.0.0:{PORT} -> box at {BOX_IP}")
        print(f"Forwarding each recording to {BRIDGE_URL}")
        print("Press BOOT on the box and ask it something. Ctrl-C to stop.")
        try: httpd.serve_forever()
        except KeyboardInterrupt: print("\nstopped.")
