"""Queues scenes from the channels whose own labels taught the probe the wrong thing.

deployed-detector-eval.md traced most "Detector got it wrong" skips to shena_nomy: her hand labels
hold 318 explicit and 2 idle frames, so the probe learned that her look means nude or explicit.
sas4a is wrong in both splits with no labels of its own. The fix is balanced labels from these
channels, so this picks unlabelled scenes the labeller should ask about:

* **wrong** — scenes inside proposals the reviewer skipped as "Detector got it wrong" or
  "Pussy covered": the probe's false positives;
* **high** — other scenes the shipped probe scores at or above the 0.45 threshold;
* **mid** — scenes it scores between 0.2 and 0.45, where it is unsure;
* **low** — scenes it scores under 0.2, the idle and tease time her labels lack.

Scenes are the labeller's own (label_server.scenes), so one key labels one. The queue is written
to data/label_queue.json and shown in the labeller's Queue tab.

  uv run python channel_queue.py
"""

from __future__ import annotations

import json
import random
from collections import defaultdict

import numpy as np

import deployed_clipper as dc
from label_server import BACKEND, DATA, PG, RealSource, all_labels, scenes

# sas4a's false positives were in recordings since deleted; its remaining ones are labelled through
# the in-between scores instead.
CHANNELS = {"shena_nomy": {"wrong": 20, "high": 15, "low": 10}, "sas4a": {"wrong": 5, "high": 6, "mid": 8, "low": 6}}
WRONG = {"skip_wrong", "pussy covered"}
SEED = 20261009
OUT = DATA / "label_queue.json"


def wrong_skips() -> dict[int, list[tuple[float, float]]]:
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            """select video_id, coalesce(detected_start, start_seconds), coalesce(detected_end, end_seconds), reasons
               from recording_clip_feedback where verdict = 'skip'"""
        ).fetchall()
    out: dict[int, list[tuple[float, float]]] = defaultdict(list)
    for vid, a, b, reasons in rows:
        if any(reason.lower() in WRONG for reason in reasons or []):
            out[vid].append((a, b))
    return out


def main() -> None:
    rng = random.Random(SEED)
    source = RealSource()
    labelled = all_labels()
    wrong = wrong_skips()
    probe = dc.load_probe()
    pools: dict[str, dict[str, list[dict]]] = {channel: defaultdict(list) for channel in CHANNELS}
    for vid, rec in source.recordings().items():
        channel = rec["channel"].lower()
        if channel not in CHANNELS or labelled.get(vid):
            continue
        if not (BACKEND / rec["sprite"]).exists():
            continue
        emb = source.embeddings(vid)
        if not len(emb) or not np.abs(emb).sum():
            continue
        scores = dc.highlight_scores(dc.classify(probe["W"], probe["b"], dc.context(emb, probe["radius"])))
        for start, end in scenes(emb, {}, source.scene_similarity):
            a, b = start * rec["interval"], (end + 1) * rec["interval"]
            score = float(scores[start:end + 1].mean())
            item = {"video_id": vid, "start": start, "end": end, "channel": channel, "file_name": rec["file_name"],
                    "score": round(score, 3)}
            if any(min(b, y) - max(a, x) > 0.5 * (b - a) for x, y in wrong.get(vid, [])):
                pools[channel]["wrong"].append(item)
            elif score >= 0.45:
                pools[channel]["high"].append(item)
            elif score >= 0.2:
                pools[channel]["mid"].append(item)
            else:
                pools[channel]["low"].append(item)
    queue = []
    for channel, quotas in CHANNELS.items():
        for stratum, quota in quotas.items():
            pool = pools[channel][stratum]
            rng.shuffle(pool)
            # Round-robin over recordings so one long stream does not fill the stratum.
            by_video: dict[int, list[dict]] = defaultdict(list)
            for item in pool:
                by_video[item["video_id"]].append(item)
            picked: list[dict] = []
            while len(picked) < quota and any(by_video.values()):
                for items in by_video.values():
                    if items and len(picked) < quota:
                        picked.append(items.pop())
            for item in picked:
                item["why"] = stratum
            queue += picked
            print(f"{channel:11} {stratum:6} {len(picked):3} of {len(pool):4} scenes, "
                  f"{len({i['video_id'] for i in picked})} recordings")
    rng.shuffle(queue)
    OUT.write_text(json.dumps({"made": "channel_queue.py", "items": queue}, indent=1))
    print(f"{len(queue)} scenes, {sum(i['end'] - i['start'] + 1 for i in queue)} frames -> {OUT}")


if __name__ == "__main__":
    main()
