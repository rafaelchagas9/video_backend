"""Draws the first recall-audit round: stretches of reviewed recordings the reviewer never judged.

Recall so far only measures agreement with earlier detectors (deployed-detector-eval.md). This
asks about time none of them proposed, in four strata, on recordings whose review was saved and
whose file still exists:

* **outside** — random 2-minute windows outside every proposal, in recordings with a keep;
* **no-keep** — the same, in recordings that ended with no keep;
* **near-miss** — 2 minutes around stretches the shipped probe scored just under the 0.45
  threshold (peak 0.25–0.45 for 20 s or more);
* **new-time** — the shipped probe's proposals that lie mostly on time no earlier detector
  proposed (capped at 4 minutes around the peak).

Each window stores a weight: the seconds (or, for new-time and near-miss, the stretches) of its
stratum it stands for, so "kept" answers scale to an estimate of what the review misses. Windows
are inserted as recording_label_tasks (kind recall-audit) and answered in Kura's Label tasks page.

  uv run python recall_audit.py --dry-run   # print the draw
  uv run python recall_audit.py             # insert it (idempotent per batch)
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

import deployed_clipper as dc
import deployed_data as dd
from label_server import PG

BATCH = "recall-audit-1"
WINDOW = 120.0
NEW_TIME_CAP = 240.0
QUOTA = {"outside": 14, "no-keep": 8, "near-miss": 8, "new-time": 10}
NEAR_MISS = (0.25, 0.45)
SEED = 20261009


def merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def covered(a: float, b: float, intervals: list[tuple[float, float]]) -> float:
    return sum(max(0.0, min(b, y) - max(a, x)) for x, y in intervals)


def gaps(duration: float, taken: list[tuple[float, float]], margin: float = 10.0) -> list[tuple[float, float]]:
    """Free stretches at least a window long, kept `margin` seconds clear of anything judged."""
    out, cursor = [], 0.0
    for a, b in merge(taken):
        if a - margin - cursor >= WINDOW:
            out.append((cursor, a - margin))
        cursor = max(cursor, b + margin)
    if duration - cursor >= WINDOW:
        out.append((cursor, duration))
    return out


def recordings() -> list[dict]:
    """Saved reviews whose file exists, with every range any generation proposed or the reviewer kept."""
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            """select r.video_id, v.file_name, v.file_path, v.duration_seconds, r.clips, r.proposals
               from recording_reviews r join videos v on v.id = r.video_id
               where r.saved_at is not null and r.status <> 'rendering'"""
        ).fetchall()
        feedback = pg.execute(
            """select video_id, start_seconds, end_seconds, detected_start, detected_end from recording_clip_feedback"""
        ).fetchall()
    judged: dict[int, list[tuple[float, float]]] = defaultdict(list)
    for vid, s, e, ds, de in feedback:
        judged[vid].append((s, e))
        if ds is not None and de is not None:
            judged[vid].append((ds, de))
    keeps = Counter(c.video_id for c in dd.latest_clips() if c.keep)
    out = []
    for vid, name, path, duration, clips, proposals in rows:
        if not duration or not Path(path).exists():
            continue
        ranges = list(judged[vid])
        for item in (clips or []) + (proposals or []):
            ranges.append((item["start_seconds"], item["end_seconds"]))
            if item.get("detected"):
                ranges.append((item["detected"]["start_seconds"], item["detected"]["end_seconds"]))
        out.append({"id": vid, "file_name": name, "duration": float(duration), "judged": merge(ranges),
                    "keeps": keeps.get(vid, 0), "channel": dd.channel(vid)})
    return out


def draw() -> list[dict]:
    rng = random.Random(SEED)
    probe = dc.load_probe()
    pools: dict[str, list[dict]] = defaultdict(list)
    eligible: Counter = Counter()
    for rec in recordings():
        found = dd.frames(rec["id"])
        if found is None or len(found[0]) < 4:
            continue
        t, v, _ = found
        probs = dc.classify(probe["W"], probe["b"], dc.context(v, probe["radius"]))
        scores = dc.highlight_scores(probs)
        proposals = dc.detect(probe, t, v, rec["duration"])
        base = {"video_id": rec["id"], "channel": rec["channel"], "file_name": rec["file_name"],
                "recording_seconds": rec["duration"], "recording_keeps": rec["keeps"]}

        # New proposals that lie mostly on unjudged time.
        fresh = []
        for p in proposals:
            a, b = p["start_seconds"], p["end_seconds"]
            if covered(a, b, rec["judged"]) < 0.5 * (b - a):
                fresh.append((a, b))
                eligible["new-time"] += 1
                if b - a > NEW_TIME_CAP:
                    a = max(a, min(p["peak_seconds"] - NEW_TIME_CAP / 2, b - NEW_TIME_CAP))
                    b = a + NEW_TIME_CAP
                pools["new-time"].append(base | {"start": a, "end": b, "score": p["score"],
                                                 "proposal": [p["start_seconds"], p["end_seconds"]]})
        taken = rec["judged"] + [(p["start_seconds"], p["end_seconds"]) for p in proposals]

        # Stretches just under the threshold, outside everything proposed.
        low, high = NEAR_MISS
        run = None
        for i, s in enumerate(list(scores) + [0.0]):
            if s >= 0.2 and i < len(scores):
                run = run or [i, i]
                run[1] = i
                continue
            if run:
                a, b = t[run[0]], t[run[1]] + dd.INTERVAL
                peak = float(scores[run[0]:run[1] + 1].max())
                if low <= peak < high and b - a >= 20 and covered(a, b, taken) == 0:
                    eligible["near-miss"] += 1
                    mid = float(t[run[0] + int(np.argmax(scores[run[0]:run[1] + 1]))])
                    start = min(max(0.0, mid - WINDOW / 2), max(0.0, rec["duration"] - WINDOW))
                    pools["near-miss"].append(base | {"start": start, "end": start + WINDOW, "score": round(peak, 3)})
                run = None

        # Random windows outside everything proposed.
        stratum = "outside" if rec["keeps"] else "no-keep"
        free = gaps(rec["duration"], taken)
        seconds = sum(b - a for a, b in free)
        eligible[stratum] += seconds
        for _ in range(3):
            if not free:
                break
            x = rng.uniform(0, seconds - WINDOW * len(free))
            for a, b in free:
                room = b - a - WINDOW
                if x <= room:
                    start = a + x
                    break
                x -= room
            else:
                continue
            index = np.searchsorted(t, [start, start + WINDOW])
            peak = float(scores[index[0]:max(index[1], index[0] + 1)].max()) if len(scores) else 0.0
            pools[stratum].append(base | {"start": round(start), "end": round(start) + WINDOW, "score": round(peak, 3)})

    picked: list[dict] = []
    for stratum, quota in QUOTA.items():
        pool = pools[stratum][:]
        rng.shuffle(pool)
        per_recording: Counter = Counter()
        per_channel: Counter = Counter()
        chosen = []
        # Spread across channels first, then recordings, then fill.
        for cap_channel, cap_recording in ((1, 1), (2, 1), (3, 2), (99, 99)):
            for item in pool:
                if len(chosen) >= quota or item in chosen:
                    continue
                if per_channel[item["channel"]] < cap_channel and per_recording[item["video_id"]] < cap_recording:
                    chosen.append(item)
                    per_channel[item["channel"]] += 1
                    per_recording[item["video_id"]] += 1
        units = eligible[stratum]
        for item in chosen:
            item["stratum"] = stratum
            # Seconds of free time (outside, no-keep) or stretches (near-miss, new-time) per window.
            item["weight"] = round(units / (len(chosen) * (WINDOW if stratum in ("outside", "no-keep") else 1)), 3)
            item["eligible"] = round(units, 1)
        picked += chosen
    rng.shuffle(picked)
    for position, item in enumerate(picked):
        item["position"] = position
    return picked


def insert(items: list[dict]) -> int:
    import psycopg

    with psycopg.connect(PG) as pg:
        written = 0
        for item in items:
            context = {key: item[key] for key in ("file_name", "recording_seconds", "recording_keeps", "score", "eligible")}
            if "proposal" in item:
                context["proposal"] = item["proposal"]
            written += pg.execute(
                """insert into recording_label_tasks
                     (kind, batch, video_id, start_seconds, end_seconds, stratum, weight, position, channel, context)
                   values ('recall-audit', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   on conflict do nothing""",
                (BATCH, item["video_id"], float(item["start"]), float(item["end"]), item["stratum"], item["weight"],
                 item["position"], item["channel"], json.dumps(context)),
            ).rowcount
    return written


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    items = draw()
    by = Counter(item["stratum"] for item in items)
    print(f"{len(items)} windows, {sum(i['end'] - i['start'] for i in items) / 60:.0f} min to watch, "
          f"{len({i['video_id'] for i in items})} recordings, {len({i['channel'] for i in items})} channels")
    for stratum in QUOTA:
        some = [i for i in items if i["stratum"] == stratum]
        if some:
            print(f"  {stratum:10} {by[stratum]:3}  eligible {some[0]['eligible']:>9}  weight {some[0]['weight']}")
    if not args.dry_run:
        print(f"inserted {insert(items)} tasks as {BATCH}")


if __name__ == "__main__":
    main()
