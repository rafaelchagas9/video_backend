"""Incremental catalogue matching, sharing the strict AMD worker and private cache.

One source queries a global compressed descriptor index. Only retrieved temporal
windows enter verification. Journals resume completed candidate pairs; media is read-only.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import signal
import sys
import tempfile
from pathlib import Path

from .video_copies import failure_payload
from .video_copy_frames import source_identity
from .video_copy_index import REVISION, index_video
from .video_copy_match import compare
from .video_copy_model import CopyModel
from .video_copy_retrieval import RetrievalIndex
from .video_copy_storage import CacheBudget, gpu_admission


def atomic_json(path: Path, value: dict):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=path.parent, prefix=".catalog-", suffix=".tmp", delete=False
        ) as output:
            temporary = Path(output.name)
            json.dump(value, output, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError("not an object")
        return value
    except (ValueError, OSError) as error:
        raise RuntimeError("COPY_CACHE_CORRUPT: invalid catalogue metadata") from error


def identity(path: str) -> dict:
    return {key: str(value) for key, value in source_identity(path).items()}


def token(record: dict) -> str:
    return hashlib.sha256(json.dumps({key: value for key, value in record.items() if key != "retrieval_token"}, sort_keys=True).encode()).hexdigest()


def candidate_token(candidates) -> str:
    evidence = []
    for candidate in candidates:
        part = {key: candidate[key] for key in ("speed", "offset", "start", "end") if key in candidate}
        indices = candidate.get("query_indices", [])
        part["query_indices"] = indices.tolist() if hasattr(indices, "tolist") else list(indices)
        evidence.append(part)
    return token({"windows": evidence, "truncated": bool(getattr(candidates, "truncated", False))})


def parse_request(raw: str) -> dict:
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get("version") != 1:
        raise ValueError("Invalid catalogue request")
    video = request.get("video")
    if not isinstance(video, dict) or type(video.get("id")) is not int or video["id"] < 1:
        raise ValueError("Invalid video")
    if not isinstance(video.get("path"), str) or not Path(video["path"]).is_absolute():
        raise ValueError("Invalid source")
    duration = video.get("duration_seconds")
    if (
        type(duration) not in (int, float)
        or not math.isfinite(duration)
        or not 5 <= duration <= 86400
        or "start_seconds" in video
    ):
        raise ValueError("Invalid duration")
    ids = request.get("reference_ids")
    if (
        not isinstance(ids, list)
        or len(ids) > 100000
        or any(type(i) is not int or i < 1 for i in ids)
    ):
        raise ValueError("Invalid reference catalogue")
    if (
        not isinstance(request.get("cache_dir"), str)
        or not Path(request["cache_dir"]).is_absolute()
    ):
        raise ValueError("Invalid cache")
    return request


def run(request: dict) -> dict:
    import cv2

    cv2.setNumThreads(2)
    cv2.setRNGSeed(42)
    root = Path(request["cache_dir"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # No published state is deleted. These are interrupted atomic JSON writes.
    for partial in root.glob(".catalog-*.tmp"):
        if partial.is_file() and not partial.is_symlink():
            partial.unlink()
    model = CopyModel(root)
    model.cache_budget = CacheBudget(root)
    catalog_path = root / "catalog.json"
    catalog = read_json(catalog_path, {})
    if catalog.get("revision") != REVISION or catalog.get("model_sha256") != model.digest:
        catalog = {"revision": REVISION, "model_sha256": model.digest, "videos": {}}
    entries = catalog["videos"]
    video = request["video"]
    query = index_video(video, model, root)
    own = {
        "video": video,
        "cache_key": query["cache_key"],
        "identity": {key: str(value) for key, value in query["identity"].items()},
        "revision": REVISION,
        "model_sha256": model.digest,
    }
    own_token = token(own)
    own["retrieval_token"] = own_token
    journal_path = root / f"catalog-work-{video['id']}.json"
    journal = read_json(journal_path, {})
    if journal.get("source") != own_token:
        journal = {"source": own_token, "pairs": {}}
    retrieval = RetrievalIndex(root / "retrieval-v4", model.digest, budget_root=root)
    retrieval.publish(video["id"], own_token, query["times"], query["views"])
    allowed = set(request["reference_ids"])
    eligible = {}
    skipped = 0
    missing_retrieval = 0
    for key, record in sorted(entries.items(), key=lambda item: int(item[0])):
        reference_video = record["video"]
        if reference_video["id"] == video["id"] or reference_video["id"] not in allowed:
            continue
        try:
            current = identity(reference_video["path"])
        except (OSError, ValueError):
            skipped += 1
            continue
        if current != record["identity"]:
            skipped += 1
            continue
        reference_token = token(record)
        if not retrieval.contains(reference_video["id"], reference_token):
            skipped += 1
            missing_retrieval += 1
            continue
        eligible[key] = reference_token
    retrieved = retrieval.search(
        video["id"], query["times"], query["views"],
        {int(key): value for key, value in eligible.items()},
    )
    # Pair journals belong to this generation and source; obsolete reference
    # tokens and pairs no longer retrieved cannot leak into a publication.
    candidate_keys = set()
    for reference_id, candidates in retrieved.candidates_by_video.items():
        key = str(reference_id)
        if key not in eligible:
            continue
        candidate_keys.add(key)
        record = entries[key]
        reference_token = eligible[key]
        candidate_digest = candidate_token(candidates)
        cached = journal["pairs"].get(key)
        if cached and cached.get("reference") == reference_token and cached.get("candidates") == candidate_digest:
            continue
        reference = index_video(record["video"], model, root)
        diagnostics = {"candidate_limited_pairs": 0}
        result = compare(query, reference, diagnostics=diagnostics, candidates=candidates)
        if identity(record["video"]["path"]) != record["identity"]:
            raise RuntimeError("COPY_SOURCE_CHANGED: reference changed during comparison")
        journal["pairs"][key] = {
            "reference": reference_token,
            "candidates": candidate_digest,
            "result": result,
            "candidate_limited": diagnostics["candidate_limited_pairs"],
        }
        atomic_json(journal_path, journal)
    if identity(video["path"]) != own["identity"]:
        raise RuntimeError("COPY_SOURCE_CHANGED: source changed during catalogue comparison")
    pairs = [
        value
        for key, value in journal["pairs"].items()
        if key in candidate_keys and value["reference"] == eligible[key]
    ]
    matches = [pair["result"] for pair in pairs if pair["result"]]
    result = {
        "version": 1,
        "revision": REVISION,
        "video_id": video["id"],
        "compared_videos": len(pairs),
        "retrieval_references": len(eligible),
        "retrieval_candidates": len(candidate_keys),
        "retrieval_truncated": bool(retrieved.truncated or missing_retrieval),
        "skipped_references": skipped,
        "match_count": len(matches),
        "matches": matches[:50],
        "truncated_matches": len(matches) > 50,
        "candidate_limited_pairs": sum(p["candidate_limited"] for p in pairs),
    }
    # Publication is the commit point. Interrupted work never looks synchronized.
    sources = {str(video["id"]): own}
    for match in matches[:50]:
        for source_id in (match["video_a"], match["video_b"]):
            if source_id != video["id"]:
                sources[str(source_id)] = entries[str(source_id)]
    atomic_json(root / f"catalog-result-{video['id']}.json", {"result": result, "sources": sources})
    entries[str(video["id"])] = own
    atomic_json(catalog_path, catalog)
    journal_path.unlink(missing_ok=True)
    return result


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
    raw = sys.stdin.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Request too large")
    request = parse_request(raw)
    with gpu_admission(Path(request["cache_dir"])):
        result = run(request)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps(failure_payload(error)), file=sys.stderr)
        sys.exit(1)
