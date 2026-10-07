"""Train the highlight probe on every label and export it for the backend.

The backend scores recording frames with it (src/modules/recordings/recordings.probe.ts):
softmax(W · [frame, mean of the ±2 neighbouring frames] + b) over the four states. Both halves
of the feature are L2-normalised SigLIP2 so400m/16 @256 embeddings — the vectors production
already stores, so no re-indexing is needed.

  uv run python export_probe.py [--out ../data/models/recordings-highlight-probe.json]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from feedback import frames as feedback_frames
from hard_negatives import WEIGHT as NEGATIVE_WEIGHT, stored as stored_negatives
from label_model import CLASSES, context
from sklearn.linear_model import LogisticRegression
from label_server import DATA, BACKEND, RealSource, all_labels

MODEL_REVISION = "siglip2/so400m-patch16-256"
CONTEXT_RADIUS = 2


DEFAULT_OUT = BACKEND / "data" / "models" / "recordings-highlight-probe.json"


def export(out: Path = DEFAULT_OUT) -> dict:
    """Fit on every label and write the probe; the backend reloads it on its next analysis."""
    source = RealSource()
    recordings = source.recordings()
    rows, y = [], []
    labels = all_labels()
    for video_id, frames in labels.items():
        if video_id not in recordings:
            continue
        features = context(source.embeddings(video_id), CONTEXT_RADIUS)
        for frame, label in frames.items():
            if label in CLASSES and frame < len(features):
                rows.append(features[frame]); y.append(CLASSES.index(label))
    weights_per_row = [1.0] * len(y)
    # Frames of highlights the reviewer marked "Detector got it wrong" (hard_negatives.py --store).
    negatives = stored_negatives()
    for video_id, frames in negatives.items():
        _, vectors = feedback_frames(video_id)
        features = context(vectors, CONTEXT_RADIUS)
        for frame, label in frames.items():
            if frame < len(features):
                rows.append(features[frame]); y.append(CLASSES.index(label)); weights_per_row.append(NEGATIVE_WEIGHT)
    model = LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced").fit(
        np.array(rows), np.array(y), sample_weight=np.array(weights_per_row))
    weights = np.zeros((len(CLASSES), model.coef_.shape[1]), dtype=np.float64)
    bias = np.zeros(len(CLASSES), dtype=np.float64)
    weights[model.classes_] = model.coef_
    bias[model.classes_] = model.intercept_

    # Held-out (leave-channel-out) results from the last evaluate.py run, if there is one.
    metrics = None
    report = DATA / "eval_r2_nude_explicit.json"
    if report.exists():
        for entry in json.loads(report.read_text()):
            if entry["model"] == "siglip2-so400m-256":
                clips = entry["probe"]["clips"]
                metrics = {"auroc": round(entry["probe+ctx"]["auroc"], 3),
                           "clip_precision": round(clips["precision"], 3), "clip_recall": round(clips["recall"], 3)}

    payload = {
        "version": time.strftime("%Y%m%d%H%M%S"),
        "model_revision": MODEL_REVISION,
        "classes": list(CLASSES),
        "context_radius": CONTEXT_RADIUS,
        "dimension": int(weights.shape[1] // 2),
        "weights": weights.round(6).tolist(),
        "bias": bias.round(6).tolist(),
        "labelled_frames": len(y) - sum(len(frames) for frames in negatives.values()),
        "feedback_negatives": sum(len(frames) for frames in negatives.values()),
        "labelled_recordings": sum(1 for v in labels if v in recordings),
        "metrics": metrics,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload))
    return {key: payload[key] for key in ("version", "labelled_frames", "labelled_recordings", "metrics")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    summary = export(args.out)
    print(f"wrote {args.out} ({args.out.stat().st_size // 1024} KB): {summary}")


if __name__ == "__main__":
    main()
