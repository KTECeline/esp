#!/usr/bin/env python3
"""Score a filled-in TTS ratings CSV into Mean Opinion Scores (MOS).

Usage:
    python3 tts_score_mos.py [tts_ratings_template.csv]

Reports per-category MOS (naturalness, clarity, pronunciation) averaged over
all participants and clips, plus per-clip breakdowns and standard deviation.
"""
import sys, os, csv, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CSV = os.path.join(HERE, "tts_ratings_template.csv")
CATEGORIES = ["naturalness_1to5", "clarity_1to5", "pronunciation_1to5"]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if all(row.get(c, "").strip() for c in CATEGORIES):
                rows.append(row)

    if not rows:
        print("No fully-filled rows found — make sure all three score columns are filled in.")
        return

    print(f"Loaded {len(rows)} completed ratings from {path}\n")

    # Overall MOS per category
    print("=" * 50)
    print("OVERALL MOS (across all clips and participants)")
    print("=" * 50)
    for cat in CATEGORIES:
        vals = [float(r[cat]) for r in rows]
        mean = statistics.mean(vals)
        stdev = statistics.stdev(vals) if len(vals) > 1 else 0.0
        label = cat.replace("_1to5", "").capitalize()
        print(f"  {label:15s}: MOS = {mean:.2f}  (stdev {stdev:.2f}, n={len(vals)})")

    # Per-clip breakdown
    print("\nPer-clip breakdown:")
    clip_ids = sorted(set(r["clip_id"] for r in rows))
    for clip_id in clip_ids:
        clip_rows = [r for r in rows if r["clip_id"] == clip_id]
        line = f"  {clip_id}: "
        for cat in CATEGORIES:
            vals = [float(r[cat]) for r in clip_rows]
            mean = statistics.mean(vals)
            label = cat.replace("_1to5", "")[:4]
            line += f"{label}={mean:.2f}  "
        line += f"(n={len(clip_rows)})"
        print(line)


if __name__ == "__main__":
    main()
