"""Does sound order proposals better than length + score? A first, cheap answer.

The reviewer puts audio at about 70% of what separates an okay clip from a nice one. This adds the
per-second features from audio_features.py to the Stage 2 baseline (stage2_baseline.py) and scores
both on the same channel-held-out folds, on the proposals whose recording still has its audio:

* ``sound``  — mean loudness+change inside the proposal, against the recording's own baseline;
* ``peak``   — its liveliest 15 seconds, the same measure;
* ``voice``  — mean share of energy in the voice band;
* ``music``  — mean tonal steadiness.

It also checks the features against the reviewer's own audio reasons (Personality, Nice talk,
Nice music, reactions): kept clips given one should sound livelier than kept clips that were not.

  uv run python stage2_audio.py
"""

from __future__ import annotations

import math

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

import deployed_data as dd
from label_server import DATA
from stage2_baseline import FOLDS, channel_folds, length_of, pairwise, top1

AUDIO = DATA / "audio"
AUDIO_REASONS = ("personality", "nice talk", "nice music", "dirty talk", "keep_reaction", "twerking to funk", "nice dance")


def robust_z(x: np.ndarray) -> np.ndarray:
    median = np.median(x)
    spread = 1.4826 * np.median(np.abs(x - median)) or 1.0
    return (x - median) / spread


def smooth(x: np.ndarray, seconds: int) -> np.ndarray:
    return np.convolve(x, np.ones(seconds) / seconds, "same")


_cache: dict[int, dict[str, np.ndarray] | None] = {}


def audio(video_id: int) -> dict[str, np.ndarray] | None:
    if video_id not in _cache:
        path = AUDIO / f"{video_id}.npz"
        z = np.load(path) if path.exists() else None
        if z is None or "db" not in z.files:
            _cache[video_id] = None
        else:
            activity = robust_z(z["db"]) + robust_z(z["flux"])
            _cache[video_id] = {"activity": activity, "peak": smooth(activity, 15), "voice": z["voice"], "music": z["music"]}
    return _cache[video_id]


def sound_features(clip: dd.Clip) -> list[float] | None:
    found = audio(clip.video_id)
    if found is None:
        return None
    a = int(clip.detected_start if clip.detected_start is not None else clip.start)
    b = int(clip.detected_end if clip.detected_end is not None else clip.end)
    if b - a < 2 or a >= len(found["activity"]):
        return None
    span = slice(a, min(b, len(found["activity"])))
    return [float(found["activity"][span].mean()), float(found["peak"][span].max()),
            float(found["voice"][span].mean()), float(found["music"][span].mean())]


def held_out(X: np.ndarray, y: np.ndarray, folds: np.ndarray) -> np.ndarray:
    out = np.zeros(len(y))
    for fold in range(FOLDS):
        train = folds != fold
        # Held-out channels must not influence normalization.
        mean, std = X[train].mean(0), X[train].std(0) + 1e-9
        Z = (X - mean) / std
        out[~train] = LogisticRegression(C=1.0).fit(Z[train], y[train]).decision_function(Z[~train])
    return out


def main() -> None:
    rows = []
    for clip in dd.latest_clips():
        if not clip.model or clip.added:
            continue
        sound = sound_features(clip)
        if sound is not None:
            rows.append((clip, sound))
    clips = [clip for clip, _ in rows]
    y = np.array([clip.keep for clip in clips], dtype=int)
    base = np.array([[math.log(length_of(clip)), clip.score] for clip in clips])
    sound = np.array([features for _, features in rows])
    folds = channel_folds(clips)
    print(f"{len(clips)} decisions with audio, {y.sum()} kept, {len({c.video_id for c in clips})} recordings, "
          f"{len({c.channel for c in clips})} channels\n")
    print("| ranker (held-out channels) | AUROC | within-recording pairs | top proposal kept |")
    print("|---|---|---|---|")
    for name, X in (("length + score", base), ("sound only", sound), ("length + score + sound", np.hstack([base, sound]))):
        scores = held_out(X, y, folds)
        right, total = pairwise(clips, scores)
        hits, recordings = top1(clips, scores)
        print(f"| {name} | {roc_auc_score(y, scores):.3f} | {right / total:.0%} of {int(total)} | {hits}/{recordings} |")
    for index, name in enumerate(("sound", "peak", "voice", "music")):
        print(f"\n{name}: AUROC alone {roc_auc_score(y, sound[:, index]):.3f}", end="")

    kept = [(clip, features) for clip, features in rows if clip.keep]
    tagged = np.array([any(r.lower() in AUDIO_REASONS for r in clip.reasons) for clip, _ in kept])
    if tagged.any() and (~tagged).any():
        peak = np.array([features[1] for _, features in kept])
        print(f"\n\nkept clips with an audio reason ({tagged.sum()}): median peak {np.median(peak[tagged]):.2f}; "
              f"without ({(~tagged).sum()}): {np.median(peak[~tagged]):.2f}; AUROC {roc_auc_score(tagged, peak):.3f}")


if __name__ == "__main__":
    main()
