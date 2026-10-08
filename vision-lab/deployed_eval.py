"""End-to-end evaluation of the highlight detector the backend actually runs.

The recipe is export_probe.py's: a 4-state logistic probe on [frame, mean of ±2 neighbours],
trained on hand labels plus, optionally, hard negatives mined from "Detector got it wrong"
skips. Every frame score then goes through the production path (deployed_clipper.py: smoothing,
threshold, gap merging, minimum length, padding, overlap merging, 24-clip cap).

Two splits, each 5-fold:

* **channel** — whole streams held out: what a new channel gets.
* **recording** — recordings held out, other recordings of the same stream kept: what the next
  recording of a known channel gets.

A held-out fold contributes nothing to training: neither its hand labels nor negatives mined from
its decisions. The threshold is chosen on development folds only (inner 3-fold out-of-fold
scores), and each fold is also scored at the production threshold (0.45, sensitivity 1.0).

Proposals are judged against the reviewer's latest analysis generation per recording. Those are
coarse triage calls (Keep = "has potential"), so a new proposal is judged as a whole, never frame
by frame: it is a keep when it overlaps a kept clip by half of either; a skip when it is not a keep
and half of it lies on skipped proposals; unjudged otherwise.

  uv run python deployed_eval.py            # fits (cached), scores (cached), prints the tables
  uv run python deployed_eval.py --refit    # drop the cached models and scores first
"""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

import deployed_clipper as dc
import deployed_data as dd

OUT = dd.DATA / "deployed_eval"
CLASSES = dc.CLASSES
POSITIVE = [CLASSES.index("nude"), CLASSES.index("explicit")]
RADIUS = 2
NEGATIVE_WEIGHT = 0.2   # hard_negatives.WEIGHT
PICK = 0.44             # hard_negatives.PICK
PRODUCTION_THRESHOLD = dc.probe_threshold(1.0)
GRID = np.round(np.arange(0.20, 0.91, 0.05), 2)
OUTER, INNER = 5, 3
DEPLOYED = "20261007003939"
PREVIOUS = "20261006175059"


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S"), message, flush=True)


# ---------------------------------------------------------------- data


@dataclass
class Corpus:
    clips: dict[int, list[dd.Clip]]                # latest generation per reviewed recording
    labels: dict[int, dict[int, str]]              # hand labels, unsure left out
    channel: dict[int, str]
    recordings: list[int]                          # everything with frames
    hand_X: np.ndarray = field(default=None)       # context features of labelled frames
    hand_y: np.ndarray = field(default=None)
    hand_vid: np.ndarray = field(default=None)
    pool_X: np.ndarray = field(default=None)       # frames inside "Detector got it wrong" skips
    pool_vid: np.ndarray = field(default=None)


def corpus() -> Corpus:
    clips: dict[int, list[dd.Clip]] = defaultdict(list)
    for clip in dd.latest_clips():
        clips[clip.video_id].append(clip)
    labels = {vid: {f: l for f, l in frames.items() if l in CLASSES} for vid, frames in dd.hand_labels().items()}
    ids = sorted(set(clips) | set(labels))
    # The backend proposes nothing below 4 frames; a couple of recordings stopped that early.
    recordings = [vid for vid in ids if (found := dd.frames(vid)) is not None and found[1].ndim == 2 and len(found[1]) >= 4]
    return Corpus(dict(clips), labels, {vid: dd.channel(vid) for vid in ids}, recordings)


def features(vid: int) -> tuple[np.ndarray, np.ndarray]:
    t, v, _ = dd.frames(vid)
    return t, dc.context(v, RADIUS).astype(np.float32)


def wrong_skips(clips: list[dd.Clip]) -> list[dd.Clip]:
    """The decisions hard_negatives.py mines: trained-detector proposals skipped as wrong."""
    return [c for c in clips if "skip_wrong" in c.reasons and c.model and not c.added]


def load_training_frames(c: Corpus) -> None:
    cache = OUT / "frames.npz"
    if cache.exists():
        z = np.load(cache)
        c.hand_X, c.hand_y, c.hand_vid, c.pool_X, c.pool_vid = (z[k] for k in ("hX", "hy", "hv", "pX", "pv"))
        return
    hX, hy, hv, pX, pv = [], [], [], [], []
    for vid in c.recordings:
        wrong = wrong_skips(c.clips.get(vid, []))
        if vid not in c.labels and not wrong:
            continue
        t, F = features(vid)
        for frame, label in c.labels.get(vid, {}).items():
            if frame < len(F):
                hX.append(F[frame]); hy.append(CLASSES.index(label)); hv.append(vid)
        inside = np.zeros(len(t), bool)
        for clip in wrong:
            a, b = clip.detected_start, clip.detected_end
            if a is None:
                a, b = clip.start, clip.end
            inside |= (t >= a) & (t < b)
        for i in np.flatnonzero(inside):
            pX.append(F[i]); pv.append(vid)
    c.hand_X, c.hand_y, c.hand_vid = np.array(hX, np.float32), np.array(hy), np.array(hv)
    c.pool_X, c.pool_vid = np.array(pX, np.float32).reshape(-1, 4 * 576), np.array(pv, int)
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez(cache, hX=c.hand_X, hy=c.hand_y, hv=c.hand_vid, pX=c.pool_X, pv=c.pool_vid)


# ---------------------------------------------------------------- folds


def balanced_folds(units: list, weight: dict, k: int) -> dict:
    """Greedy: heaviest unit first into the lightest fold, so decisions spread evenly."""
    load = [0.0] * k
    out = {}
    for unit in sorted(units, key=lambda u: (-weight[u], str(u))):
        fold = int(np.argmin(load))
        out[unit] = fold
        load[fold] += weight[unit]
    return out


def split_groups(c: Corpus, split: str) -> dict[int, object]:
    return {vid: (c.channel[vid] if split == "channel" else vid) for vid in c.recordings}


def outer_folds(c: Corpus, split: str) -> dict[int, int]:
    group = split_groups(c, split)
    weight: dict = defaultdict(float)
    for vid in c.recordings:
        # Decisions are what gets scored; hand labels only train, so they weigh little.
        weight[group[vid]] += len(c.clips.get(vid, [])) + 0.5 * (vid in c.labels)
    fold_of_group = balanced_folds(list(weight), weight, OUTER)
    return {vid: fold_of_group[group[vid]] for vid in c.recordings}


def inner_folds(c: Corpus, split: str, dev: list[int]) -> dict[int, int]:
    group = split_groups(c, split)
    weight: dict = defaultdict(float)
    for vid in dev:
        weight[group[vid]] += len(c.clips.get(vid, [])) + 0.5 * (vid in c.labels)
    fold_of_group = balanced_folds(list(weight), weight, INNER)
    return {vid: fold_of_group[group[vid]] for vid in dev}


# ---------------------------------------------------------------- models


def fit(X, y, w=None) -> tuple[np.ndarray, np.ndarray]:
    m = LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced").fit(X, y, sample_weight=w)
    W = np.zeros((len(CLASSES), X.shape[1])); b = np.zeros(len(CLASSES))
    W[m.classes_] = m.coef_; b[m.classes_] = m.intercept_
    return W, b


def train_pair(c: Corpus, train_vids: set[int]) -> dict[str, tuple[np.ndarray, np.ndarray, int]]:
    """export_probe.py's recipe on the given recordings only: without and with mined negatives."""
    hand = np.isin(c.hand_vid, list(train_vids))
    X, y = c.hand_X[hand], c.hand_y[hand]
    W, b = fit(X, y)
    # Negatives as hard_negatives.store() picks them, but with this fold's own base probe.
    pool = np.isin(c.pool_vid, list(train_vids))
    P = dc.classify(W, b, c.pool_X[pool].astype(np.float64))
    pick = P[:, POSITIVE].sum(1) >= PICK
    NX = c.pool_X[pool][pick]
    Ny = np.argmax(P[pick][:, :2], 1)
    W2, b2 = fit(np.concatenate([X, NX]), np.concatenate([y, Ny]),
                 np.concatenate([np.ones(len(y)), np.full(len(Ny), NEGATIVE_WEIGHT)]))
    return {"base": (W, b, 0), "negatives": (W2, b2, int(len(Ny)))}


def train_all(c: Corpus) -> dict[str, dict]:
    cache = OUT / "models.npz"
    meta_path = OUT / "models.json"
    if cache.exists() and meta_path.exists():
        z = np.load(cache)
        meta = json.loads(meta_path.read_text())
        return {name: {**info, "W": z[f"{name}|W"], "b": z[f"{name}|b"]} for name, info in meta.items()}
    models: dict[str, dict] = {}
    for split in ("channel", "recording"):
        folds = outer_folds(c, split)
        for k in range(OUTER):
            dev = [v for v in c.recordings if folds[v] != k]
            log(f"{split} fold {k}: {len(dev)} dev recordings")
            for variant, (W, b, n) in train_pair(c, set(dev)).items():
                models[f"{split}/{variant}/o{k}"] = {"W": W, "b": b, "negatives": n, "split": split, "outer": k, "inner": None}
            inner = inner_folds(c, split, dev)
            for j in range(INNER):
                train = {v for v in dev if inner[v] != j}
                for variant, (W, b, n) in train_pair(c, train).items():
                    models[f"{split}/{variant}/o{k}i{j}"] = {"W": W, "b": b, "negatives": n, "split": split, "outer": k, "inner": j}
    for version in (DEPLOYED, PREVIOUS):
        probe = dc.load_probe(version) if version != DEPLOYED else dc.load_probe()
        assert probe["version"] == version
        models[f"shipped/{version}"] = {"W": probe["W"], "b": probe["b"], "negatives": None, "split": "shipped", "outer": None, "inner": None}
    np.savez(cache, **{f"{n}|W": m["W"] for n, m in models.items()}, **{f"{n}|b": m["b"] for n, m in models.items()})
    meta_path.write_text(json.dumps({n: {k: v for k, v in m.items() if k not in ("W", "b")} for n, m in models.items()}))
    return models


def score_all(c: Corpus, models: dict[str, dict]) -> dict[int, dict[str, np.ndarray]]:
    """Smoothed nude+explicit score per frame for every model on every recording."""
    cache = OUT / "scores.npz"
    names = sorted(models)
    if cache.exists():
        z = np.load(cache)
        return {vid: {n: z[f"{vid}|{n}"] for n in names} for vid in c.recordings} | {"_t": {vid: z[f"{vid}|t"] for vid in c.recordings}}
    W = np.stack([models[n]["W"] for n in names]); b = np.stack([models[n]["b"] for n in names])
    out: dict = {"_t": {}}
    for i, vid in enumerate(c.recordings):
        t, F = features(vid)
        probs = dc.classify(W, b, F.astype(np.float64))
        scores = dc.highlight_scores(probs)
        out[vid] = {n: scores[m].astype(np.float32) for m, n in enumerate(names)}
        out["_t"][vid] = t
        if i % 20 == 0:
            log(f"scored {i + 1}/{len(c.recordings)}")
    np.savez(cache, **{f"{vid}|{n}": s for vid in c.recordings for n, s in out[vid].items()},
             **{f"{vid}|t": out["_t"][vid] for vid in c.recordings})
    return out


# ---------------------------------------------------------------- judging


def overlap(a0, a1, b0, b1) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


@dataclass
class Tally:
    proposals: int = 0
    keep: int = 0
    skip: int = 0
    skip_wrong: int = 0
    unjudged: int = 0
    proposed_seconds: float = 0.0
    recording_seconds: float = 0.0
    kept_clips: int = 0
    kept_found: int = 0
    wrong_clips: int = 0
    wrong_found: int = 0
    skipped_clips: int = 0
    skipped_found: int = 0
    pos_frames: int = 0
    pos_covered: int = 0
    lab_in: int = 0
    lab_pos_in: int = 0
    recordings: int = 0

    def add(self, other: "Tally") -> None:
        for key in self.__dataclass_fields__:
            setattr(self, key, getattr(self, key) + getattr(other, key))

    @property
    def precision(self) -> float:        # judged proposals only
        return self.keep / max(1, self.keep + self.skip)

    @property
    def precision_floor(self) -> float:  # unjudged counted as skips
        return self.keep / max(1, self.proposals)

    @property
    def kept_recall(self) -> float:
        return self.kept_found / max(1, self.kept_clips)

    @property
    def hand_recall(self) -> float:
        return self.pos_covered / max(1, self.pos_frames)

    @property
    def hand_precision(self) -> float:
        return self.lab_pos_in / max(1, self.lab_in)

    @property
    def minutes_per_hour(self) -> float:
        return 60 * self.proposed_seconds / max(1.0, self.recording_seconds)


def judge(vid: int, t: np.ndarray, scores: np.ndarray, threshold: float, c: Corpus) -> Tally:
    clips = c.clips.get(vid, [])
    duration = next((x.recording_seconds for x in clips if x.recording_seconds), None) or float(t[-1] + 5)
    proposals = dc.shape_clips(t, scores, threshold, duration)
    # Recordings nobody reviewed only count towards the hand-label columns.
    tally = Tally(recordings=1, recording_seconds=duration) if clips else Tally()
    if not clips:
        proposals_judged = []
    else:
        proposals_judged = proposals
    kept = [(x.start, x.end) for x in clips if x.keep]
    skipped = [(x.detected_start if x.detected_start is not None else x.start,
                x.detected_end if x.detected_end is not None else x.end, x) for x in clips if not x.keep]
    for p in proposals_judged:
        a, b = p["start_seconds"], p["end_seconds"]
        tally.proposals += 1
        tally.proposed_seconds += b - a
        if clips and any(overlap(a, b, k0, k1) >= 0.5 * min(b - a, k1 - k0) for k0, k1 in kept):
            tally.keep += 1
        elif clips and sum(overlap(a, b, s0, s1) for s0, s1, _ in skipped) >= 0.5 * (b - a):
            tally.skip += 1
            if any("skip_wrong" in x.reasons and overlap(a, b, s0, s1) > 0 for s0, s1, x in skipped):
                tally.skip_wrong += 1
        else:
            tally.unjudged += 1

    def covered(x0, x1) -> bool:
        return sum(overlap(x0, x1, p["start_seconds"], p["end_seconds"]) for p in proposals) >= 0.5 * (x1 - x0)

    for k0, k1 in kept:
        tally.kept_clips += 1; tally.kept_found += covered(k0, k1)
    for s0, s1, x in skipped:
        tally.skipped_clips += 1; tally.skipped_found += covered(s0, s1)
        if "skip_wrong" in x.reasons:
            tally.wrong_clips += 1; tally.wrong_found += covered(s0, s1)
    labels = c.labels.get(vid)
    if labels:
        inside = np.zeros(len(t), bool)
        for p in proposals:
            inside |= (t + 2.5 >= p["start_seconds"]) & (t + 2.5 < p["end_seconds"])
        for frame, label in labels.items():
            if frame >= len(t):
                continue
            positive = CLASSES.index(label) in POSITIVE
            tally.pos_frames += positive; tally.pos_covered += positive and inside[frame]
            tally.lab_in += inside[frame]; tally.lab_pos_in += positive and inside[frame]
    return tally


def objective(t: Tally) -> float:
    """What the threshold is tuned for on dev folds: kept clips found against review load."""
    p, r = t.precision_floor, t.kept_recall
    return 2 * p * r / (p + r) if p + r else 0.0


# ---------------------------------------------------------------- report


def evaluate_split(c: Corpus, scores, models, split: str, variant: str) -> dict:
    folds = outer_folds(c, split)
    at_production, tuned = Tally(), Tally()
    by_channel: dict[str, Tally] = defaultdict(Tally)
    thresholds = []
    for k in range(OUTER):
        dev = [v for v in c.recordings if folds[v] != k]
        inner = inner_folds(c, split, dev)
        best = (-1.0, PRODUCTION_THRESHOLD)
        for threshold in GRID:
            total = Tally()
            for vid in dev:
                if vid in c.clips:
                    total.add(judge(vid, scores["_t"][vid], scores[vid][f"{split}/{variant}/o{k}i{inner[vid]}"], threshold, c))
            if objective(total) > best[0]:
                best = (objective(total), float(threshold))
        thresholds.append(best[1])
        for vid in c.recordings:
            if folds[vid] != k:
                continue
            s = scores[vid][f"{split}/{variant}/o{k}"]
            prod = judge(vid, scores["_t"][vid], s, PRODUCTION_THRESHOLD, c)
            at_production.add(prod)
            by_channel[c.channel[vid]].add(prod)
            tuned.add(judge(vid, scores["_t"][vid], s, best[1], c))
    negatives = [models[f"{split}/{variant}/o{k}"]["negatives"] for k in range(OUTER)]
    return {"production": at_production, "tuned": tuned, "thresholds": thresholds, "negatives": negatives,
            "by_channel": by_channel}


def shipped(c: Corpus, scores, version: str, vids) -> Tally:
    total = Tally()
    for vid in vids:
        total.add(judge(vid, scores["_t"][vid], scores[vid][f"shipped/{version}"], PRODUCTION_THRESHOLD, c))
    return total


def row(name: str, t: Tally) -> str:
    return (f"| {name} | {t.recordings} | {t.proposals} | {t.keep} / {t.skip} / {t.unjudged} | "
            f"{t.precision:.0%} | {t.precision_floor:.0%} | {t.kept_found}/{t.kept_clips} ({t.kept_recall:.0%}) | "
            f"{t.wrong_found}/{t.wrong_clips} | {f'{t.hand_recall:.0%}' if t.pos_frames else '—'} | "
            f"{f'{t.hand_precision:.0%}' if t.lab_in else '—'} | {t.minutes_per_hour:.0f} |")


HEADER = ("| | recs | proposals | keep / skip / unjudged | precision (judged) | precision (unjudged = skip) | "
          "kept clips found | wrong-skips still proposed | hand-label recall | hand-label precision | min proposed / h |\n"
          "|---|---|---|---|---|---|---|---|---|---|---|")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refit", action="store_true")
    args = parser.parse_args()
    if args.refit:
        for name in ("frames.npz", "models.npz", "models.json", "scores.npz"):
            (OUT / name).unlink(missing_ok=True)
    c = corpus()
    log(f"{len(c.recordings)} recordings with frames, {sum(map(len, c.clips.values()))} latest-generation decisions")
    load_training_frames(c)
    log(f"{len(c.hand_y)} hand-labelled frames, {len(c.pool_vid)} frames inside wrong-detection skips")
    models = train_all(c)
    scores = score_all(c, models)
    results = {(split, variant): evaluate_split(c, scores, models, split, variant)
               for split in ("channel", "recording") for variant in ("base", "negatives")}
    reviewed = [v for v in c.recordings if v in c.clips]
    trained_on = set(c.labels) | set(dd.stored_negatives())
    judged_by = {v: c.clips[v][0].model for v in reviewed}
    print(HEADER)
    for version in (DEPLOYED, PREVIOUS):
        clean = [v for v in reviewed if v not in trained_on]
        print(row(f"shipped {version}, unseen recordings", shipped(c, scores, version, clean)))
        print(row(f"shipped {version}, recordings it judged", shipped(c, scores, version, [v for v in clean if judged_by[v] == version])))
    for (split, variant), r in results.items():
        print(row(f"{split}-out · {variant} · 0.45", r["production"]))
        print(row(f"{split}-out · {variant} · tuned {r['thresholds']}", r["tuned"]))
    for split in ("channel", "recording"):
        print(f"\n{split}-out per channel at 0.45 (base → negatives): keep/skip/unjudged, wrong-skips still proposed")
        a, b = results[(split, "base")]["by_channel"], results[(split, "negatives")]["by_channel"]
        for ch in sorted(a, key=lambda ch: -a[ch].proposals):
            if a[ch].kept_clips + a[ch].skipped_clips >= 4:
                print(f"  {ch:18s} {a[ch].keep}/{a[ch].skip}/{a[ch].unjudged} wrong {a[ch].wrong_found}/{a[ch].wrong_clips} kept {a[ch].kept_found}/{a[ch].kept_clips}"
                      f"  →  {b[ch].keep}/{b[ch].skip}/{b[ch].unjudged} wrong {b[ch].wrong_found}/{b[ch].wrong_clips} kept {b[ch].kept_found}/{b[ch].kept_clips}")
        print(f"  negatives mined per fold: {results[(split, 'negatives')]['negatives']}")
    # Not used to pick anything: how the held-out trade-off moves with the threshold.
    for split in ("channel", "recording"):
        folds = outer_folds(c, split)
        print(f"\n{split}-out held-out sweep (judged precision, kept clips found, wrong-skips still proposed, min/h):")
        for threshold in (0.3, 0.45, 0.55, 0.65, 0.75, 0.85):
            cells = []
            for variant in ("base", "negatives"):
                t = Tally()
                for vid in reviewed:
                    t.add(judge(vid, scores["_t"][vid], scores[vid][f"{split}/{variant}/o{folds[vid]}"], threshold, c))
                cells.append(f"{variant} {t.precision:.0%} {t.kept_found}/{t.kept_clips} {t.wrong_found}/{t.wrong_clips} {t.minutes_per_hour:.0f}")
            print(f"  {threshold:.2f}  " + "   |   ".join(cells))
    (OUT / "results.json").write_text(json.dumps(
        {f"{s}/{v}": {"production": r["production"].__dict__, "tuned": r["tuned"].__dict__, "thresholds": r["thresholds"],
                      "negatives": r["negatives"]} for (s, v), r in results.items()}, indent=1, default=float))


if __name__ == "__main__":
    main()
