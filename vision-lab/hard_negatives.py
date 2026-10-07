"""Hard negatives from the reviewer's "Detector got it wrong" skips, and whether they help.

A highlight skipped as `skip_wrong` was proposed as nude/explicit but wasn't (mostly outfits
close to skin colour). Its frames that the current probe scores as highlight become extra
training frames labelled with the probe's own best non-highlight state (idle or tease), at a
lower weight than hand labels since nobody looked at each frame.

`evaluate` compares the probe with and without them, leave-recording-out over the feedback
recordings, so a recording's negatives never train the model that scores it:

* hand-label AUROC (nude+explicit vs rest), leave-channel-out as in evaluate.py;
* highlights the detector would still propose for each reviewed decision: wrong ones should
  vanish, kept ones should stay.

  uv run python hard_negatives.py            # evaluate
  uv run python hard_negatives.py --store    # pick them with the current probe and keep them

Stored negatives live in labels.sqlite (`feedback_negatives`), apart from hand labels, and
export_probe.py trains on them at WEIGHT. Picking them once matters: a probe trained on them
scores those frames low, so picking again with it would find fewer and undo the fix.
"""

from __future__ import annotations

import os

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

import feedback as fb
from label_model import CLASSES, context

# Weight of one stored negative against one hand label; 0.1–0.5 all scored alike (2026-10-07).
WEIGHT = float(os.environ.get("HN_WEIGHT", 0.2))
THRESHOLD = 0.55
# Only frames the probe scored at least this high become negatives.
PICK = float(os.environ.get("HN_PICK", 0.44))
POSITIVE = [CLASSES.index("nude"), CLASSES.index("explicit")]


def hand_set():
    from label_server import all_labels

    recordings = fb.source.recordings()
    X, y, groups, videos = [], [], [], []
    for vid, frames in all_labels().items():
        if vid not in recordings:
            continue
        features = context(fb.source.embeddings(vid))
        for frame, label in frames.items():
            if label in CLASSES and frame < len(features):
                X.append(features[frame]); y.append(CLASSES.index(label))
                groups.append(recordings[vid]["channel"]); videos.append(vid)
    return np.array(X, np.float32), np.array(y), np.array(groups), np.array(videos)


def negative_set(probe: dict, decisions: list[fb.Decision]):
    """Frames of wrong detections that the given probe scores as highlight, labelled idle/tease."""
    X, y, videos = [], [], []
    for d in decisions:
        if "skip_wrong" not in d.reasons or not d.trained:
            continue
        t, v = fb.frames(d.video_id)
        if not len(t):
            continue
        probs = fb.probabilities(probe, v)
        features = context(v)
        a, b = d.edges
        for i in np.where((t >= a) & (t < b) & (probs[:, POSITIVE].sum(1) >= PICK))[0]:
            X.append(features[i]); y.append(int(np.argmax(probs[i, :2]))); videos.append(d.video_id)
    return np.array(X, np.float32), np.array(y), np.array(videos)


def fit(X, y, w=None) -> LogisticRegression:
    return LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced").fit(X, y, sample_weight=w)


def as_probe(model: LogisticRegression, base: dict) -> dict:
    W = np.zeros((len(CLASSES), model.coef_.shape[1]), np.float32)
    b = np.zeros(len(CLASSES), np.float32)
    W[model.classes_] = model.coef_
    b[model.classes_] = model.intercept_
    return {**base, "W": W, "b": b}


def proposed(probe: dict, d: fb.Decision) -> float:
    """Share of the decision's detected stretch the probe still scores as highlight."""
    t, v = fb.frames(d.video_id)
    a, b = d.edges
    mask = (t >= a + 10) & (t < b - 10)
    if not mask.any():
        mask = (t >= a) & (t < b)
    if not mask.any():
        return float("nan")
    return float((fb.highlight_score(fb.probabilities(probe, v))[mask] >= THRESHOLD).mean())


def evaluate() -> None:
    base = fb.load_probe()
    decisions = [d for d in fb.decisions() if not d.added]
    X, y, groups, videos = hand_set()
    NX, Ny, Nv = negative_set(base, decisions)
    print(f"hand frames {len(y)}, hard negatives {len(Ny)} from {len(set(Nv))} recordings "
          f"(idle {int((Ny == 0).sum())}, tease {int((Ny == 1).sum())})")

    # 1. Hand-label AUROC, leave-channel-out; the negatives of a held-out channel are left out too.
    channel_of = {vid: fb.channel(vid) for vid in set(Nv)}
    Nch = np.array([channel_of[v] for v in Nv])
    for name, use in (("without", False), ("with", True)):
        scores = np.zeros(len(y))
        for train, test in GroupKFold(5).split(X, y, groups):
            held = set(groups[test])
            TX, Ty, Tw = X[train], y[train], np.ones(len(train))
            if use:
                keep = ~np.isin(Nch, list(held))
                TX = np.concatenate([TX, NX[keep]]); Ty = np.concatenate([Ty, Ny[keep]])
                Tw = np.concatenate([Tw, np.full(int(keep.sum()), WEIGHT)])
            m = fit(TX, Ty, Tw)
            p = np.zeros((len(test), len(CLASSES))); p[:, m.classes_] = m.predict_proba(X[test])
            scores[test] = p[:, POSITIVE].sum(1)
        print(f"hand-label AUROC {name} hard negatives: {roc_auc_score(np.isin(y, POSITIVE), scores):.4f}")

    # 2. Reviewed decisions, leave-recording-out: production training (all hand labels) plus the
    #    negatives of every other feedback recording.
    trained = [d for d in decisions if d.trained]
    rec_ids = sorted({d.video_id for d in trained})
    before, after = {}, {}
    for fold in range(5):
        held = set(rec_ids[fold::5])
        keep = ~np.isin(Nv, list(held))
        m = fit(np.concatenate([X, NX[keep]]), np.concatenate([y, Ny[keep]]),
                np.concatenate([np.ones(len(y)), np.full(int(keep.sum()), WEIGHT)]))
        probe = as_probe(m, base)
        for d in trained:
            if d.video_id in held:
                after[id(d)] = proposed(probe, d)
                before[id(d)] = proposed(base, d)
    def report(title, subset):
        b = np.nanmean([before[id(d)] for d in subset]); a = np.nanmean([after[id(d)] for d in subset])
        gone_b = np.mean([before[id(d)] < 0.2 for d in subset]); gone_a = np.mean([after[id(d)] < 0.2 for d in subset])
        print(f"{title:32s} n={len(subset):3d}  highlight share {b:.2f} → {a:.2f}   mostly gone {gone_b:.0%} → {gone_a:.0%}")
    report("Detector got it wrong", [d for d in trained if "skip_wrong" in d.reasons])
    report("Kept", [d for d in trained if d.keep])
    report("Skipped, other reasons", [d for d in trained if not d.keep and "skip_wrong" not in d.reasons])
    for channel in ("shena_nomy", "sas4a"):
        report(f"  kept · {channel}", [d for d in trained if d.keep and d.channel == channel])
    for d in trained:
        if d.keep and after[id(d)] < 0.2:
            print(f"  lost keep: {d.channel} {d.video_id} {d.edges[0]:.0f}-{d.edges[1]:.0f} "
                  f"{before[id(d)]:.2f}→{after[id(d)]:.2f} {d.reasons}")


def store() -> int:
    """Pick the negatives with the current probe and replace the stored set."""
    from contextlib import closing

    from label_server import labels_db

    base = fb.load_probe()
    decisions = [d for d in fb.decisions() if not d.added]
    rows = []
    for d in decisions:
        if "skip_wrong" not in d.reasons or not d.trained:
            continue
        t, v = fb.frames(d.video_id)
        if not len(t):
            continue
        probs = fb.probabilities(base, v)
        a, b = d.edges
        for i in np.where((t >= a) & (t < b) & (probs[:, POSITIVE].sum(1) >= PICK))[0]:
            rows.append((d.video_id, int(i), CLASSES[int(np.argmax(probs[i, :2]))], base["version"]))
    with closing(labels_db()) as db:
        db.execute("""create table if not exists feedback_negatives (
            video_id integer not null, frame_index integer not null, label text not null,
            picked_by text not null, primary key (video_id, frame_index))""")
        db.execute("delete from feedback_negatives")
        db.executemany("insert or replace into feedback_negatives values (?, ?, ?, ?)", rows)
        db.commit()
    return len(rows)


def stored() -> dict[int, dict[int, str]]:
    """Stored negatives by recording and frame; empty before the first --store."""
    from contextlib import closing

    from label_server import labels_db

    out: dict[int, dict[int, str]] = {}
    with closing(labels_db()) as db:
        if not db.execute("select 1 from sqlite_master where name = 'feedback_negatives'").fetchone():
            return out
        for video_id, frame, label in db.execute("select video_id, frame_index, label from feedback_negatives"):
            out.setdefault(video_id, {})[frame] = label
    return out


if __name__ == "__main__":
    import sys

    if "--store" in sys.argv:
        print(f"stored {store()} hard negatives")
    else:
        evaluate()
