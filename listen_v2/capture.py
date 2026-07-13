#!/usr/bin/env python3
"""Capture base64 WAV streams from the BOX-3 over serial and save them as .wav.

Usage:
    python3 capture.py [/dev/cu.usbmodemXXXX]

If no port is given, it auto-picks the first /dev/cu.usbmodem* (macOS).
Each recording the board emits is saved as rec_001.wav, rec_002.wav, ...
Press Ctrl-C to stop. Do NOT run `idf.py monitor` at the same time — only one
program can own the serial port.
"""
import sys, glob, base64, time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial missing. Install with:  pip3 install pyserial")

BEGIN = "-----BEGIN WAV-----"
END   = "-----END WAV-----"

def pick_port():
    if len(sys.argv) > 1:
        return sys.argv[1]
    ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/cu.usbserial*"))
    if not ports:
        sys.exit("No serial port found. Pass it explicitly: python3 capture.py /dev/cu.usbmodemXXXX")
    return ports[0]

def main():
    port = pick_port()
    print(f"Listening on {port} @ 115200. Ctrl-C to stop.\n")
    ser = serial.Serial(port, 115200, timeout=1)
    n = 0
    collecting = False
    buf = []
    while True:
        line = ser.readline().decode("utf-8", "ignore").strip()
        if not line:
            continue
        if line == BEGIN:
            collecting, buf = True, []
            print("  capturing...", end="", flush=True)
            continue
        if line == END and collecting:
            collecting = False
            n += 1
            try:
                data = base64.b64decode("".join(buf))
                fn = f"rec_{n:03d}.wav"
                with open(fn, "wb") as f:
                    f.write(data)
                print(f" saved {fn} ({len(data)} bytes)")
            except Exception as e:
                print(f" decode failed: {e}")
            continue
        if collecting:
            buf.append(line)
        else:
            # normal log lines from the board
            print(line)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
