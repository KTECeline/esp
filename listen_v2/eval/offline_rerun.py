#!/usr/bin/env python3
"""Re-run STT accuracy against ALREADY-SAVED recordings — no box needed.

Uses eval/wav_expected_mapping.json (built once from a real test run) to pair
each saved WAV with its known expected phrase, re-transcribes every one with
a given whisper model + settings, and reports WER / accuracy. Lets us iterate
on STT quality entirely offline and only go back to the physical box for a
final confirmation once we've picked the best setup.

Usage:
    python3 offline_rerun.py <model_path> [--normalize] [--label NAME]

Example:
    python3 offline_rerun.py ~/whisper.cpp/models/ggml-small.en.bin --label small.en
"""
import sys, os, re, json, string, subprocess, argparse, time

HERE = os.path.dirname(os.path.abspath(__file__))
BOX_DIR = os.path.dirname(HERE)
MAPPING_PATH = os.path.join(HERE, "wav_expected_mapping.json")
WHISPER_BIN = os.path.expanduser("~/esp/whisper.cpp/build/bin/whisper-cli")


NUM_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
}

def normalize(text):
    text = text.lower().strip()
    text = text.translate(str.maketrans("", "", string.punctuation))
    text = re.sub(r"\s+", " ", text)
    # Whisper writing "5" vs the reference saying "five" is a formatting
    # difference, not a transcription error — score them as equal.
    words = [NUM_WORDS.get(w, w) for w in text.split()]
    return " ".join(words)


def word_edit_distance(ref_words, hyp_words):
    n, m = len(ref_words), len(hyp_words)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref_words[i - 1] == hyp_words[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    return dp[n][m]


def transcribe(model_path, wav_path, do_normalize, beam_size=None,
               language="en", prompt=None):
    audio_path = wav_path
    if do_normalize:
        norm_path = "/tmp/offline_rerun_norm.wav"
        subprocess.run(["sox", wav_path, norm_path, "norm", "-3"],
                       check=True, capture_output=True)
        audio_path = norm_path
    args = [WHISPER_BIN, "-m", model_path, "-f", audio_path, "-ng", "-nt", "-l", language]
    if prompt:
        # Bias the decoder toward menu / Manglish vocabulary. carry-initial-prompt
        # keeps the bias on every 30s window, not just the first.
        args += ["--prompt", prompt, "--carry-initial-prompt"]
    if beam_size:
        args += ["-bs", str(beam_size)]
    out = subprocess.run(args, capture_output=True, text=True, timeout=120)
    return out.stdout.replace("\n", "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_path")
    ap.add_argument("--normalize", action="store_true", help="sox norm -3 before transcribing")
    ap.add_argument("--beam-size", type=int, default=None)
    ap.add_argument("--label", default=None)
    ap.add_argument("--limit", type=int, default=None, help="only test the first N recordings (quick iteration)")
    ap.add_argument("--mapping", default=MAPPING_PATH, help="path to a wav_expected_mapping*.json file")
    ap.add_argument("--language", default="en", help="whisper language code: 'en', 'ms', or 'auto' (default: en)")
    ap.add_argument("--prompt", default=None, help="initial-prompt string to bias decoding")
    ap.add_argument("--prompt-file", default=None, help="read the initial prompt from a file")
    args = ap.parse_args()

    prompt = args.prompt
    if args.prompt_file:
        prompt = open(args.prompt_file).read().strip()

    label = args.label or os.path.basename(args.model_path)
    mapping = json.load(open(args.mapping))
    if args.limit:
        mapping = mapping[:args.limit]

    total_edits = 0
    total_words = 0
    correct = 0
    per_command = []
    t0 = time.time()

    for i, m in enumerate(mapping, 1):
        wav_path = os.path.join(BOX_DIR, m["wav"])
        if not os.path.exists(wav_path):
            continue
        hyp = transcribe(args.model_path, wav_path, args.normalize, args.beam_size,
                         language=args.language, prompt=prompt)
        ref_norm = normalize(m["expected"])
        hyp_norm = normalize(hyp)
        ref_words, hyp_words = ref_norm.split(), hyp_norm.split()
        edits = word_edit_distance(ref_words, hyp_words)
        total_edits += edits
        total_words += len(ref_words)
        is_correct = ref_norm == hyp_norm
        if is_correct:
            correct += 1
        per_command.append({"wav": m["wav"], "expected": m["expected"], "hyp": hyp,
                            "wer": round(edits / max(len(ref_words), 1), 3), "correct": is_correct})
        if i % 20 == 0:
            print(f"  ...{i}/{len(mapping)}")

    elapsed = time.time() - t0
    wer = total_edits / max(total_words, 1)
    accuracy = correct / len(mapping)

    print(f"\n=== {label} ===")
    print(f"n={len(mapping)}  WER={wer:.3f}  Accuracy={accuracy*100:.1f}%  ({correct}/{len(mapping)})")
    print(f"Time: {elapsed:.1f}s  ({elapsed/len(mapping):.2f}s/clip)")

    out_path = os.path.join(HERE, f"offline_rerun_{label.replace('/', '_')}.json")
    json.dump({"label": label, "wer": wer, "accuracy": accuracy, "n": len(mapping),
              "elapsed_s": elapsed, "per_command": per_command}, open(out_path, "w"), indent=2)
    print(f"Saved: {out_path}")

    # Show the misses for quick eyeballing
    misses = [p for p in per_command if not p["correct"]]
    if misses:
        print(f"\n{len(misses)} misses:")
        for p in misses[:20]:
            print(f"  expected={p['expected']!r:45s} got={p['hyp']!r}")


if __name__ == "__main__":
    main()
