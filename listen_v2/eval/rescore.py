#!/usr/bin/env python3
"""Re-score already-collected offline_rerun_*.json results with an improved
normalizer (handles hyphens, more number words) — no need to re-run whisper."""
import sys, re, json, string

NUM_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "hundred": "100", "thousand": "1000",
}

def normalize(text):
    text = text.lower().strip()
    text = text.replace("-", " ")   # "to-do" == "to do"
    text = text.replace("+", " plus ")   # "2+2" == "2 plus 2", not "22"
    text = text.translate(str.maketrans("", "", string.punctuation))
    text = re.sub(r"\s+", " ", text)
    words = [NUM_WORDS.get(w, w) for w in text.split()]
    return " ".join(words)

def word_edit_distance(ref_words, hyp_words):
    n, m = len(ref_words), len(hyp_words)
    dp = [[0]*(m+1) for _ in range(n+1)]
    for i in range(n+1): dp[i][0] = i
    for j in range(m+1): dp[0][j] = j
    for i in range(1, n+1):
        for j in range(1, m+1):
            dp[i][j] = dp[i-1][j-1] if ref_words[i-1]==hyp_words[j-1] else 1+min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1])
    return dp[n][m]

for path in sys.argv[1:]:
    data = json.load(open(path))
    total_edits = total_words = correct = 0
    misses = []
    for p in data["per_command"]:
        ref = normalize(p["expected"]); hyp = normalize(p.get("hyp", p.get("actual","")))
        rw, hw = ref.split(), hyp.split()
        e = word_edit_distance(rw, hw)
        total_edits += e; total_words += len(rw)
        if ref == hyp: correct += 1
        else: misses.append((p["expected"], p.get("hyp", p.get("actual",""))))
    n = len(data["per_command"])
    print(f"{data['label']:20s}  WER={total_edits/max(total_words,1):.3f}  Accuracy={correct/n*100:.1f}%  ({correct}/{n})")
    for e,h in misses[:8]:
        print(f"    expected={e!r:40s} got={h!r}")
