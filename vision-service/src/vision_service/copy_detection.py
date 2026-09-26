"""Copy detection worker: audio retrieval + visual confirmation over the library index.

Reads one JSON request on stdin and streams JSON lines on stdout:
  {"type": "progress", "stage": "join" | "verify", "done": n, "total": m}
  {"type": "pair", ...}   one decided pair (match or rejected), safe to persist immediately
  {"type": "done", ...}   summary
Fatal errors end with a JSON line {"code": ...} on stderr and exit status 1.

Only the authenticated backend supplies local paths. Media files are opened read-only.
"""

from __future__ import annotations

import json
import os
import sys
import time

os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("OMP_NUM_THREADS", "2")

import numpy as np  # noqa: E402

from .copy_match import HOP, align_pair, group_by_offset, self_join, union_length  # noqa: E402

PACK_MAGIC = b"CPFP0001"
REVISION = "audio-visual-v1"


class InputError(ValueError):
    pass


def read_pack(path: str) -> dict[int, np.ndarray]:
    raw = np.fromfile(path, dtype=np.uint8)
    if raw.size < 12 or raw[:8].tobytes() != PACK_MAGIC:
        raise InputError("invalid fingerprint pack")
    words = raw[8:].view(np.uint32) if (raw.size - 8) % 4 == 0 else None
    if words is None:
        raise InputError("truncated fingerprint pack")
    count = int(words[0])
    out: dict[int, np.ndarray] = {}
    p = 1
    for _ in range(count):
        if p + 2 > words.size:
            raise InputError("truncated fingerprint pack")
        vid, n = int(words[p]), int(words[p + 1])
        p += 2
        if p + n > words.size:
            raise InputError("truncated fingerprint pack")
        out[vid] = words[p : p + n]
        p += n
    if p != words.size:
        raise InputError("trailing data in fingerprint pack")
    return out


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def needs_visual(
    cov_a: float, cov_b: float, sec_a: float, sec_b: float, dur_a: float, dur_b: float, policy: dict
) -> bool:
    """Could this audio evidence reach any class the product reports? Mirrors perceptual-relevance."""
    overlap = (
        min(sec_a, sec_b) >= policy["min_overlap_seconds"]
        and min(cov_a, cov_b) >= policy["min_overlap_coverage"]
    )
    short_cov, short_sec = (cov_a, sec_a) if dur_a <= dur_b else (cov_b, sec_b)
    similar = (
        short_cov >= policy["min_similarity_coverage"] and short_sec >= policy["min_clip_seconds"]
    )
    return overlap or similar


def _superseded(
    group, verified_a: list[tuple[int, int]], verified_b: list[tuple[int, int]]
) -> bool:
    """Is most of this group already covered, on either timeline, by a verified mapping?"""
    if not verified_a:
        return False
    length = sum(s.b1 - s.b0 for s in group)

    def overlap(ranges, verified):
        return union_length(ranges) + union_length(verified) - union_length(ranges + verified)

    return (
        max(
            overlap([(s.a0, s.a1) for s in group], verified_a),
            overlap([(s.b0, s.b1) for s in group], verified_b),
        )
        >= 0.5 * length
    )


def decide_pair(
    a: int, b: int, fa: np.ndarray, fb: np.ndarray, peaks, videos: dict, policy: dict, opts: dict
):
    """Returns a pair record, or None when the audio evidence is only a short shared fragment."""
    segments = align_pair(fa, fb, peaks)
    if not segments:
        return None, "no_alignment"
    dur_a, dur_b = videos[a]["duration"], videos[b]["duration"]
    sec_a = union_length([s.a_seconds for s in segments])
    sec_b = union_length([s.b_seconds for s in segments])
    if not needs_visual(sec_a / dur_a, sec_b / dur_b, sec_a, sec_b, dur_a, dur_b, policy):
        return None, "fragment"

    from .copy_verify import GroupVerdict, pair_sources, sample_times, verify_times

    sources = None
    source_error = None
    try:
        sources = pair_sources(videos[a]["path"], videos[b]["path"])
    except Exception as error:  # noqa: BLE001 - audio evidence stays, frames are unverifiable
        source_error = type(error).__name__

    groups = group_by_offset(segments)
    group_records = []
    out_segments = []
    verified_groups = rejected_groups = 0
    verified_a: list[tuple[int, int]] = []
    verified_b: list[tuple[int, int]] = []
    budget = opts["max_groups"]
    for gi, group in enumerate(groups):
        offset_s = float(np.median([s.offset for s in group])) * HOP
        ranges = [s.b_seconds for s in group]
        seconds = sum(e - s for s, e in ranges)
        if _superseded(group, verified_a, verified_b):
            # Looping playlists re-align the same stretch at another offset. A verified mapping
            # already explains it; the alias adds no coverage and would read as a conflict.
            group_records.append(
                {
                    "offset_seconds": round(offset_s, 3),
                    "seconds": round(seconds, 1),
                    "reason": "alias_of_verified",
                    "status": "superseded",
                    "samples": 0,
                }
            )
            continue
        if sources is None or budget <= 0:
            verdict = GroupVerdict("ambiguous", [])
            reason = "unverifiable_source" if sources is None else "verification_budget"
        else:
            budget -= 1
            confident = verified_groups >= 3 and rejected_groups == 0
            times = sample_times(ranges, offset_s, opts["samples"])
            reason = None if times else "too_short"
            try:
                verdict = (
                    verify_times(sources[0], sources[1], times, needed=1 if confident else 2)
                    if times
                    else GroupVerdict("ambiguous", [])
                )
            except Exception as error:  # noqa: BLE001
                # one unreadable stretch or odd frame must not end a library-wide pass
                verdict, reason = (
                    GroupVerdict("ambiguous", []),
                    f"verify_failed:{type(error).__name__}",
                )
        verified_groups += verdict.status == "verified"
        rejected_groups += verdict.status == "rejected"
        if verdict.status == "verified":
            verified_a.extend((s.a0, s.a1) for s in group)
            verified_b.extend((s.b0, s.b1) for s in group)
        summary = verdict.summary()
        group_records.append(
            {
                "offset_seconds": round(offset_s, 3),
                "seconds": round(seconds, 1),
                "reason": reason,
                **summary,
            }
        )
        if verdict.status == "rejected":
            continue
        for s in group:
            (a_start, a_end), (b_start, b_end) = s.a_seconds, s.b_seconds
            out_segments.append(
                {
                    "a_start": round(a_start, 3),
                    "a_end": round(min(a_end, dur_a), 3),
                    "b_start": round(b_start, 3),
                    "b_end": round(min(b_end, dur_b), 3),
                    "status": verdict.status,
                    "items": s.b1 - s.b0,
                    "ber": s.ber,
                    "contrast": s.contrast,
                    "votes": s.votes,
                    "group": gi,
                }
            )
    out_segments = [
        s for s in out_segments if s["a_end"] > s["a_start"] and s["b_end"] > s["b_start"]
    ]
    return {
        "type": "pair",
        "video_a": a,
        "video_b": b,
        "verdict": "match" if out_segments else "rejected",
        "segments": out_segments,
        "groups": group_records,
        "audio": {
            "matched_seconds_a": round(sec_a, 1),
            "matched_seconds_b": round(sec_b, 1),
            "votes": max(s.votes for s in segments),
        },
        "source_error": source_error,
    }, None


def run(request: dict) -> dict:
    if request.get("version") != 1:
        raise InputError("unsupported request version")
    fingerprints = read_pack(request["fingerprints"])
    videos = {int(k): v for k, v in request["videos"].items() if float(v.get("duration") or 0) > 0}
    focus = (
        set(int(v) for v in request["focus_ids"]) if request.get("focus_ids") is not None else None
    )
    skip = {(min(a, b), max(a, b)) for a, b in request.get("skip_pairs", [])}
    policy = request["policy"]
    opts = {
        "samples": int(request.get("samples_per_group", 5)),
        "max_groups": int(request.get("max_groups_per_pair", 12)),
    }
    # only fingerprints of available videos with a known duration take part
    fingerprints = {k: v for k, v in fingerprints.items() if k in videos}

    started = time.monotonic()
    emit({"type": "progress", "stage": "join", "done": 0, "total": 1})
    candidates = self_join(fingerprints, focus=focus)
    pairs = sorted(p for p in candidates if p not in skip)
    join_seconds = time.monotonic() - started
    stats = {"fragment": 0, "no_alignment": 0, "matches": 0, "rejected": 0, "errors": 0}
    failed: list[list[int]] = []
    for i, (a, b) in enumerate(pairs):
        emit({"type": "progress", "stage": "verify", "done": i, "total": len(pairs)})
        try:
            record, skipped = decide_pair(
                a, b, fingerprints[a], fingerprints[b], candidates[(a, b)], videos, policy, opts
            )
        except Exception as error:  # noqa: BLE001 - undecided pairs are retried by a later pass
            sys.stderr.write(f"pair {a}-{b} failed: {type(error).__name__}\n")
            stats["errors"] += 1
            failed.append([a, b])
            continue
        if record is None:
            stats[skipped] += 1
            continue
        stats["matches" if record["verdict"] == "match" else "rejected"] += 1
        emit(record)
    return {
        "type": "done",
        "revision": REVISION,
        "fingerprints": len(fingerprints),
        "candidates": len(candidates),
        "skipped_pairs": len(candidates) - len(pairs),
        "join_seconds": round(join_seconds, 2),
        "seconds": round(time.monotonic() - started, 2),
        "failed_pairs": failed,
        **stats,
    }


def main() -> int:
    try:
        import cv2

        cv2.setNumThreads(2)
        request = json.loads(sys.stdin.read(64 << 20))
        emit(run(request))
        return 0
    except InputError:
        sys.stderr.write(json.dumps({"code": "COPY_INPUT_INVALID"}) + "\n")
    except Exception as error:  # noqa: BLE001 - bounded public code, details stay local
        sys.stderr.write(f"{type(error).__name__}\n")
        sys.stderr.write(json.dumps({"code": "COPY_ANALYSIS_FAILED"}) + "\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
