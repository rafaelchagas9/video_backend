import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from vision_service import video_copy_catalog as catalog


class FakeModel:
    digest = "a" * 64

    def __init__(self, _root):
        pass


class FakeRetrieval:
    def __init__(self, *_args, **_kwargs):
        pass

    def publish(self, *_args):
        pass

    def contains(self, *_args):
        return True

    def search(self, _video_id, _times, _views, eligible):
        return SimpleNamespace(candidates_by_video={key: [] for key in eligible}, truncated=False)



class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.videos = []
        for number in range(1, 5):
            path = self.root / f"source-{number}.mkv"
            path.write_bytes(b"original")
            self.videos.append({"id": number, "path": str(path), "duration_seconds": 10})
        self.model = patch.object(catalog, "CopyModel", FakeModel)
        self.search = patch.object(catalog, "RetrievalIndex", FakeRetrieval)
        self.index = patch.object(
            catalog,
            "index_video",
            side_effect=lambda video, *_: {
                "video": video,
                "identity": catalog.source_identity(video["path"]),
                "cache_key": "b" * 64,
                "times": np.arange(10),
                "views": np.zeros((10, 11, 512), dtype=np.float32),
            },
        )
        for patcher in (self.model, self.search, self.index):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.temporary.cleanup)

    def run_video(self, number, allowed=None):
        return catalog.run(
            {
                "video": self.videos[number - 1],
                "cache_dir": str(self.root),
                "reference_ids": allowed if allowed is not None else [1, 2, 3, 4],
            }
        )

    def test_first_source_indexes_and_later_sources_verify_retrieved_candidates(self):
        with patch.object(catalog, "compare", return_value=None) as compare:
            first = self.run_video(1)
            second = self.run_video(2)
            third = self.run_video(3)
        self.assertEqual(
            [first["compared_videos"], second["compared_videos"], third["compared_videos"]],
            [0, 1, 2],
        )
        self.assertEqual(compare.call_count, 3)
        self.assertEqual(len(json.loads((self.root / "catalog.json").read_text())["videos"]), 3)

    def test_interrupted_comparison_resumes_pairs_without_publishing_source(self):
        with patch.object(catalog, "compare", return_value=None):
            self.run_video(1)
            self.run_video(2)
        with patch.object(catalog, "compare", side_effect=[None, RuntimeError("interrupted")]):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.run_video(3)
        stored = json.loads((self.root / "catalog.json").read_text())
        self.assertNotIn("3", stored["videos"])
        with patch.object(catalog, "compare", return_value=None) as compare:
            resumed = self.run_video(3)
        self.assertEqual(resumed["compared_videos"], 2)
        self.assertEqual(compare.call_count, 1)
        self.assertFalse((self.root / "catalog-work-3.json").exists())

    def test_stale_and_deleted_references_are_not_compared(self):
        with patch.object(catalog, "compare", return_value=None):
            self.run_video(1)
            self.run_video(2)
        Path(self.videos[0]["path"]).write_bytes(b"replacement")
        with patch.object(catalog, "compare", return_value=None) as compare:
            result = self.run_video(3, [1, 3])
        self.assertEqual(result["skipped_references"], 1)
        self.assertEqual(result["compared_videos"], 0)
        compare.assert_not_called()

    def test_non_candidates_are_not_loaded_or_compared(self):
        with patch.object(catalog, "compare", return_value=None):
            self.run_video(1)
            self.run_video(2)
        with (patch.object(FakeRetrieval, "search", return_value=SimpleNamespace(
                  candidates_by_video={}, truncated=True)),
              patch.object(catalog, "compare") as compare):
            result = self.run_video(3)
        compare.assert_not_called()
        self.assertEqual(result["retrieval_references"], 2)
        self.assertEqual(result["compared_videos"], 0)
        self.assertTrue(result["retrieval_truncated"])

    def test_changed_retrieval_windows_do_not_reuse_a_stale_pair_checkpoint(self):
        with patch.object(catalog, "compare", return_value=None):
            self.run_video(1)
            self.run_video(2)
        with patch.object(catalog, "compare", side_effect=[None, RuntimeError("interrupted")]):
            with self.assertRaises(RuntimeError):
                self.run_video(3)
        changed = {
            1: [
                {
                    "start": 2,
                    "end": 9,
                    "speed": 1,
                    "offset": 0,
                    "query_indices": [2, 3, 4],
                }
            ],
            2: [],
        }
        with (
            patch.object(
                FakeRetrieval,
                "search",
                return_value=SimpleNamespace(candidates_by_video=changed, truncated=False),
            ),
            patch.object(catalog, "compare", return_value=None) as compare,
        ):
            self.run_video(3)
        self.assertEqual(compare.call_count, 2)

    def test_new_long_query_verifies_retrieved_older_short_reference_in_that_orientation(self):
        with patch.object(catalog, "compare", return_value=None):
            self.run_video(1)
        self.videos[1]["duration_seconds"] = 30
        candidates = {
            1: [
                {
                    "start": 8,
                    "end": 17,
                    "speed": 1,
                    "offset": -8,
                    "score": 9,
                    "query_indices": list(range(8, 18)),
                }
            ]
        }

        with (
            patch.object(
                FakeRetrieval,
                "search",
                return_value=SimpleNamespace(candidates_by_video=candidates, truncated=False),
            ),
            patch.object(catalog, "compare", return_value=None) as compare,
        ):
            result = self.run_video(2)

        query, reference = compare.call_args.args[:2]
        self.assertEqual(query["video"]["id"], 2)
        self.assertEqual(query["video"]["duration_seconds"], 30)
        self.assertEqual(reference["video"]["id"], 1)
        self.assertEqual(reference["video"]["duration_seconds"], 10)
        self.assertIs(compare.call_args.kwargs["candidates"], candidates[1])
        self.assertEqual(result["compared_videos"], 1)

    def test_reordered_scored_candidates_invalidate_pair_checkpoint(self):
        with patch.object(catalog, "compare", return_value=None):
            self.run_video(1)
            self.run_video(2)
        first = {
            "start": 0,
            "end": 9,
            "speed": 1,
            "offset": 0,
            "score": 10,
            "query_indices": list(range(10)),
        }
        second = {**first, "offset": 20, "score": 9}
        initial = {1: [first, second], 2: []}
        with (
            patch.object(
                FakeRetrieval,
                "search",
                return_value=SimpleNamespace(candidates_by_video=initial, truncated=False),
            ),
            patch.object(catalog, "compare", side_effect=[None, RuntimeError("interrupted")]),
        ):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.run_video(3)

        reordered = {1: [{**second, "score": 11}, first], 2: []}
        with (
            patch.object(
                FakeRetrieval,
                "search",
                return_value=SimpleNamespace(candidates_by_video=reordered, truncated=False),
            ),
            patch.object(catalog, "compare", return_value=None) as compare,
        ):
            self.run_video(3)

        # Pair 1 is recomputed because ordering affects the verifier budget;
        # pair 2 still had no checkpoint because the first run was interrupted.
        self.assertEqual(compare.call_count, 2)

    def test_request_rejects_relative_path_partial_window_and_large_duration(self):
        valid = {
            "version": 1,
            "video": self.videos[0],
            "reference_ids": [],
            "cache_dir": str(self.root),
        }
        for change in ({"path": "relative"}, {"start_seconds": 2}, {"duration_seconds": 86401}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                catalog.parse_request(json.dumps({**valid, "video": {**valid["video"], **change}}))

    def test_changed_query_is_not_published(self):
        with patch.object(catalog, "compare", return_value=None):
            self.run_video(1)

        def mutate(*_args, **_kwargs):
            Path(self.videos[1]["path"]).write_bytes(b"changed")

        with patch.object(catalog, "compare", side_effect=mutate):
            with self.assertRaisesRegex(RuntimeError, "COPY_SOURCE_CHANGED"):
                self.run_video(2)
        self.assertNotIn("2", json.loads((self.root / "catalog.json").read_text())["videos"])


if __name__ == "__main__":
    unittest.main()
