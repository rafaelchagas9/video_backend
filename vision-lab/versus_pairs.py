"""Draws a round of versus pairs: two keeps of one channel, which is worth its storage?

Every keep cleared the triage bar ("has potential"), so what separates them is worth for the space
they take, relative to the channel. Asking that per clip mixes length with worth; asking it per pair
does not, and it is the comparison Stage 2 learns from. To keep a round to minutes:

* pairs come from one channel, preferably two recordings, and only where the baseline
  (recordings.baseline.ts, length + score) can hardly tell them apart, since an obvious pair
  teaches little; no clip appears twice in a round, and no channel more than three times;
* each clip is offered pre-cut to its best part: the stretch around its strongest frame where the
  shipped probe stays near its peak, padded, at most 4 minutes. The reviewer accepts it or moves
  the edges, so every answer also labels "which part is worth storing".

Pairs already asked are never drawn again. Inserted as recording_label_tasks (kind versus).

  uv run python versus_pairs.py --dry-run
  uv run python versus_pairs.py              # next round of 20
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

import deployed_clipper as dc
import deployed_data as dd
from label_server import PG

ROUND = 20
PER_CHANNEL = 3
BEST_MAX = 240.0
BEST_MIN = 30.0
PAD = 10.0
NEAR_PEAK = 0.8
# baseline-v1, as shipped in recordings.baseline.ts.
INTERCEPT, PER_LOG_SECOND, PER_SCORE = -6.654, 0.8134, 1.7894


def baseline(clip: dd.Clip) -> float:
    a = clip.detected_start if clip.detected_start is not None else clip.start
    b = clip.detected_end if clip.detected_end is not None else clip.end
    return INTERCEPT + PER_LOG_SECOND * math.log(max(1.0, b - a)) + PER_SCORE * clip.score


def best_part(t: np.ndarray, scores: np.ndarray, start: float, end: float) -> tuple[float, float]:
    """The stretch around the strongest frame where the score stays near its peak, padded and capped."""
    if end - start <= BEST_MIN * 2:
        return start, end
    inside = np.flatnonzero((t >= start) & (t < end))
    if not len(inside):
        return start, min(end, start + BEST_MAX)
    peak = inside[int(np.argmax(scores[inside]))]
    bar = NEAR_PEAK * scores[peak]
    lo = hi = peak
    while lo - 1 in inside and scores[lo - 1] >= bar:
        lo -= 1
    while hi + 1 in inside and scores[hi + 1] >= bar:
        hi += 1
    a, b = max(start, t[lo] - PAD), min(end, t[hi] + dd.INTERVAL + PAD)
    if b - a > BEST_MAX:
        mid = float(t[peak])
        a = max(start, min(mid - BEST_MAX / 2, end - BEST_MAX))
        b = a + BEST_MAX
    if b - a < BEST_MIN:
        mid = (a + b) / 2
        a, b = max(start, mid - BEST_MIN / 2), min(end, mid + BEST_MIN / 2)
    return round(float(a)), round(float(b))


def playable() -> dict[int, str]:
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute("select id, file_path, file_name from videos v join recording_reviews r on r.video_id = v.id").fetchall()
    return {vid: name for vid, path, name in rows if Path(path).exists()}


def asked() -> tuple[set[frozenset], int]:
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute("select batch, context from recording_label_tasks where kind = 'versus'").fetchall()
    pairs = {frozenset((c["a"]["feedback_id"], c["b"]["feedback_id"])) for _, c in rows}
    rounds = [int(b.rsplit("-", 1)[1]) for b, _ in rows if b.rsplit("-", 1)[1].isdigit()]
    return pairs, max(rounds, default=0)


def feedback_ids() -> dict[tuple[int, str], int]:
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            """select f.id, f.video_id, f.clip_id from recording_clip_feedback f
               join (select video_id, max(analyzed_at) a from recording_clip_feedback group by 1) l
                 on l.video_id = f.video_id and l.a = f.analyzed_at"""
        ).fetchall()
    return {(vid, clip): fid for fid, vid, clip in rows}


def draw() -> tuple[list[dict], int]:
    rng = random.Random()
    files = playable()
    ids = feedback_ids()
    done, last_round = asked()
    probe = dc.load_probe()
    keeps: dict[str, list[dict]] = defaultdict(list)
    scored: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for clip in dd.latest_clips():
        if not clip.keep or clip.video_id not in files or (clip.video_id, clip.clip_id) not in ids:
            continue
        if clip.video_id not in scored:
            found = dd.frames(clip.video_id)
            if found is None or len(found[0]) < 4:
                continue
            t, v, _ = found
            scored[clip.video_id] = (t, dc.highlight_scores(dc.classify(probe["W"], probe["b"], dc.context(v, probe["radius"]))))
        t, scores = scored[clip.video_id]
        keeps[clip.channel].append({
            "feedback_id": ids[(clip.video_id, clip.clip_id)], "video_id": clip.video_id, "file_name": files[clip.video_id],
            "clip": [clip.start, clip.end], "best": list(best_part(t, scores, clip.start, clip.end)),
            "score": clip.score, "baseline": round(baseline(clip), 3),
        })
    candidates = []
    for channel, clips in keeps.items():
        for a, b in itertools.combinations(clips, 2):
            if frozenset((a["feedback_id"], b["feedback_id"])) in done:
                continue
            # Close baselines first; two recordings beat one; a little noise varies the rounds.
            closeness = abs(a["baseline"] - b["baseline"]) + (0 if a["video_id"] != b["video_id"] else 0.5) + rng.random() * 0.2
            candidates.append((closeness, channel, a, b))
    candidates.sort(key=lambda item: item[0])
    used: set[int] = set()
    per_channel: Counter = Counter()
    picked = []
    for closeness, channel, a, b in candidates:
        if len(picked) >= ROUND:
            break
        if a["feedback_id"] in used or b["feedback_id"] in used or per_channel[channel] >= PER_CHANNEL:
            continue
        if rng.random() < 0.5:
            a, b = b, a  # Which side a clip lands on must not follow its baseline.
        used |= {a["feedback_id"], b["feedback_id"]}
        per_channel[channel] += 1
        picked.append({"channel": channel, "a": a, "b": b, "baseline_gap": round(abs(a["baseline"] - b["baseline"]), 3)})
    rng.shuffle(picked)
    return picked, last_round + 1


def insert(pairs: list[dict], round_number: int) -> int:
    import psycopg

    batch = f"versus-{round_number}"
    with psycopg.connect(PG) as pg:
        written = 0
        for position, pair in enumerate(pairs):
            a = pair["a"]
            written += pg.execute(
                """insert into recording_label_tasks (kind, batch, video_id, start_seconds, end_seconds, stratum, position, channel, context)
                   values ('versus', %s, %s, %s, %s, 'pair', %s, %s, %s) on conflict do nothing""",
                (batch, a["video_id"], float(a["best"][0]), float(a["best"][1]), position, pair["channel"], json.dumps(pair)),
            ).rowcount
    return written


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    pairs, round_number = draw()
    seconds = sum(p[s]["best"][1] - p[s]["best"][0] for p in pairs for s in ("a", "b"))
    print(f"round {round_number}: {len(pairs)} pairs, {len({p['channel'] for p in pairs})} channels, "
          f"{seconds / 60:.0f} min of pre-cut best parts")
    for pair in pairs[:5]:
        print(" ", pair["channel"], pair["a"]["clip"], pair["a"]["best"], "vs", pair["b"]["clip"], pair["b"]["best"], pair["baseline_gap"])
    if not args.dry_run:
        print(f"inserted {insert(pairs, round_number)} tasks as versus-{round_number}")


if __name__ == "__main__":
    main()
