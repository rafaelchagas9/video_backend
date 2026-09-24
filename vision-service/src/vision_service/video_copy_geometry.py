"""Bounded, crop-aware geometric verification for candidate video frames.

This module is deliberately a verifier, not a retrieval system.  Callers should
first retrieve a small set of candidate time ranges, then use this verifier on
several time-aligned frame pairs.  A single accepted frame is not sufficient to
declare a video copy: static scenes and reused backgrounds remain inherently
ambiguous without temporal evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from threading import local

import cv2
import numpy as np
from numpy.typing import NDArray

_MAX_FEATURES = 1_500
_LOWE_RATIO = 0.74
_RANSAC_THRESHOLD_PX = 3.5
_LOCAL = local()


@dataclass(frozen=True, slots=True)
class FrameFeatures:
    """Prepared image data used by :func:`verify`.

    ``points`` and ``descriptors`` are capped so both memory and matching cost
    remain bounded.  The grayscale image is retained for the independent
    photometric check after geometric alignment.
    """

    gray: NDArray[np.uint8]
    support: NDArray[np.uint8]
    points: NDArray[np.float32]
    descriptors: NDArray[np.float32] | None


def _as_gray(image: NDArray[np.generic]) -> NDArray[np.uint8]:
    pixels = np.asarray(image)
    if pixels.ndim == 2:
        gray = pixels
    elif pixels.ndim == 3 and pixels.shape[2] in (3, 4):
        conversion = cv2.COLOR_RGB2GRAY if pixels.shape[2] == 3 else cv2.COLOR_RGBA2GRAY
        gray = cv2.cvtColor(pixels, conversion)
    else:
        raise ValueError("image must be a non-empty grayscale, RGB, or RGBA array")

    if gray.size == 0 or gray.shape[0] < 32 or gray.shape[1] < 32:
        raise ValueError("image must be at least 32x32 pixels")
    if gray.dtype != np.uint8:
        if np.issubdtype(gray.dtype, np.floating):
            finite = np.nan_to_num(gray, nan=0.0, posinf=255.0, neginf=0.0)
            if finite.size and float(np.max(finite)) <= 1.0:
                finite = finite * 255.0
            gray = np.clip(finite, 0, 255).astype(np.uint8)
        else:
            gray = np.clip(gray, 0, 255).astype(np.uint8)
    return np.ascontiguousarray(gray)


def _content_support(gray: NDArray[np.uint8]) -> NDArray[np.uint8]:
    """Exclude uniform black letterbox bars from photometric corroboration.

    FFmpeg padding is exactly black before compression.  The percentile and
    variance checks tolerate mild codec ringing without treating ordinary dark
    image borders as padding.
    """

    row_active = (np.percentile(gray, 95, axis=1) > 10) | (np.std(gray, axis=1) > 3)
    column_active = (np.percentile(gray, 95, axis=0) > 10) | (np.std(gray, axis=0) > 3)
    active_rows = np.flatnonzero(row_active)
    active_columns = np.flatnonzero(column_active)
    support = np.zeros(gray.shape, dtype=np.uint8)
    if len(active_rows) == 0 or len(active_columns) == 0:
        return support
    support[
        active_rows[0] : active_rows[-1] + 1,
        active_columns[0] : active_columns[-1] + 1,
    ] = 255
    return support


def prepare_pixels(image: NDArray[np.generic]) -> FrameFeatures:
    """Prepare pixels/support without the SIFT cost for a fixed-transform check."""
    gray = _as_gray(image)
    return FrameFeatures(
        gray=gray,
        support=_content_support(gray),
        points=np.empty((0, 2), dtype=np.float32),
        descriptors=None,
    )


def prepare(image: NDArray[np.generic]) -> FrameFeatures:
    """Extract a bounded set of SIFT features from a grayscale or RGB frame."""

    pixels = prepare_pixels(image)
    sift = getattr(_LOCAL, "sift", None)
    if sift is None:
        sift = cv2.SIFT_create(
            nfeatures=_MAX_FEATURES,
            nOctaveLayers=3,
            contrastThreshold=0.025,
            edgeThreshold=12,
            sigma=1.6,
        )
        _LOCAL.sift = sift
    keypoints, descriptors = sift.detectAndCompute(pixels.gray, None)
    points = np.asarray([keypoint.pt for keypoint in keypoints], dtype=np.float32)
    if not keypoints:
        points = np.empty((0, 2), dtype=np.float32)
        descriptors = None
    elif descriptors is not None:
        descriptors = np.ascontiguousarray(descriptors, dtype=np.float32)
    return FrameFeatures(
        gray=pixels.gray,
        support=pixels.support,
        points=points,
        descriptors=descriptors,
    )


def verify_transform(
    query_features: FrameFeatures,
    reference_features: FrameFeatures,
    matrix: NDArray[np.float32 | np.float64],
) -> dict[str, object]:
    """Corroborate a previously established fixed crop transform photometrically."""

    affine_ok, anisotropy, shear, rotation_degrees = _valid_affine(matrix)
    reference_height, reference_width = reference_features.gray.shape
    mapped_query_support = cv2.warpAffine(
        query_features.support,
        matrix,
        (reference_width, reference_height),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    mapped_overlap = float(
        np.mean((mapped_query_support > 0) & (reference_features.support > 0))
    )
    pixel_error, gradient_similarity, changed_fraction = _photometric_evidence(
        query_features.gray,
        query_features.support,
        reference_features.gray,
        reference_features.support,
        matrix,
    )
    photometric_ok = (
        pixel_error <= 0.115
        and changed_fraction <= 0.36
        and (gradient_similarity >= 0.28 or pixel_error <= 0.045)
    )
    return {
        "accepted": bool(affine_ok and mapped_overlap >= 0.08 and photometric_ok),
        "inliers": 0,
        "pixel_error": pixel_error,
        "gradient_similarity": gradient_similarity,
        "changed_fraction": changed_fraction,
        "mapped_overlap": mapped_overlap,
        "anisotropy": anisotropy,
        "shear": shear,
        "rotation_degrees": rotation_degrees,
        "transform": np.asarray(matrix).tolist(),
    }


def _mutual_ratio_matches(
    query: NDArray[np.float32], reference: NDArray[np.float32]
) -> list[cv2.DMatch]:
    if len(query) < 2 or len(reference) < 2:
        return []

    matcher = cv2.BFMatcher(cv2.NORM_L2, crossCheck=False)
    forward_pairs = matcher.knnMatch(query, reference, k=2)
    reverse_pairs = matcher.knnMatch(reference, query, k=2)

    forward = {
        first.queryIdx: first
        for pair in forward_pairs
        if len(pair) == 2
        for first, second in [pair]
        if first.distance < _LOWE_RATIO * second.distance
    }
    reverse = {
        first.queryIdx: first.trainIdx
        for pair in reverse_pairs
        if len(pair) == 2
        for first, second in [pair]
        if first.distance < _LOWE_RATIO * second.distance
    }
    return [
        match
        for query_index, match in forward.items()
        if reverse.get(match.trainIdx) == query_index
    ]


def _hull_coverage(points: NDArray[np.float32], width: int, height: int) -> float:
    if len(points) < 3:
        return 0.0
    hull = cv2.convexHull(points.reshape(-1, 1, 2))
    return float(cv2.contourArea(hull) / max(1.0, float(width * height)))


def _support_bounds(support: NDArray[np.bool_ | np.uint8]) -> tuple[float, float, float, float]:
    rows, columns = np.nonzero(support)
    if len(rows) == 0:
        return 0.0, 0.0, 0.0, 0.0
    return (
        float(np.min(columns)),
        float(np.min(rows)),
        float(np.max(columns) + 1),
        float(np.max(rows) + 1),
    )


def _grid_distribution(
    points: NDArray[np.float32],
    width: int,
    height: int,
    bounds: tuple[float, float, float, float] | None = None,
) -> tuple[int, int, int]:
    if len(points) == 0:
        return 0, 0, 0
    left, top, right, bottom = bounds or (0.0, 0.0, float(width), float(height))
    bounded_width = right - left
    bounded_height = bottom - top
    if bounded_width <= 0 or bounded_height <= 0:
        return 0, 0, 0
    inside = (
        (points[:, 0] >= left - 1.0)
        & (points[:, 0] <= right + 1.0)
        & (points[:, 1] >= top - 1.0)
        & (points[:, 1] <= bottom + 1.0)
    )
    points = points[inside]
    if len(points) == 0:
        return 0, 0, 0
    origin = np.array([left, top], dtype=np.float32)
    cell_size = np.array([bounded_width / 4.0, bounded_height / 4.0], dtype=np.float32)
    cells = np.floor((points - origin) / cell_size)
    cells = np.clip(cells.astype(np.int32), 0, 3)
    unique = np.unique(cells, axis=0)
    return len(unique), len(np.unique(unique[:, 0])), len(np.unique(unique[:, 1]))


def _valid_affine(matrix: NDArray[np.float64]) -> tuple[bool, float, float, float]:
    linear = matrix[:, :2]
    determinant = float(np.linalg.det(linear))
    if not np.isfinite(linear).all() or determinant <= 0.0:
        return False, 0.0, 0.0, 0.0

    singular_values = np.linalg.svd(linear, compute_uv=False)
    smallest = float(np.min(singular_values))
    largest = float(np.max(singular_values))
    anisotropy = largest / max(smallest, 1e-9)

    first_column = linear[:, 0]
    second_column = linear[:, 1]
    first_length = float(np.linalg.norm(first_column))
    second_length = float(np.linalg.norm(second_column))
    orthogonality = abs(float(np.dot(first_column, second_column))) / max(
        first_length * second_length, 1e-9
    )

    u, _singular, vt = np.linalg.svd(linear)
    rotation = u @ vt
    rotation_degrees = abs(float(np.degrees(np.arctan2(rotation[1, 0], rotation[0, 0]))))

    accepted = (
        smallest >= 0.28
        and largest <= 3.6
        and anisotropy <= 2.6
        and orthogonality <= 0.20
        and rotation_degrees <= 18.0
    )
    return accepted, anisotropy, orthogonality, rotation_degrees


def _photometric_evidence(
    query: NDArray[np.uint8],
    query_support: NDArray[np.uint8],
    reference: NDArray[np.uint8],
    reference_support: NDArray[np.uint8],
    matrix: NDArray[np.float64],
) -> tuple[float, float, float]:
    reference_height, reference_width = reference.shape
    warped = cv2.warpAffine(
        query,
        matrix,
        (reference_width, reference_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    support = cv2.warpAffine(
        query_support,
        matrix,
        (reference_width, reference_height),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    support = cv2.erode(support, np.ones((5, 5), dtype=np.uint8), iterations=1) > 0
    support &= reference_support > 0
    if int(np.count_nonzero(support)) < 1_024:
        return 1.0, 0.0, 1.0

    query_values = warped[support].astype(np.float32)
    reference_values = reference[support].astype(np.float32)
    query_mean = float(np.mean(query_values))
    reference_mean = float(np.mean(reference_values))
    query_std = float(np.std(query_values))
    reference_std = float(np.std(reference_values))
    gain = np.clip(reference_std / max(query_std, 1.0), 0.55, 1.8)
    normalized_query = (query_values - query_mean) * gain + reference_mean
    differences = np.abs(normalized_query - reference_values)

    # Ignore the worst 20% so captions, logos, and modest overlays do not veto
    # an otherwise strong copy.  Widespread changed content still contributes.
    trim_at = max(1, int(len(differences) * 0.80))
    trimmed = np.partition(differences, trim_at - 1)[:trim_at]
    pixel_error = float(np.mean(trimmed) / 255.0)
    changed_fraction = float(np.mean(differences > 40.0))

    warped_float = warped.astype(np.float32)
    reference_float = reference.astype(np.float32)
    query_dx = cv2.Sobel(warped_float, cv2.CV_32F, 1, 0, ksize=3)[support]
    query_dy = cv2.Sobel(warped_float, cv2.CV_32F, 0, 1, ksize=3)[support]
    reference_dx = cv2.Sobel(reference_float, cv2.CV_32F, 1, 0, ksize=3)[support]
    reference_dy = cv2.Sobel(reference_float, cv2.CV_32F, 0, 1, ksize=3)[support]
    numerator = float(np.sum(query_dx * reference_dx + query_dy * reference_dy))
    denominator = float(
        np.sqrt(
            np.sum(query_dx * query_dx + query_dy * query_dy)
            * np.sum(reference_dx * reference_dx + reference_dy * reference_dy)
        )
    )
    gradient_similarity = numerator / denominator if denominator > 1e-6 else 0.0
    return pixel_error, float(np.clip(gradient_similarity, -1.0, 1.0)), changed_fraction


def _rejected(
    **values: float | int | bool | str | list[list[float]] | None,
) -> dict[str, object]:
    result: dict[str, object] = {
        "accepted": False,
        "inliers": 0,
        "inlier_ratio": 0.0,
        "query_coverage": 0.0,
        "reference_coverage": 0.0,
        "query_coverage_normalized": 0.0,
        "reference_coverage_normalized": 0.0,
        "mapped_overlap": 0.0,
        "pixel_error": 1.0,
    }
    result.update(values)
    return result


def verify(query_features: FrameFeatures, reference_features: FrameFeatures) -> dict[str, object]:
    """Verify that two candidate frames are related by a plausible crop/rescale.

    The result intentionally exposes evidence rather than only a boolean.  A
    temporal caller can require consistent transforms and offsets across frames
    and can downgrade static-scene matches to ambiguous.
    """

    if query_features.descriptors is None or reference_features.descriptors is None:
        return _rejected(reason="insufficient_features")

    matches = _mutual_ratio_matches(query_features.descriptors, reference_features.descriptors)
    if len(matches) < 12:
        return _rejected(matches=len(matches), reason="insufficient_matches")

    query_points = np.asarray(
        [query_features.points[match.queryIdx] for match in matches], dtype=np.float32
    )
    reference_points = np.asarray(
        [reference_features.points[match.trainIdx] for match in matches], dtype=np.float32
    )
    matrix, mask = cv2.estimateAffine2D(
        query_points,
        reference_points,
        method=cv2.RANSAC,
        ransacReprojThreshold=_RANSAC_THRESHOLD_PX,
        maxIters=3_000,
        confidence=0.995,
        refineIters=20,
    )
    if matrix is None or mask is None:
        return _rejected(matches=len(matches), reason="affine_estimation_failed")

    inlier_mask = mask.ravel().astype(bool)
    inliers = int(np.count_nonzero(inlier_mask))
    inlier_ratio = inliers / len(matches)
    inlier_query = query_points[inlier_mask]
    inlier_reference = reference_points[inlier_mask]
    query_height, query_width = query_features.gray.shape
    reference_height, reference_width = reference_features.gray.shape
    query_coverage = _hull_coverage(inlier_query, query_width, query_height)
    reference_coverage = _hull_coverage(inlier_reference, reference_width, reference_height)

    mapped_query_support = cv2.warpAffine(
        query_features.support,
        matrix,
        (reference_width, reference_height),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    mapped_intersection = (mapped_query_support > 0) & (reference_features.support > 0)
    query_support_fraction = float(np.mean(query_features.support > 0))
    mapped_overlap = float(np.mean(mapped_intersection))
    query_coverage_normalized = query_coverage / max(query_support_fraction, 1e-9)
    reference_coverage_normalized = reference_coverage / max(mapped_overlap, 1e-9)

    query_cells, query_columns, query_rows = _grid_distribution(
        inlier_query,
        query_width,
        query_height,
        _support_bounds(query_features.support),
    )
    reference_cells, reference_columns, reference_rows = _grid_distribution(
        inlier_reference,
        reference_width,
        reference_height,
        _support_bounds(mapped_intersection),
    )
    affine_ok, anisotropy, shear, rotation_degrees = _valid_affine(matrix)
    pixel_error, gradient_similarity, changed_fraction = _photometric_evidence(
        query_features.gray,
        query_features.support,
        reference_features.gray,
        reference_features.support,
        matrix,
    )

    spatially_distributed = (
        query_cells >= 3
        and reference_cells >= 3
        and max(query_cells, reference_cells) >= 4
        and query_columns >= 2
        and reference_columns >= 2
        and query_rows >= 2
        and reference_rows >= 2
    )
    photometric_ok = (
        pixel_error <= 0.115
        and changed_fraction <= 0.36
        and (gradient_similarity >= 0.28 or pixel_error <= 0.045)
    )
    accepted = (
        inliers >= 12
        and inlier_ratio >= 0.38
        and query_coverage_normalized >= 0.10
        and reference_coverage_normalized >= 0.16
        and mapped_overlap >= 0.08
        and spatially_distributed
        and affine_ok
        and photometric_ok
    )

    return {
        "accepted": bool(accepted),
        "inliers": inliers,
        "inlier_ratio": float(inlier_ratio),
        "query_coverage": query_coverage,
        "reference_coverage": reference_coverage,
        "query_coverage_normalized": query_coverage_normalized,
        "reference_coverage_normalized": reference_coverage_normalized,
        "mapped_overlap": mapped_overlap,
        "query_grid_cells": query_cells,
        "reference_grid_cells": reference_cells,
        "pixel_error": pixel_error,
        "matches": len(matches),
        "gradient_similarity": gradient_similarity,
        "changed_fraction": changed_fraction,
        "anisotropy": anisotropy,
        "shear": shear,
        "rotation_degrees": rotation_degrees,
        "transform": matrix.tolist(),
    }
