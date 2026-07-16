#!/usr/bin/env python3
"""Live per-stage latency viewer for the BOX-3 voice pipeline.

Usage:
    python3 show_latency.py            # follow new interactions as they happen
    python3 show_latency.py --all      # print every interaction in the log so far

Reads interaction_log.jsonl (written by mcp-core/server.js) and prints a
clean timeline for each of the 12 stages:
    record_start / record_end                (approx — box streams while recording)
    audio_upload_start / audio_upload_end     (exact)
    stt_start / stt_end                       (exact)
    llm_start / llm_end                       (exact)
    tts_start / tts_end                       (exact)
    playback_start / playback_end             (playback_start exact; playback_end
                                                is when the box confirms fully played)

Also flags "stutter_risk" — when playback took noticeably longer than the
reply audio's actual duration, which points at a WiFi/buffer stall on the box
rather than normal real-time speech playback.
"""
import sys, os, json, time

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.environ.get(
    "INTERACTION_LOG",
    os.path.expanduser("~/esp/mcp-core/interaction_log.jsonl"))

STAGE_ORDER = [
    ("record_start", "record_end", "RECORD (~approx, streams while uploading)"),
    ("audio_upload_start", "audio_upload_end", "UPLOAD to Mac"),
    ("stt_start", "stt_end", "STT (whisper)"),
    ("llm_start", "llm_end", "LLM (Ollama)"),
    ("tts_start", "tts_end", "TTS (MOSS)"),
    ("playback_start", "playback_end", "PLAYBACK on box"),
]


def print_record(rec):
    print("=" * 70)
    print(f"{rec.get('timestamp','?')}  {rec.get('recording','?')}")
    if "error" in rec:
        print(f"  FAILED: {rec['error']}")
        return
    print(f"  you said:  {rec.get('transcript','')!r}")
    print(f"  assistant: {rec.get('reply','')!r}")
    stages = rec.get("stages_epoch_ms", {})
    if not stages:
        print("  (no stage timestamps recorded — older log entry)")
        return
    t_first = stages.get("record_start", min(stages.values()))
    print(f"\n  {'stage':<32s} {'start(+ms)':>12s} {'end(+ms)':>12s} {'dur(ms)':>9s}")
    for start_k, end_k, label in STAGE_ORDER:
        s, e = stages.get(start_k), stages.get(end_k)
        if s is None or e is None:
            continue
        print(f"  {label:<32s} {s - t_first:>12d} {e - t_first:>12d} {e - s:>9d}")
    print(f"\n  expected audio duration: {rec.get('expected_audio_ms','?')}ms   "
         f"playback wall time: {rec.get('playback_wall_ms','?')}ms")
    if rec.get("stutter_risk"):
        print("  ** STUTTER RISK: playback took notably longer than the audio itself —")
        print("     likely a WiFi throughput stall / I2S buffer underrun on the box, not normal speech pacing.")
    total = stages.get("playback_end", 0) - t_first
    print(f"\n  TOTAL end-to-end: {total}ms")


def main():
    show_all = "--all" in sys.argv
    if not os.path.exists(LOG_PATH):
        print(f"No log yet at {LOG_PATH} — ask the box something first.")
        return

    if show_all:
        with open(LOG_PATH) as f:
            for line in f:
                try:
                    print_record(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return

    print(f"Following {LOG_PATH} — ask the box something (Ctrl-C to stop).\n")
    with open(LOG_PATH) as f:
        f.seek(0, os.SEEK_END)
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.3)
                continue
            try:
                print_record(json.loads(line))
            except json.JSONDecodeError:
                pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
