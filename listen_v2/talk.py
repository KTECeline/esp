#!/usr/bin/env python3
"""Send a WAV to the BOX-3 so it plays it out the speaker (the TALK path).

Usage:
    python3 talk.py somefile.wav [box_ip]

Defaults box_ip to 192.168.68.142 (the box's current IP — shown on its screen).
The box plays any 16-bit PCM WAV; its own recordings (16 kHz mono) work perfectly,
so you can round-trip: record with LISTEN, then play it back with TALK.
"""
import sys, urllib.request

if len(sys.argv) < 2:
    sys.exit("usage: python3 talk.py file.wav [box_ip]")
path = sys.argv[1]
box_ip = sys.argv[2] if len(sys.argv) > 2 else "192.168.68.142"

with open(path, "rb") as f:
    data = f.read()

url = f"http://{box_ip}/play"
print(f"sending {path} ({len(data)} bytes) -> {url}")
req = urllib.request.Request(url, data=data, method="POST",
                             headers={"Content-Type": "audio/wav"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print("box replied:", r.status, r.read().decode("utf-8", "ignore"))
except Exception as e:
    print("failed:", e)
    print("- is the box on and showing READY?  is the IP right (check its screen)?")
