"""Offline copy matching worker. Reads one JSON request on stdin, emits one result.

Only the authenticated backend supplies local source paths. No HTTP file/path
access, media modifications, database access or automatic deletion occurs here.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import signal
import sys
import time
from pathlib import Path

# Set before importing numpy/OpenCV so a background worker cannot claim every CPU.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("OMP_NUM_THREADS", "2")

DEFAULT_FAILURE_CODE = "COPY_ANALYSIS_FAILED"
FAILURE_CODES = frozenset(
    {
        "COPY_MODEL_MISSING",
        "COPY_MODEL_INVALID",
        "COPY_GPU_UNAVAILABLE",
        "COPY_GPU_UNVERIFIED",
        "COPY_PRECISION_INVALID",
        "COPY_SOURCE_CHANGED",
        "COPY_DECODE_FAILED",
        "COPY_CACHE_CORRUPT",
        "COPY_CACHE_FULL",
        DEFAULT_FAILURE_CODE,
    }
)


def failure_payload(error: Exception) -> dict[str, str]:
    """Return a bounded diagnostic without exposing exception text or source paths."""
    message = str(error)
    prefix, separator, _detail = message.partition(":")
    approved = prefix in FAILURE_CODES and (bool(separator) or message == prefix)
    code = prefix if approved else DEFAULT_FAILURE_CODE
    return {"error": type(error).__name__, "code": code}


def parse_request(raw: str) -> dict:
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("Unsupported copy request version")
    videos = value.get("videos")
    if not isinstance(videos, list) or not 2 <= len(videos) <= 12:
        raise ValueError("A comparison requires between 2 and 12 videos")
    ids = set()
    duration_sum = 0.0
    for video in videos:
        if not isinstance(video, dict) or type(video.get("id")) is not int or video["id"] <= 0:
            raise ValueError("Invalid video ID")
        if video["id"] in ids:
            raise ValueError("Duplicate video ID")
        ids.add(video["id"])
        if not isinstance(video.get("path"), str) or not Path(video["path"]).is_absolute():
            raise ValueError("Source path must be absolute")
        duration = video.get("duration_seconds")
        if (
            type(duration) not in (int, float)
            or not math.isfinite(duration)
            or not 5 <= duration <= 86400
        ):
            raise ValueError("Video duration must be between 5 seconds and 24 hours")
        duration_sum += duration
        if "start_seconds" in video:
            raise ValueError("Partial source windows are only supported by the benchmark API")
    if duration_sum > 259200:
        raise ValueError("Batch exceeds the 72 hour indexing budget")
    if not isinstance(value.get("cache_dir"), str) or not Path(value["cache_dir"]).is_absolute():
        raise ValueError("Cache directory must be absolute")
    return value


def run(request: dict) -> dict:
    import cv2

    from .video_copy_frames import source_identity
    from .video_copy_index import REVISION, index_video
    from .video_copy_match import compare
    from .video_copy_model import CopyModel
    from .video_copy_retrieval import RetrievalIndex

    cv2.setNumThreads(2)
    cv2.setRNGSeed(42)
    started = time.monotonic()
    cache = Path(request["cache_dir"])
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    model = CopyModel(cache)
    from .video_copy_storage import CacheBudget

    model.cache_budget = CacheBudget(cache)
    retrieval = RetrievalIndex(cache / "retrieval-v4", model.digest, budget_root=cache)
    records, tokens, summaries = {}, {}, []
    # Publish one video at a time, avoiding one resident descriptor array per
    # selected source. Catalog and manual jobs share a single admission lock.
    for video in request["videos"]:
        index = index_video(video, model, cache)
        record = {"video": video, "cache_key": index["cache_key"],
                  "identity": {key: str(value) for key, value in index["identity"].items()},
                  "revision": REVISION, "model_sha256": model.digest}
        digest = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
        retrieval.publish(video["id"], digest, index["times"], index["views"])
        records[video["id"]] = record
        tokens[video["id"]] = digest
        summaries.append({"id": video["id"], "frame_count": len(index["times"]),
                          "duration_seconds": video["duration_seconds"]})
        del index
    matches, examined = [], set()
    diagnostics = {"candidate_limited_pairs": 0}
    retrieval_limited = False
    for video in sorted(request["videos"], key=lambda item: item["duration_seconds"]):
        query = index_video(video, model, cache)
        found = retrieval.search(video["id"], query["times"], query["views"], tokens)
        retrieval_limited |= found.truncated
        for reference_id, candidates in found.candidates_by_video.items():
            pair = tuple(sorted((video["id"], reference_id)))
            if pair in examined:
                continue
            examined.add(pair)
            reference = index_video(records[reference_id]["video"], model, cache)
            result = compare(query, reference, diagnostics=diagnostics, candidates=candidates)
            if result:
                matches.append(result)
            del reference
        del query
    for record in records.values():
        current = {key: str(value) for key, value in source_identity(record["video"]["path"]).items()}
        if current != record["identity"]:
            raise RuntimeError("COPY_SOURCE_CHANGED: source changed during copy comparison")
    return {
        "version": 1,
        "revision": REVISION,
        "videos": summaries,
        "matches": matches,
        "runtime": {
            **model.runtime,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "sample_rate": 1,
            "verification_rate": 5,
            "candidate_limit_per_pair": 64,
            "retrieval_truncated": bool(retrieval_limited),
            "retrieval_candidates": len(examined),
            "cache_bytes": model.cache_budget.used,
            **diagnostics,
        },
    }


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
    raw = sys.stdin.read(65537)
    if len(raw) > 65536:
        raise ValueError("Copy request exceeds input limit")
    request = parse_request(raw)
    from .video_copy_storage import gpu_admission

    with gpu_admission(Path(request["cache_dir"])):
        result = run(request)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print exception text that can contain a source path or native
        # runtime/model dump. Backend maps this to an actionable job failure.
        print(json.dumps(failure_payload(error)), file=sys.stderr)
        sys.exit(1)
