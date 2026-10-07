"""How much does probe quality improve with more labelled channels?

For a growing number of training channels (random subsets, repeated), fit the logistic probe and
score it on the held-out channels. A curve still climbing at the right edge means more labels
pay off; a flat one means they won't.

  uv run python learning_curve.py <model> [--positive nude,explicit]
"""

from __future__ import annotations

import argparse

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

from evaluate import CLASSES, DATA, channels, load_labels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("--positive", default="nude,explicit")
    parser.add_argument("--repeats", type=int, default=12)
    args = parser.parse_args()
    positive = [CLASSES.index(c) for c in args.positive.split(",")]
    labels, channel_of = load_labels(), channels()
    X, y, groups = [], [], []
    for video_id, frames in labels.items():
        path = DATA / "emb" / args.model / f"{video_id}.npy"
        if not path.exists():
            continue
        matrix = np.load(path).astype(np.float32)
        for frame, label in frames.items():
            if frame < len(matrix):
                X.append(matrix[frame]); y.append(int(CLASSES.index(label) in positive))
                groups.append(channel_of[video_id])
    X, y, groups = np.array(X), np.array(y), np.array(groups)
    names = sorted(set(groups))
    rng = np.random.default_rng(0)
    print(f"{args.model}: {len(y)} frames, {len(names)} channels")
    for size in (3, 6, 9, 12, 15, len(names) - 2):
        aps, aucs = [], []
        for _ in range(args.repeats):
            train_names = set(rng.choice(names, size=size, replace=False))
            train = np.isin(groups, list(train_names))
            test = ~train
            if len(set(y[train])) < 2 or len(set(y[test])) < 2:
                continue
            probe = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced").fit(X[train], y[train])
            scores = probe.predict_proba(X[test])[:, 1]
            aps.append(average_precision_score(y[test], scores)); aucs.append(roc_auc_score(y[test], scores))
        print(f"  train on {size:>2} channels: AP {np.mean(aps):.3f} ± {np.std(aps):.3f}   AUROC {np.mean(aucs):.3f}")


if __name__ == "__main__":
    main()
