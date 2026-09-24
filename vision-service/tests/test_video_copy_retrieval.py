import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

import numpy as np

from vision_service.video_copy_retrieval import (
    RetrievalIndex,
    descriptor_ids,
    neighbor_recall,
    streaming_exact_topk,
    tolerant_neighbor_recall,
)


class RetrievalIndexTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    @staticmethod
    def sequence(seed: int, frames: int = 12, dimensions: int = 16):
        rng = np.random.default_rng(seed)
        values = rng.normal(size=(frames, 1, dimensions)).astype(np.float32)
        values /= np.linalg.norm(values, axis=2, keepdims=True)
        return np.arange(frames, dtype=np.float64), values

    def index(self, **overrides):
        options = dict(
            shard_max_vectors=20,
            dimensions=16,
            hnsw_m=4,
            ef_construction=20,
            ef_search=32,
            training_min_vectors=64,
            training_max_vectors=128,
            similarity_threshold=0.7,
            max_references=4,
            max_stale_fraction=0.75,
            budget_root=self.root,
        )
        options.update(overrides)
        return RetrievalIndex(self.root, "a" * 64, **options)

    def test_exact_fallback_retrieves_temporal_candidate_without_pairs(self):
        index = self.index()
        times, reference = self.sequence(3)
        index.publish(1, "one", times, reference)
        unrelated_times, unrelated = self.sequence(9)
        index.publish(2, "two", unrelated_times, unrelated)
        result = index.search(3, times, reference, {1: "one", 2: "two"}, top_k=2)
        self.assertEqual(result.diagnostics["mode"], "exact")
        self.assertIn(1, result.candidates_by_video)
        self.assertNotIn(2, result.candidates_by_video)
        candidate = result.candidates_by_video[1][0]
        self.assertEqual(candidate["reference_video_id"], 1)
        self.assertEqual(candidate["speed"], 1.0)
        self.assertGreaterEqual(len(candidate["query_indices"]), 5)
        audit = index.audit_neighbors(reference[:, 0], {1: "one", 2: "two"}, top_k=1)
        np.testing.assert_array_equal(audit.ids[:, 0], descriptor_ids(1, times, 1))

    def test_global_topk_does_not_starve_later_shards_when_hit_budget_is_exceeded(self):
        index = self.index(max_raw_hits=1)
        distractor_times, distractor = self.sequence(30, frames=20)
        target_times, target = self.sequence(31, frames=20)
        index.publish(1, "distractor", distractor_times, distractor)
        index.publish(2, "target", target_times, target)
        result = index.search(
            3,
            target_times,
            target,
            {1: "distractor", 2: "target"},
            top_k=2,
        )
        self.assertIn(2, result.candidates_by_video)
        self.assertTrue(result.diagnostics["hit_volume_warning"])
        self.assertFalse(list(self.root.glob(".neighbors-*")))

    def test_offset_votes_overlap_bucket_boundaries(self):
        index = self.index()
        query_times, values = self.sequence(41, frames=10)
        offsets = np.where(np.arange(10) % 2 == 0, 37.49, 37.51)
        reference_times = query_times + offsets
        index.publish(1, "reference", reference_times, values)
        result = index.search(2, query_times, values, {1: "reference"}, top_k=1)
        self.assertIn(1, result.candidates_by_video)
        self.assertGreaterEqual(len(result.candidates_by_video[1][0]["query_indices"]), 5)

    def test_search_discovers_on_temporal_anchors_then_refines_dense_rows(self):
        index = self.index()
        times, values = self.sequence(42, frames=20)
        index.publish(1, "reference", times, values)
        searched = []
        original = index._search_shard

        def record_search(index_value, record, rows, query, k, **options):
            searched.append((len(query), options.get("ef_search")))
            return original(index_value, record, rows, query, k, **options)

        with patch.object(index, "_search_shard", side_effect=record_search):
            result = index.search(2, times, values, {1: "reference"}, top_k=2)
        self.assertIn(1, result.candidates_by_video)
        self.assertLess(result.diagnostics["discovery_query_vectors"], len(times))
        self.assertEqual(result.diagnostics["full_query_vectors"], len(times))
        self.assertGreater(result.diagnostics["reconstructed_vectors"], 0)
        self.assertTrue(all(ef == index.discovery_ef_search for _, ef in searched))

    def test_temporal_refinement_rejects_reverse_progression(self):
        index = self.index(similarity_threshold=0.6)
        times, values = self.sequence(43)
        index.publish(1, "forward", times + 30, values)
        index.publish(2, "reverse", times + 50, values[::-1].copy())
        result = index.search(
            3,
            times,
            values,
            {1: "forward", 2: "reverse"},
            top_k=4,
        )
        self.assertIn(1, result.candidates_by_video)
        self.assertNotIn(2, result.candidates_by_video)
        candidate = result.candidates_by_video[1][0]
        self.assertGreaterEqual(len(candidate["query_indices"]), 9)
        self.assertGreaterEqual(candidate["end"] - candidate["start"], 8)

    def test_sparse_seed_opens_dense_verification_corridor(self):
        index = self.index(similarity_threshold=0.8)
        times, query = self.sequence(44)
        _other_times, tail = self.sequence(45)
        partial = query.copy()
        partial[8:] = tail[8:]
        index.publish(1, "partial", times + 20, partial)
        result = index.search(2, times, query, {1: "partial"}, top_k=2)
        self.assertIn(1, result.candidates_by_video)
        candidate = result.candidates_by_video[1][0]
        self.assertGreaterEqual(len(candidate["query_indices"]), 9)
        self.assertLess(candidate["descriptor_support"], 1.0)

    def test_discovery_keeps_reverse_containment_crop_view(self):
        index = self.index(similarity_threshold=0.8)
        times, matching = self.sequence(46)
        _other_times, unrelated = self.sequence(47)
        reference = np.concatenate([matching, unrelated], axis=1)
        query = np.concatenate([unrelated, matching], axis=1)
        index.publish(1, "reference", times + 10, reference)
        result = index.search(2, times, query, {1: "reference"}, top_k=2)
        self.assertIn(1, result.candidates_by_video)

    def test_changed_token_makes_old_vectors_ineligible(self):
        index = self.index()
        times, values = self.sequence(4)
        index.publish(1, "old", times, values)
        index.publish(1, "new", times, values)
        self.assertFalse(index.search(2, times, values, {1: "old"}, top_k=2).candidates_by_video)
        self.assertIn(1, index.search(2, times, values, {1: "new"}, top_k=2).candidates_by_video)

    def test_eligible_rows_vectorizes_identity_and_token_filtering(self):
        index = self.index()
        one = np.void(bytes.fromhex("01" * 16))
        two = np.void(bytes.fromhex("02" * 16))
        stale = np.void(bytes.fromhex("03" * 16))
        metadata = {
            "video_ids": np.asarray([2, 1, 3, 1, 2], dtype=np.int64),
            "tokens": np.asarray([two, stale, one, one, stale], dtype="V16"),
        }
        rows = index._eligible_rows(metadata, {1: one, 2: two})
        np.testing.assert_array_equal(rows, [0, 3])

    def test_publish_is_idempotent_and_bounds_shards(self):
        index = self.index()
        times, values = self.sequence(2, frames=25)
        first = index.publish(1, "one", times, values)
        second = index.publish(1, "one", times, values)
        self.assertTrue(index.contains(1, "one"))
        self.assertFalse(index.contains(1, "stale"))
        self.assertEqual(first.added_vectors, 25)
        self.assertEqual(second.added_vectors, 0)
        self.assertEqual(first.total_vectors, second.total_vectors)
        self.assertGreater(first.shards, 1)
        self.assertEqual(index.manifest_summary()["members"]["1"]["vectors"], 25)

    def test_promotes_to_hnswsq8_and_remains_searchable(self):
        index = self.index(similarity_threshold=0.1)
        stored = {}
        for video_id in range(1, 7):
            times, values = self.sequence(video_id)
            stored[video_id] = (times, values)
            stats = index.publish(video_id, f"token-{video_id}", times, values)
        self.assertTrue(stats.trained)
        times, values = stored[3]
        result = index.search(99, times, values, {i: f"token-{i}" for i in stored}, top_k=4)
        self.assertEqual(result.diagnostics["mode"], "hnswsq8")
        self.assertIn(3, result.candidates_by_video)

    def test_sealed_hnsw_uses_read_only_mmap_and_matches_regular_search(self):
        import faiss

        index = self.index(similarity_threshold=0.1)
        for video_id in range(1, 7):
            times, values = self.sequence(video_id)
            index.publish(video_id, f"token-{video_id}", times, values)
        manifest = index._read_manifest()
        sealed = next(record for record in manifest["shards"] if record["sealed"])
        mutable = next(record for record in manifest["shards"] if not record["sealed"])

        mapped = index._load_index(sealed)
        regular = faiss.read_index(str(self.root / sealed["index"]))
        query = np.ascontiguousarray(regular.reconstruct(0)[None, :], dtype=np.float32)
        mapped_scores, mapped_rows = mapped.search(query, 5)
        regular_scores, regular_rows = regular.search(query, 5)
        np.testing.assert_array_equal(mapped_rows, regular_rows)
        np.testing.assert_allclose(mapped_scores, regular_scores, rtol=0, atol=1e-6)

        original = faiss.read_index
        calls = []

        def record_flags(*args):
            calls.append(args)
            return original(*args)

        with patch.object(faiss, "read_index", side_effect=record_flags):
            index._load_index(sealed)
            index._load_index(mutable)
        self.assertEqual(calls[0][1], faiss.IO_FLAG_MMAP_IFC | faiss.IO_FLAG_READ_ONLY)
        self.assertEqual(calls[1][1], 0)

    def test_can_import_an_audited_hnswsq8_shard(self):
        import faiss

        times, values = self.sequence(22)
        source = faiss.IndexHNSWSQ(
            16,
            faiss.ScalarQuantizer.QT_8bit,
            4,
            faiss.METRIC_INNER_PRODUCT,
        )
        source.train(values[:, 0])
        source.add(values[:, 0])
        source_path = self.root / "source.faiss"
        faiss.write_index(source, str(source_path))
        source_digest = sha256(source_path.read_bytes()).hexdigest()
        identifiers = descriptor_ids(7, times, 1)

        destination = self.root / "retrieval"
        index = RetrievalIndex(
            destination,
            "a" * 64,
            shard_max_vectors=10,
            dimensions=16,
            hnsw_m=4,
            ef_construction=20,
            ef_search=32,
            training_min_vectors=64,
            training_max_vectors=128,
            similarity_threshold=0.1,
            max_stale_fraction=0.75,
            budget_root=self.root,
        )
        stats = index.import_shard(source_path, identifiers, {7: "token-7"})
        self.assertTrue(stats.trained)
        self.assertTrue(index.contains(7, "token-7"))
        self.assertEqual(index.manifest_summary()["kind"], "hnswsq8")
        self.assertTrue(index._read_manifest()["shards"][0]["sealed"])
        found = index.audit_neighbors(values[:, 0], {7: "token-7"}, top_k=1)
        np.testing.assert_array_equal(found.ids[:, 0], identifiers)
        self.assertEqual(sha256(source_path.read_bytes()).hexdigest(), source_digest)
        with self.assertRaisesRegex(RuntimeError, "requires an empty index"):
            index.import_shard(source_path, identifiers, {7: "token-7"})

    def test_import_rejects_incompatible_graph_before_publication(self):
        import faiss

        times, values = self.sequence(23)
        identifiers = descriptor_ids(7, times, 1)
        cases = {
            "wrong-type": faiss.IndexHNSWFlat(16, 4, faiss.METRIC_INNER_PRODUCT),
            "wrong-metric": faiss.IndexHNSWSQ(
                16, faiss.ScalarQuantizer.QT_8bit, 4, faiss.METRIC_L2
            ),
            "wrong-m": faiss.IndexHNSWSQ(
                16, faiss.ScalarQuantizer.QT_8bit, 8, faiss.METRIC_INNER_PRODUCT
            ),
        }
        for name, source in cases.items():
            with self.subTest(name=name):
                if not source.is_trained:
                    source.train(values[:, 0])
                source.add(values[:, 0])
                source_path = self.root / f"{name}.faiss"
                faiss.write_index(source, str(source_path))
                destination = self.root / f"retrieval-{name}"
                index = RetrievalIndex(
                    destination,
                    "a" * 64,
                    shard_max_vectors=10,
                    dimensions=16,
                    hnsw_m=4,
                    ef_construction=20,
                    ef_search=32,
                    training_min_vectors=64,
                    training_max_vectors=128,
                    max_stale_fraction=0.75,
                    budget_root=self.root,
                )
                with self.assertRaisesRegex(RuntimeError, "incompatible imported"):
                    index.import_shard(source_path, identifiers, {7: "token-7"})
                self.assertFalse(index.manifest_path.exists())
                self.assertFalse(list(destination.glob("shard-*")))

    def test_retry_after_post_commit_promotion_failure_promotes_exact_manifest(self):
        index = self.index(similarity_threshold=0.1)
        stored = {}
        for video_id in range(1, 6):
            times, values = self.sequence(video_id)
            stored[video_id] = (times, values)
            index.publish(video_id, f"token-{video_id}", times, values)
        times, values = self.sequence(6)
        with patch.object(index, "_promote", side_effect=RuntimeError("interrupted")):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                index.publish(6, "token-6", times, values)
        self.assertTrue(index.contains(6, "token-6"))
        stats = index.publish(6, "token-6", times, values)
        self.assertTrue(stats.trained)

    def test_retry_cleans_orphan_from_mid_promotion_failure(self):
        index = self.index(similarity_threshold=0.1)
        for video_id in range(1, 6):
            times, values = self.sequence(video_id)
            index.publish(video_id, f"token-{video_id}", times, values)
        times, values = self.sequence(6)
        write = index._write_shard
        converted = 0

        def interrupt(record, *args):
            nonlocal converted
            if record["kind"] == "hnswsq8":
                converted += 1
                if converted == 2:
                    raise RuntimeError("mid-promotion")
            return write(record, *args)

        with patch.object(index, "_write_shard", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "mid-promotion"):
                index.publish(6, "token-6", times, values)
        orphan = list(self.root.glob("shard-*-g*.faiss"))
        recovered = self.index(similarity_threshold=0.1)
        self.assertLess(len(list(self.root.glob("shard-*-g*.faiss"))), len(orphan))
        self.assertTrue(recovered.publish(6, "token-6", times, values).trained)

    def test_stale_descriptor_budget_fails_before_append(self):
        index = self.index(max_stale_fraction=0.25, max_stale_vectors=1_000)
        times, values = self.sequence(7)
        index.publish(1, "old", times, values)
        with self.assertRaisesRegex(RuntimeError, "too many stale descriptors"):
            index.publish(1, "new", times, values)
        self.assertTrue(index.contains(1, "old"))
        self.assertFalse(index.contains(1, "new"))

    def test_streaming_exact_recall_diagnostic_is_bounded_and_stable(self):
        rng = np.random.default_rng(14)
        references = rng.normal(size=(37, 8)).astype(np.float32)
        references /= np.linalg.norm(references, axis=1, keepdims=True)
        queries = references[[3, 19, 31]]
        batches = [
            (np.arange(0, 13), references[:13]),
            (np.arange(13, 37), references[13:]),
        ]
        _scores, exact = streaming_exact_topk(queries, batches, 3, reference_block_size=5)
        self.assertEqual(exact[:, 0].tolist(), [3, 19, 31])
        self.assertEqual(neighbor_recall(exact, exact.copy()), 1.0)
        displaced = exact.copy()
        displaced[:, 0] = -1
        self.assertAlmostEqual(neighbor_recall(exact, displaced), 2 / 3)

        exact_neighborhoods = descriptor_ids(1, np.array([10.0, 20.0]), 2)[None, :]
        nearby = descriptor_ids(1, np.array([11.5, 25.0]), 1)[None, :]
        self.assertEqual(
            tolerant_neighbor_recall(exact_neighborhoods, nearby),
            0.5,
        )


if __name__ == "__main__":
    unittest.main()
