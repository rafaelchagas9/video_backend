"""Audio-anchored copy retrieval over Chromaprint fingerprints.

Every library video contributes its raw Chromaprint items (32-bit, one per HOP seconds). A global
self-join on identical items votes for (video pair, time offset). Offsets with enough votes are
aligned item by item: runs with a low bit error rate (BER) become candidate segments.

Silence, hum and other stationary audio match at *every* offset, so a run only counts when its
BER at the aligned offset is clearly lower than at offsets shifted by one to five seconds.
Shared background music still passes this test; the visual verifier settles those cases.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

HOP = 4096 / 3 / 11025  # seconds per Chromaprint item at 11025 Hz (algorithm 2)
# Each item summarises ~20 overlapping frames, so item k covers audio [k*HOP, k*HOP + ~2.7 s]:
# a run of items [s, e) ends ITEM_TAIL seconds after e*HOP (measured 2.60-2.69 s on real clips).
ITEM_TAIL = 2.6

# An item value shared by more places than this is a stop word (silence, clipping, tones).
MAX_GROUP = 48
MIN_VOTES = 4  # alignment is the cheap, strict filter; 10 s clips yield only ~5 exact items
SMOOTH_ITEMS = 41  # ~5 s window for the BER profile
MAX_BER = 0.30  # random alignment sits near 0.46-0.50
MIN_CONTRAST = 0.12
MIN_SEGMENT_SECONDS = 4.0
MERGE_GAP_SECONDS = 3.0
CONTRAST_SHIFTS = (-40, -24, -8, 8, 24, 40)  # items; ~1 to 5 s

_VID_BITS = 20
_OFF_BITS = 23
_OFF_BIAS = 1 << (_OFF_BITS - 1)
_POP8 = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def popcount32(x: np.ndarray) -> np.ndarray:
    v = np.ascontiguousarray(x, dtype=np.uint32).view(np.uint8).reshape(-1, 4)
    return _POP8[v].sum(axis=1, dtype=np.int32)


def self_join(
    fingerprints: dict[int, np.ndarray],
    focus: set[int] | None = None,
    max_group: int = MAX_GROUP,
    min_votes: int = MIN_VOTES,
) -> dict[tuple[int, int], list[tuple[int, int]]]:
    """Candidate offsets per pair (a < b by id): [(offset_items, votes)], strongest first.

    offset = index in A minus index in B for the same content. With `focus`, only pairs that
    involve at least one focused video are returned.
    """
    ids = np.array(sorted(fingerprints), dtype=np.int64)
    if ids.size < 2:
        return {}
    if ids.size >= 1 << _VID_BITS:
        raise ValueError("too many fingerprints for the join key")
    sizes = np.array([fingerprints[int(i)].size for i in ids], dtype=np.int64)
    codes = np.concatenate([fingerprints[int(i)] for i in ids]).astype(np.uint32, copy=False)
    vid = np.repeat(np.arange(ids.size, dtype=np.int32), sizes)
    starts_of = np.concatenate([[0], np.cumsum(sizes)[:-1]])
    pos = (np.arange(codes.size, dtype=np.int64) - np.repeat(starts_of, sizes)).astype(np.int32)
    focus_mask = None
    if focus is not None:
        focus_mask = np.isin(ids, np.fromiter(focus, dtype=np.int64))

    order = np.argsort(codes, kind="stable")
    c = codes[order]
    del codes
    group_start = np.flatnonzero(np.r_[True, c[1:] != c[:-1]])
    group_len = np.diff(np.r_[group_start, c.size])
    del c
    keys = []
    for size in range(2, max_group + 1):
        g = group_start[group_len == size]
        if g.size == 0:
            continue
        iu, ju = np.triu_indices(size, 1)
        mi = order[g[:, None] + iu[None, :]].ravel()
        mj = order[g[:, None] + ju[None, :]].ravel()
        va, vb = vid[mi], vid[mj]
        keep = va != vb
        if focus_mask is not None:
            keep &= focus_mask[va] | focus_mask[vb]
        mi, mj, va, vb = mi[keep], mj[keep], va[keep], vb[keep]
        swap = va > vb
        a = np.where(swap, vb, va).astype(np.int64)
        b = np.where(swap, va, vb).astype(np.int64)
        pa = np.where(swap, pos[mj], pos[mi]).astype(np.int64)
        pb = np.where(swap, pos[mi], pos[mj]).astype(np.int64)
        keys.append((a << (_VID_BITS + _OFF_BITS)) | (b << _OFF_BITS) | (pa - pb + _OFF_BIAS))
    if not keys:
        return {}
    k, n = np.unique(np.concatenate(keys), return_counts=True)
    sel = n >= 2
    k, n = k[sel], n[sel]
    a = (k >> (_VID_BITS + _OFF_BITS)).astype(np.int64)
    b = ((k >> _OFF_BITS) & ((1 << _VID_BITS) - 1)).astype(np.int64)
    off = (k & ((1 << _OFF_BITS) - 1)).astype(np.int64) - _OFF_BIAS
    votes: dict[tuple[int, int], dict[int, int]] = {}
    for ai, bi, oi, ni in zip(a.tolist(), b.tolist(), off.tolist(), n.tolist()):
        votes.setdefault((ai, bi), {})[oi] = ni
    out: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for (ai, bi), bins in votes.items():
        peaks = []
        for o, v in bins.items():
            left, right = bins.get(o - 1, 0), bins.get(o + 1, 0)
            # neighbouring bins absorb sub-item jitter; keep only the local maximum
            if v > left and v >= right:
                total = v + left + right
                if total >= min_votes:
                    peaks.append((o, total))
        if peaks:
            peaks.sort(key=lambda p: -p[1])
            out[(int(ids[ai]), int(ids[bi]))] = peaks
    return out


@dataclass
class Segment:
    """Aligned run; item indices, A index = B index + offset."""

    b0: int
    b1: int
    offset: int
    ber: float
    contrast: float
    votes: int

    @property
    def a0(self) -> int:
        return self.b0 + self.offset

    @property
    def a1(self) -> int:
        return self.b1 + self.offset

    @property
    def a_seconds(self) -> tuple[float, float]:
        return self.a0 * HOP, self.a1 * HOP + ITEM_TAIL

    @property
    def b_seconds(self) -> tuple[float, float]:
        return self.b0 * HOP, self.b1 * HOP + ITEM_TAIL

    @property
    def seconds(self) -> float:
        return (self.b1 - self.b0) * HOP + ITEM_TAIL


def _ber(fa: np.ndarray, fb: np.ndarray, offset: int, j: np.ndarray) -> np.ndarray:
    i = j + offset
    m = (i >= 0) & (i < fa.size)
    out = np.full(j.size, np.nan, dtype=np.float32)
    out[m] = popcount32(fa[i[m]] ^ fb[j[m]]) / 32.0
    return out


def aligned_runs(fa: np.ndarray, fb: np.ndarray, offset: int, votes: int = 0) -> list[Segment]:
    """Runs of B that match A at `offset` (refined by +-1 item), merged across short dips."""
    j = np.arange(fb.size)
    best = None
    for o in (offset - 1, offset, offset + 1):
        ber = _ber(fa, fb, o, j)
        valid = ~np.isnan(ber)
        if valid.sum() < SMOOTH_ITEMS:
            return []
        score = float(np.nanmean(ber))
        if best is None or score < best[0]:
            best = (score, o, ber)
    _, offset, ber = best
    valid = ~np.isnan(ber)
    filled = np.where(valid, ber, 0.5)
    kernel = np.ones(SMOOTH_ITEMS, dtype=np.float32) / SMOOTH_ITEMS
    smooth = np.convolve(filled, kernel, "same")
    good = (smooth < MAX_BER) & valid
    edges = np.flatnonzero(np.diff(np.r_[0, good.astype(np.int8), 0]))
    raw = list(zip(edges[::2].tolist(), edges[1::2].tolist()))
    merged: list[list[int]] = []
    gap = int(MERGE_GAP_SECONDS / HOP)
    for s, e in raw:
        if merged and s - merged[-1][1] <= gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    runs = []
    for s, e in merged:
        if (e - s) * HOP < MIN_SEGMENT_SECONDS:
            continue
        span = np.arange(s, e)
        aligned = float(np.nanmean(ber[s:e]))
        shifted = []
        for d in CONTRAST_SHIFTS:
            x = _ber(fa, fb, offset + d, span)
            if np.count_nonzero(~np.isnan(x)) > 8:
                shifted.append(float(np.nanmean(x)))
        contrast = (min(shifted) - aligned) if shifted else 0.0
        if contrast < MIN_CONTRAST:
            continue
        runs.append(Segment(s, e, offset, round(aligned, 4), round(contrast, 4), votes))
    return runs


def align_pair(
    fa: np.ndarray, fb: np.ndarray, peaks: list[tuple[int, int]], max_offsets: int = 256
) -> list[Segment]:
    """All accepted runs for a candidate pair, strongest offsets first, one pass per offset."""
    segments: list[Segment] = []
    tried: list[int] = []
    for offset, votes in peaks[:max_offsets]:
        if any(abs(offset - t) <= 2 for t in tried):
            continue
        tried.append(offset)
        segments.extend(aligned_runs(fa, fb, offset, votes))
    return segments


def union_length(ranges):
    total, end = 0, None
    start = None
    for s, e in sorted(ranges):
        if end is None or s > end:
            if end is not None:
                total += end - start
            start, end = s, e
        else:
            end = max(end, e)
    if end is not None:
        total += end - start
    return total


def group_by_offset(segments: list[Segment], tolerance: int = 3) -> list[list[Segment]]:
    """Segments sharing one time mapping (within `tolerance` items), longest group first."""
    groups: list[list[Segment]] = []
    for seg in sorted(segments, key=lambda s: s.offset):
        if groups and abs(seg.offset - groups[-1][-1].offset) <= tolerance:
            groups[-1].append(seg)
        else:
            groups.append([seg])
    groups.sort(key=lambda g: -sum(s.seconds for s in g))
    return groups
