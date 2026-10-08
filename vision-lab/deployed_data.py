"""Inputs for deployed_eval.py: reviewed decisions (latest generation), frames, hand labels.

Frames come from the source production reads (video_frame_embeddings) when it still holds the
recording, else from a training snapshot, else from the older ad hoc caches. Each recording is
cached once as data/emb/eval/<id>.npz (float16 vectors, which is what Postgres stores anyway),
so later runs never touch Postgres and only one recording is in memory at a time.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from label_server import DATA, PG

CACHE = DATA / "emb" / "eval"
INTERVAL = 5.0


def channel_key(name: str | None) -> str:
    return re.sub(r"^@", "", name or "").lower()


@dataclass
class Clip:
    video_id: int
    clip_id: str
    channel: str
    detector: str
    keep: bool
    added: bool
    reasons: list[str]
    start: float
    end: float
    detected_start: float | None
    detected_end: float | None
    score: float
    recording_seconds: float | None
    shown_default: str | None

    @property
    def model(self) -> str | None:
        try:
            parsed = json.loads(self.detector)
        except ValueError:
            return None
        return parsed.get("model") if isinstance(parsed, dict) else None


@lru_cache(maxsize=1)
def latest_clips() -> tuple[Clip, ...]:
    """Every recording's latest analysis generation, merged-away proposals left out."""
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            """select f.video_id, f.clip_id, f.channel, f.detector, f.verdict = 'keep', f.added, f.reasons,
                      f.start_seconds, f.end_seconds, f.detected_start, f.detected_end, f.score,
                      f.recording_seconds, f.shown_default
               from recording_clip_feedback f
               join (select video_id, max(analyzed_at) a from recording_clip_feedback group by video_id) l
                 on l.video_id = f.video_id and l.a = f.analyzed_at
               where f.merged_into is null order by f.video_id, f.start_seconds"""
        ).fetchall()
    return tuple(Clip(r[0], r[1], channel_key(r[2]), *r[3:]) for r in rows)


@lru_cache(maxsize=1)
def file_channels() -> dict[int, str]:
    import psycopg

    from label_server import channel_of

    with psycopg.connect(PG) as pg:
        # Deleted recordings leave the catalogue; the recorder's outcome log keeps their names.
        rows = pg.execute("select distinct video_id, file_name from recorder_autopilot_outcomes where video_id is not null").fetchall()
        rows += pg.execute("select id, file_name from videos").fetchall()
    return {vid: channel_key(channel_of(name)) for vid, name in rows}


def channel(video_id: int) -> str:
    """Stream a recording belongs to; a recording nothing names stands alone."""
    return file_channels().get(video_id) or f"unknown-{video_id}"


def hand_labels() -> dict[int, dict[int, str]]:
    from label_server import all_labels

    return all_labels()


def stored_negatives() -> dict[int, dict[int, str]]:
    from hard_negatives import stored

    return stored()


def _from_db(video_id: int):
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            "select timestamp_seconds, embedding::text from video_frame_embeddings where video_id = %s order by frame_index",
            (video_id,),
        ).fetchall()
    if not rows:
        return None
    t = np.array([r[0] for r in rows], np.float64)
    v = np.array([json.loads(r[1]) for r in rows], np.float16)
    return t, v, "db"


def _from_snapshot(video_id: int):
    import training_snapshots as ts

    try:
        reviews = ts.manifests(video_id)
    except (FileNotFoundError, ValueError):
        return None
    if not reviews:
        return None
    t, v = ts.frames(reviews[-1])
    return t, v.astype(np.float16), "snapshot"


def _from_old_cache(video_id: int):
    for folder in ("feedback", "siglip2-so400m-256"):
        path = DATA / "emb" / folder / f"{video_id}.npy"
        if path.exists():
            v = np.load(path).astype(np.float16)
            # These caches kept vectors only; storyboards sample every 5 s from 0.
            return np.arange(len(v)) * INTERVAL, v, f"cache:{folder}"
    return None


def frames(video_id: int) -> tuple[np.ndarray, np.ndarray, str] | None:
    """(timestamps, float16 vectors, source) for one recording, None if nothing holds its frames."""
    path = CACHE / f"{video_id}.npz"
    if path.exists():
        z = np.load(path)
        return z["t"], z["v"], str(z["source"])
    for load in (_from_db, _from_snapshot, _from_old_cache):
        found = load(video_id)
        if found is not None:
            CACHE.mkdir(parents=True, exist_ok=True)
            t, v, source = found
            np.savez(path, t=t, v=v, source=source)
            return found
    return None


if __name__ == "__main__":
    clips = latest_clips()
    labels = hand_labels()
    ids = sorted({c.video_id for c in clips} | set(labels))
    sources: dict[str, int] = {}
    for vid in ids:
        found = frames(vid)
        key = found[2] if found else "missing"
        sources[key] = sources.get(key, 0) + 1
        if not found:
            print("missing", vid)
    print(sources)
