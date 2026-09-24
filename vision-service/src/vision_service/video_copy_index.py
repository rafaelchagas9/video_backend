"""Incremental private frame indexes keyed by source identity and algorithm/model revision."""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
from zipfile import BadZipFile

import cv2
import numpy as np

from .video_copy_frames import extract, source_identity

LEGACY_REVISION = "sscd-regions-sift-temporal-v2"
INDEX_REVISION = "sscd-ivfpq-dense-v3"  # Descriptor identity, independent of search codec.
REVISION = "sscd-temporal-v4"
VIEW_COUNT = 11


def index_video(video: dict, model, cache: Path) -> dict:
    before = source_identity(video["path"])
    start = float(video.get("start_seconds", 0))
    duration = float(video["duration_seconds"])
    key = hashlib.sha256(
        json.dumps(
            {
                "source": before,
                "model": model.digest,
                "revision": INDEX_REVISION,
                "start": start,
                "duration": duration,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    legacy_key = hashlib.sha256(
        json.dumps({"source": before, "model": model.digest, "revision": LEGACY_REVISION,
                    "start": start, "duration": duration}, sort_keys=True).encode()
    ).hexdigest()
    folder = cache / "indexes" / key
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    all_times, all_vectors, all_motion, all_views = [], [], [], []
    for chunk_number in range(math.ceil(duration / 60)):
        chunk_start = start + chunk_number * 60
        chunk_duration = min(60, start + duration - chunk_start)
        target = folder / f"{chunk_start:.6f}.npz"
        if target.exists():
            try:
                # Own the file handle so malformed ZIP headers cannot leak the
                # descriptor if NumPy raises before constructing an NpzFile.
                with target.open("rb") as archive, np.load(
                    archive, allow_pickle=False
                ) as saved:
                    times, thumbnails = saved["times"], saved["thumbnails"]
                    stored_views = saved["views"]
                    if stored_views.dtype not in (np.float16, np.float32):
                        raise ValueError("Invalid descriptor storage precision")
                    views = stored_views.astype(np.float32)
                    vectors = saved["vectors"] if "vectors" in saved.files else views[:, 0].copy()
                if (
                    vectors.shape != (len(times), 512)
                    or thumbnails.shape != (len(times), 16, 16)
                    or views.shape != (len(times), VIEW_COUNT, 512)
                ):
                    raise ValueError("Invalid cached dimensions")
                if (
                    not np.isfinite(views).all()
                    or views.dtype != np.float32
                    or not np.allclose(np.linalg.norm(views, axis=2), 1, atol=0.01)
                    or not np.isfinite(vectors).all()
                    or not np.isfinite(times).all()
                    or len(times) == 0
                    or len(times) > math.ceil(chunk_duration) + 3
                    or times[0] < chunk_start - 0.05
                    or times[-1] >= chunk_start + chunk_duration + 0.05
                    or times[0] > chunk_start + 2.5
                    or chunk_start + chunk_duration - times[-1] > 2.5
                    or (
                        len(times) > 1
                        and ((np.diff(times) <= 0).any() or (np.diff(times) > 2.5).any())
                    )
                    or not np.array_equal(vectors, views[:, 0])
                    or vectors.dtype != np.float32
                    or thumbnails.dtype != np.uint8
                    or not np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=0.01)
                ):
                    raise ValueError("Invalid cached content")
            except (ValueError, OSError, KeyError, BadZipFile):
                target.unlink(missing_ok=True)
                raise RuntimeError("COPY_CACHE_CORRUPT: Corrupt copy index removed; retry the job")
        else:
            # Reuse only compatible descriptors, never old decisions. The new
            # generation has its own files so an older worker cannot read v3 data.
            legacy = None
            legacy_path = cache / "indexes" / legacy_key / target.name
            if legacy_path.is_file():
                try:
                    with np.load(legacy_path, allow_pickle=False) as saved:
                        old_times, old_views = saved["times"], saved["views"]
                    if (old_views.shape == (len(old_times), 6, 512)
                        and old_views.dtype == np.float32
                        and np.isfinite(old_views).all()
                        and np.isfinite(old_times).all()
                        and np.allclose(np.linalg.norm(old_views, axis=2), 1, atol=0.01)):
                        legacy = (old_times, old_views)
                except (ValueError, OSError, KeyError, BadZipFile):
                    pass  # Old derived data is optional and is never mutated.
            times, outputs, thumbnails, batch = [], [], [], []
            for timestamp, frame in extract(
                video["path"], float(chunk_start), float(chunk_duration)
            ):
                times.append(timestamp)
                thumbnails.append(cv2.resize(cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY), (16, 16)))
                # Both crop axes receive equal sampling. Geometry verification
                # later uses aspect-preserving frames, not these model inputs.
                heights = [cv2.resize(frame[y:y + 96, :], (288, 288))
                           for y in (0, 48, 96, 144, 192)]
                regions = heights if legacy is not None else ([frame] + [
                    cv2.resize(frame[:, x:x + 96], (288, 288))
                    for x in (0, 48, 96, 144, 192)
                ] + heights)
                for region in regions:
                    batch.append(region)
                    if len(batch) == model.batch_size:
                        outputs.append(model.embed(batch))
                        batch.clear()
            if batch:
                outputs.append(model.embed(batch))
            times = np.array(times, dtype=np.float64)
            views = np.concatenate(outputs).reshape(len(times), 5 if legacy is not None else VIEW_COUNT, 512)
            if legacy is not None:
                if len(times) != len(legacy[0]) or not np.allclose(times, legacy[0], atol=0.001):
                    raise RuntimeError("COPY_CACHE_CORRUPT: legacy timestamps do not match extraction")
                views = np.concatenate([legacy[1], views], axis=1)
            vectors = views[:, 0].copy()
            thumbnails = np.array(thumbnails, dtype=np.uint8)
            if source_identity(video["path"]) != before:
                raise RuntimeError("COPY_SOURCE_CHANGED: Source changed during copy indexing")
            budget = getattr(model, "cache_budget", None)
            if budget is not None:
                budget.check(
                    views.nbytes + thumbnails.nbytes + times.nbytes + vectors.nbytes + 16384
                )
            name = None
            try:
                with tempfile.NamedTemporaryFile(
                    dir=folder, prefix=".chunk-", suffix=".tmp", delete=False
                ) as temporary:
                    name = temporary.name
                    np.savez_compressed(
                        temporary, times=times, thumbnails=thumbnails, views=views.astype(np.float16)
                    )
                os.replace(name, target)
            finally:
                if name is not None:
                    Path(name).unlink(missing_ok=True)
            if budget is not None:
                budget.add(target.stat().st_size)
        # Storage is FP16, inference and search remain FP32. Apply the identical
        # storage rounding on cold and warm paths, including pre-release FP32
        # chunks, so retries cannot change evidence solely through cache state.
        views = views.astype(np.float16).astype(np.float32)
        views /= np.linalg.norm(views, axis=2, keepdims=True)
        vectors = views[:, 0].copy()
        all_times.append(times - start)
        all_vectors.append(vectors)
        all_motion.append(thumbnails)
        all_views.append(views)
    if source_identity(video["path"]) != before:
        raise RuntimeError("COPY_SOURCE_CHANGED: Source changed while reading the copy index")
    # A lightweight status manifest lets the API detect truncated/replaced or
    # wrongly named chunks without importing Python or rereading descriptors.
    published_chunks = {}
    for chunk_number in range(math.ceil(duration / 60)):
        name = f"{start + chunk_number * 60:.6f}.npz"
        metadata = (folder / name).stat()
        published_chunks[name] = {"size": metadata.st_size, "mtime_ns": str(metadata.st_mtime_ns)}
    status_path = folder / "complete.json"
    status = {"revision": INDEX_REVISION, "cache_key": key, "chunks": published_chunks}
    temporary_status = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=folder, prefix=".complete-", suffix=".tmp", delete=False) as output:
            temporary_status = Path(output.name)
            json.dump(status, output, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_status, status_path)
    finally:
        if temporary_status is not None:
            temporary_status.unlink(missing_ok=True)
    return {
        "video": video,
        "cache_key": key,
        "identity": before,
        "times": np.concatenate(all_times),
        "vectors": np.concatenate(all_vectors),
        "thumbnails": np.concatenate(all_motion),
        "views": np.concatenate(all_views),
    }
