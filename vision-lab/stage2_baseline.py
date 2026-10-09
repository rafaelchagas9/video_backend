"""The Stage 2 ordering baseline: proposal length plus detector score.

Fits a two-feature logistic model of Keep on the trained detector's proposals (latest generation,
added and merged-away rows left out) and scores how well it orders proposals, on channel-held-out
folds. The backend ships the fitted coefficients as `baseline-v1`; any Stage 2 ranker has to beat
these numbers on the same folds.

  uv run python stage2_baseline.py          # prints the report, writes data/stage2_baseline.json
"""

from __future__ import annotations

import json
import math
from collections import defaultdict

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

import deployed_data as dd
from label_server import DATA

FOLDS = 5


def length_of(clip: dd.Clip) -> float:
    start = clip.detected_start if clip.detected_start is not None else clip.start
    end = clip.detected_end if clip.detected_end is not None else clip.end
    return max(1.0, end - start)


def features(clips: list[dd.Clip]) -> np.ndarray:
    return np.array([[math.log(length_of(clip)), clip.score] for clip in clips])


def channel_folds(clips: list[dd.Clip]) -> np.ndarray:
    """Whole channels per fold, greedily balanced by decision count."""
    counts: dict[str, int] = defaultdict(int)
    for clip in clips:
        counts[clip.channel or f"video-{clip.video_id}"] += 1
    load = [0] * FOLDS
    fold_of: dict[str, int] = {}
    for channel, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        fold = int(np.argmin(load))
        fold_of[channel] = fold
        load[fold] += count
    return np.array([fold_of[clip.channel or f"video-{clip.video_id}"] for clip in clips])


def pairwise(clips: list[dd.Clip], scores: np.ndarray) -> tuple[int, int]:
    """Kept-vs-skipped pairs inside one recording that the scores order correctly (ties count half)."""
    by_video: dict[int, list[int]] = defaultdict(list)
    for index, clip in enumerate(clips):
        by_video[clip.video_id].append(index)
    right = total = 0.0
    for indices in by_video.values():
        kept = [i for i in indices if clips[i].keep]
        skipped = [i for i in indices if not clips[i].keep]
        for k in kept:
            for s in skipped:
                total += 1
                right += 1.0 if scores[k] > scores[s] else 0.5 if scores[k] == scores[s] else 0.0
    return right, total


def top1(clips: list[dd.Clip], scores: np.ndarray) -> tuple[int, int]:
    """Recordings with a keep whose top-scored proposal was kept."""
    by_video: dict[int, list[int]] = defaultdict(list)
    for index, clip in enumerate(clips):
        by_video[clip.video_id].append(index)
    hits = recordings = 0
    for indices in by_video.values():
        if len(indices) < 2 or not any(clips[i].keep for i in indices):
            continue
        recordings += 1
        hits += clips[max(indices, key=lambda i: scores[i])].keep
    return hits, recordings


def main() -> None:
    clips = [c for c in dd.latest_clips() if c.model and not c.added]
    y = np.array([c.keep for c in clips], dtype=int)
    X = features(clips)
    folds = channel_folds(clips)
    held_out = np.zeros(len(clips))
    for fold in range(FOLDS):
        train = folds != fold
        model = LogisticRegression(C=1.0).fit(X[train], y[train])
        held_out[~train] = model.decision_function(X[~train])
    final = LogisticRegression(C=1.0).fit(X, y)

    rankers = {
        "length + score (held-out channels)": held_out,
        "score only": X[:, 1],
        "length only": X[:, 0],
        "timeline order": -np.array([c.start for c in clips]),
    }
    print(f"{len(clips)} decisions, {y.sum()} kept, {len({c.video_id for c in clips})} recordings, "
          f"{len({c.channel for c in clips})} channels\n")
    print("| ranker | AUROC | within-recording pairs | top proposal kept |")
    print("|---|---|---|---|")
    report = {}
    for name, scores in rankers.items():
        auc = roc_auc_score(y, scores)
        right, total = pairwise(clips, scores)
        hits, recordings = top1(clips, scores)
        report[name] = {"auroc": auc, "pairs": [right, total], "top1": [hits, recordings]}
        print(f"| {name} | {auc:.3f} | {right / total:.0%} of {int(total)} | {hits}/{recordings} |")

    out = {
        "version": "baseline-v1",
        "features": ["ln(detected seconds)", "mean score"],
        "coef": [round(float(v), 4) for v in final.coef_[0]],
        "intercept": round(float(final.intercept_[0]), 4),
        "decisions": len(clips),
        "report": report,
    }
    (DATA / "stage2_baseline.json").write_text(json.dumps(out, indent=2))
    print(f"\nshipped: logit = {out['intercept']} + {out['coef'][0]}·ln(seconds) + {out['coef'][1]}·score")


if __name__ == "__main__":
    main()
