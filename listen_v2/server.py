#!/usr/bin/env python3
"""PC-side receiver: accepts the WAV the BOX-3 POSTs over WiFi and saves it.

Run:   python3 server.py
Then press BOOT on the box; each recording is saved as recNNN_<time>.wav here
and (on macOS) auto-played so you hear it immediately.

Listens on 0.0.0.0:8000, endpoint POST /upload.
"""
import http.server, socketserver, datetime, subprocess, sys, os

PORT = 8000
count = 0

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
        print(f"[+] received {fn}  ({len(data)} bytes)")
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")
        # auto-play on macOS so you hear it right away
        if sys.platform == "darwin":
            try: subprocess.Popen(["afplay", fn])
            except Exception: pass

    def log_message(self, *a): pass  # quiet default logging

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Receiver listening on 0.0.0.0:{PORT}  (POST /upload)")
        print("Press BOOT on the box to record + send. Ctrl-C to stop.")
        try: httpd.serve_forever()
        except KeyboardInterrupt: print("\nstopped.")
