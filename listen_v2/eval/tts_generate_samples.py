#!/usr/bin/env python3
"""Generate a batch of TTS clips for a human MOS (Mean Opinion Score) study.

Calls MOSS-TTS directly for each sentence in tts_test_sentences.txt, saves
numbered clips into ./tts_samples/, and writes a blank ratings CSV for your
10 participants to fill in (1 row per participant per clip).

Usage:
    python3 tts_generate_samples.py [sentence_list.txt]
Requires MOSS-TTS running on :8080 (uvicorn server:app).
"""
import sys, os, csv, json, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LIST = os.path.join(HERE, "tts_test_sentences.txt")
SAMPLES_DIR = os.path.join(HERE, "tts_samples")
TTS_URL = os.environ.get("TTS_URL", "http://localhost:8080/v1/audio/speech")
N_PARTICIPANTS = 10


def load_sentences(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(line)
    return out


def synthesize(text):
    body = json.dumps({"model": "tts-1", "input": text, "voice": "default"}).encode()
    req = urllib.request.Request(TTS_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def main():
    list_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LIST
    sentences = load_sentences(list_path)
    os.makedirs(SAMPLES_DIR, exist_ok=True)
    print(f"Generating {len(sentences)} clips from {list_path} -> {SAMPLES_DIR}/")

    manifest = []
    for i, text in enumerate(sentences, 1):
        clip_id = f"clip_{i:03d}"
        fn = os.path.join(SAMPLES_DIR, f"{clip_id}.wav")
        print(f"  [{i}/{len(sentences)}] {text[:50]!r}...")
        try:
            wav = synthesize(text)
            with open(fn, "wb") as f:
                f.write(wav)
            manifest.append({"clip_id": clip_id, "text": text, "bytes": len(wav)})
        except Exception as e:
            print(f"    FAILED: {e}")

    manifest_path = os.path.join(HERE, "tts_manifest.csv")
    with open(manifest_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["clip_id", "text", "bytes"])
        w.writeheader()
        w.writerows(manifest)
    print(f"\nWrote manifest: {manifest_path}")

    # Blank ratings template: one row per (participant, clip) to fill in.
    ratings_path = os.path.join(HERE, "tts_ratings_template.csv")
    with open(ratings_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["participant_id", "clip_id", "naturalness_1to5",
                   "clarity_1to5", "pronunciation_1to5"])
        for p in range(1, N_PARTICIPANTS + 1):
            for m in manifest:
                w.writerow([f"P{p}", m["clip_id"], "", "", ""])
    print(f"Wrote blank ratings template: {ratings_path}")
    print(f"\nNext steps:")
    print(f"  1. Have each of your {N_PARTICIPANTS} participants listen to the clips in {SAMPLES_DIR}/")
    print(f"     and fill in their scores (1-5) in {os.path.basename(ratings_path)}")
    print(f"  2. Run: python3 tts_score_mos.py {os.path.basename(ratings_path)}")


if __name__ == "__main__":
    main()
