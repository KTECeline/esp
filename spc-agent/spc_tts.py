#!/usr/bin/env python3
"""Bridge the spc-agent TTS contract to the local Piper shim.

spc-agent hands text on stdin and wants a WAV written to the path in argv[1]
(see SPC_TTS_CMD in spc_agent.py). Piper on this Pi lives behind an
OpenAI-compatible HTTP shim on 127.0.0.1:5002, so this is the small piece of
glue between the two.

Without it spc-agent falls back to espeak-ng, which is in every apt repo and
sounds like a robot from 1985.

Nothing hosted is involved despite the OpenAI-shaped request body: openai_tts
is the protocol here, not the provider. No API key, no network egress.

The "voice" sent here is nominal -- piper_tts_server.py picks the actual
Piper model by inspecting the TEXT (English vs Chinese script), not this
field, because a reply's language varies request to request while this
script's request shape does not. See that file for why.
"""
import json
import os
import sys
import urllib.request

# The OrangePi's shim listens on 5002, so that stays the default and nothing
# there has to change. The Radxa runs the same OpenAI-shaped route from its own
# piper-wrapper.js on 5001 instead, so the port has to be settable per machine
# rather than baked in.
TTS_URL = os.environ.get("SPC_TTS_URL", "http://127.0.0.1:5002/v1/audio/speech")

# Generous: Piper synthesises sentence by sentence and a long reply is slow on
# an RK3588. spc-agent's own "speak" timeout is 55s, so staying under that lets
# the caller report the useful error rather than this script dying first.
TIMEOUT_S = 45


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: spc_tts.py <output.wav>   (text arrives on stdin)")
    out_path = sys.argv[1]
    text = sys.stdin.read().strip()
    if not text:
        sys.exit("no text on stdin")

    req = urllib.request.Request(
        TTS_URL,
        data=json.dumps({"model": "tts-1", "input": text, "voice": "alloy"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            audio = resp.read()
    except Exception as err:
        # Name the service, because the usual cause is piper-tts.service being
        # down, and "connection refused" alone sends people looking at the
        # speaker instead.
        sys.exit(f"piper shim at {TTS_URL} failed ({err}) - check piper-tts.service")

    if not audio:
        sys.exit("piper shim returned an empty response")
    with open(out_path, "wb") as fh:
        fh.write(audio)


if __name__ == "__main__":
    main()
