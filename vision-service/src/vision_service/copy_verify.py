"""Visual confirmation of an audio alignment: is it the same footage at the same instant?

Shared background music across different streams in the same room produces a perfect audio
alignment. At the aligned instant, though, a real copy shows the same pixels and the same motion,
while another stream shows a different pose on the same background. For each sample:

1. decode ~0.6 s from A and ~2.6 s from B around the aligned instant (absorbs A/V sync differences);
2. register B onto A with SIFT + RANSAC similarity (crop, scale, letterbox);
3. appearance: share of textured grid cells whose gradients agree;
4. motion: correlation of frame differences over the moving pixels.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass

import cv2
import numpy as np

FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_PATH", "ffprobe")
LONGEST_SIDE = 640
MAX_SIDE = 1280
WINDOW = 0.6
DELTA = 0.5
# Audio/video sync differs between encodes of the same footage (encoder priming, container
# start offsets, remuxes); the matching B frame is searched this far around the audio instant.
SEARCH = 1.0
CELL = 24
GRADIENT_BLUR = 2.5  # sigma; pixel-level texture and compression noise carry no copy evidence

# Same-room negatives measured ~0.45-0.53 appearance and ~0 motion; copies 0.73-1.0 and 0.8-1.0.
# A small performer in a wide shot keeps appearance high on a shared background, so motion
# agreement is required either way.
SAME_APPEARANCE = 0.65
SAME_MOTION = 0.5
DIFFERENT_APPEARANCE = 0.60
DIFFERENT_MOTION = 0.3
MIN_MOVING_SHARE = 0.02
# A weak registration (few inliers) may simply be the wrong transform, and a wrong transform
# guarantees disagreement: it can support "same" (pixels and motion agree) but never "different".
STRONG_INLIERS = 25
# Frames with this many SIFT keypoints that still share no geometry are different footage: a
# copy of even a soft 84-keypoint frame registers with 20+ inliers.
RICH_KEYPOINTS = 60


class DecodeError(RuntimeError):
    pass


@dataclass
class Sample:
    verdict: str  # same | different | unsure
    appearance: float | None = None
    motion: float | None = None
    moving: float | None = None
    inliers: int = 0
    scale: float | None = None
    reason: str | None = None
    av_offset: float | None = None  # seconds B's matching frame sits from the audio instant


def classify(appearance: float | None, motion: float | None) -> str:
    """same | different | unsure for one sample, or for a group's median evidence."""
    if appearance is None:
        return "unsure"
    if appearance < DIFFERENT_APPEARANCE or (motion is not None and motion < DIFFERENT_MOTION):
        return "different"
    if appearance >= SAME_APPEARANCE and motion is not None and motion >= SAME_MOTION:
        return "same"
    # static content: identical pixels alone do not prove a copy (an empty room looks the same)
    return "unsure"


class FrameSource:
    """Seeks into one file; probes geometry once."""

    def __init__(self, path: str, longest: int = LONGEST_SIDE):
        self.path = path
        out = subprocess.run(
            [
                FFPROBE,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_streams",
                "-of",
                "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        streams = json.loads(out.stdout or "{}").get("streams") or []
        if not streams:
            raise DecodeError("no video stream")
        s = streams[0]
        w, h = int(s["width"]), int(s["height"])
        rotation = next(
            (int(float(d["rotation"])) for d in s.get("side_data_list", []) if "rotation" in d), 0
        )
        if abs(rotation) % 180 == 90:  # ffmpeg autorotates decoded frames
            w, h = h, w
        self.source_size = (w, h)
        self.resize(longest)

    @property
    def portrait(self) -> bool:
        return self.source_size[1] > self.source_size[0]

    def resize(self, longest: int) -> None:
        w, h = self.source_size
        if w >= h:
            self.width, self.height = longest, max(2, int(round(longest * h / w / 2)) * 2)
        else:
            self.height, self.width = longest, max(2, int(round(longest * w / h / 2)) * 2)

    def frames(self, start: float, duration: float) -> np.ndarray:
        proc = subprocess.run(
            [
                FFMPEG, "-nostdin", "-v", "error", "-ss", f"{max(start, 0.0):.3f}", "-i", self.path,
                "-t", f"{duration:.3f}", "-an", "-sn", "-dn",
                "-vf", f"scale={self.width}:{self.height},format=gray", "-f", "rawvideo", "-",
            ],
            capture_output=True,
            timeout=120,
        )  # fmt: skip
        size = self.width * self.height
        n = len(proc.stdout) // size
        if n == 0:
            raise DecodeError("no frames decoded")
        return np.frombuffer(proc.stdout[: n * size], dtype=np.uint8).reshape(
            n, self.height, self.width
        )


def pair_sources(path_a: str, path_b: str) -> tuple[FrameSource, FrameSource]:
    """A vertical crop of a landscape video spans the landscape frame's full height: decode the
    landscape side at the portrait side's height so the shared region keeps its detail."""
    a, b = FrameSource(path_a), FrameSource(path_b)
    if a.portrait != b.portrait:
        landscape = b if a.portrait else a
        w, h = landscape.source_size
        landscape.resize(min(MAX_SIDE, int(round(LONGEST_SIDE * w / h))))
    return a, b


_sift = cv2.SIFT_create(nfeatures=1500)
_matcher = cv2.BFMatcher(cv2.NORM_L2)


def features(img: np.ndarray):
    return _sift.detectAndCompute(img, None)


def register(a, b: np.ndarray) -> tuple[np.ndarray | None, int, int]:
    """Similarity transform mapping B pixels onto A: (M, inliers, B keypoints).

    `a` is a frame or its precomputed `features()`."""
    ka, da = features(a) if isinstance(a, np.ndarray) else a
    kb, db = features(b)
    if da is None or db is None or len(ka) < 8 or len(kb) < 8:
        return None, 0, len(kb)
    good = [
        m[0]
        for m in _matcher.knnMatch(db, da, k=2)
        if len(m) == 2 and m[0].distance < 0.75 * m[1].distance
    ]
    if len(good) < 8:
        return None, 0, len(kb)
    src = np.float32([kb[m.queryIdx].pt for m in good])
    dst = np.float32([ka[m.trainIdx].pt for m in good])
    M, inliers = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0, maxIters=4000
    )
    if M is None:
        return None, 0, len(kb)
    return M, int(inliers.sum()), len(kb)


def _soften(img: np.ndarray, factor: float) -> np.ndarray:
    """Drop detail finer than the other side can show (factor = how much sharper this side is)."""
    if factor <= 1.1:
        return img
    h, w = img.shape
    small = cv2.resize(
        img, (max(8, int(w / factor)), max(8, int(h / factor))), interpolation=cv2.INTER_AREA
    )
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def _gradient(img: np.ndarray) -> np.ndarray:
    g = cv2.GaussianBlur(img.astype(np.float32), (0, 0), GRADIENT_BLUR)
    return cv2.magnitude(
        cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    )


def cell_agreement(
    x: np.ndarray, y: np.ndarray, mask: np.ndarray, min_std: float = 4.0
) -> float | None:
    """Share of textured, fully visible cells whose content correlates (NCC > 0.6)."""
    h, w = x.shape
    agree = total = 0
    for r in range(0, h - CELL + 1, CELL):
        for c in range(0, w - CELL + 1, CELL):
            if mask[r : r + CELL, c : c + CELL].mean() < 0.95:
                continue
            xa = x[r : r + CELL, c : c + CELL].ravel()
            ya = y[r : r + CELL, c : c + CELL].ravel()
            sx, sy = float(xa.std()), float(ya.std())
            if sx < min_std and sy < min_std:
                continue  # flat in both: no evidence either way
            total += 1
            if sx > 1e-3 and sy > 1e-3:
                ncc = float(((xa - xa.mean()) * (ya - ya.mean())).mean() / (sx * sy))
                agree += ncc > 0.6
    return agree / total if total >= 12 else None


def _normalized(img: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    """Zero-mean, unit-variance intensities: re-encodes shift brightness and contrast."""
    values = img[mask] if mask is not None else img
    return (img - float(values.mean())) / (float(values.std()) + 1e-3)


def _closest(target: np.ndarray, frames: list[np.ndarray], mask: np.ndarray, nominal: int) -> int:
    """Best pixel match; near-identical frames (static scenes) tie-break toward `nominal`."""
    t = target.astype(np.float32)
    errors = [
        float(np.abs(t - f.astype(np.float32))[mask].mean()) + 0.02 * abs(i - nominal)
        for i, f in enumerate(frames)
    ]
    return int(np.argmin(errors))


def compare(
    a: FrameSource, ta: float, b: FrameSource, tb: float, hint: float | None = None
) -> Sample:
    """One aligned instant. `hint`: A/V skew (s) already verified for this pair of files."""
    fa = a.frames(ta, WINDOW)
    b_start = max(0.0, tb - SEARCH)
    fb = b.frames(b_start, WINDOW + SEARCH + (tb - b_start))
    if len(fa) < 2 or len(fb) < 2:
        return Sample("unsure", reason="short_decode")
    a0 = fa[0]
    a1 = fa[min(len(fa) - 1, int(round(DELTA * len(fa) / WINDOW)))]
    fps_b = len(fb) / (WINDOW + SEARCH + (tb - b_start))
    nominal = min(len(fb) - 1, int(round((tb - b_start) * fps_b)))
    step = max(1, int(round(DELTA * fps_b)))
    last_start = len(fb) - 1 - step  # leave room for the second frame
    if last_start < 0:
        return Sample("unsure", reason="short_decode")

    # Which B frame is A's instant? Each candidate is registered with its own transform and
    # scored by normalized pixel error. Inlier counts alone tie on a static camera (the room
    # registers at every instant); one shared transform fails on a moving camera.
    fa0 = features(a0)
    stride = max(1, int(round(0.125 * fps_b)))
    h, w = a0.shape
    a0n = _normalized(a0.astype(np.float32))
    richest_b = 0
    most_inliers = 0
    scored: dict[int, tuple[float, np.ndarray, int]] = {}

    def score(i: int) -> None:
        nonlocal richest_b, most_inliers
        if i in scored:
            return
        M, inl, kb = register(fa0, fb[i])
        richest_b = max(richest_b, kb)
        most_inliers = max(most_inliers, inl)
        if M is None or inl < 12 or not 0.1 <= float(np.hypot(M[0, 0], M[1, 0])) <= 10:
            return
        visible = cv2.warpAffine(np.ones(fb[i].shape, np.uint8), M, (w, h)) > 0
        if visible.mean() < 0.05:
            return
        warped = _normalized(cv2.warpAffine(fb[i], M, (w, h)).astype(np.float32), visible)
        scored[i] = (float(np.abs(a0n - warped)[visible].mean()), M, inl)

    def fine(center: int) -> None:
        for i in range(max(0, center - stride + 1), min(last_start, center + stride - 1) + 1):
            score(i)

    if hint is not None:
        # A/V skew is a property of the two files: search around the verified one first
        fine(min(last_start, max(0, nominal + int(round(hint * fps_b)))))
    if not scored:
        for i in range(nominal % stride, last_start + 1, stride):
            score(i)
        # the two best coarse candidates: fast motion makes neighbours compete closely
        for c in sorted(scored, key=lambda i: scored[i][0])[:2]:
            fine(c)
    if scored:
        found = min(scored, key=lambda i: scored[i][0])
        _, M, inliers = scored[found]
    else:
        M, inliers, found = None, most_inliers, -1
    if M is None or inliers < 12:
        # Feature-rich frames on both sides with no geometric correspondence anywhere in the
        # window: this is other footage (same soundtrack over a different video).
        if len(fa0[0]) >= RICH_KEYPOINTS and richest_b >= RICH_KEYPOINTS and inliers < 8:
            return Sample("different", inliers=inliers, reason="no_correspondence")
        return Sample("unsure", inliers=inliers, reason="no_registration")
    h, w = a0.shape
    mask = cv2.warpAffine(np.ones(fb[0].shape, np.uint8), M, (w, h), flags=cv2.INTER_NEAREST)
    mask = cv2.erode(mask, np.ones((5, 5), np.uint8)) > 0
    if mask.mean() < 0.05:
        return Sample("unsure", inliers=inliers, reason="tiny_overlap")
    scale = float(np.hypot(M[0, 0], M[1, 0]))
    if not 0.1 <= scale <= 10:
        return Sample("unsure", inliers=inliers, reason="implausible_transform")
    # compare at the coarser of the two effective resolutions
    a0, a1 = _soften(a0, scale), _soften(a1, scale)
    lo0, hi0 = max(0, found - 2), min(last_start, found + 2) + 1
    hi1 = min(len(fb), hi0 + step + 3)
    warped = {i: cv2.warpAffine(_soften(fb[i], 1 / scale), M, (w, h)) for i in range(lo0, hi1)}
    # Both ends of B's difference are matched by pixels: a one-frame slip on fast motion would
    # otherwise decorrelate the frame differences of a genuine copy.
    ib0 = lo0 + _closest(a0, [warped[i] for i in range(lo0, hi0)], mask, found - lo0)
    lo, hi = max(ib0 + 1, ib0 + step - 3), min(hi1, ib0 + step + 4)
    ib1 = lo + _closest(a1, [warped[i] for i in range(lo, hi)], mask, ib0 + step - lo)
    b0, b1 = warped[ib0], warped[ib1]
    appearance = cell_agreement(_gradient(a0), _gradient(b0), mask)
    a0f = a0.astype(np.float32)
    da = cv2.GaussianBlur(a1.astype(np.float32) - a0f, (5, 5), 0)
    db = cv2.GaussianBlur(b1.astype(np.float32) - b0.astype(np.float32), (5, 5), 0)
    moving = mask & ((np.abs(da) > 6) | (np.abs(db) > 6))
    moving_share = float(moving.mean())
    motion = None
    if moving.sum() > 200 and moving_share >= MIN_MOVING_SHARE:
        x, y = da[moving], db[moving]
        if x.std() > 1e-3 and y.std() > 1e-3:
            motion = float(np.corrcoef(x, y)[0, 1])
    verdict = classify(appearance, motion)
    reason = None
    if verdict == "different" and inliers < STRONG_INLIERS:
        verdict, reason = "unsure", "weak_registration"
    return Sample(
        verdict,
        None if appearance is None else round(appearance, 3),
        None if motion is None else round(motion, 3),
        round(moving_share, 4),
        inliers,
        round(scale, 3),
        reason=reason,
        av_offset=round((ib0 - nominal) / fps_b, 3),
    )


def _median(values) -> float | None:
    values = [v for v in values if v is not None]
    return None if not values else round(float(np.median(values)), 3)


@dataclass
class GroupVerdict:
    status: str  # verified | ambiguous | rejected
    samples: list[Sample]

    def summary(self) -> dict:
        return {
            "status": self.status,
            "samples": len(self.samples),
            "same": sum(s.verdict == "same" for s in self.samples),
            "different": sum(s.verdict == "different" for s in self.samples),
            "appearance": _median(s.appearance for s in self.samples),
            "motion": _median(s.motion for s in self.samples),
            "inliers": int(np.median([s.inliers for s in self.samples])) if self.samples else 0,
            "scale": _median(s.scale for s in self.samples),
            "av_offset": _median(s.av_offset for s in self.samples),
        }


def group_status(samples: list[Sample]) -> str:
    """Median evidence decides, so a single odd sample (scene cut, logo over the action) cannot.

    Only strongly registered samples can reject: a weak transform explains any disagreement.
    Footage with no geometric correspondence in any sample is rejected as other video.
    """
    usable = [s for s in samples if s.appearance is not None]
    if not usable and sum(s.reason == "no_correspondence" for s in samples) >= 2:
        return "rejected"
    strong = [s for s in usable if s.inliers >= STRONG_INLIERS]

    def median_verdict(group: list[Sample]) -> str:
        return classify(_median(s.appearance for s in group), _median(s.motion for s in group))

    same = len(usable) >= 2 and median_verdict(usable) == "same"
    different = len(strong) >= 2 and median_verdict(strong) == "different"
    if same != different:
        return "verified" if same else "rejected"
    return "ambiguous"


def verify_times(
    a: FrameSource, b: FrameSource, times: list[tuple[float, float]], needed: int = 2
) -> GroupVerdict:
    """Sample (ta, tb) instants in order; stop once `needed` samples agree without contradiction,
    or once three samples give a clear median."""
    samples: list[Sample] = []
    hint = None
    for ta, tb in times:
        samples.append(compare(a, ta, b, tb, hint))
        if samples[-1].verdict == "same":
            hint = samples[-1].av_offset
        same = sum(s.verdict == "same" for s in samples)
        diff = sum(s.verdict == "different" for s in samples)
        if same >= needed and diff == 0 or diff >= needed and same == 0:
            break
        if len(samples) >= 3 and group_status(samples) != "ambiguous":
            break
    return GroupVerdict(group_status(samples), samples)


def sample_times(
    ranges: list[tuple[float, float]], offset_seconds: float, count: int
) -> list[tuple[float, float]]:
    """`count` (ta, tb) instants spread across B ranges, keeping clear of edges.

    Order alternates across the span (middle, early, late, ...) so an early exit still sees
    more than one region.
    """
    usable = [(s + 1.0, e - 1.0 - WINDOW) for s, e in ranges if e - s > 2.0 + WINDOW]
    total = sum(e - s for s, e in usable)
    if total <= 0:
        return []
    fractions = [0.5, 0.2, 0.8, 0.35, 0.65, 0.05, 0.95][:count]
    out = []
    for q in fractions:
        rest = q * total
        for s, e in usable:
            if rest <= e - s:
                out.append((s + rest + offset_seconds, s + rest))
                break
            rest -= e - s
    return out
