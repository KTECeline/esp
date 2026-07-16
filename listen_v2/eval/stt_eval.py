#!/usr/bin/env python3
"""Guided STT accuracy evaluation for the BOX-3 voice pipeline.

Reads a list of commands, prompts you to speak each one into the box (press
BOOT after each prompt), waits for the corresponding transcript to show up in
~/esp/mcp-core/interaction_log.jsonl (written automatically by
mcp-core/server.js), and pairs (expected, actual) for scoring.

Reports:
  - Word Error Rate (WER), aggregate and per-command
  - Command Recognition Accuracy (% transcribed correctly, normalized match)

Usage:
    python3 stt_eval.py [command_list.txt]
Defaults to stt_test_commands.txt in this folder. Requires the full stack
(ollama, MOSS, restaurant agent, mcp-core) already running and the
box on and connected. Ctrl-C at any prompt to stop early and score what you have.
"""
import sys, os, re, json, time, string

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.environ.get(
    "INTERACTION_LOG",
    os.path.expanduser("~/esp/mcp-core/interaction_log.jsonl"))
DEFAULT_LIST = os.path.join(HERE, "stt_test_commands.txt")


def load_commands(path):
    cmds = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                cmds.append(line)
    return cmds


NUM_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
}

def normalize(text):
    text = text.lower().strip()
    text = text.translate(str.maketrans("", "", string.punctuation))
    text = re.sub(r"\s+", " ", text)
    # "5" vs "five" is a formatting difference, not a transcription error.
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


def wait_for_next_log_entry(after_ts, timeout=90):
    """Poll interaction_log.jsonl for the first entry newer than after_ts.

    Full round trip (record -> upload -> STT -> LLM -> TTS -> box playback)
    routinely takes 15-25s+, so this needs real headroom, not a tight timeout.
    """
    start = time.time()
    seen_size = os.path.getsize(LOG_PATH) if os.path.exists(LOG_PATH) else 0
    last_tick = 0
    while time.time() - start < timeout:
        elapsed = time.time() - start
        if int(elapsed) // 10 > last_tick:
            last_tick = int(elapsed) // 10
            print(f"    ...still waiting ({int(elapsed)}s)")
        if os.path.exists(LOG_PATH):
            size = os.path.getsize(LOG_PATH)
            if size > seen_size:
                with open(LOG_PATH) as f:
                    lines = f.readlines()
                for line in reversed(lines):
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    rec_ts = time.mktime(time.strptime(rec["timestamp"][:19], "%Y-%m-%dT%H:%M:%S"))
                    if rec_ts >= after_ts and "transcript" in rec:
                        return rec
        time.sleep(0.5)
    return None


def main():
    cmd_list_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LIST
    commands = load_commands(cmd_list_path)
    print(f"Loaded {len(commands)} test commands from {cmd_list_path}")
    print("For each one: read it aloud to the box, press BOOT, then wait.")
    print("Ctrl-C to stop early and score what's collected so far.\n")

    results = []
    try:
        for i, expected in enumerate(commands, 1):
            print(f"[{i}/{len(commands)}] SAY: \"{expected}\"  (press BOOT now)")
            t_prompt = time.time()
            rec = wait_for_next_log_entry(t_prompt)
            if rec is None:
                print("    (timed out waiting for a recording — skipping)\n")
                continue
            actual = rec.get("transcript", "")
            print(f"    heard: {actual!r}\n")
            results.append({"expected": expected, "actual": actual,
                            "latency_ms": rec.get("latency_ms", {})})
    except KeyboardInterrupt:
        print("\nStopped early — scoring what was collected.\n")

    if not results:
        print("No results collected, nothing to score.")
        return

    total_ref_words = 0
    total_edits = 0
    correct = 0
    per_command = []
    for r in results:
        ref_norm = normalize(r["expected"])
        hyp_norm = normalize(r["actual"])
        ref_words = ref_norm.split()
        hyp_words = hyp_norm.split()
        edits = word_edit_distance(ref_words, hyp_words)
        total_ref_words += len(ref_words)
        total_edits += edits
        is_correct = ref_norm == hyp_norm
        if is_correct:
            correct += 1
        per_command.append({
            "expected": r["expected"], "actual": r["actual"],
            "wer": round(edits / max(len(ref_words), 1), 3),
            "correct": is_correct,
        })

    wer = total_edits / max(total_ref_words, 1)
    accuracy = correct / len(results)

    print("=" * 60)
    print(f"Commands tested:            {len(results)}")
    print(f"Word Error Rate (WER):       {wer:.3f}  ({total_edits} edits / {total_ref_words} words)")
    print(f"Command Recognition Accuracy: {accuracy*100:.1f}%  ({correct}/{len(results)} exact matches)")
    print("=" * 60)

    # Latency stats, free bonus from the same test run.
    lat_keys = ["bridge_stt-ms", "bridge_llm-ms", "bridge_tts-ms", "bridge_total-ms",
               "downmix", "box_post", "end_to_end"]
    lat_samples = {k: [] for k in lat_keys}
    for r in results:
        for k in lat_keys:
            v = r.get("latency_ms", {}).get(k)
            if v is not None:
                lat_samples[k].append(v)
    if any(lat_samples.values()):
        print("\nLatency (ms), mean over collected samples:")
        for k in lat_keys:
            vals = lat_samples[k]
            if vals:
                mean = sum(vals) / len(vals)
                print(f"  {k:16s}: mean={mean:8.0f}  min={min(vals):8.0f}  max={max(vals):8.0f}  (n={len(vals)})")
    print("\nPer-command breakdown:")
    for pc in per_command:
        mark = "OK  " if pc["correct"] else "MISS"
        print(f"  [{mark}] wer={pc['wer']:.2f}  expected={pc['expected']!r}  actual={pc['actual']!r}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    report_path = os.path.join(HERE, f"stt_eval_report_{ts}.json")
    with open(report_path, "w") as f:
        json.dump({"wer": wer, "accuracy": accuracy, "n": len(results),
                  "latency_ms_samples": lat_samples,
                  "per_command": per_command}, f, indent=2)
    print(f"\nSaved full report to {report_path}")


if __name__ == "__main__":
    main()
