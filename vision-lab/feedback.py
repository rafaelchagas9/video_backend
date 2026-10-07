"""The reviewer's clip decisions (Kura's recording_clip_feedback), lined up with frame scores.

Each row is one highlight from one analysis: kept or skipped, why, the edges the detector
proposed and the edges the reviewer settled on. This module loads them with the frames of
their recordings so detector rules and probes can be replayed against real decisions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from label_model import CLASSES, context
from label_server import BACKEND, PG, RealSource, channel_of

PROBE = BACKEND / "data" / "models" / "recordings-highlight-probe.json"
POSITIVE = ("nude", "explicit")


@dataclass
class Decision:
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
    analyzed_at: str

    @property
    def trained(self) -> bool:
        return '"trained"' in self.detector

    @property
    def edges(self) -> tuple[float, float]:
        """What the detector proposed (falls back to the final edges)."""
        if self.detected_start is None or self.detected_end is None:
            return self.start, self.end
        return self.detected_start, self.detected_end


def decisions() -> list[Decision]:
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            """select video_id, clip_id, coalesce(channel, ''), detector, verdict = 'keep', added, reasons,
                      start_seconds, end_seconds, detected_start, detected_end, score, recording_seconds,
                      analyzed_at::text
               from recording_clip_feedback order by video_id, start_seconds"""
        ).fetchall()
    return [Decision(*row) for row in rows]


source = RealSource()


@lru_cache(maxsize=128)
def frames(video_id: int) -> tuple[np.ndarray, np.ndarray]:
    """(timestamps, embeddings) for every indexed frame of a recording."""
    import psycopg

    with psycopg.connect(PG) as pg:
        rows = pg.execute(
            "select frame_index, timestamp_seconds, embedding::text from video_frame_embeddings where video_id = %s order by frame_index",
            (video_id,),
        ).fetchall()
    timestamps = np.array([row[1] for row in rows], dtype=np.float64)
    cache = Path(__file__).parent / "data" / "emb" / "feedback" / f"{video_id}.npy"
    if cache.exists():
        vectors = np.load(cache)
    else:
        vectors = np.array([json.loads(row[2]) for row in rows], dtype=np.float32)
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.save(cache, vectors)
    return timestamps, vectors


def load_probe(path: Path = PROBE) -> dict:
    probe = json.loads(path.read_text())
    probe["W"] = np.array(probe["weights"], dtype=np.float32)
    probe["b"] = np.array(probe["bias"], dtype=np.float32)
    return probe


def probabilities(probe: dict, vectors: np.ndarray) -> np.ndarray:
    """Per-frame state probabilities, exactly as recordings.probe.ts computes them."""
    logits = context(vectors, probe["context_radius"]) @ probe["W"].T + probe["b"]
    logits -= logits.max(1, keepdims=True)
    exp = np.exp(logits)
    return exp / exp.sum(1, keepdims=True)


def smooth(values: np.ndarray, radius: int = 1) -> np.ndarray:
    kernel = np.ones(2 * radius + 1)
    return np.convolve(values, kernel, "same") / np.convolve(np.ones_like(values), kernel, "same")


def highlight_score(probs: np.ndarray, states=POSITIVE) -> np.ndarray:
    return smooth(probs[:, [CLASSES.index(state) for state in states]].sum(1))


def channel(video_id: int) -> str:
    return channel_of(source.recordings()[video_id]["file_name"]) if video_id in source.recordings() else ""
