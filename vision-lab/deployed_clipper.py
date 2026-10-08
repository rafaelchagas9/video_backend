"""The backend's trained-detector proposal path, ported line for line from TypeScript.

recordings.probe.ts (classifyFrames, probeThreshold) and recordings.highlights.ts
(detectWithProbe, shapeClips, isLikelySkip). `python deployed_clipper.py` replays the stored
probe files over the cached frames and compares the result with the proposals the backend
saved, so any drift between this port and production shows up as a mismatch.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from label_server import BACKEND

CLASSES = ("idle", "tease", "nude", "explicit")
MODELS = BACKEND / "data" / "models"
DEFAULTS = {"merge_gap": 35.0, "min_seconds": 20.0, "pad": 10.0, "max_clips": 24}
LIKELY_SKIP = {"max_seconds": 180.0, "min_score": 0.8}


def js_round(x: float) -> int:
    """Math.round: halves go up, unlike Python's round()."""
    return math.floor(x + 0.5)


def probe_threshold(sensitivity: float) -> float:
    return min(0.9, max(0.2, 0.55 + (sensitivity - 1.4) * 0.25))


def load_probe(version: str | None = None) -> dict:
    path = MODELS / (f"recordings-highlight-probe.{version}.json" if version else "recordings-highlight-probe.json")
    raw = json.loads(path.read_text())
    if version and raw["version"] != version:
        raise ValueError(f"{path.name} holds {raw['version']}")
    return {"version": raw["version"], "W": np.array(raw["weights"], np.float64), "b": np.array(raw["bias"], np.float64),
            "radius": int(raw["context_radius"]), "classes": raw["classes"]}


def context(vectors: np.ndarray, radius: int) -> np.ndarray:
    v = vectors.astype(np.float64)
    prefix = np.concatenate([np.zeros((1, v.shape[1])), np.cumsum(v, axis=0)])
    index = np.arange(len(v))
    low, high = np.maximum(0, index - radius), np.minimum(len(v), index + radius + 1)
    return np.concatenate([v, (prefix[high] - prefix[low]) / (high - low)[:, None]], axis=1)


def classify(W: np.ndarray, b: np.ndarray, features: np.ndarray) -> np.ndarray:
    """Softmax over the states; W may stack several probes as (models, classes, width)."""
    logits = features @ W.T + b if W.ndim == 2 else np.einsum("nd,mkd->mnk", features, W) + b[:, None, :]
    logits = logits - logits.max(-1, keepdims=True)
    e = np.exp(logits)
    return e / e.sum(-1, keepdims=True)


def smooth(values: np.ndarray, radius: int = 1) -> np.ndarray:
    kernel = np.ones(2 * radius + 1)
    return np.convolve(values, kernel, "same") / np.convolve(np.ones_like(values), kernel, "same")


def highlight_scores(probs: np.ndarray, states=("nude", "explicit")) -> np.ndarray:
    return smooth(probs[..., [CLASSES.index(s) for s in states]].sum(-1)) if probs.ndim == 2 else \
        np.stack([highlight_scores(p, states) for p in probs])


def shape_clips(timestamps: np.ndarray, scores: np.ndarray, threshold: float, duration: float | None,
                labels: list[str] | None = None, merge_gap=DEFAULTS["merge_gap"], min_seconds=DEFAULTS["min_seconds"],
                pad=DEFAULTS["pad"], max_clips=DEFAULTS["max_clips"]) -> list[dict]:
    n = len(scores)
    if n < 4:
        return []
    interval = (timestamps[-1] - timestamps[0]) / (n - 1) if n > 1 else 5.0
    runs: list[list[int]] = []
    for index in np.flatnonzero(scores >= threshold):
        if runs and timestamps[index] - timestamps[runs[-1][1]] <= merge_gap:
            runs[-1][1] = index
        else:
            runs.append([int(index), int(index)])
    clips = []
    limit = duration if duration else math.inf
    for a, z in runs:
        start, end = timestamps[a], timestamps[z] + interval
        if end - start < min_seconds:
            continue
        window = scores[a:z + 1]
        peak = a + int(np.argmax(window))  # first maximum, as the strict > in the TypeScript
        label = ""
        if labels is not None:
            votes: dict[str, float] = {}
            for i in range(a, z + 1):
                votes[labels[i]] = votes.get(labels[i], 0.0) + max(0.0, float(scores[i]))
            label = max(votes.items(), key=lambda kv: kv[1])[0]
        clip_start = max(0, js_round(start - pad))
        clip_end = min(limit, js_round(end + pad))
        if clip_end <= clip_start:
            continue
        clips.append({"start_seconds": clip_start, "end_seconds": clip_end, "peak_seconds": js_round(timestamps[peak]),
                      "score": js_round(float(window.mean()) * 100) / 100, "label": label})
    merged: list[dict] = []
    for clip in clips:
        if merged and clip["start_seconds"] <= merged[-1]["end_seconds"]:
            last = merged[-1]
            last["end_seconds"] = max(last["end_seconds"], clip["end_seconds"])
            if clip["score"] > last["score"]:
                last.update(score=clip["score"], peak_seconds=clip["peak_seconds"], label=clip["label"])
        else:
            merged.append(dict(clip))
    kept = sorted(merged, key=lambda c: -c["score"])[:max_clips]  # stable, like Array.sort
    return sorted(kept, key=lambda c: c["start_seconds"])


def likely_skip(clip: dict) -> bool:
    return clip["end_seconds"] - clip["start_seconds"] < LIKELY_SKIP["max_seconds"] and clip["score"] < LIKELY_SKIP["min_score"]


def detect(probe: dict, timestamps: np.ndarray, vectors: np.ndarray, duration: float | None, sensitivity: float = 1.0,
           states=("nude", "explicit")) -> list[dict]:
    """detectWithProbe for one stored probe."""
    probs = classify(probe["W"], probe["b"], context(vectors, probe["radius"]))
    columns = [CLASSES.index(s) for s in states]
    labels = [CLASSES[columns[int(np.argmax(row[columns]))]].capitalize() for row in probs]
    clips = shape_clips(timestamps, highlight_scores(probs, states), probe_threshold(sensitivity), duration, labels)
    for clip in clips:
        clip["keep"] = not likely_skip(clip)
    return clips


def stored_detections() -> dict[int, dict]:
    """Detected ranges per recording's current analysis: the review's clips (each keeps the range
    detection proposed) plus merged-away proposals from the feedback rows of that analysis."""
    import psycopg

    from label_server import PG

    out: dict[int, dict] = {}
    with psycopg.connect(PG) as pg:
        for vid, clips, revision, analyzed in pg.execute(
                "select video_id, clips, prompts_revision, analyzed_at from recording_reviews"):
            ranges = {(c["detected"]["start_seconds"], c["detected"]["end_seconds"]) for c in clips
                      if not c["id"].startswith("added-") and c.get("detected")}
            for a, b in pg.execute(
                    "select detected_start, detected_end from recording_clip_feedback where video_id = %s and analyzed_at = %s "
                    "and merged_into is not null and detected_start is not null", (vid, analyzed)):
                ranges.add((a, b))
            out[vid] = {"revision": revision, "ranges": sorted(ranges)}
    return out


def verify() -> None:
    import psycopg

    from deployed_data import frames, latest_clips
    from label_server import PG

    probes: dict[str, dict | None] = {}
    with psycopg.connect(PG) as pg:
        durations = dict(pg.execute("select id, duration_seconds from videos").fetchall())
    durations |= {c.video_id: c.recording_seconds for c in latest_clips() if c.recording_seconds}
    exact = close = off = skipped = 0
    for vid, review in sorted(stored_detections().items()):
        try:
            revision = json.loads(review["revision"])
        except ValueError:
            continue
        if not isinstance(revision, dict) or revision.get("detector") != "trained":
            continue
        version = revision["model"]
        if version not in probes:
            try:
                probes[version] = load_probe(version)
            except FileNotFoundError:
                probes[version] = load_probe() if load_probe()["version"] == version else None
        found = frames(vid)
        if probes[version] is None or found is None or found[2] != "db":
            skipped += 1
            continue
        t, v, _ = found
        theirs = [tuple(r) for r in review["ranges"]]
        # The backend clamps the last clip to a freshly probed length; a fractional end shows it.
        duration = theirs[-1][1] if theirs and theirs[-1][1] != int(theirs[-1][1]) else durations.get(vid)
        ours = [(c["start_seconds"], c["end_seconds"]) for c in
                detect(probes[version], t, v, duration, revision["sensitivity"], revision["states"])]
        if ours == theirs:
            exact += 1
        elif len(ours) == len(theirs) and all(abs(a[0] - b[0]) <= 5 and abs(a[1] - b[1]) <= 5 for a, b in zip(ours, theirs)):
            close += 1
        else:
            off += 1
            print(f"  {vid} v{version}: ours   {ours}")
            print(f"  {vid} v{version}: stored {theirs}")
    print(f"exact {exact}, within 5 s {close}, different {off}, no frames/probe {skipped}")


if __name__ == "__main__":
    verify()
