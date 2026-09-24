"""Bounded global candidate retrieval for video-copy descriptors.

FAISS shards replace catalogue-wide video-pair scans.  Shards are immutable
snapshots from the manifest's point of view: updating the small active shard
writes a new generation and atomically publishes it through ``manifest.json``.
Old generations and descriptors superseded by a source token are harmless and
can be removed later by deterministic maintenance.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .video_copy_match import CandidateList
from .video_copy_storage import CacheBudget

RETRIEVAL_REVISION = "sscd-temporal-v4"
_MANIFEST_VERSION = 1


@dataclass(frozen=True)
class PublishStats:
    added_vectors: int
    total_vectors: int
    trained: bool
    shards: int


@dataclass(frozen=True)
class RetrievalResult:
    candidates_by_video: dict[int, CandidateList]
    truncated: bool
    diagnostics: dict[str, int | float | str | bool]


@dataclass(frozen=True)
class NeighborAudit:
    scores: np.ndarray
    ids: np.ndarray
    saturated: bool
    shards: int


def _token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()[:16]


def descriptor_ids(video_id: int, times: np.ndarray, view_count: int) -> np.ndarray:
    """Build stable int64 IDs from video, float32 millisecond timestamp and view."""
    if type(video_id) is not int or not 0 < video_id < 2**23 or not 0 < view_count <= 255:
        raise ValueError("descriptor identity is out of range")
    times = np.asarray(times, dtype=np.float32)
    milliseconds = np.rint(times.astype(np.float64) * 1000).astype(np.int64)
    if (
        times.ndim != 1
        or not np.isfinite(times).all()
        or (milliseconds < 0).any()
        or (milliseconds >= 2**32).any()
    ):
        raise ValueError("descriptor timestamps are out of range")
    frames = np.repeat(milliseconds.astype(np.uint64), view_count)
    views = np.tile(np.arange(view_count, dtype=np.uint64), len(times))
    identifiers = np.uint64(video_id) << np.uint64(40) | frames << np.uint64(8) | views
    return identifiers.view(np.int64)


def _metadata_ids(metadata: dict[str, np.ndarray]) -> np.ndarray:
    milliseconds = np.rint(metadata["times"].astype(np.float64) * 1000).astype(np.uint64)
    return (
        metadata["video_ids"].astype(np.uint64) << np.uint64(40)
        | milliseconds << np.uint64(8)
        | metadata["views"].astype(np.uint64)
    ).view(np.int64)


def streaming_exact_topk(
    query_vectors: np.ndarray,
    reference_batches,
    top_k: int,
    *,
    reference_block_size: int = 4096,
) -> tuple[np.ndarray, np.ndarray]:
    """Return exact cosine top-K while holding only one reference block.

    ``reference_batches`` yields ``(stable_ids, normalized_vectors)``. Stable
    IDs are chosen by the diagnostic harness and must match the IDs used for
    the corresponding ANN results. This keeps the production index independent
    from benchmark-only identity schemes.
    """
    query = np.ascontiguousarray(query_vectors, dtype=np.float32)
    if query.ndim != 2 or query.shape[1] < 1 or top_k < 1 or reference_block_size < 1:
        raise ValueError("invalid exact-neighbor diagnostic input")
    values = np.full((len(query), top_k), -np.inf, dtype=np.float32)
    identifiers = np.full((len(query), top_k), -1, dtype=np.int64)
    dimensions = query.shape[1]
    for batch_ids, batch_vectors in reference_batches:
        batch_ids = np.asarray(batch_ids, dtype=np.int64)
        batch_vectors = np.asarray(batch_vectors, dtype=np.float32)
        if (
            batch_vectors.ndim != 2
            or batch_vectors.shape != (len(batch_ids), dimensions)
            or not np.isfinite(batch_vectors).all()
        ):
            raise ValueError("invalid exact-neighbor reference batch")
        for start in range(0, len(batch_vectors), reference_block_size):
            block = np.ascontiguousarray(
                batch_vectors[start : start + reference_block_size], dtype=np.float32
            )
            block_ids = batch_ids[start : start + reference_block_size]
            if not len(block):
                continue
            similarities = query @ block.T
            local_k = min(top_k, len(block))
            chosen = np.argpartition(similarities, -local_k, axis=1)[:, -local_k:]
            scores = np.take_along_axis(similarities, chosen, axis=1)
            found_ids = block_ids[chosen]
            merged_values = np.concatenate([values, scores], axis=1)
            merged_ids = np.concatenate([identifiers, found_ids], axis=1)
            keep = np.argpartition(merged_values, -top_k, axis=1)[:, -top_k:]
            values = np.take_along_axis(merged_values, keep, axis=1)
            identifiers = np.take_along_axis(merged_ids, keep, axis=1)
    order = np.argsort(values, axis=1)[:, ::-1]
    return np.take_along_axis(values, order, axis=1), np.take_along_axis(identifiers, order, axis=1)


def neighbor_recall(exact_ids: np.ndarray, approximate_ids: np.ndarray) -> float:
    """Mean per-query recall for two neighbor-ID matrices."""
    exact = np.asarray(exact_ids, dtype=np.int64)
    approximate = np.asarray(approximate_ids, dtype=np.int64)
    if exact.ndim != 2 or approximate.ndim != 2 or exact.shape[0] != approximate.shape[0]:
        raise ValueError("invalid neighbor matrices")
    recalls = []
    for expected, observed in zip(exact, approximate, strict=True):
        expected_set = {int(value) for value in expected if value >= 0}
        observed_set = {int(value) for value in observed if value >= 0}
        if expected_set:
            recalls.append(len(expected_set & observed_set) / len(expected_set))
    return float(np.mean(recalls)) if recalls else 1.0


def tolerant_neighbor_recall(
    exact_ids: np.ndarray,
    approximate_ids: np.ndarray,
    *,
    tolerance_milliseconds: int = 2_000,
) -> float:
    """Recall allowing any view from the same video and temporal neighborhood."""
    exact = np.asarray(exact_ids, dtype=np.int64)
    approximate = np.asarray(approximate_ids, dtype=np.int64)
    if (
        exact.ndim != 2
        or approximate.ndim != 2
        or exact.shape[0] != approximate.shape[0]
        or tolerance_milliseconds < 0
    ):
        raise ValueError("invalid tolerant neighbor matrices")
    mask = np.uint64(2**32 - 1)
    recalls = []
    for expected, observed in zip(exact, approximate, strict=True):
        observed = observed[observed >= 0].astype(np.uint64)
        if not len(observed):
            if np.any(expected >= 0):
                recalls.append(0.0)
            continue
        observed_videos = observed >> np.uint64(40)
        observed_times = (observed >> np.uint64(8)) & mask
        matched = 0
        count = 0
        for identifier in expected[expected >= 0].astype(np.uint64):
            count += 1
            video_id = identifier >> np.uint64(40)
            timestamp = (identifier >> np.uint64(8)) & mask
            difference = np.abs(observed_times.astype(np.int64) - int(timestamp))
            matched += int(
                np.any((observed_videos == video_id) & (difference <= tolerance_milliseconds))
            )
        if count:
            recalls.append(matched / count)
    return float(np.mean(recalls)) if recalls else 1.0


def _atomic_json(path: Path, value: dict) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=path.parent, prefix=".retrieval-", suffix=".tmp", delete=False
        ) as output:
            temporary = Path(output.name)
            json.dump(value, output, allow_nan=False, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _atomic_index(faiss, path: Path, index) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        faiss.write_index(index, str(temporary))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_copy(source: Path, destination: Path) -> None:
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        with source.open("rb") as input_file, temporary.open("xb") as output_file:
            shutil.copyfileobj(input_file, output_file, length=8 * 1024**2)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_metadata(path: Path, *, video_ids, times, views, tokens) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as output:
            np.savez(
                output,
                video_ids=np.asarray(video_ids, dtype=np.int64),
                times=np.asarray(times, dtype=np.float32),
                views=np.asarray(views, dtype=np.uint8),
                tokens=np.asarray(tokens, dtype="V16"),
            )
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class RetrievalIndex:
    """Disk-backed HNSW-SQ8 index with a bounded mutable shard.

    Before enough descriptors exist to calibrate SQ8, shards use exact
    inner-product indexes. Crossing ``training_min_vectors`` promotes every
    visible shard once. The exact path is reported explicitly and is intended
    only for a small catalogue/pilot.
    """

    def __init__(
        self,
        root: Path,
        model_sha256: str,
        revision: str = RETRIEVAL_REVISION,
        *,
        shard_max_vectors: int = 1_000_000,
        dimensions: int = 512,
        hnsw_m: int = 16,
        ef_construction: int = 80,
        ef_search: int = 2_048,
        discovery_ef_search: int = 64,
        discovery_stride_seconds: float = 2.0,
        discovery_top_k: int = 64,
        training_min_vectors: int = 160_000,
        training_max_vectors: int = 262_144,
        similarity_threshold: float = 0.50,
        max_references: int = 16,
        max_windows_per_reference: int = 64,
        max_raw_hits: int = 2_000_000,
        max_stale_vectors: int = 250_000,
        max_stale_fraction: float = 0.25,
        cpu_threads: int = 2,
        budget_root: Path | None = None,
        faiss_module=None,
    ):
        if not model_sha256 or not revision:
            raise ValueError("retrieval identity is required")
        if dimensions < 1:
            raise ValueError("invalid descriptor dimensions")
        if (
            shard_max_vectors < 1
            or hnsw_m < 1
            or ef_construction < 1
            or ef_search < 1
            or discovery_ef_search < 1
            or discovery_stride_seconds <= 0
            or discovery_top_k < 1
            or training_min_vectors < 1
            or cpu_threads < 1
            or max_stale_vectors < 1
        ):
            raise ValueError("invalid retrieval bounds")
        if training_max_vectors < training_min_vectors:
            raise ValueError("training maximum is below its minimum")
        if not 0 < similarity_threshold < 1:
            raise ValueError("invalid similarity threshold")
        if not 0 < max_stale_fraction < 1:
            raise ValueError("invalid stale descriptor fraction")
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.cache_budget = CacheBudget(Path(budget_root) if budget_root else self.root.parent)
        self.manifest_path = self.root / "manifest.json"
        self.template_path = self.root / "template.faiss"
        self.model_sha256 = model_sha256
        self.revision = revision
        self.shard_max_vectors = shard_max_vectors
        self.dimensions = dimensions
        self.hnsw_m = hnsw_m
        self.ef_construction = ef_construction
        self.ef_search = ef_search
        self.discovery_ef_search = discovery_ef_search
        self.discovery_stride_seconds = discovery_stride_seconds
        self.discovery_top_k = discovery_top_k
        self.training_min_vectors = training_min_vectors
        self.training_max_vectors = training_max_vectors
        self.similarity_threshold = similarity_threshold
        self.max_references = max_references
        self.max_windows_per_reference = max_windows_per_reference
        self.max_raw_hits = max_raw_hits
        self.max_stale_vectors = max_stale_vectors
        self.max_stale_fraction = max_stale_fraction
        if faiss_module is None:
            import faiss as faiss_module
        self.faiss = faiss_module
        self.faiss.omp_set_num_threads(cpu_threads)
        self._remove_orphans(self._read_manifest())

    def _new_manifest(self) -> dict:
        return {
            "version": _MANIFEST_VERSION,
            "revision": self.revision,
            "model_sha256": self.model_sha256,
            "dimensions": self.dimensions,
            "index": {
                "kind": "exact",
                "hnsw_m": self.hnsw_m,
                "ef_construction": self.ef_construction,
                "ef_search": self.ef_search,
                "scalar_quantizer": "QT_8bit",
            },
            "members": {},
            "shards": [],
            "stale_vectors": 0,
        }

    def _read_manifest(self) -> dict:
        if not self.manifest_path.exists():
            return self._new_manifest()
        try:
            value = json.loads(self.manifest_path.read_text())
        except (OSError, ValueError) as error:
            raise RuntimeError("COPY_CACHE_CORRUPT: invalid retrieval manifest") from error
        expected = (self.revision, self.model_sha256, self.dimensions)
        found = (value.get("revision"), value.get("model_sha256"), value.get("dimensions"))
        if value.get("version") != _MANIFEST_VERSION or found != expected:
            raise RuntimeError("COPY_CACHE_CORRUPT: retrieval identity mismatch")
        if not isinstance(value.get("shards"), list) or not isinstance(value.get("members"), dict):
            raise RuntimeError("COPY_CACHE_CORRUPT: invalid retrieval manifest")
        index_config = value.get("index")
        if not isinstance(index_config, dict) or (
            index_config.get("hnsw_m"),
            index_config.get("ef_construction"),
            index_config.get("ef_search"),
            index_config.get("scalar_quantizer"),
        ) != (self.hnsw_m, self.ef_construction, self.ef_search, "QT_8bit"):
            raise RuntimeError("COPY_CACHE_CORRUPT: retrieval index configuration mismatch")
        for record in value["shards"]:
            if (
                not isinstance(record, dict)
                or type(record.get("count")) is not int
                or record["count"] < 0
                or record.get("kind") not in {"exact", "hnswsq8"}
            ):
                raise RuntimeError("COPY_CACHE_CORRUPT: invalid retrieval shard record")
            for name, size_name in (("index", "index_size"), ("metadata", "metadata_size")):
                filename = record.get(name)
                if not isinstance(filename, str) or Path(filename).name != filename:
                    raise RuntimeError("COPY_CACHE_CORRUPT: invalid retrieval shard path")
                path = self.root / filename
                if (
                    not path.is_file()
                    or path.is_symlink()
                    or path.stat().st_size != record.get(size_name)
                ):
                    raise RuntimeError("COPY_CACHE_CORRUPT: missing retrieval shard")
        if value["index"].get("kind") == "hnswsq8" and (
            not self.template_path.is_file() or self.template_path.is_symlink()
        ):
            raise RuntimeError("COPY_CACHE_CORRUPT: missing retrieval template")
        return value

    def _validate_vectors(self, times: np.ndarray, views: np.ndarray):
        times = np.asarray(times, dtype=np.float64)
        views = np.asarray(views, dtype=np.float32)
        if views.ndim != 3 or views.shape[0] != len(times) or views.shape[2] != self.dimensions:
            raise ValueError("invalid retrieval descriptor dimensions")
        if len(times) == 0 or views.shape[1] < 1 or views.shape[1] > 255:
            raise ValueError("empty or invalid retrieval views")
        if not np.isfinite(times).all() or not np.isfinite(views).all():
            raise ValueError("non-finite retrieval descriptors")
        if len(times) > 1 and (np.diff(times) <= 0).any():
            raise ValueError("retrieval timestamps must increase")
        flat = np.ascontiguousarray(views.reshape(-1, self.dimensions), dtype=np.float32)
        if not np.allclose(np.linalg.norm(flat, axis=1), 1, atol=0.01):
            raise ValueError("retrieval descriptors must be normalized")
        frame_indices = np.repeat(np.arange(len(times), dtype=np.int64), views.shape[1])
        return (
            flat,
            np.asarray(times[frame_indices], dtype=np.float32),
            np.tile(np.arange(views.shape[1], dtype=np.uint8), len(times)),
        )

    def _paths(self, shard_id: int, generation: int) -> tuple[Path, Path]:
        stem = f"shard-{shard_id:06d}-g{generation:06d}"
        return self.root / f"{stem}.faiss", self.root / f"{stem}.npz"

    def _load_metadata(self, record: dict) -> dict[str, np.ndarray]:
        try:
            with np.load(self.root / record["metadata"], allow_pickle=False) as saved:
                value = {
                    name: saved[name].copy() for name in ("video_ids", "times", "views", "tokens")
                }
        except (OSError, ValueError, KeyError) as error:
            raise RuntimeError("COPY_CACHE_CORRUPT: invalid retrieval metadata") from error
        count = int(record["count"])
        if any(len(array) != count for array in value.values()):
            raise RuntimeError("COPY_CACHE_CORRUPT: retrieval metadata length mismatch")
        return value

    def _new_index(self, kind: str):
        if kind == "exact":
            return self.faiss.IndexFlatIP(self.dimensions)
        if not self.template_path.exists():
            raise RuntimeError("COPY_CACHE_CORRUPT: missing retrieval template")
        index = self.faiss.clone_index(self.faiss.read_index(str(self.template_path)))
        index.reset()
        index.hnsw.efConstruction = self.ef_construction
        index.hnsw.efSearch = self.ef_search
        return index

    def _load_index(self, record: dict):
        path = self.root / record["index"]
        try:
            flags = 0
            if record["kind"] == "hnswsq8" and record.get("sealed"):
                mmap_flag = getattr(self.faiss, "IO_FLAG_MMAP_IFC", 0)
                read_only_flag = getattr(self.faiss, "IO_FLAG_READ_ONLY", 0)
                if mmap_flag:
                    flags = mmap_flag | read_only_flag
            index = self.faiss.read_index(str(path), flags)
        except Exception as error:
            raise RuntimeError("COPY_CACHE_CORRUPT: invalid retrieval shard") from error
        if index.d != self.dimensions or index.ntotal != int(record["count"]):
            raise RuntimeError("COPY_CACHE_CORRUPT: retrieval shard mismatch")
        if record["kind"] == "hnswsq8":
            index.hnsw.efSearch = self.ef_search
        return index

    @staticmethod
    def _eligible_rows(metadata: dict[str, np.ndarray], eligible: dict[int, np.void]):
        if not eligible:
            return np.empty(0, dtype=np.int64)
        eligible_ids = np.asarray(sorted(eligible), dtype=np.int64)
        eligible_tokens = np.asarray(
            [eligible[int(video_id)] for video_id in eligible_ids], dtype="V16"
        )
        selected = []
        # Keep temporary search positions bounded even if a future compacted
        # base shard contains tens of millions of descriptors.
        for start in range(0, len(metadata["video_ids"]), 262_144):
            end = min(start + 262_144, len(metadata["video_ids"]))
            video_ids = metadata["video_ids"][start:end]
            positions = np.searchsorted(eligible_ids, video_ids)
            in_range = positions < len(eligible_ids)
            local = np.flatnonzero(in_range)
            if not len(local):
                continue
            positions = positions[local]
            local = local[eligible_ids[positions] == video_ids[local]]
            positions = np.searchsorted(eligible_ids, video_ids[local])
            local = local[
                metadata["tokens"][start:end][local] == eligible_tokens[positions]
            ]
            if len(local):
                selected.append(local.astype(np.int64) + start)
        return np.concatenate(selected) if selected else np.empty(0, dtype=np.int64)

    def _search_shard(
        self,
        index,
        record: dict,
        allowed_rows: np.ndarray,
        query,
        k: int,
        *,
        ef_search: int | None = None,
    ):
        if record["kind"] != "exact":
            selector = self.faiss.IDSelectorBatch(allowed_rows)
            parameters = self.faiss.SearchParametersHNSW(
                efSearch=ef_search or self.ef_search, sel=selector
            )
            return index.search(query, k, params=parameters)
        selected = np.ascontiguousarray(index.reconstruct_batch(allowed_rows), dtype=np.float32)
        exact = self.faiss.IndexFlatIP(self.dimensions)
        exact.add(selected)
        scores, rows = exact.search(query, k)
        valid = rows >= 0
        rows[valid] = allowed_rows[rows[valid]]
        return scores, rows

    def _write_shard(self, record: dict, index, metadata: dict[str, np.ndarray]) -> dict:
        generation = int(record.get("generation", -1)) + 1
        index_path, metadata_path = self._paths(int(record["id"]), generation)
        # The old generation remains published until manifest commit, so reserve
        # enough room for both snapshots. Exact shards dominate this estimate;
        # HNSW-SQ8 stores one byte per source dimension plus a bounded graph.
        count = int(index.ntotal)
        index_bytes = (
            count * self.dimensions * 4
            if record["kind"] == "exact"
            else count * (self.dimensions + self.hnsw_m * 32 + 64)
        )
        metadata_bytes = count * (8 + 4 + 1 + 16)
        self.cache_budget.check(index_bytes + metadata_bytes + 16 * 1024**2)
        _atomic_index(self.faiss, index_path, index)
        _atomic_metadata(metadata_path, **metadata)
        self.cache_budget.add(index_path.stat().st_size + metadata_path.stat().st_size)
        return {
            "id": int(record["id"]),
            "generation": generation,
            "count": int(index.ntotal),
            "sealed": bool(record.get("sealed", False)),
            "kind": record["kind"],
            "index": index_path.name,
            "metadata": metadata_path.name,
            "index_size": index_path.stat().st_size,
            "metadata_size": metadata_path.stat().st_size,
        }

    def contains(self, video_id: int, source_token: str) -> bool:
        """Return whether the published manifest contains the current source."""
        if type(video_id) is not int or video_id < 1 or not source_token:
            return False
        member = self._read_manifest()["members"].get(str(video_id))
        return bool(member and member.get("token") == source_token)

    def manifest_summary(self) -> dict:
        """Small stable shape for backend synchronization checks."""
        manifest = self._read_manifest()
        return {
            "version": manifest["version"],
            "revision": manifest["revision"],
            "model_sha256": manifest["model_sha256"],
            "kind": manifest["index"]["kind"],
            "members": {
                key: {"token": value["token"], "vectors": int(value["vectors"])}
                for key, value in manifest["members"].items()
            },
            "shards": len(manifest["shards"]),
            "vectors": sum(int(value["count"]) for value in manifest["shards"]),
            "stale_vectors": int(manifest.get("stale_vectors", 0)),
        }

    def import_shard(
        self,
        index_path: Path,
        stable_ids: Path | np.ndarray,
        eligible_tokens: dict[int, str],
    ) -> PublishStats:
        """Atomically adopt a previously audited HNSW-SQ8 shard.

        Import is intentionally restricted to an empty retrieval root.  Stable
        IDs carry video, millisecond timestamp, and view; source tokens remain
        per-video manifest data and are expanded only into private shard
        metadata for eligibility filtering.
        """
        manifest = self._read_manifest()
        if manifest["shards"] or manifest["members"]:
            raise RuntimeError("COPY_CACHE_CORRUPT: imported shard requires an empty index")
        source_path = Path(index_path)
        if not source_path.is_file() or source_path.is_symlink():
            raise RuntimeError("COPY_CACHE_CORRUPT: missing imported retrieval shard")
        try:
            index = self.faiss.read_index(str(source_path))
        except Exception as error:
            raise RuntimeError("COPY_CACHE_CORRUPT: invalid imported retrieval shard") from error
        if (
            type(index).__name__ != "IndexHNSWSQ"
            or index.d != self.dimensions
            or index.metric_type != self.faiss.METRIC_INNER_PRODUCT
            or index.hnsw.nb_neighbors(1) != self.hnsw_m
            or not index.is_trained
        ):
            raise RuntimeError("COPY_CACHE_CORRUPT: incompatible imported retrieval shard")
        identifiers = (
            np.load(stable_ids, allow_pickle=False)
            if isinstance(stable_ids, (str, os.PathLike))
            else np.asarray(stable_ids)
        )
        identifiers = np.asarray(identifiers, dtype=np.int64)
        if identifiers.ndim != 1 or len(identifiers) != index.ntotal:
            raise RuntimeError("COPY_CACHE_CORRUPT: imported retrieval identity mismatch")
        encoded = identifiers.view(np.uint64)
        video_ids = (encoded >> np.uint64(40)).astype(np.int64)
        if (video_ids < 1).any() or len(np.unique(identifiers)) != len(identifiers):
            raise RuntimeError("COPY_CACHE_CORRUPT: invalid imported descriptor IDs")
        milliseconds = (encoded >> np.uint64(8)) & np.uint64(2**32 - 1)
        views = (encoded & np.uint64(255)).astype(np.uint8)
        tokens = np.empty(len(identifiers), dtype="V16")
        members = {}
        for video_id, count in zip(*np.unique(video_ids, return_counts=True), strict=True):
            source_token = eligible_tokens.get(int(video_id))
            if not source_token:
                raise RuntimeError("COPY_CACHE_CORRUPT: imported shard token is missing")
            token_hash = _token_hash(source_token)
            tokens[video_ids == video_id] = np.void(token_hash)
            members[str(int(video_id))] = {
                "token": source_token,
                "token_hash": token_hash.hex(),
                "vectors": int(count),
            }

        self.cache_budget.check(
            source_path.stat().st_size + len(identifiers) * (8 + 4 + 1 + 16) + 16 * 1024**2
        )
        index_destination, metadata_destination = self._paths(0, 0)
        try:
            _atomic_copy(source_path, index_destination)
            _atomic_metadata(
                metadata_destination,
                video_ids=video_ids,
                times=milliseconds.astype(np.float32) / 1000.0,
                views=views,
                tokens=tokens,
            )
            template = self.faiss.clone_index(index)
            template.reset()
            template.hnsw.efConstruction = self.ef_construction
            template.hnsw.efSearch = self.ef_search
            _atomic_index(self.faiss, self.template_path, template)
            record = {
                "id": 0,
                "generation": 0,
                "count": int(index.ntotal),
                "sealed": int(index.ntotal) >= self.shard_max_vectors,
                "kind": "hnswsq8",
                "index": index_destination.name,
                "metadata": metadata_destination.name,
                "index_size": index_destination.stat().st_size,
                "metadata_size": metadata_destination.stat().st_size,
            }
            working = copy.deepcopy(manifest)
            working["index"]["kind"] = "hnswsq8"
            working["members"] = members
            working["shards"] = [record]
            _atomic_json(self.manifest_path, working)
            self.cache_budget.add(record["index_size"] + record["metadata_size"])
        except Exception:
            index_destination.unlink(missing_ok=True)
            metadata_destination.unlink(missing_ok=True)
            raise
        return PublishStats(0, int(index.ntotal), True, 1)

    def _remove_unreferenced(self, previous: dict, current: dict) -> None:
        retained = {value[name] for value in current["shards"] for name in ("index", "metadata")}
        for value in previous["shards"]:
            for name in ("index", "metadata"):
                if value.get(name) in retained:
                    continue
                path = self.root / value.get(name, "")
                if path.is_file() and not path.is_symlink():
                    size = path.stat().st_size
                    path.unlink()
                    self.cache_budget.remove(size)

    def _remove_orphans(self, manifest: dict) -> None:
        retained = {value[name] for value in manifest["shards"] for name in ("index", "metadata")}
        for path in self.root.iterdir():
            own_shard = path.name.startswith("shard-") and path.suffix in {".faiss", ".npz"}
            own_temporary = path.name.startswith(
                (".shard-", ".retrieval-", ".neighbors-")
            ) and path.name.endswith(".tmp")
            if (
                path.name not in retained
                and (own_shard or own_temporary)
                and path.is_file()
                and not path.is_symlink()
            ):
                size = path.stat().st_size
                path.unlink()
                self.cache_budget.remove(size)

    def publish(
        self,
        video_id: int,
        source_token: str,
        times: np.ndarray,
        views: np.ndarray,
    ) -> PublishStats:
        if type(video_id) is not int or video_id < 1 or not source_token:
            raise ValueError("invalid retrieval member")
        vectors, vector_times, vector_views = self._validate_vectors(times, views)
        manifest = self._read_manifest()
        current = manifest["members"].get(str(video_id))
        if current and current.get("token") == source_token:
            if (
                manifest["index"]["kind"] == "exact"
                and sum(int(s["count"]) for s in manifest["shards"]) >= self.training_min_vectors
            ):
                manifest = self._promote(manifest)
            return PublishStats(
                0,
                sum(int(s["count"]) for s in manifest["shards"]),
                manifest["index"]["kind"] == "hnswsq8",
                len(manifest["shards"]),
            )

        stale = int(manifest.get("stale_vectors", 0)) + (
            int(current.get("vectors", 0)) if current else 0
        )
        total_after = sum(int(s["count"]) for s in manifest["shards"]) + len(vectors)
        if stale > self.max_stale_vectors or stale / max(1, total_after) > self.max_stale_fraction:
            raise RuntimeError(
                "COPY_CACHE_FULL: retrieval has too many stale descriptors; rebuild the derived index"
            )

        working = copy.deepcopy(manifest)
        working["stale_vectors"] = stale
        token = np.void(_token_hash(source_token))
        cursor = 0
        while cursor < len(vectors):
            active = working["shards"][-1] if working["shards"] else None
            if (
                active is None
                or active.get("sealed", False)
                or active["kind"] != working["index"]["kind"]
            ):
                active = {
                    "id": max((int(s["id"]) for s in working["shards"]), default=-1) + 1,
                    "generation": -1,
                    "count": 0,
                    "sealed": False,
                    "kind": working["index"]["kind"],
                }
                index = self._new_index(active["kind"])
                metadata = {
                    "video_ids": np.empty(0, dtype=np.int64),
                    "times": np.empty(0, dtype=np.float32),
                    "views": np.empty(0, dtype=np.uint8),
                    "tokens": np.empty(0, dtype="V16"),
                }
                working["shards"].append(active)
            else:
                index = self._load_index(active)
                metadata = self._load_metadata(active)
            take = min(self.shard_max_vectors - int(active["count"]), len(vectors) - cursor)
            if take <= 0:
                active["sealed"] = True
                continue
            end = cursor + take
            index.add(vectors[cursor:end])
            metadata = {
                "video_ids": np.concatenate(
                    [metadata["video_ids"], np.full(take, video_id, dtype=np.int64)]
                ),
                "times": np.concatenate([metadata["times"], vector_times[cursor:end]]),
                "views": np.concatenate([metadata["views"], vector_views[cursor:end]]),
                "tokens": np.concatenate([metadata["tokens"], np.full(take, token, dtype="V16")]),
            }
            active["sealed"] = int(index.ntotal) >= self.shard_max_vectors
            written = self._write_shard(active, index, metadata)
            working["shards"][-1] = written
            cursor = end

        working["members"][str(video_id)] = {
            "token": source_token,
            "token_hash": _token_hash(source_token).hex(),
            "vectors": len(vectors),
        }
        _atomic_json(self.manifest_path, working)
        self._remove_unreferenced(manifest, working)
        self._remove_orphans(working)
        if (
            working["index"]["kind"] == "exact"
            and sum(int(s["count"]) for s in working["shards"]) >= self.training_min_vectors
        ):
            working = self._promote(working)
        return PublishStats(
            len(vectors),
            sum(int(s["count"]) for s in working["shards"]),
            working["index"]["kind"] == "hnswsq8",
            len(working["shards"]),
        )

    def _training_sample(self, manifest: dict) -> np.ndarray:
        total = sum(int(s["count"]) for s in manifest["shards"])
        parts = []
        remaining = self.training_max_vectors
        for position, record in enumerate(manifest["shards"]):
            index = self._load_index(record)
            vectors = index.reconstruct_n(0, int(record["count"]))
            shards_left = len(manifest["shards"]) - position
            take = min(len(vectors), max(1, remaining // shards_left))
            chosen = np.linspace(0, len(vectors) - 1, take, dtype=np.int64)
            parts.append(np.ascontiguousarray(vectors[chosen], dtype=np.float32))
            remaining -= take
        sample = np.concatenate(parts)
        if len(sample) < self.training_min_vectors or total < self.training_min_vectors:
            raise RuntimeError("COPY_RETRIEVAL_TRAINING_INCOMPLETE")
        return sample

    def _promote(self, manifest: dict) -> dict:
        sample = self._training_sample(manifest)
        template = self.faiss.IndexHNSWSQ(
            self.dimensions,
            self.faiss.ScalarQuantizer.QT_8bit,
            self.hnsw_m,
            self.faiss.METRIC_INNER_PRODUCT,
        )
        template.hnsw.efConstruction = self.ef_construction
        template.hnsw.efSearch = self.ef_search
        template.train(sample)
        if not template.is_trained:
            raise RuntimeError("COPY_RETRIEVAL_TRAINING_INCOMPLETE")
        _atomic_index(self.faiss, self.template_path, template)
        working = copy.deepcopy(manifest)
        converted = []
        for record in manifest["shards"]:
            source = self._load_index(record)
            vectors = np.ascontiguousarray(
                source.reconstruct_n(0, int(record["count"])), dtype=np.float32
            )
            index = self.faiss.clone_index(template)
            index.add(vectors)
            rewritten = dict(record, kind="hnswsq8")
            converted.append(self._write_shard(rewritten, index, self._load_metadata(record)))
        working["shards"] = converted
        working["index"]["kind"] = "hnswsq8"
        _atomic_json(self.manifest_path, working)
        self._remove_unreferenced(manifest, working)
        self._remove_orphans(working)
        return working

    @staticmethod
    def _temporal_candidates(hits: list[dict], max_windows: int) -> CandidateList:
        if len(hits) < 5:
            return CandidateList()
        qt = np.asarray([h["query_time"] for h in hits], dtype=np.float64)
        rt = np.asarray([h["reference_time"] for h in hits], dtype=np.float64)
        confidence = np.asarray([h["similarity"] for h in hits], dtype=np.float32)
        hypotheses = []
        # The validated v3 scope covers fixed-rate clips. Searching 31 speculative
        # playback speeds multiplied common-scene hypotheses and displaced the
        # strong identity-rate candidate in the development sentinel. A future
        # time-warp mode needs its own labelled recall/precision gate.
        for speed in (1.0,):
            offsets = rt - qt * speed
            buckets = np.round(offsets).astype(np.int64)
            unique, inverse = np.unique(buckets, return_inverse=True)
            weights = np.bincount(inverse, weights=confidence)
            for bucket in np.argsort(weights)[-3:]:
                selected = np.where(np.abs(offsets - float(unique[bucket])) <= 0.8)[0]
                best = {}
                for index in selected:
                    key = int(hits[index]["query_index"])
                    if key not in best or confidence[index] > confidence[best[key]]:
                        best[key] = index
                ordered = sorted(best.values(), key=lambda i: qt[i])
                groups: list[list[int]] = []
                for index in ordered:
                    if not groups or qt[index] - qt[groups[-1][-1]] > 2.5:
                        groups.append([])
                    groups[-1].append(index)
                for group in groups:
                    if len(group) < 5 or qt[group[-1]] - qt[group[0]] < 4:
                        continue
                    part = np.asarray(group)
                    offset = float(np.median(rt[part] - qt[part] * speed))
                    raw_hits = [hits[i] for i in group]
                    hypotheses.append(
                        {
                            "query_indices": np.asarray(
                                [h["query_index"] for h in raw_hits], dtype=np.int64
                            ),
                            "start": float(qt[group[0]]),
                            "end": float(qt[group[-1]]),
                            "speed": float(speed),
                            "offset": offset,
                            "score": float(np.mean(confidence[part]) * len(part)),
                            "hits": raw_hits,
                        }
                    )
        hypotheses.sort(key=lambda value: value["score"], reverse=True)
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
        return CandidateList(unique[:max_windows], truncated=len(unique) > max_windows)

    def audit_neighbors(
        self,
        query_vectors: np.ndarray,
        eligible_tokens: dict[int, str],
        top_k: int = 32,
    ) -> NeighborAudit:
        """Return raw ANN neighbors for an exact-vs-approximate recall audit."""
        query = np.ascontiguousarray(query_vectors, dtype=np.float32)
        if (
            query.ndim != 2
            or query.shape[1] != self.dimensions
            or not 0 < len(query) <= 256
            or top_k < 1
            or not np.isfinite(query).all()
        ):
            raise ValueError("invalid ANN audit query")
        manifest = self._read_manifest()
        eligible = {
            int(video_id): np.void(_token_hash(token))
            for video_id, token in eligible_tokens.items()
            if manifest["members"].get(str(video_id), {}).get("token") == token
        }
        values = np.full((len(query), top_k), -np.inf, dtype=np.float32)
        identifiers = np.full((len(query), top_k), -1, dtype=np.int64)
        saturated = False
        searched = 0
        for record in manifest["shards"]:
            metadata = self._load_metadata(record)
            allowed_rows = self._eligible_rows(metadata, eligible)
            local_k = min(top_k, len(allowed_rows))
            if local_k == 0:
                continue
            searched += 1
            index = self._load_index(record)
            scores, rows = self._search_shard(index, record, allowed_rows, query, local_k)
            if local_k == top_k and np.any(scores[:, -1] >= self.similarity_threshold):
                saturated = True
            shard_ids = _metadata_ids(metadata)
            found_ids = np.full(rows.shape, -1, dtype=np.int64)
            valid = rows >= 0
            found_ids[valid] = shard_ids[rows[valid]]
            merged_values = np.concatenate([values, scores], axis=1)
            merged_ids = np.concatenate([identifiers, found_ids], axis=1)
            keep = np.argpartition(merged_values, -top_k, axis=1)[:, -top_k:]
            values = np.take_along_axis(merged_values, keep, axis=1)
            identifiers = np.take_along_axis(merged_ids, keep, axis=1)
        order = np.argsort(values, axis=1)[:, ::-1]
        return NeighborAudit(
            scores=np.take_along_axis(values, order, axis=1),
            ids=np.take_along_axis(identifiers, order, axis=1),
            saturated=saturated,
            shards=searched,
        )

    def _anchor_indices(self, times: np.ndarray) -> np.ndarray:
        """Select bounded temporal anchors while retaining both clip endpoints."""
        times = np.asarray(times, dtype=np.float64)
        selected = [0]
        last = float(times[0])
        for position in range(1, len(times)):
            if float(times[position]) - last >= self.discovery_stride_seconds - 1e-6:
                selected.append(position)
                last = float(times[position])
        if selected[-1] != len(times) - 1:
            selected.append(len(times) - 1)
        return np.asarray(selected, dtype=np.int64)

    def _neighbor_hits(
        self,
        query_times: np.ndarray,
        frame_indices: np.ndarray,
        view_count: int,
        scores: np.ndarray,
        identifiers: np.ndarray,
    ) -> tuple[list[dict], int, int, bool]:
        """Collapse per-view neighbors and attach query-local distinctiveness.

        The additive evidence term mirrors query-side score normalization: a
        hit is measured above the fourth-best distinct reference for the same
        query frame.  Unlike an absolute threshold, this suppresses frames
        that match many catalogue items while preserving their raw score for
        the later dense alignment.
        """
        mask = np.uint64(2**32 - 1)
        top_k = scores.shape[1]
        hits: list[dict] = []
        raw_hits = 0
        unique_hits = 0
        frame_limited = False
        for local_index, query_index_value in enumerate(frame_indices):
            query_index = int(query_index_value)
            query_time = float(query_times[query_index])
            start = local_index * view_count
            end = start + view_count
            frame_scores = np.asarray(scores[start:end]).reshape(-1)
            frame_ids = np.asarray(identifiers[start:end]).reshape(-1)
            best: dict[tuple[int, int], dict] = {}
            for position in np.flatnonzero(
                (frame_scores >= self.similarity_threshold) & (frame_ids >= 0)
            ):
                raw_hits += 1
                identifier = np.uint64(frame_ids[position])
                reference_id = int(identifier >> np.uint64(40))
                reference_ms = int((identifier >> np.uint64(8)) & mask)
                key = (reference_id, reference_ms)
                hit = {
                    "reference_video_id": reference_id,
                    "query_index": query_index,
                    "query_time": query_time,
                    "reference_time": reference_ms / 1000.0,
                    "similarity": float(frame_scores[position]),
                    "query_view": int(position // top_k),
                    "reference_view": int(identifier & np.uint64(255)),
                }
                old = best.get(key)
                if old is None or hit["similarity"] > old["similarity"]:
                    best[key] = hit
            ordered = sorted(best.values(), key=lambda hit: hit["similarity"], reverse=True)
            if len(ordered) > 128:
                ordered = ordered[:128]
                frame_limited = True
            unique_hits += len(ordered)
            best_by_reference: dict[int, float] = {}
            for hit in ordered:
                best_by_reference.setdefault(hit["reference_video_id"], hit["similarity"])
            competing = sorted(best_by_reference.values(), reverse=True)
            background = (
                competing[3] if len(competing) >= 4 else self.similarity_threshold
            )
            for hit in ordered:
                hit["evidence"] = max(0.0, hit["similarity"] - background)
            hits.extend(ordered)
        return hits, raw_hits, unique_hits, frame_limited

    def _coherent_candidates(
        self,
        hits: list[dict],
        *,
        min_samples: int,
        min_span: float,
        max_gap: float,
        max_windows: int,
    ) -> tuple[dict[int, CandidateList], bool]:
        """Turn hits into dense, monotone, fixed-rate temporal sequences."""
        hypotheses: dict[tuple[int, int], dict[int, dict]] = {}
        for hit in hits:
            offset = hit["reference_time"] - hit["query_time"]
            center = round(offset)
            for bucket in range(center - 1, center + 2):
                if abs(offset - bucket) > 0.8:
                    continue
                key = (hit["reference_video_id"], bucket)
                by_query = hypotheses.setdefault(key, {})
                old = by_query.get(hit["query_index"])
                if old is None or (hit["evidence"], hit["similarity"]) > (
                    old["evidence"],
                    old["similarity"],
                ):
                    by_query[hit["query_index"]] = hit

        by_reference: dict[int, list[dict]] = {}
        for (reference_id, _bucket), by_query in hypotheses.items():
            ordered = sorted(by_query.values(), key=lambda hit: hit["query_time"])
            groups: list[list[dict]] = []
            for hit in ordered:
                if groups:
                    previous = groups[-1][-1]
                    query_step = hit["query_time"] - previous["query_time"]
                    reference_step = hit["reference_time"] - previous["reference_time"]
                    coherent = (
                        query_step <= max_gap
                        and reference_step > 0
                        and abs(reference_step - query_step) <= 1.25
                    )
                else:
                    coherent = False
                if not coherent:
                    groups.append([])
                groups[-1].append(hit)
            for group in groups:
                span = group[-1]["query_time"] - group[0]["query_time"]
                if len(group) < min_samples or span < min_span:
                    continue
                offsets = np.asarray(
                    [hit["reference_time"] - hit["query_time"] for hit in group],
                    dtype=np.float64,
                )
                similarities = np.asarray(
                    [hit["similarity"] for hit in group], dtype=np.float64
                )
                evidence = np.asarray([hit["evidence"] for hit in group], dtype=np.float64)
                density = len(group) / max(1.0, span + 1.0)
                stability = 1.0 / (1.0 + float(np.std(offsets)))
                # Support and temporal stability dominate raw similarity.  The
                # normalized margin breaks ties without rewarding ubiquitous
                # studio frames merely because they have high cosine scores.
                quality = len(group) * density * stability * (
                    0.01
                    + max(0.0, float(np.median(similarities)) - self.similarity_threshold)
                    + 2.0 * float(np.mean(evidence))
                )
                candidate = {
                    "reference_video_id": reference_id,
                    "query_indices": np.asarray(
                        [hit["query_index"] for hit in group], dtype=np.int64
                    ),
                    "start": float(group[0]["query_time"]),
                    "end": float(group[-1]["query_time"]),
                    "speed": 1.0,
                    "offset": float(np.median(offsets)),
                    "score": float(quality),
                    "mean_similarity": float(np.mean(similarities)),
                    "distinctiveness": float(np.mean(evidence)),
                }
                by_reference.setdefault(reference_id, []).append(candidate)

        limited = False
        result: dict[int, CandidateList] = {}
        for reference_id, candidates in by_reference.items():
            candidates.sort(key=lambda candidate: candidate["score"], reverse=True)
            unique = []
            for candidate in candidates:
                if any(
                    abs(candidate["offset"] - old["offset"]) < 1.5
                    and candidate["start"] <= old["end"]
                    and candidate["end"] >= old["start"]
                    for old in unique
                ):
                    continue
                unique.append(candidate)
            truncated = len(unique) > max_windows
            limited |= truncated
            result[reference_id] = CandidateList(unique[:max_windows], truncated=truncated)
        return result, limited

    def _refine_candidates(
        self,
        manifest: dict,
        preliminary: dict[int, CandidateList],
        eligible: dict[int, np.void],
        query_times: np.ndarray,
        query_views: np.ndarray,
    ) -> tuple[dict[int, CandidateList], int, bool]:
        """Densely align short listed windows using reconstructed shard rows.

        This avoids a second graph traversal: only rows near the discovered
        offset are reconstructed, and each query second is compared within a
        narrow temporal band.
        """
        if not preliminary:
            return {}, 0, False
        refined_by_reference: dict[int, list[dict]] = {}
        reconstructed = 0
        wanted = set(preliminary)
        for record in manifest["shards"]:
            metadata = self._load_metadata(record)
            present = wanted.intersection(int(value) for value in np.unique(metadata["video_ids"]))
            if not present:
                continue
            index = self._load_index(record)
            for reference_id in present:
                valid_source = (metadata["video_ids"] == reference_id) & (
                    metadata["tokens"] == eligible[reference_id]
                )
                for candidate in preliminary[reference_id]:
                    start = max(float(query_times[0]), candidate["start"] - 1.1)
                    end = min(float(query_times[-1]), candidate["end"] + 1.1)
                    if end - start < 8.0:
                        missing = 8.0 - (end - start)
                        start = max(float(query_times[0]), start - missing / 2)
                        end = min(float(query_times[-1]), end + missing)
                        if end - start < 8.0:
                            start = max(float(query_times[0]), end - 8.0)
                    query_indices = np.flatnonzero((query_times >= start) & (query_times <= end))
                    if len(query_indices) < 9:
                        continue
                    low = start + candidate["offset"] - 1.25
                    high = end + candidate["offset"] + 1.25
                    rows = np.flatnonzero(
                        valid_source & (metadata["times"] >= low) & (metadata["times"] <= high)
                    ).astype(np.int64)
                    if not len(rows):
                        continue
                    vectors = np.ascontiguousarray(index.reconstruct_batch(rows), dtype=np.float32)
                    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
                    vectors /= np.maximum(norms, 1e-12)
                    reconstructed += len(rows)
                    reference_times = metadata["times"][rows].astype(np.float64)
                    aligned = []
                    for query_index in query_indices:
                        query_time = float(query_times[query_index])
                        near = np.flatnonzero(
                            np.abs(reference_times - (query_time + candidate["offset"])) <= 1.25
                        )
                        if not len(near):
                            continue
                        similarities = query_views[query_index] @ vectors[near].T
                        flat_position = int(np.argmax(similarities))
                        query_view, local_position = np.unravel_index(
                            flat_position, similarities.shape
                        )
                        similarity = float(similarities[query_view, local_position])
                        row_position = int(near[local_position])
                        aligned.append(
                            {
                                "query_index": int(query_index),
                                "query_time": query_time,
                                "reference_time": float(reference_times[row_position]),
                                "similarity": similarity,
                            }
                        )
                    if not aligned:
                        continue
                    strong = [
                        hit
                        for hit in aligned
                        if hit["similarity"] >= self.similarity_threshold
                    ]
                    # Discovery already supplied a sparse coherent seed. Dense
                    # descriptor scores refine its offset and rank, but they do
                    # not gate the candidate: hard crops can have intermittent
                    # SSCD scores while the pixel verifier still proves every
                    # second in the corridor.
                    offset_hits = strong if len(strong) >= 3 else aligned
                    offset = float(
                        np.median(
                            [
                                hit["reference_time"] - hit["query_time"]
                                for hit in offset_hits
                            ]
                        )
                    )
                    similarities = np.asarray(
                        [hit["similarity"] for hit in aligned], dtype=np.float64
                    )
                    support = len(strong) / len(aligned)
                    quality = (
                        float(candidate["score"])
                        + len(aligned) * 0.01
                        + len(strong) * 0.04
                        + float(
                            np.maximum(similarities - self.similarity_threshold, 0).sum()
                        )
                    )
                    refined_by_reference.setdefault(reference_id, []).append(
                        {
                            "reference_video_id": reference_id,
                            "query_indices": np.asarray(query_indices, dtype=np.int64),
                            "start": float(query_times[query_indices[0]]),
                            "end": float(query_times[query_indices[-1]]),
                            "speed": 1.0,
                            "offset": offset,
                            "score": quality,
                            "mean_similarity": float(np.mean(similarities)),
                            "distinctiveness": float(
                                candidate.get("distinctiveness", 0.0)
                            ),
                            "descriptor_support": float(support),
                        }
                    )
            del index
        limited = False
        refined = {}
        for reference_id, candidates in refined_by_reference.items():
            candidates.sort(key=lambda value: value["score"], reverse=True)
            unique = []
            for candidate in candidates:
                if any(
                    abs(candidate["offset"] - old["offset"]) < 1.5
                    and candidate["start"] <= old["end"]
                    and candidate["end"] >= old["start"]
                    for old in unique
                ):
                    continue
                unique.append(candidate)
            truncated = len(unique) > self.max_windows_per_reference
            limited |= truncated
            refined[reference_id] = CandidateList(
                unique[: self.max_windows_per_reference], truncated=truncated
            )
        return refined, reconstructed, limited

    def search(
        self,
        query_video_id: int,
        query_times: np.ndarray,
        query_views: np.ndarray,
        eligible_tokens: dict[int, str],
        *,
        top_k: int = 128,
    ) -> RetrievalResult:
        if top_k < 1:
            raise ValueError("top_k must be positive")
        vectors, _, _ = self._validate_vectors(query_times, query_views)
        query_times = np.asarray(query_times, dtype=np.float64)
        view_count = query_views.shape[1]
        normalized_views = vectors.reshape(len(query_times), view_count, self.dimensions)
        anchor_indices = self._anchor_indices(query_times)
        discovery_vectors = np.ascontiguousarray(
            normalized_views[anchor_indices].reshape(-1, self.dimensions), dtype=np.float32
        )
        discovery_k = min(top_k, self.discovery_top_k)
        manifest = self._read_manifest()
        eligible = {
            int(video_id): np.void(_token_hash(token))
            for video_id, token in eligible_tokens.items()
            if int(video_id) != query_video_id
            and manifest["members"].get(str(video_id), {}).get("token") == token
        }
        scratch_bytes = len(discovery_vectors) * discovery_k * (4 + 8)
        self.cache_budget.check(scratch_bytes + 16 * 1024**2)
        score_path = id_path = None
        scores_map = ids_map = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=self.root, prefix=".neighbors-", suffix=".scores.tmp", delete=False
            ) as score_file:
                score_path = Path(score_file.name)
            with tempfile.NamedTemporaryFile(
                dir=self.root, prefix=".neighbors-", suffix=".ids.tmp", delete=False
            ) as id_file:
                id_path = Path(id_file.name)
            scores_map = np.memmap(
                score_path,
                mode="w+",
                dtype=np.float32,
                shape=(len(discovery_vectors), discovery_k),
            )
            ids_map = np.memmap(
                id_path,
                mode="w+",
                dtype=np.int64,
                shape=(len(discovery_vectors), discovery_k),
            )
            scores_map[:] = -np.inf
            ids_map[:] = -1
            searched_shards = 0
            for record in manifest["shards"]:
                metadata = self._load_metadata(record)
                allowed_rows = self._eligible_rows(metadata, eligible)
                local_k = min(discovery_k, len(allowed_rows))
                if local_k == 0:
                    continue
                searched_shards += 1
                index = self._load_index(record)
                shard_ids = _metadata_ids(metadata)
                for start in range(0, len(discovery_vectors), 1024):
                    end = min(start + 1024, len(discovery_vectors))
                    found_scores, rows = self._search_shard(
                        index,
                        record,
                        allowed_rows,
                        discovery_vectors[start:end],
                        local_k,
                        ef_search=self.discovery_ef_search,
                    )
                    found_ids = np.full(rows.shape, -1, dtype=np.int64)
                    valid = rows >= 0
                    found_ids[valid] = shard_ids[rows[valid]]
                    merged_scores = np.concatenate([scores_map[start:end], found_scores], axis=1)
                    merged_ids = np.concatenate([ids_map[start:end], found_ids], axis=1)
                    keep = np.argpartition(merged_scores, -discovery_k, axis=1)[
                        :, -discovery_k:
                    ]
                    scores_map[start:end] = np.take_along_axis(merged_scores, keep, axis=1)
                    ids_map[start:end] = np.take_along_axis(merged_ids, keep, axis=1)
                del index, metadata
            scores_map.flush()
            ids_map.flush()
            neighbor_saturated = bool(
                np.any(np.min(scores_map, axis=1) >= self.similarity_threshold)
            )
            hits, raw_hits, unique_hits, frame_limited = self._neighbor_hits(
                query_times,
                anchor_indices,
                view_count,
                scores_map,
                ids_map,
            )
            preliminary, discovery_windows_limited = self._coherent_candidates(
                hits,
                min_samples=4,
                min_span=6.0,
                max_gap=self.discovery_stride_seconds + 0.6,
                max_windows=min(8, self.max_windows_per_reference),
            )
            discovery_ranked = sorted(
                preliminary.items(), key=lambda item: item[1][0]["score"], reverse=True
            )
            discovery_reference_limited = len(discovery_ranked) > self.max_references
            preliminary = dict(discovery_ranked[: self.max_references])
            refined, reconstructed_vectors, windows_limited = self._refine_candidates(
                manifest,
                preliminary,
                eligible,
                query_times,
                normalized_views,
            )
            ranked = sorted(
                refined.items(), key=lambda item: item[1][0]["score"], reverse=True
            )
            reference_limited = len(ranked) > self.max_references
            candidates_by_video = {
                reference_id: candidates
                for reference_id, candidates in ranked[: self.max_references]
            }
            hit_volume_warning = unique_hits > self.max_raw_hits
            truncated = (
                neighbor_saturated
                or frame_limited
                or discovery_windows_limited
                or discovery_reference_limited
                or windows_limited
                or reference_limited
            )
            result = RetrievalResult(
                candidates_by_video=candidates_by_video,
                truncated=truncated,
                diagnostics={
                    "mode": manifest["index"]["kind"],
                    "shards_searched": searched_shards,
                    "vectors_searched": sum(int(s["count"]) for s in manifest["shards"]),
                    "discovery_ef_search": self.discovery_ef_search,
                    "discovery_query_vectors": len(discovery_vectors),
                    "full_query_vectors": len(vectors),
                    "preliminary_references": len(preliminary),
                    "refined_references": len(refined),
                    "reconstructed_vectors": reconstructed_vectors,
                    "raw_hits": raw_hits,
                    "unique_hits": unique_hits,
                    "candidate_references": len(candidates_by_video),
                    "neighbor_saturated": neighbor_saturated,
                    "frame_limited": frame_limited,
                    "hit_volume_warning": hit_volume_warning,
                    "window_limited": discovery_windows_limited or windows_limited,
                    "reference_limited": discovery_reference_limited or reference_limited,
                    "scratch_bytes": scratch_bytes,
                },
            )
        finally:
            if scores_map is not None:
                del scores_map
            if ids_map is not None:
                del ids_map
            if score_path is not None:
                score_path.unlink(missing_ok=True)
            if id_path is not None:
                id_path.unlink(missing_ok=True)
        return result
