"""Score every embedded candidate model against the hand labels.

For each model with embeddings in data/emb/<model>/ it reports, on labelled frames only
(`unsure` excluded):

* zero-shot — today's detector: best highlight-prompt similarity minus mean idle-prompt
  similarity, robust-z'd per recording and lightly smoothed (recordings.highlights.ts);
* probe — a logistic regression on the frozen embeddings, cross-validated leave-channel-out
  so a stream never trains and tests at once (its room, light and camera would leak);
* probe+ctx — the same with the mean of the ±2 neighbouring frames appended, which lets the
  probe use the 20 s around a frame.

Binary target: `--positive` labels (default nude,explicit) against everything else.
Clip metrics replay the production clipper over each score and measure how much proposed
clip time is really positive (precision) and how much positive time is covered (recall).

  uv run python evaluate.py [--positive tease,nude,explicit] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, balanced_accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CLASSES = ("idle", "tease", "nude", "explicit")
INTERVAL = 5.0


def load_labels() -> dict[int, dict[int, str]]:
    db = sqlite3.connect(os.environ.get("LABELS_DB", DATA / "labels.sqlite"))
    out: dict[int, dict[int, str]] = {}
    for video_id, frame, label in db.execute(
        "select video_id, frame_index, label from frame_labels where label != 'unsure'"
    ):
        out.setdefault(video_id, {})[frame] = label
    return out


def channels() -> dict[int, str]:
    import re

    import psycopg

    from label_server import PG

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            "select v.id, v.file_name from recording_reviews r join videos v on v.id = r.video_id"
        ).fetchall()
    return {video_id: re.sub(r"_\d{4}-\d\d-\d\d.*", "", name) for video_id, name in rows}


def robust_z(values: np.ndarray) -> np.ndarray:
    center = np.median(values)
    spread = 1.4826 * np.median(np.abs(values - center)) or 1e-6
    return (values - center) / spread


def smooth(values: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return values
    # Window means via cumulative sums; windows shrink at the edges (and for short recordings).
    cumulative = np.concatenate([[0.0], np.cumsum(values)])
    index = np.arange(len(values))
    low = np.maximum(0, index - radius)
    high = np.minimum(len(values), index + radius + 1)
    return (cumulative[high] - cumulative[low]) / (high - low)


def context(matrix: np.ndarray, radius: int = 2) -> np.ndarray:
    """Each frame's embedding with the mean of its ±radius neighbours appended."""
    cumulative = np.concatenate([np.zeros((1, matrix.shape[1])), np.cumsum(matrix, axis=0)])
    index = np.arange(len(matrix))
    low, high = np.maximum(0, index - radius), np.minimum(len(matrix), index + radius + 1)
    neighbours = (cumulative[high] - cumulative[low]) / (high - low)[:, None]
    return np.concatenate([matrix, neighbours], axis=1)


def clips_from(scores: np.ndarray, threshold: float, gap=35.0, min_seconds=20.0, pad=10.0):
    """Production clipper: runs above threshold, merged across gaps, padded, overlaps joined."""
    runs: list[list[int]] = []
    for index in np.flatnonzero(scores >= threshold):
        if runs and (index - runs[-1][1]) * INTERVAL <= gap:
            runs[-1][1] = index
        else:
            runs.append([index, index])
    spans: list[list[float]] = []
    for start, end in runs:
        begin, finish = start * INTERVAL, (end + 1) * INTERVAL
        if finish - begin < min_seconds:
            continue
        begin, finish = max(0.0, begin - pad), finish + pad
        if spans and begin <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], finish)
        else:
            spans.append([begin, finish])
    return spans


def clip_metrics(per_video: dict[int, tuple[np.ndarray, dict[int, int]]], threshold: float):
    """Time precision/recall of proposed clips against labelled positive frames."""
    covered_pos = covered_all = positives = 0
    for scores, truth in per_video.values():
        mask = np.zeros(len(scores), dtype=bool)
        for begin, finish in clips_from(scores, threshold):
            mask[int(begin // INTERVAL) : int(np.ceil(finish / INTERVAL))] = True
        for frame, positive in truth.items():
            if frame >= len(mask):
                continue
            positives += positive
            if mask[frame]:
                covered_all += 1
                covered_pos += positive
    precision = covered_pos / covered_all if covered_all else 0.0
    recall = covered_pos / positives if positives else 0.0
    return precision, recall


def best_clip_threshold(per_video, candidates) -> tuple[float, float, float, float]:
    """Threshold maximising clip F1 — reported so methods compare at their own best setting."""
    best = (0.0, 0.0, 0.0, -1.0)
    for threshold in candidates:
        precision, recall = clip_metrics(per_video, threshold)
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        if f1 > best[3]:
            best = (threshold, precision, recall, f1)
    return best


def evaluate_model(model: str, labels, channel_of, positive: set[str]) -> dict | None:
    folder = DATA / "emb" / model
    text = json.loads((folder / "text.json").read_text())
    videos = [v for v in labels if (folder / f"{v}.npy").exists()]
    if not videos:
        return None
    vec = {k: np.array(v, dtype=np.float32) for k, v in text["vectors"].items()}
    highlight = np.stack([vec[p] for c in ("tease", "nude", "explicit") for p in text["prompts"][c]])
    idle = np.stack([vec[p] for p in text["prompts"]["idle"]])

    X, Xc, y4, groups, video_of, frame_of, zero = [], [], [], [], [], [], []
    full: dict[int, np.ndarray] = {}
    for video_id in videos:
        matrix = np.load(folder / f"{video_id}.npy").astype(np.float32)
        full[video_id] = matrix
        raw = (matrix @ highlight.T).max(1) - (matrix @ idle.T).mean(1)
        z = smooth(robust_z(raw), 1)
        withctx = context(matrix)
        for frame, label in labels[video_id].items():
            if frame >= len(matrix):
                continue
            X.append(matrix[frame]); Xc.append(withctx[frame]); y4.append(CLASSES.index(label))
            groups.append(channel_of.get(video_id, str(video_id)))
            video_of.append(video_id); frame_of.append(frame); zero.append(z[frame])
    X, Xc, y4 = np.array(X), np.array(Xc), np.array(y4)
    y = np.isin(y4, [CLASSES.index(c) for c in positive]).astype(int)
    zero = np.array(zero)
    groups, video_of, frame_of = np.array(groups), np.array(video_of), np.array(frame_of)
    result = {"model": model, "frames": int(len(y)), "positives": int(y.sum()),
              "videos": len(videos), "channels": int(len(set(groups)))}
    if len(set(y)) < 2:
        result["error"] = "need both positive and negative labels"
        return result

    result["zero_shot"] = {"auroc": roc_auc_score(y, zero), "ap": average_precision_score(y, zero)}

    folds = min(5, len(set(groups)))
    for name, features in (("probe", X), ("probe+ctx", Xc)):
        if folds < 2:
            break
        prob = np.zeros(len(y))
        pred4 = np.zeros(len(y), dtype=int)
        for train, test in GroupKFold(n_splits=folds).split(features, y, groups):
            if len(set(y[train])) < 2:
                prob[test] = y[train].mean()
                continue
            binary = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced")
            binary.fit(features[train], y[train])
            prob[test] = binary.predict_proba(features[test])[:, 1]
            if len(set(y4[train])) > 1:
                multi = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced")
                multi.fit(features[train], y4[train])
                pred4[test] = multi.predict(features[test])
        result[name] = {
            "auroc": roc_auc_score(y, prob),
            "ap": average_precision_score(y, prob),
            "balanced_acc_4class": balanced_accuracy_score(y4, pred4),
        }
        # Out-of-fold probabilities only exist for labelled frames, so clip metrics for the
        # probe use a model fit on the other channels and applied to the whole recording.
        if name == "probe":
            per_video = {}
            for held in set(groups):
                train = groups != held
                if len(set(y[train])) < 2:
                    continue
                model_fit = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced")
                model_fit.fit(X[train], y[train])
                for video_id in set(video_of[groups == held]):
                    scores = smooth(model_fit.predict_proba(full[video_id])[:, 1], 1)
                    truth = {int(f): int(t) for f, t, v in zip(frame_of, y, video_of) if v == video_id}
                    per_video[video_id] = (scores, truth)
            result["probe"]["clips"] = dict(zip(
                ("threshold", "precision", "recall", "f1"),
                best_clip_threshold(per_video, np.linspace(0.3, 0.9, 13)),
            ))

    per_video = {}
    for video_id in videos:
        matrix = full[video_id]
        raw = (matrix @ highlight.T).max(1) - (matrix @ idle.T).mean(1)
        truth = {int(f): int(t) for f, t, v in zip(frame_of, y, video_of) if v == video_id}
        per_video[video_id] = (smooth(robust_z(raw), 1), truth)
    result["zero_shot"]["clips_at_1.0"] = dict(zip(("precision", "recall"), clip_metrics(per_video, 1.0)))
    result["zero_shot"]["clips"] = dict(zip(
        ("threshold", "precision", "recall", "f1"),
        best_clip_threshold(per_video, np.linspace(0.5, 3.0, 11)),
    ))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--positive", default="nude,explicit")
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    positive = set(args.positive.split(","))
    labels = load_labels()
    channel_of = channels()
    results = []
    for folder in sorted((DATA / "emb").iterdir()):
        result = evaluate_model(folder.name, labels, channel_of, positive)
        if result:
            results.append(result)

    def cell(block, key):
        return f"{block[key]:.3f}" if block and key in block else "  —  "

    print(f"positive = {sorted(positive)}")
    print(f"{'model':22} {'frames':>6} {'pos':>5} {'ch':>3} | {'ZS AP':>6} {'ZS AUC':>6} | "
          f"{'probe AP':>8} {'AUC':>6} {'acc4':>6} | {'ctx AP':>6} {'acc4':>6} | clip P/R (ZS@1.0 → probe best)")
    for r in results:
        if "error" in r:
            print(f"{r['model']:22} {r['frames']:>6} {r['positives']:>5} — {r['error']}")
            continue
        zs, pr, cx = r["zero_shot"], r.get("probe"), r.get("probe+ctx")
        clips = f"{zs['clips_at_1.0']['precision']:.2f}/{zs['clips_at_1.0']['recall']:.2f}"
        if pr and "clips" in pr:
            clips += f" → {pr['clips']['precision']:.2f}/{pr['clips']['recall']:.2f}"
        print(f"{r['model']:22} {r['frames']:>6} {r['positives']:>5} {r['channels']:>3} | "
              f"{cell(zs, 'ap'):>6} {cell(zs, 'auroc'):>6} | {cell(pr, 'ap'):>8} {cell(pr, 'auroc'):>6} "
              f"{cell(pr, 'balanced_acc_4class'):>6} | {cell(cx, 'ap'):>6} {cell(cx, 'balanced_acc_4class'):>6} | {clips}")
    if args.json:
        args.json.write_text(json.dumps(results, indent=2, default=float))


if __name__ == "__main__":
    main()
