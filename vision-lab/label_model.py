"""The labeler's own model: a probe on the SigLIP2 frame embeddings, retrained from the labels.

It powers two things in the UI:

* **Review** — runs of frames where the model, trained *without that stream*, confidently picks a
  different label than the stored one. Leaving the stream out means it can't just echo the
  labels back; a disagreement is either a model mistake or a label worth a second look.
* **Worth labelling next** — recordings that would teach the model most: unfinished ones,
  streams it handles badly, and streams where only one state has been labelled so far.

Training runs in a background thread and is keyed by the label version, so the UI always gets
the latest finished state immediately and a fresher one shortly after labels change.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

CLASSES = ("idle", "tease", "nude", "explicit")
POSITIVE = (2, 3)  # nude, explicit — what the highlight detector would clip
FOLDS = 5
# A run is shown when the model prefers its label by this margin (probability points) on average.
MIN_MARGIN = 0.5
MIN_RUN_FRAMES = 3
LONE_FRAME_MARGIN = 0.8


def context(matrix: np.ndarray, radius: int = 2) -> np.ndarray:
    """Each frame's embedding with the mean of its ±radius neighbours appended."""
    cumulative = np.concatenate([np.zeros((1, matrix.shape[1]), np.float32), np.cumsum(matrix, axis=0)])
    index = np.arange(len(matrix))
    low, high = np.maximum(0, index - radius), np.minimum(len(matrix), index + radius + 1)
    return np.concatenate([matrix, (cumulative[high] - cumulative[low]) / (high - low)[:, None]], axis=1)


def fit(X: np.ndarray, y: np.ndarray) -> LogisticRegression:
    return LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced").fit(X, y)


def full_probs(model: LogisticRegression, X: np.ndarray) -> np.ndarray:
    """Probabilities in CLASSES order even when a fold lacked a class."""
    out = np.zeros((len(X), len(CLASSES)), dtype=np.float32)
    out[:, model.classes_] = model.predict_proba(X)
    return out


@dataclass
class ModelState:
    version: tuple
    trained_at: float
    labelled_frames: int
    # (video_id) -> (n_frames, 4) out-of-fold probabilities, NaN where the frame is unlabelled.
    held_out: dict[int, np.ndarray] = field(default_factory=dict)
    # (video_id) -> (n_frames, 4) probabilities from a model trained on every label.
    predicted: dict[int, np.ndarray] = field(default_factory=dict)
    channel_auroc: dict[str, float] = field(default_factory=dict)


def train(version: tuple, recordings: dict[int, dict], embeddings, labels: dict[int, dict[int, str]]) -> ModelState:
    features = {vid: context(embeddings(vid)) for vid in recordings}
    rows, y, groups, where = [], [], [], []
    for vid, frames in labels.items():
        if vid not in features:
            continue
        for frame, label in frames.items():
            if label in CLASSES and frame < len(features[vid]):
                rows.append(features[vid][frame]); y.append(CLASSES.index(label))
                groups.append(recordings[vid]["channel"]); where.append((vid, frame))
    state = ModelState(version=version, trained_at=time.time(), labelled_frames=len(y))
    if len(set(y)) < 2 or len(set(groups)) < 2:
        return state
    X, y, groups = np.array(rows), np.array(y), np.array(groups)

    oof = np.zeros((len(y), len(CLASSES)), dtype=np.float32)
    for train_idx, test_idx in GroupKFold(n_splits=min(FOLDS, len(set(groups)))).split(X, y, groups):
        if len(set(y[train_idx])) < 2:
            continue
        oof[test_idx] = full_probs(fit(X[train_idx], y[train_idx]), X[test_idx])
    for vid in labels:
        if vid in features:
            state.held_out[vid] = np.full((len(features[vid]), len(CLASSES)), np.nan, dtype=np.float32)
    for (vid, frame), probs in zip(where, oof):
        state.held_out[vid][frame] = probs

    positive = np.isin(y, POSITIVE)
    score = oof[:, list(POSITIVE)].sum(1)
    for channel in set(groups):
        mask = groups == channel
        if len(set(positive[mask])) == 2:
            state.channel_auroc[str(channel)] = float(roc_auc_score(positive[mask], score[mask]))

    everything = fit(X, y)
    for vid, matrix in features.items():
        state.predicted[vid] = full_probs(everything, matrix)
    return state


class LabelModel:
    def __init__(self, recordings, embeddings, read_labels, version):
        self._recordings, self._embeddings = recordings, embeddings
        self._read_labels, self._version = read_labels, version
        self._state: ModelState | None = None
        self._training = False
        self._lock = threading.Lock()

    def state(self) -> tuple[ModelState | None, bool]:
        """Latest finished state and whether a fresher one is on its way."""
        version = self._version()
        with self._lock:
            current = self._state
            stale = current is None or current.version != version
            if stale and not self._training:
                self._training = True
                threading.Thread(target=self._train, args=(version,), daemon=True).start()
            return current, stale

    def _train(self, version: tuple) -> None:
        try:
            state = train(version, self._recordings(), self._embeddings, self._read_labels())
            with self._lock:
                self._state = state
        finally:
            with self._lock:
                self._training = False


def disagreements(state: ModelState, labels: dict[int, dict[int, str]], confirmed: set[tuple[int, int]]):
    """Runs of consecutive frames with one stored label and one confident other model label."""
    out = []
    for vid, probs in state.held_out.items():
        frames = labels.get(vid, {})
        run: dict | None = None

        def close():
            if run and (run["end"] - run["start"] + 1 >= MIN_RUN_FRAMES or run["margin"] / run["n"] >= LONE_FRAME_MARGIN):
                out.append(run)

        for frame in range(len(probs)):
            label = frames.get(frame)
            row = probs[frame]
            hit = None
            if label in CLASSES and (vid, frame) not in confirmed and not np.isnan(row[0]):
                top = int(np.argmax(row))
                margin = float(row[top] - row[CLASSES.index(label)])
                if top != CLASSES.index(label) and margin >= MIN_MARGIN:
                    hit = (label, CLASSES[top], margin, float(row[top]))
            if hit and run and run["yours"] == hit[0] and run["model"] == hit[1] and frame - run["end"] <= 2:
                run["end"] = frame; run["n"] += 1; run["margin"] += hit[2]; run["confidence"] += hit[3]
                run["frames"].append(frame)
            else:
                if hit or (run and frame - run["end"] > 2):
                    close()
                    run = None
                if hit:
                    run = {"video_id": vid, "start": frame, "end": frame, "yours": hit[0], "model": hit[1],
                           "n": 1, "margin": hit[2], "confidence": hit[3], "frames": [frame]}
        close()
    for item in out:
        item["confidence"] = round(item.pop("confidence") / item["n"], 3)
        item["margin"] = round(item["margin"] / item["n"], 3)
        item["score"] = item["margin"] * np.sqrt(item["n"])
    out.sort(key=lambda item: -item["score"])
    return out


def suggestions(state: ModelState | None, recordings: dict[int, dict], labels: dict[int, dict[int, str]]):
    """Unlabelled or unfinished recordings worth doing next, each with the reasons why."""
    by_channel: dict[str, set[str]] = {}
    for vid, frames in labels.items():
        if vid in recordings:
            by_channel.setdefault(recordings[vid]["channel"], set()).update(
                label for label in frames.values() if label in CLASSES)
    out = []
    for vid, rec in recordings.items():
        done = len(labels.get(vid, {}))
        reasons, score = [], 0.0
        channel = rec["channel"]
        if 0 < done < rec["count"]:
            reasons.append({"kind": "unfinished", "text": f"{round(100 * done / rec['count'])}% labelled"})
            score += 1
        if done == 0:
            seen = by_channel.get(channel, set())
            if not seen:
                reasons.append({"kind": "new", "text": "No labels from this stream yet"})
                score += 4
            auroc = state.channel_auroc.get(channel) if state else None
            if auroc is not None and auroc < 0.85:
                reasons.append({"kind": "weak", "text": f"Model struggles with this stream ({auroc:.2f})"})
                score += 3 + (0.85 - auroc) * 10
            if state and vid in state.predicted and len(seen) == 1:
                mix = state.predicted[vid].argmax(1)
                missing = [CLASSES[c] for c in range(len(CLASSES))
                           if CLASSES[c] not in seen and (mix == c).mean() >= 0.15]
                if missing:
                    reasons.append({"kind": "single", "text": f"Only {next(iter(seen))} labelled for this stream; "
                                    f"model expects {' and '.join(missing)} here"})
                    score += 2.5 + 0.5 * len(missing)
            if len(seen) == 1 and not any(r["kind"] == "single" for r in reasons):
                reasons.append({"kind": "single", "text": f"Only {next(iter(seen))} labelled for this stream"})
                score += 1.5
        if reasons:
            out.append({"video_id": vid, "reasons": reasons, "score": score})
    out.sort(key=lambda item: -item["score"])
    # Spread the list over streams: each stream's best recording first, then second-best.
    spread, taken = [], {}
    for round_ in range(2):
        for item in out:
            channel = recordings[item["video_id"]]["channel"]
            if taken.get(channel, 0) == round_ and item not in spread:
                spread.append(item)
                taken[channel] = round_ + 1
    return spread
