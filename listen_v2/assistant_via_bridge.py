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
BRIDGE_BASE = BRIDGE_URL.rsplit("/", 1)[0]
LOG_PATH   = os.environ.get("INTERACTION_LOG", "interaction_log.jsonl")
SAMPLE_RATE_BOX = 16000   # box always records at 16kHz mono 16-bit

count = 0

# Confirm-before-LLM flow: after STT, the transcript is shown on the box and
# NOTHING is sent to the LLM until the customer tap-confirms (box POSTs
# /confirm here). One pending turn at a time — it's a single kiosk. The box
# enforces its own shorter tap window (~8s); this longer window just garbage-
# collects a stale pending turn if the box's confirm never arrives.
PENDING = {"transcript": None, "expires": 0, "record": None, "stages": None}
PENDING_WINDOW_S = 25

def now_ms():
    return int(time.time() * 1000)

def bridge_transcribe(wav_bytes):
    """Phase 1: STT only. Returns the transcript string ('' if no speech)."""
    req = urllib.request.Request(f"{BRIDGE_BASE}/transcribe", data=wav_bytes, method="POST",
                                 headers={"Content-Type": "audio/wav"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode()).get("transcript", "").strip()

def bridge_respond(text):
    """Phase 2 (after confirm): LLM + TTS. Returns (audio, reply, order, latencies, stages)."""
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(f"{BRIDGE_BASE}/respond", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        reply = urllib.parse.unquote(r.headers.get("X-Reply-Text", ""))
        order = None
        order_raw = urllib.parse.unquote(r.headers.get("X-Order-Json", ""))
        if order_raw:
            try:
                order = json.loads(order_raw)
            except json.JSONDecodeError:
                pass
        latencies = {k[10:].lower(): int(v) for k, v in r.headers.items()
                    if k.lower().startswith("x-latency-")}
        # Absolute epoch-ms stage boundaries bridge-server measured itself.
        stages = {k[5:].lower().replace("-", "_"): int(v) for k, v in r.headers.items()
                 if k.lower().startswith("x-ts-")}
        return r.read(), reply, order, latencies, stages

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

def send_caption(text, who="YOU", confirm=False):
    try:
        headers = {"X-Speaker": who}
        if confirm:
            # Tells the firmware to arm its tap-to-confirm window for this caption.
            headers["X-Confirm"] = "1"
        req = urllib.request.Request(f"http://{BOX_IP}/caption",
                                     data=_ascii_oneline(text).encode("ascii"),
                                     method="POST", headers=headers)
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

def send_order_to_box(order):
    """Render the priced order onto the box screen via POST /order.

    Body is a dead-simple line protocol (no JSON parsing needed in firmware):
        TITLE|YOUR ORDER
        ITEM|2X NASI LEMAK|RM11.00
        TOTAL|RM15.50
    The box font is uppercase-only, so names are uppercased here; item names
    are truncated so name+price fit the 320px screen at scale 2 (~24 chars).
    """
    if not order or not order.get("items"):
        return None
    cur = order.get("currency", "RM")
    title = "ORDER CONFIRMED" if order.get("status") == "confirmed" else "YOUR ORDER"
    lines = [f"TITLE|{title}"]
    for it in order["items"][:5]:
        name = _ascii_oneline(f"{it['qty']}X {it['name']}").upper()[:15]
        lines.append(f"ITEM|{name}|{cur}{it['line_total']:.2f}")
    lines.append(f"TOTAL|{cur}{order['total']:.2f}")
    body = "\n".join(lines).encode("ascii")
    try:
        req = urllib.request.Request(f"http://{BOX_IP}/order", data=body, method="POST")
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except Exception as e:
        print(f"       (order screen to box failed: {e})")   # old firmware: 404, fine
        return None

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/upload":
            self.handle_upload()
        elif self.path == "/confirm":
            self.handle_confirm()
        else:
            self.send_response(404); self.end_headers()

    # ---- Phase 1: recording arrives -> STT only -> show transcript, wait ----
    def handle_upload(self):
        global count
        # audio_upload_start: connection accepted, about to read the body.
        # The box streams mic samples into this same HTTP POST as it records
        # (record_and_post() in the firmware reads+writes interleaved), so
        # record_end and audio_upload_end are effectively simultaneous.
        audio_upload_start = now_ms()
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        audio_upload_end = now_ms()
        # record_start is derived from the WAV's own length (16kHz mono 16-bit).
        data_bytes = len(data) - 44
        actual_record_ms = int(data_bytes / (SAMPLE_RATE_BOX * 2) * 1000) if len(data) > 44 else 0

        count += 1
        ts = datetime.datetime.now().strftime("%H%M%S")
        fn = f"rec{count:03d}_{ts}.wav"
        with open(fn, "wb") as f:
            f.write(data)
        print(f"\n[1/2] received {fn} ({len(data)} bytes)")
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")

        record = {"timestamp": datetime.datetime.now().isoformat(), "recording": fn,
                  "recording_bytes": len(data)}
        stages = {
            "record_start": audio_upload_end - actual_record_ms, "record_end": audio_upload_end,
            "audio_upload_start": audio_upload_start, "audio_upload_end": audio_upload_end,
        }
        try:
            transcript = bridge_transcribe(data)
            print(f"       heard: {transcript!r}")
            record["transcript"] = transcript

            # Whisper annotates non-speech as "(upbeat music)", "[door slams]"
            # etc. If nothing remains once bracketed annotations are stripped,
            # there was no real speech — treat it the same as silence.
            import re
            if re.sub(r"[\(\[].*?[\)\]]", "", transcript).strip(" .,!?") == "":
                transcript = ""

            if not transcript:
                # Nothing intelligible — never bother the LLM, just ask again.
                send_caption("DIDN'T CATCH THAT - SPEAK AGAIN", who="TRY AGAIN")
                PENDING["transcript"] = None
                record["outcome"] = "no_speech"
                return

            # Show what was heard and arm the box's tap-to-confirm window.
            # The LLM is NOT called until /confirm arrives.
            send_caption(transcript, who="TAP = SEND", confirm=True)
            PENDING.update({"transcript": transcript, "expires": time.time() + PENDING_WINDOW_S,
                            "record": record, "stages": stages})
            record["outcome"] = "awaiting_confirm"
            print(f"       waiting for tap-confirm on the box (window {PENDING_WINDOW_S}s)...")
        except Exception as e:
            print(f"       phase-1 failed: {e}")
            record["error"] = str(e)
        finally:
            with open(LOG_PATH, "a") as logf:
                logf.write(json.dumps(record) + "\n")

    # ---- Phase 2: box tap-confirmed -> LLM -> TTS -> play -> order screen ----
    def handle_confirm(self):
        transcript = PENDING["transcript"]
        if not transcript or time.time() > PENDING["expires"]:
            self.send_response(410); self.end_headers()   # gone/stale
            print("       /confirm arrived but nothing pending (or expired)")
            return
        PENDING["transcript"] = None   # consume it — one confirm per turn
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")

        stages = PENDING["stages"] or {}
        record = {"timestamp": datetime.datetime.now().isoformat(),
                  "confirmed_transcript": transcript,
                  "recording": (PENDING["record"] or {}).get("recording")}
        try:
            print(f"[2/2] confirmed -> LLM: {transcript!r}")
            reply_wav, reply, order, bridge_lat, bridge_stages = bridge_respond(transcript)
            stages.update(bridge_stages)
            print(f"       assistant: {reply!r}")

            box_wav = downmix_for_box(reply_wav)
            playback_start = now_ms()
            status = send_to_box(box_wav, reply_text=reply)
            playback_end = now_ms()
            stages["playback_start"] = playback_start
            stages["playback_end"] = playback_end

            # /play returns when playback finishes; the box lingers the reply
            # caption ~3.5s. The order screen then takes over as resting state.
            if order and order.get("items"):
                print(f"       order -> box: {order.get('status')} "
                      f"{len(order['items'])} items, total {order.get('currency','RM')}{order.get('total')}")
                send_order_to_box(order)

            playback_wall_ms = playback_end - playback_start
            expected_audio_ms = int(len(box_wav) / (22050 * 2) * 1000)
            stutter_risk = playback_wall_ms > expected_audio_ms + 500
            print(f"       box replied {status}. playback {playback_wall_ms}ms for {expected_audio_ms}ms audio"
                 f"{'  <-- possible stutter/underrun' if stutter_risk else ''}\n")

            record.update({
                "reply": reply, "order": order, "box_status": status,
                "stages_epoch_ms": stages,
                "expected_audio_ms": expected_audio_ms,
                "playback_wall_ms": playback_wall_ms,
                "stutter_risk": stutter_risk,
                "latency_ms": {
                    "llm": stages.get("llm_end", 0) - stages.get("llm_start", 0),
                    "tts": stages.get("tts_end", 0) - stages.get("tts_start", 0),
                    "playback": playback_wall_ms,
                    **{f"bridge_{k}": v for k, v in bridge_lat.items()},
                },
            })
        except Exception as e:
            print(f"       phase-2 failed: {e}")
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
