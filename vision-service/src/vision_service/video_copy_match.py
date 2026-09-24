"""Temporal candidate retrieval and conservative spatial corroboration.

Descriptors only propose candidates. Every returned relationship needs matching
local details in several frames; low-information or non-unique timing abstains.
"""

from __future__ import annotations

import cv2
import numpy as np

from .video_copy_frames import FrameSamplingGapError, extract
from .video_copy_geometry import prepare, prepare_pixels, verify, verify_transform


_MIN_WINDOW_SAMPLES = 9
_MIN_ALIGNED_SAMPLES = 8
_MIN_OBSERVED_SPAN_SECONDS = 8.0
_MAX_EVIDENCE_GAP_SECONDS = 1.5
_VERIFICATION_WINDOW_SECONDS = 15.0
_VERIFICATION_WINDOW_OVERLAP_SECONDS = 1.0
_MAX_LEGACY_CANDIDATES = 64
# Start with the former ~183-second sentinel budget, then grow only as far as
# the existing relevance policy needs, with a hard per-pair ceiling.
MIN_VERIFICATION_WINDOWS = 13
MAX_VERIFICATION_WINDOWS = 128
_INITIAL_SEARCH_RADIUS_SECONDS = 1.1
_REFERENCE_SEARCH_RADIUS_SECONDS = 0.45
_FIXED_TRANSFORM_TOLERANCE = 0.04
_QUERY_FRAME_CACHE_LIMIT = 32
_REFERENCE_FRAME_CACHE_LIMIT = 96


class _FrameCache:
    """Bounded decoded-frame and feature cache for one source/rate."""

    def __init__(self, source: dict, rate: float, limit: int):
        self.source = source
        self.rate = rate
        self.limit = limit
        self.frames: dict[float, dict] = {}
        self.covered: list[tuple[float, float]] = []

    def matches(self, source: dict, rate: float) -> bool:
        return (
            self.source.get("path") == source.get("path")
            and self.source.get("start_seconds", 0) == source.get("start_seconds", 0)
            and self.source.get("duration_seconds") == source.get("duration_seconds")
            and self.rate == rate
        )

    def _missing(self, start: float, end: float) -> list[tuple[float, float]]:
        missing = []
        cursor = start
        for low, high in sorted(self.covered):
            if high <= cursor:
                continue
            if low >= end:
                break
            if low > cursor:
                missing.append((cursor, min(low, end)))
            cursor = max(cursor, high)
            if cursor >= end:
                break
        if cursor < end:
            missing.append((cursor, end))
        return [(low, high) for low, high in missing if high - low > 1e-3]

    def _mark_covered(self, low: float, high: float) -> None:
        merged = []
        for start, end in sorted([*self.covered, (low, high)]):
            if merged and start <= merged[-1][1] + 1e-3:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        self.covered = [(start, end) for start, end in merged]

    def get(self, start: float, end: float) -> list[dict]:
        for low, high in self._missing(start, end):
            source_offset = float(self.source.get("start_seconds", 0))
            for timestamp, frame in extract(
                self.source["path"],
                low + source_offset,
                high - low,
                size=512,
                rate=self.rate,
            ):
                local_time = float(timestamp - source_offset)
                key = round(local_time, 6)
                self.frames[key] = {
                    "time": local_time,
                    "frame": frame,
                    "pixels": None,
                    "features": None,
                }
            self._mark_covered(low, high)

        selected = [
            item
            for item in self.frames.values()
            if start - 1e-3 <= item["time"] < end + 1e-3
        ]
        selected.sort(key=lambda item: item["time"])
        if len(self.frames) > self.limit:
            # Retain the current working set. Dropped intervals become
            # uncovered so a later distant request is decoded again safely.
            self.frames = {round(item["time"], 6): item for item in selected}
            self.covered = [(start, end)]
        return selected


def _prepared_pixels(item: dict):
    if item["features"] is not None:
        return item["features"]
    if item["pixels"] is None:
        item["pixels"] = prepare_pixels(item["frame"])
        item["frame"] = None
    return item["pixels"]


def _prepared_features(item: dict):
    if item["features"] is None:
        pixels = _prepared_pixels(item)
        item["features"] = prepare(pixels.gray)
        item["pixels"] = None
        item["frame"] = None
    return item["features"]


def _query_can_evolve(frames: list[dict]) -> bool:
    """Cheap necessary condition for the final shared-evolution proof."""

    informative = 0
    previous_time = None
    previous_gray = None
    for item in frames:
        pixels = _prepared_pixels(item)
        gray = cv2.resize(pixels.gray, (128, 128)).astype(np.float32)
        if previous_gray is not None and item["time"] - previous_time <= _MAX_EVIDENCE_GAP_SECONDS:
            if int(np.count_nonzero(np.abs(gray - previous_gray) > 6.0)) >= 48:
                informative += 1
        previous_time = item["time"]
        previous_gray = gray
    return informative >= 4


def _select_query_frames(
    frames: list[dict], selected: np.ndarray, selected_times: np.ndarray
) -> list[dict]:
    """Keep one decoded frame, closest in time, for each indexed query sample."""

    closest: dict[int, tuple[float, dict]] = {}
    for item in frames:
        position = int(np.argmin(np.abs(selected_times - item["time"])))
        distance = float(abs(selected_times[position] - item["time"]))
        if distance > 0.55:
            continue
        query_index = int(selected[position])
        previous = closest.get(query_index)
        if previous is None or distance < previous[0]:
            closest[query_index] = (distance, item)
    result = []
    for query_index in selected:
        value = closest.get(int(query_index))
        if value is not None:
            value[1]["query_index"] = int(query_index)
            result.append(value[1])
    return result


def nearest_frames(query: np.ndarray, reference: np.ndarray, k: int = 3):
    """Exact blocked search avoids approximate-index recall loss and N*M allocation."""
    k = min(k, len(reference))
    for start in range(0, len(query), 128):
        block = query[start : start + 128]
        values = np.full((len(block), k), -np.inf, dtype=np.float32)
        indices = np.zeros((len(block), k), dtype=np.int64)
        for offset in range(0, len(reference), 4096):
            similarities = block @ reference[offset : offset + 4096].T
            local_k = min(k, similarities.shape[1])
            chosen = np.argpartition(similarities, -local_k, axis=1)[:, -local_k:]
            scores = np.take_along_axis(similarities, chosen, axis=1)
            merged_values = np.concatenate([values, scores], axis=1)
            merged_indices = np.concatenate([indices, chosen + offset], axis=1)
            keep = np.argpartition(merged_values, -k, axis=1)[:, -k:]
            values = np.take_along_axis(merged_values, keep, axis=1)
            indices = np.take_along_axis(merged_indices, keep, axis=1)
        yield start, values, indices


class CandidateList(list):
    def __init__(self, values=(), truncated=False):
        super().__init__(values)
        self.truncated = truncated


def temporal_candidates(query: dict, reference: dict, search=nearest_frames) -> list[dict]:
    q_indices, r_indices, scores = [], [], []
    q_views = query.get("views", query["vectors"][:, None, :])
    r_views = reference.get("views", reference["vectors"][:, None, :])
    for start, values, indices in search(
        q_views.reshape(-1, q_views.shape[-1]), r_views.reshape(-1, r_views.shape[-1])
    ):
        rows, columns = np.where(values >= 0.50)
        q_indices.extend(((rows + start) // q_views.shape[1]).tolist())
        r_indices.extend((indices[rows, columns] // r_views.shape[1]).tolist())
        scores.extend(values[rows, columns].tolist())
    if len(scores) < 5:
        return []
    qi, ri, confidence = np.array(q_indices), np.array(r_indices), np.array(scores)
    qt, rt = query["times"][qi], reference["times"][ri]
    # Continuous speeds are obtained by refinement. The coarse grid is dense
    # enough that >=5 seconds of evidence survive between adjacent speeds.
    hypotheses = []
    for speed in np.arange(0.5, 2.001, 0.05):
        offsets = rt - qt * speed
        buckets = np.round(offsets).astype(np.int64)
        unique, inverse = np.unique(buckets, return_inverse=True)
        weights = np.bincount(inverse, weights=confidence)
        for bucket in np.argsort(weights)[-3:]:
            offset = float(unique[bucket])
            selected = np.abs(offsets - offset) <= 0.8
            if len(np.unique(qi[selected])) < 5:
                continue
            # Keep the voted slope; fitting all top-K neighbors here would mix
            # several adjacent reference frames and bias both speed and offset.
            fit = np.array([speed, np.median(offsets[selected])])
            residual = np.abs(rt - (qt * fit[0] + fit[1]))
            chosen = np.where(residual <= 0.65)[0]
            # Keep one reference timestamp for each query frame.
            best = {}
            for index in chosen:
                old = best.get(qi[index])
                if old is None or residual[index] < residual[old]:
                    best[qi[index]] = index
            ordered = sorted(best.values(), key=lambda index: qt[index])
            groups = []
            for index in ordered:
                if not groups or qt[index] - qt[groups[-1][-1]] > 2.5:
                    groups.append([])
                groups[-1].append(index)
            for group in groups:
                if len(group) < 5 or qt[group[-1]] - qt[group[0]] < 4:
                    continue
                part = np.array(group)
                score = float(confidence[part].mean()) * len(part)
                hypotheses.append(
                    {
                        "speed": float(fit[0]),
                        "offset": float(fit[1]),
                        "query_indices": qi[part],
                        "score": score,
                        "start": float(qt[part[0]]),
                        "end": float(qt[part[-1]]),
                    }
                )
    hypotheses.sort(
        key=lambda candidate: (candidate["score"], -abs(candidate["speed"] - 1)), reverse=True
    )
    unique = []
    for candidate in hypotheses:
        if any(
            abs(candidate["offset"] - old["offset"]) < 1.5
            and abs(candidate["speed"] - old["speed"]) < 0.08
            and candidate["start"] <= old["end"]
            and candidate["end"] >= old["start"]
            for old in unique
        ):
            continue
        unique.append(candidate)
        if len(unique) == _MAX_LEGACY_CANDIDATES + 1:
            break
    return CandidateList(
        unique[:_MAX_LEGACY_CANDIDATES],
        truncated=len(unique) > _MAX_LEGACY_CANDIDATES,
    )


def _motion(index: dict, indices: np.ndarray) -> float:
    frames = index["thumbnails"][indices].astype(np.float32) / 255
    if len(frames) < 3:
        return 0
    differences = np.abs(np.diff(frames, axis=0)).reshape(len(frames) - 1, -1)
    # Inspect the changing part of the image, without treating codec noise as motion.
    return float(np.mean(np.sort(differences, axis=1)[:, -64:]))


def _candidate_windows(query: dict, candidate: dict) -> list[dict]:
    """Split a retrieval hypothesis into dense, overlapping verification windows.

    Retrieval is allowed to propose a long relationship.  Verification is not
    allowed to turn sparse endpoints into coverage: every returned window has
    its own dense run of observed query samples.
    """

    raw_indices = candidate.get("query_indices")
    if raw_indices is None and candidate.get("hits"):
        raw_indices = [hit["query_index"] for hit in candidate["hits"]]
    if raw_indices is None:
        # Compatibility for callers/tests that replace verify_candidate.  The
        # real verifier still rejects a candidate without observed indices.
        return [candidate]

    query_times = np.asarray(query["times"], dtype=np.float64)
    if "start" in candidate and "end" in candidate:
        # ANN hits propose a temporal range; they are not the evidence being
        # verified. Confirm every available one-fps query sample in that range
        # so a missed ANN vote cannot create a false negative.
        indices = np.flatnonzero(
            (query_times >= float(candidate["start"]) - 0.1)
            & (query_times <= float(candidate["end"]) + 0.1)
        )
    else:
        indices = np.unique(np.asarray(raw_indices, dtype=np.int64))
        indices = indices[(indices >= 0) & (indices < len(query_times))]
    if len(indices) < _MIN_WINDOW_SAMPLES:
        return []
    indices = indices[np.argsort(query_times[indices])]

    runs: list[list[int]] = [[]]
    for index in indices:
        if runs[-1]:
            previous_time = float(query["times"][runs[-1][-1]])
            if float(query_times[index]) - previous_time > 1.5:
                runs.append([])
        runs[-1].append(int(index))

    windows: list[dict] = []
    for run in runs:
        if len(run) < _MIN_WINDOW_SAMPLES:
            continue
        cursor = 0
        previous_cursor = -1
        while cursor < len(run):
            start_time = float(query_times[run[cursor]])
            stop = cursor
            while (
                stop + 1 < len(run)
                and float(query_times[run[stop + 1]]) - start_time < _VERIFICATION_WINDOW_SECONDS
            ):
                stop += 1
            part = run[cursor : stop + 1]
            observed_span = float(query_times[part[-1]] - query_times[part[0]])
            if len(part) >= _MIN_WINDOW_SAMPLES and observed_span >= _MIN_OBSERVED_SPAN_SECONDS:
                window = dict(candidate)
                window["query_indices"] = np.asarray(part, dtype=np.int64)
                window["start"] = float(query_times[part[0]])
                window["end"] = float(query_times[part[-1]])
                windows.append(window)
            if stop == len(run) - 1:
                break
            next_time = float(query_times[run[stop]]) - _VERIFICATION_WINDOW_OVERLAP_SECONDS
            next_cursor = cursor + 1
            while next_cursor < len(run) and float(query_times[run[next_cursor]]) < next_time:
                next_cursor += 1
            final_time = float(query_times[run[-1]])
            if final_time - float(query_times[run[next_cursor]]) < _MIN_OBSERVED_SPAN_SECONDS:
                tail_start = final_time - (_VERIFICATION_WINDOW_SECONDS - 1.0)
                next_cursor = int(np.searchsorted(query_times[run], tail_start, side="left"))
            previous_cursor, cursor = cursor, max(cursor + 1, next_cursor)
            if cursor <= previous_cursor:
                break
    return windows


def _evidence_bounds(times: np.ndarray, duration: float) -> tuple[float, float]:
    """Return conservative sample support without filling an internal gap."""

    ordered = np.sort(np.asarray(times, dtype=np.float64))
    if len(ordered) < 2:
        value = min(max(0.0, float(ordered[0])), duration)
        return value, value
    step = min(1.0, float(np.median(np.diff(ordered))))
    start = max(0.0, float(ordered[0]) - step / 2)
    end = min(duration, float(ordered[-1]) + step / 2)
    if ordered[0] <= step * 0.75:
        start = 0.0
    if duration - ordered[-1] <= step * 1.25:
        end = duration
    return start, end


def _transform_deviation(matrices: list[np.ndarray]) -> float:
    """Measure fixed-crop transform drift as normalized corner displacement."""

    if not matrices:
        return 1.0
    anchors = np.asarray(
        [[0.0, 0.0, 1.0], [511.0, 0.0, 1.0], [0.0, 511.0, 1.0], [511.0, 511.0, 1.0]],
        dtype=np.float32,
    )
    mapped = np.stack([anchors @ matrix.T for matrix in matrices])
    median = np.median(mapped, axis=0)
    deviations = np.linalg.norm(mapped - median, axis=2).mean(axis=1)
    return float(np.quantile(deviations, 0.9) / np.hypot(512.0, 512.0))


def _temporal_evolution(evidence: list[dict]) -> dict[str, float | int | bool]:
    """Require the same pixels to evolve together over several transitions.

    A static studio can pass frame geometry because its background is genuinely
    shared.  It cannot supply this evidence.  Separately recorded movement in
    that studio changes different pixels and therefore has low motion overlap
    and low signed delta correlation.
    """

    similarities: list[float] = []
    overlaps: list[float] = []
    sign_agreements: list[float] = []
    energies: list[float] = []
    shared_motion_repeats = np.zeros((4, 4), dtype=np.int32)
    shared_motion_support = np.zeros((128, 128), dtype=bool)
    shared_support = np.zeros((128, 128), dtype=bool)
    for before, after in zip(evidence, evidence[1:], strict=False):
        if (
            after["q"] - before["q"] > _MAX_EVIDENCE_GAP_SECONDS
            or after["r"] - before["r"] > _MAX_EVIDENCE_GAP_SECONDS * 2.05
        ):
            continue
        support = before["support"] & after["support"]
        if int(np.count_nonzero(support)) < 1_024:
            continue
        q_delta = after["query_gray"] - before["query_gray"]
        r_delta = after["reference_gray"] - before["reference_gray"]
        q_active = (np.abs(q_delta) > 6.0) & support
        r_active = (np.abs(r_delta) > 6.0) & support
        q_count = int(np.count_nonzero(q_active))
        r_count = int(np.count_nonzero(r_active))
        minimum_motion = max(48, int(np.count_nonzero(support) * 0.004))
        if q_count < minimum_motion or r_count < minimum_motion:
            continue
        union = q_active | r_active
        intersection = q_active & r_active
        q_values = q_delta[union]
        r_values = r_delta[union]
        denominator = float(np.sqrt(np.sum(q_values**2) * np.sum(r_values**2)))
        similarity = float(np.sum(q_values * r_values) / denominator) if denominator > 1 else 0.0
        overlap = 2.0 * int(np.count_nonzero(intersection)) / max(1, q_count + r_count)
        intersection_count = int(np.count_nonzero(intersection))
        same_direction = intersection & (np.sign(q_delta) == np.sign(r_delta))
        same_sign = (
            float(np.mean(same_direction[intersection]))
            if intersection_count
            else 0.0
        )
        support_rows, support_columns = np.nonzero(support)
        if len(support_rows):
            top, bottom = int(support_rows.min()), int(support_rows.max()) + 1
            left, right = int(support_columns.min()), int(support_columns.max()) + 1
            grid_rows = np.clip(
                (support_rows - top) * 4 // max(1, bottom - top), 0, 3
            )
            grid_columns = np.clip(
                (support_columns - left) * 4 // max(1, right - left), 0, 3
            )
            support_counts = np.bincount(
                grid_rows * 4 + grid_columns, minlength=16
            )
            motion_rows, motion_columns = np.nonzero(same_direction)
            motion_grid_rows = np.clip(
                (motion_rows - top) * 4 // max(1, bottom - top), 0, 3
            )
            motion_grid_columns = np.clip(
                (motion_columns - left) * 4 // max(1, right - left), 0, 3
            )
            motion_counts = np.bincount(
                motion_grid_rows * 4 + motion_grid_columns, minlength=16
            )
            # A cell needs several corroborated pixels in two transitions.
            # This rejects a transient coincidence and keeps the criterion
            # meaningful after narrow crop/letterbox support normalization.
            meaningful = motion_counts >= np.maximum(
                8, np.ceil(support_counts * 0.01).astype(np.int64)
            )
            shared_motion_repeats += meaningful.reshape(4, 4)
            shared_motion_support[motion_rows, motion_columns] |= meaningful[
                motion_grid_rows * 4 + motion_grid_columns
            ]
            shared_support |= support
        similarities.append(float(np.clip(similarity, -1.0, 1.0)))
        overlaps.append(overlap)
        sign_agreements.append(same_sign)
        energies.append(float(np.mean(np.abs(q_delta[support])) / 255.0))

    informative = len(similarities)
    similarity = float(np.median(similarities)) if similarities else 0.0
    overlap = float(np.median(overlaps)) if overlaps else 0.0
    sign_agreement = float(np.median(sign_agreements)) if sign_agreements else 0.0
    energy = float(np.mean(energies)) if energies else 0.0
    repeated_cells = shared_motion_repeats >= 2
    grid_cells = int(np.count_nonzero(repeated_cells))
    grid_rows = int(np.count_nonzero(np.any(repeated_cells, axis=1)))
    grid_columns = int(np.count_nonzero(np.any(repeated_cells, axis=0)))
    support_rows, support_columns = np.nonzero(shared_support)
    span_x = span_y = 0.0
    if len(support_rows):
        top, bottom = int(support_rows.min()), int(support_rows.max()) + 1
        left, right = int(support_columns.min()), int(support_columns.max()) + 1
        motion_rows, motion_columns = np.nonzero(shared_motion_support)
        if len(motion_rows):
            motion_grid_rows = np.clip(
                (motion_rows - top) * 4 // max(1, bottom - top), 0, 3
            )
            motion_grid_columns = np.clip(
                (motion_columns - left) * 4 // max(1, right - left), 0, 3
            )
            repeated_motion = repeated_cells[
                motion_grid_rows, motion_grid_columns
            ]
            motion_rows = motion_rows[repeated_motion]
            motion_columns = motion_columns[repeated_motion]
            if len(motion_rows):
                row_counts = np.bincount(motion_rows, minlength=128)
                column_counts = np.bincount(motion_columns, minlength=128)
                meaningful_rows = np.flatnonzero(
                    row_counts >= max(2, int(np.ceil((right - left) * 0.02)))
                )
                meaningful_columns = np.flatnonzero(
                    column_counts >= max(2, int(np.ceil((bottom - top) * 0.02)))
                )
                if len(meaningful_rows):
                    span_y = float(
                        (meaningful_rows[-1] - meaningful_rows[0] + 1)
                        / max(1, bottom - top)
                    )
                if len(meaningful_columns):
                    span_x = float(
                        (meaningful_columns[-1] - meaningful_columns[0] + 1)
                        / max(1, right - left)
                    )
    return {
        "confirmed": bool(
            informative >= 4
            and similarity >= 0.55
            and overlap >= 0.40
            and sign_agreement >= 0.70
            and grid_rows >= 2
            and grid_columns >= 2
            and span_x >= 0.20
            and span_y >= 0.20
        ),
        "informative_transitions": informative,
        "similarity": similarity,
        "overlap": overlap,
        "sign_agreement": sign_agreement,
        "energy": energy,
        "grid_cells": grid_cells,
        "grid_rows": grid_rows,
        "grid_columns": grid_columns,
        "span_x": span_x,
        "span_y": span_y,
    }


def _fixed_rate_prediction(query_time: float, evidence: list[dict]) -> float:
    offset = float(np.median([point["r"] - point["q"] for point in evidence]))
    return query_time + offset


def verify_candidate(query: dict, reference: dict, candidate: dict, debug=None) -> dict | None:
    source_q, source_r = query["video"], reference["video"]

    def reject(reason: str):
        if debug is not None:
            debug(
                {
                    "reason": reason,
                    "start": candidate.get("start"),
                    "end": candidate.get("end"),
                    "speed": candidate.get("speed"),
                    "offset": candidate.get("offset"),
                }
            )
        return None

    # Playback-speed edits remain diagnostic, outside the first production
    # promise. Reject them before decoding rather than letting many coarse
    # retrieval slopes consume the bounded spatial-verification budget.
    if not 0.85 <= float(candidate.get("speed", 1.0)) <= 1.15:
        return reject("unsupported_speed")
    if "query_indices" not in candidate:
        return reject("missing_query_indices")
    selected = np.unique(np.asarray(candidate["query_indices"], dtype=np.int64))
    selected = selected[(selected >= 0) & (selected < len(query["times"]))]
    if len(selected) < _MIN_WINDOW_SAMPLES:
        return reject("insufficient_query_samples")
    selected = selected[np.argsort(query["times"][selected])]
    selected_times = np.asarray(query["times"])[selected]
    if selected_times[-1] - selected_times[0] < _MIN_OBSERVED_SPAN_SECONDS:
        return reject("insufficient_query_span")

    q_start = max(0.0, float(selected_times[0]))
    q_end = min(float(source_q["duration_seconds"]), float(selected_times[-1]) + 1.05)
    predicted_start = candidate["speed"] * q_start + candidate["offset"]
    predicted_end = candidate["speed"] * q_end + candidate["offset"]
    r_start = max(0.0, min(predicted_start, predicted_end) - 1.2)
    r_end = min(float(source_r["duration_seconds"]), max(predicted_start, predicted_end) + 1.2)
    if q_end <= q_start or r_end <= r_start:
        return reject("predicted_window_outside_source")

    context = candidate.get("_verification_context")
    if context is None:
        query_cache = _FrameCache(source_q, 1, _QUERY_FRAME_CACHE_LIMIT)
        reference_cache = _FrameCache(source_r, 5, _REFERENCE_FRAME_CACHE_LIMIT)
    else:
        query_cache, reference_cache = context
    try:
        query_frames = _select_query_frames(
            query_cache.get(q_start, q_end), selected, selected_times
        )
        if not _query_can_evolve(query_frames):
            return reject("insufficient_query_evolution")
        reference_frames = reference_cache.get(r_start, r_end)
    except FrameSamplingGapError:
        # A monotonic source cadence gap makes this window unknowable. Keep it
        # distinct from a negative match and let compare expose incompleteness.
        candidate["_verification_sampling_gap"] = True
        return reject("sampling_gap")
    required = max(_MIN_ALIGNED_SAMPLES, int(np.ceil(len(selected) * 0.85)))
    evidence = []
    seed_transform = candidate.get("_seed_transform")
    seed_inliers = int(candidate.get("_seed_inliers", 0))
    for position, query_item in enumerate(query_frames):
        query_time = float(query_item["time"])
        predicted = candidate["speed"] * query_time + candidate["offset"]
        if evidence:
            # The first production contract is fixed-rate playback. A slope
            # fitted from a short one-fps run is too noisy to aim later frames;
            # robustly refine only the clock offset here. The complete evidence
            # set still validates the observed slope below.
            predicted = _fixed_rate_prediction(query_time, evidence)

        anchor = position < 3 or position % 5 == 0 or len(evidence) < 3
        alternatives = []
        # A transform from an already verified neighboring window is trusted
        # immediately.  A new window must first establish three independent
        # geometric anchors; one coincidental match must not bootstrap the
        # cheaper fixed-transform path for the rest of the window.
        transform_pool = []
        if seed_transform is not None:
            transform_pool.append(np.asarray(seed_transform, dtype=np.float32))
            transform_pool.extend(point["transform"] for point in evidence)
        elif len(evidence) >= 3:
            transform_pool.extend(point["transform"] for point in evidence)
        if transform_pool:
            fixed_matrix = np.median(np.stack(transform_pool), axis=0).astype(np.float32)
            nearby_items = sorted(
                (
                    item
                    for item in reference_frames
                    if abs(item["time"] - predicted) <= _REFERENCE_SEARCH_RADIUS_SECONDS
                ),
                key=lambda item: abs(item["time"] - predicted),
            )
            for nearby in nearby_items:
                q_pixels = _prepared_pixels(query_item)
                nearby_pixels = _prepared_pixels(nearby)
                result = verify_transform(q_pixels, nearby_pixels, fixed_matrix)
                if result["accepted"]:
                    inliers = [point["inliers"] for point in evidence]
                    if seed_inliers:
                        inliers.append(seed_inliers)
                    result["inliers"] = int(np.median(inliers)) if inliers else 1
                    alternatives.append((result, nearby["time"], nearby_pixels))

        # Periodic anchors still seek independent SIFT corroboration. A seed
        # transform that passes the full photometric check remains usable when
        # a cropped/low-texture anchor has too few local features.
        if not alternatives or anchor:
            q_features = _prepared_features(query_item)
            radius = (
                _INITIAL_SEARCH_RADIUS_SECONDS
                if not evidence and seed_transform is None
                else _REFERENCE_SEARCH_RADIUS_SECONDS
            )
            nearby_items = sorted(
                (
                    item
                    for item in reference_frames
                    if abs(item["time"] - predicted) <= radius
                ),
                key=lambda item: abs(item["time"] - predicted),
            )
            if alternatives:
                # The fixed transform already supplied full photometric
                # evidence. A periodic SIFT refresh is useful when available,
                # but one nearest attempt is enough and low texture must not
                # trigger a broad optional search.
                nearby_items = nearby_items[:1]
            for item in nearby_items:
                reference_features = _prepared_features(item)
                result = verify(q_features, reference_features)
                if result["accepted"]:
                    alternatives.append(
                        (result, item["time"], reference_features)
                    )
                    # During bootstrap, score every geometrically accepted
                    # temporal alternative so the three required anchors use
                    # the best subframe phase instead of the nearest decode.
                    if len(evidence) >= 3 or seed_transform is not None:
                        break
        if alternatives:
            best, timestamp, reference_features = max(
                alternatives,
                key=lambda pair: (
                    float(pair[0].get("gradient_similarity", 0)) - float(pair[0]["pixel_error"]),
                    -abs(float(pair[1]) - predicted),
                ),
            )
            matrix = np.asarray(best["transform"], dtype=np.float32)
            q_pixels = _prepared_pixels(query_item)
            aligned = cv2.warpAffine(
                reference_features.gray,
                matrix,
                (512, 512),
                flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
            )
            aligned_support = cv2.warpAffine(
                reference_features.support,
                matrix,
                (512, 512),
                flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP,
            )
            support = (q_pixels.support > 0) & (aligned_support > 0)
            qi = int(query_item["query_index"])
            evidence.append(
                {
                    "qi": qi,
                    "q": query_time,
                    "r": min(max(0.0, timestamp), float(source_r["duration_seconds"])),
                    "inliers": int(best["inliers"]),
                    "error": float(best["pixel_error"]),
                    "query_gray": cv2.resize(q_pixels.gray, (128, 128)).astype(np.float32),
                    "reference_gray": cv2.resize(aligned, (128, 128)).astype(np.float32),
                    "support": cv2.resize(
                        support.astype(np.uint8), (128, 128), interpolation=cv2.INTER_NEAREST
                    ).astype(bool),
                    "transform": matrix,
                }
            )
        remaining_query_frames = len(query_frames) - position - 1
        if len(evidence) + remaining_query_frames < required:
            return reject("insufficient_spatial_evidence")
    if len(evidence) < required:
        return reject("insufficient_spatial_evidence")
    evidence.sort(key=lambda point: point["q"])
    q_times = np.array([point["q"] for point in evidence])
    r_times = np.array([point["r"] for point in evidence])
    if (
        q_times[-1] - q_times[0] < _MIN_OBSERVED_SPAN_SECONDS
        or (np.diff(q_times) > _MAX_EVIDENCE_GAP_SECONDS).any()
        or (np.diff(r_times) <= 0).any()
    ):
        return reject("non_contiguous_temporal_evidence")
    fit = np.polyfit(q_times, r_times, 1)
    residual = np.abs(r_times - np.polyval(fit, q_times))
    if (
        not 0.48 <= fit[0] <= 2.02
        or np.quantile(residual, 0.9) > 0.4
        or q_times[-1] - q_times[0] < 4
    ):
        return reject("inconsistent_temporal_fit")
    transform_deviation = _transform_deviation([point["transform"] for point in evidence])
    evolution = _temporal_evolution(evidence)
    fixed_transform = transform_deviation <= _FIXED_TRANSFORM_TOLERANCE
    identity_rate = 0.85 <= fit[0] <= 1.15
    verified = bool(evolution["confirmed"] and fixed_transform and identity_rate)
    a_start, a_end = _evidence_bounds(q_times, float(source_q["duration_seconds"]))
    b_start, b_end = _evidence_bounds(r_times, float(source_r["duration_seconds"]))
    return {
        "a_start": a_start,
        "a_end": a_end,
        "b_start": b_start,
        "b_end": b_end,
        "speed": float(fit[0]),
        "_temporal_offset": float(np.median(r_times - q_times)),
        "_seed_transform": np.median(
            np.stack([point["transform"] for point in evidence]), axis=0
        ).tolist(),
        "_seed_inliers": int(np.median([point["inliers"] for point in evidence])),
        "matched_frames": len(evidence),
        "spatial_inliers": int(np.median([p["inliers"] for p in evidence])),
        "motion": float(evolution["energy"]),
        "timing_error_seconds": float(np.quantile(residual, 0.9)),
        "temporal_motion_similarity": float(evolution["similarity"]),
        "temporal_motion_energy": float(evolution["energy"]),
        "temporal_motion_overlap": float(evolution["overlap"]),
        "temporal_informative_transitions": int(evolution["informative_transitions"]),
        "temporal_motion_grid_cells": int(evolution["grid_cells"]),
        "temporal_motion_grid_rows": int(evolution["grid_rows"]),
        "temporal_motion_grid_columns": int(evolution["grid_columns"]),
        "temporal_motion_span_x": float(evolution["span_x"]),
        "temporal_motion_span_y": float(evolution["span_y"]),
        "transform_deviation": transform_deviation,
        "status": "verified" if verified else "ambiguous",
    }


def _interval_seconds(intervals: list[tuple[float, float]]) -> float:
    merged: list[list[float]] = []
    for low, high in sorted(intervals):
        if high <= low:
            continue
        if merged and low <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], high)
        else:
            merged.append([low, high])
    return sum(high - low for low, high in merged)


def _verification_target(query: dict, reference: dict, candidates: list[dict]) -> float:
    if "video" not in query or "video" not in reference:
        return 0.0
    duration_a = float(query["video"]["duration_seconds"])
    duration_b = float(reference["video"]["duration_seconds"])
    partial_target = max(60.0, 0.05 * duration_a, 0.05 * duration_b)
    proposed_a = _interval_seconds(
        [(float(candidate["start"]), float(candidate["end"])) for candidate in candidates]
    )
    proposed_b = _interval_seconds(
        [
            (
                float(candidate["speed"]) * float(candidate["start"]),
                float(candidate["speed"]) * float(candidate["end"]),
            )
            for candidate in candidates
        ]
    )
    shorter_duration = min(duration_a, duration_b)
    proposed_shorter = proposed_a if duration_a <= duration_b else proposed_b
    containment_target = 0.85 * shorter_duration
    if proposed_shorter >= containment_target:
        return min(partial_target, containment_target)
    return partial_target


def _extension_windows(query: dict, segment: dict) -> list[dict]:
    """Turn a verified retrieval seed into adjacent verification proposals.

    ANN coverage is only a proposal boundary. Once a window has proved a
    mapping spatially and temporally, nearby dense query samples may be tested
    against that mapping. The extension itself receives exactly the same
    verifier and never contributes coverage unless it passes.
    """

    query_times = np.asarray(query.get("times", []), dtype=np.float64)
    if len(query_times) < _MIN_WINDOW_SAMPLES:
        return []
    duration = float(query["video"]["duration_seconds"])
    if duration <= 60.0:
        start, end = float(query_times[0]), float(query_times[-1])
    else:
        start = max(float(query_times[0]), float(segment["a_start"]) - 15.0)
        end = min(float(query_times[-1]), float(segment["a_end"]) + 15.0)
    speed = 1.0
    offset = float(
        segment.get(
            "_temporal_offset",
            float(segment["b_start"]) - speed * float(segment["a_start"]),
        )
    )
    proposal = {
        "query_indices": np.flatnonzero((query_times >= start) & (query_times <= end)),
        "start": start,
        "end": end,
        "speed": speed,
        "offset": offset,
        "score": 0.0,
        "_extension": True,
        "_seed_transform": segment.get("_seed_transform"),
        "_seed_inliers": segment.get("_seed_inliers", 0),
    }
    return _candidate_windows(query, proposal)


def _invert_candidates(
    candidates: list[dict], original_query: dict, shorter_query: dict
) -> CandidateList:
    """Express long-query retrieval hypotheses on the shorter video's grid."""

    shorter_times = np.asarray(shorter_query.get("times", []), dtype=np.float64)
    original_times = np.asarray(original_query.get("times", []), dtype=np.float64)
    if len(shorter_times) == 0:
        return CandidateList([], truncated=bool(getattr(candidates, "truncated", False)))
    inverted = []
    for candidate in candidates:
        speed = float(candidate.get("speed", 1.0))
        if speed == 0:
            continue
        start = float(candidate["start"])
        end = float(candidate["end"])
        mapped = (speed * start + float(candidate["offset"]),
                  speed * end + float(candidate["offset"]))
        low, high = min(mapped), max(mapped)
        value = dict(candidate)
        value.update(
            {
                "start": low,
                "end": high,
                "speed": 1.0 / speed,
                "offset": -float(candidate["offset"]) / speed,
                "query_indices": np.flatnonzero(
                    (shorter_times >= low - 0.1) & (shorter_times <= high + 0.1)
                ),
                "reference_video_id": original_query.get("video", {}).get("id"),
            }
        )
        if candidate.get("hits"):
            hits = []
            for hit in candidate["hits"]:
                query_time = float(hit["reference_time"])
                old_query_time = hit.get("query_time")
                if old_query_time is None:
                    old_index = int(hit["query_index"])
                    old_query_time = original_times[old_index]
                new_hit = dict(hit)
                new_hit.update(
                    {
                        "query_index": int(
                            np.argmin(np.abs(shorter_times - query_time))
                        ),
                        "query_time": query_time,
                        "reference_time": float(old_query_time),
                        "query_view": hit.get("reference_view"),
                        "reference_view": hit.get("query_view"),
                    }
                )
                hits.append(new_hit)
            value["hits"] = hits
        inverted.append(value)
    return CandidateList(inverted, truncated=bool(getattr(candidates, "truncated", False)))


def _invert_result(result: dict | None, query: dict, reference: dict) -> dict | None:
    if result is None:
        return None
    value = dict(result)
    segments = []
    for original in result["segments"]:
        segment = dict(original)
        inner_speed = float(original["speed"])
        segment.update(
            {
                "a_start": original["b_start"],
                "a_end": original["b_end"],
                "b_start": original["a_start"],
                "b_end": original["a_end"],
                "speed": 1.0 / inner_speed,
                "timing_error_seconds": float(original["timing_error_seconds"])
                / inner_speed,
            }
        )
        segments.append(segment)
    segments.sort(key=lambda segment: (segment["a_start"], segment["b_start"]))
    value.update(
        {
            "video_a": query["video"]["id"],
            "video_b": reference["video"]["id"],
            "segments": segments,
            "coverage_a": result["coverage_b"],
            "coverage_b": result["coverage_a"],
        }
    )
    return value


def _compare_ordered(
    query: dict,
    reference: dict,
    search=nearest_frames,
    diagnostics=None,
    *,
    candidates: list[dict] | None = None,
) -> dict | None:
    candidates = temporal_candidates(query, reference, search) if candidates is None else candidates
    retrieval_limited = bool(getattr(candidates, "truncated", False))
    candidates = sorted(
        (
            candidate
            for candidate in candidates
            if 0.85 <= float(candidate.get("speed", 1.0)) <= 1.15
        ),
        key=lambda candidate: (
            abs(float(candidate.get("speed", 1.0)) - 1.0),
            -float(candidate.get("score", 0.0)),
        ),
    )
    target_seconds = _verification_target(query, reference, candidates) if candidates else 0.0
    windows = [
        window for candidate in candidates for window in _candidate_windows(query, candidate)
    ]
    required_windows = max(
        1,
        int(
            np.ceil(
                max(0.0, target_seconds - _VERIFICATION_WINDOW_SECONDS)
                / (_VERIFICATION_WINDOW_SECONDS - _VERIFICATION_WINDOW_OVERLAP_SECONDS)
            )
        )
        + 1,
    )
    window_limit = min(
        MAX_VERIFICATION_WINDOWS,
        max(MIN_VERIFICATION_WINDOWS, required_windows + 1),
    )
    hard_limit_reached = len(windows) > window_limit
    segments = []
    target_reached = False
    verification_context = None
    if "video" in query and "video" in reference:
        query_cache = query.get("_verification_query_frame_cache")
        if not isinstance(query_cache, _FrameCache) or not query_cache.matches(
            query["video"], 1
        ):
            query_cache = _FrameCache(query["video"], 1, _QUERY_FRAME_CACHE_LIMIT)
            query["_verification_query_frame_cache"] = query_cache
        reference_cache = _FrameCache(reference["video"], 5, _REFERENCE_FRAME_CACHE_LIMIT)
        verification_context = (query_cache, reference_cache)
    scheduled = {
        (
            round(float(window["start"]), 3),
            round(float(window["end"]), 3),
            round(float(window["speed"]), 4),
            round(float(window["offset"]), 3),
        )
        for window in windows
    }
    cursor = 0
    verification_count = 0
    sampling_gap_seen = False
    while cursor < len(windows) and verification_count < window_limit:
        candidate = windows[cursor]
        cursor += 1
        midpoint = (candidate["start"] + candidate["end"]) / 2
        if any(
            candidate["start"] >= old["a_start"] - 1
            and candidate["end"] <= old["a_end"] + 1
            and abs(
                candidate["offset"]
                + candidate["speed"] * midpoint
                - (old["b_start"] + old["speed"] * (midpoint - old["a_start"]))
            )
            < 2
            for old in segments
        ):
            continue
        verification_count += 1
        candidate.pop("_verification_sampling_gap", None)
        if verification_context is not None:
            candidate["_verification_context"] = verification_context
        try:
            segment = verify_candidate(query, reference, candidate)
        finally:
            candidate.pop("_verification_context", None)
        sampling_gap_seen = bool(
            candidate.pop("_verification_sampling_gap", False)
        ) or sampling_gap_seen
        if segment is None:
            continue
        for field in ("a_start", "a_end"):
            segment[field] = min(
                max(0.0, segment[field]), float(query["video"]["duration_seconds"])
            )
        for field in ("b_start", "b_end"):
            segment[field] = min(
                max(0.0, segment[field]), float(reference["video"]["duration_seconds"])
            )
        if segment["a_end"] <= segment["a_start"] or segment["b_end"] <= segment["b_start"]:
            continue
        if segment["status"] == "verified" and not candidate.get("_extension"):
            adjacent = []
            for extension in _extension_windows(query, segment):
                key = (
                    round(float(extension["start"]), 3),
                    round(float(extension["end"]), 3),
                    round(float(extension["speed"]), 4),
                    round(float(extension["offset"]), 3),
                )
                if key not in scheduled:
                    scheduled.add(key)
                    adjacent.append(extension)
            # Confirm the proven mapping before spending the budget on weaker
            # ANN alternatives for the same query interval.
            insert_at = cursor + 1
            for extension in adjacent:
                windows.insert(min(insert_at, len(windows)), extension)
                insert_at += 2
        overlapping = [
            old
            for old in segments
            if segment["a_start"] <= old["a_end"] and segment["a_end"] >= old["a_start"]
        ]
        if segment["status"] == "ambiguous" and any(
            old["status"] == "verified" for old in overlapping
        ):
            # Weak alternatives are diagnostic, not counter-evidence. A static
            # or poorly evolving alignment cannot poison a strongly verified
            # sequence over the same query interval.
            continue
        if segment["status"] == "verified":
            segments = [
                old
                for old in segments
                if old not in overlapping or old["status"] != "ambiguous"
            ]
        duplicate = False
        for old in segments:
            overlaps = segment["a_start"] <= old["a_end"] and segment["a_end"] >= old["a_start"]
            overlap_midpoint = (
                max(segment["a_start"], old["a_start"])
                + min(segment["a_end"], old["a_end"])
            ) / 2
            same_time = (
                abs(
                    segment["b_start"]
                    + segment["speed"] * (overlap_midpoint - segment["a_start"])
                    - (
                        old["b_start"]
                        + old["speed"] * (overlap_midpoint - old["a_start"])
                    )
                )
                < 1.5
                and abs(segment["speed"] - old["speed"]) < 0.08
            )
            if overlaps and same_time:
                if old["status"] != segment["status"]:
                    continue
                old["a_start"] = min(old["a_start"], segment["a_start"])
                old["a_end"] = max(old["a_end"], segment["a_end"])
                old["b_start"] = min(old["b_start"], segment["b_start"])
                old["b_end"] = max(old["b_end"], segment["b_end"])
                old["matched_frames"] = max(old["matched_frames"], segment["matched_frames"])
                duplicate = True
                break
            if overlaps and segment["status"] == old["status"] == "verified":
                segment["status"] = old["status"] = "ambiguous"
        if not duplicate:
            segments.append(segment)
        verified_seconds = _interval_seconds(
            [
                (item["a_start"], item["a_end"])
                for item in segments
                if item["status"] == "verified"
            ]
        )
        if verified_seconds >= target_seconds:
            target_reached = True
            break
    hard_limit_reached = hard_limit_reached or (
        verification_count >= window_limit and cursor < len(windows)
    )
    verification_limited = sampling_gap_seen or (
        hard_limit_reached and not target_reached
    )
    if diagnostics is not None:
        diagnostics["verification_limited_pairs"] = diagnostics.get(
            "verification_limited_pairs", 0
        ) + int(verification_limited)
        diagnostics["candidate_limited_pairs"] = diagnostics.get(
            "candidate_limited_pairs", 0
        ) + int(retrieval_limited or verification_limited)
    if not segments:
        return None
    if any(segment["status"] == "verified" for segment in segments):
        # The product has no separate channel for weak alternatives inside a
        # verified pair. Keep the proven relationship and avoid letting an
        # unrelated intro/static suggestion downgrade it.
        segments = [segment for segment in segments if segment["status"] == "verified"]
    for segment in segments:
        segment.pop("_temporal_offset", None)
        segment.pop("_seed_transform", None)
        segment.pop("_seed_inliers", None)

    def coverage(start, end, duration):
        intervals = sorted((max(0.0, s[start]), min(duration, s[end])) for s in segments)
        merged = []
        for low, high in intervals:
            if merged and low <= merged[-1][1]:
                merged[-1][1] = max(high, merged[-1][1])
            else:
                merged.append([low, high])
        return min(1.0, sum(high - low for low, high in merged) / duration)

    return {
        "video_a": query["video"]["id"],
        "video_b": reference["video"]["id"],
        "status": "ambiguous" if any(s["status"] == "ambiguous" for s in segments) else "verified",
        "segments": segments,
        "coverage_a": coverage("a_start", "a_end", query["video"]["duration_seconds"]),
        "coverage_b": coverage("b_start", "b_end", reference["video"]["duration_seconds"]),
    }


def compare(
    query: dict,
    reference: dict,
    search=nearest_frames,
    diagnostics=None,
    *,
    candidates: list[dict] | None = None,
) -> dict | None:
    """Verify on the shorter timeline, while preserving caller orientation."""

    duration_a = float(query.get("video", {}).get("duration_seconds", 0.0))
    duration_b = float(reference.get("video", {}).get("duration_seconds", 0.0))
    if duration_a <= duration_b:
        return _compare_ordered(
            query,
            reference,
            search,
            diagnostics,
            candidates=candidates,
        )

    original_candidates = (
        temporal_candidates(query, reference, search) if candidates is None else candidates
    )
    inverted = _invert_candidates(original_candidates, query, reference)
    result = _compare_ordered(
        reference,
        query,
        search,
        diagnostics,
        candidates=inverted,
    )
    return _invert_result(result, query, reference)
