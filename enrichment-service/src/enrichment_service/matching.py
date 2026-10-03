"""Rank stash-box scene results against a local file's fingerprints.

Ported from Stash's tagger (ui/v2.5/src/components/Tagger/scenes/utils.ts,
v0.31.1): priority is pHash matches, then submitted durations within 5 s, then
their ratios, then the smallest duration difference.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import cmp_to_key
from typing import Any

PHASH_DISTANCE = 8
DURATION_TOLERANCE_SECONDS = 5


@dataclass
class LocalFingerprints:
    """What we know about the local file being identified."""

    phashes: list[str] = field(default_factory=list)
    checksums: set[str] = field(default_factory=set)  # OSHASH / MD5 values, lowercase
    durations: list[float] = field(default_factory=list)


def hamming(a: str, b: str | None) -> int:
    if not b or len(a) != len(b):
        return 32
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 32


def _min_distance(hash_value: str, local: LocalFingerprints) -> int:
    return min((hamming(hash_value, p) for p in local.phashes), default=9999)


def _min_duration_diff(duration: float, local: LocalFingerprints) -> float:
    return min((abs(duration - d) for d in local.durations), default=9999.0)


def evidence(scene: dict[str, Any], local: LocalFingerprints) -> dict[str, Any]:
    """Fingerprint agreement between one scraped scene and the local file."""
    fingerprints = scene.get("fingerprints") or []
    phashes = [f for f in fingerprints if (f.get("algorithm") or "").upper() == "PHASH"]
    phash_matches = [f for f in phashes if _min_distance(f["hash"], local) <= PHASH_DISTANCE]
    durations = [f.get("duration") or 0 for f in fingerprints]
    diffs = [_min_duration_diff(d, local) for d in durations]
    duration_matches = [d for d in diffs if d <= DURATION_TOLERANCE_SECONDS]
    exact = any((f.get("algorithm") or "").upper() in {"OSHASH", "MD5"}
                and (f.get("hash") or "").lower() in local.checksums for f in fingerprints)
    scene_duration = scene.get("duration")
    return {
        "fingerprint_count": len(fingerprints),
        "phash_matches": len(phash_matches),
        "phash_total": len(phashes),
        "best_phash_distance": min((_min_distance(f["hash"], local) for f in phash_matches), default=None),
        "duration_matches": len(duration_matches),
        "duration_total": len(durations),
        "min_duration_diff": min(diffs) if diffs else None,
        "scene_duration_diff": (_min_duration_diff(float(scene_duration), local)
                                if scene_duration and local.durations else None),
        "exact_hash": exact,
    }


def _compare(a: dict[str, Any], b: dict[str, Any]) -> float:
    ea, eb = a["evidence"], b["evidence"]
    if not ea["fingerprint_count"] and eb["fingerprint_count"]:
        return 1
    if not eb["fingerprint_count"] and ea["fingerprint_count"]:
        return -1
    if ea["exact_hash"] != eb["exact_hash"]:
        return -1 if ea["exact_hash"] else 1
    pa = ea["phash_matches"] / ea["phash_total"] if ea["phash_total"] else 0
    pb = eb["phash_matches"] / eb["phash_total"] if eb["phash_total"] else 0
    # Stash returns "equal" when neither scene has a pHash match, skipping the
    # duration checks; re-encoded files often have no pHash match, so fall through.
    if ea["phash_matches"] != eb["phash_matches"] and 0 in (ea["phash_matches"], eb["phash_matches"]):
        return eb["phash_matches"] - ea["phash_matches"]
    if pa != pb:
        return pb - pa
    if ea["duration_matches"] != eb["duration_matches"]:
        return eb["duration_matches"] - ea["duration_matches"]
    da = ea["duration_matches"] / ea["duration_total"] if ea["duration_total"] else 0
    db = eb["duration_matches"] / eb["duration_total"] if eb["duration_total"] else 0
    if da != db:
        return db - da
    return (ea["min_duration_diff"] or 0) - (eb["min_duration_diff"] or 0)


def rank_scenes(scenes: list[dict[str, Any]], local: LocalFingerprints) -> list[dict[str, Any]]:
    """Return scenes best-first, each with an `evidence` dict attached."""
    annotated = [{**scene, "evidence": evidence(scene, local)} for scene in scenes]
    return sorted(annotated, key=cmp_to_key(_compare))


def confidence(evidence_value: dict[str, Any], fallback: float) -> float:
    """Map fingerprint evidence to Kura's 0..1 proposal confidence."""
    if evidence_value["exact_hash"]:
        return 1.0
    if evidence_value["phash_matches"]:
        ratio = evidence_value["phash_matches"] / max(evidence_value["phash_total"], 1)
        return round(0.9 + 0.09 * ratio, 3)
    if evidence_value["duration_matches"]:
        ratio = evidence_value["duration_matches"] / max(evidence_value["duration_total"], 1)
        return round(0.7 + 0.1 * ratio, 3)
    return fallback
