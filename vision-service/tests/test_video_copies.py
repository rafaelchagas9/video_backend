from __future__ import annotations

import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from vision_service import video_copies
from vision_service.video_copy_frames import source_identity


class FakeModel:
    digest = "a" * 64

    def __init__(self, _root):
        self.runtime = {}


class FakeRetrieval:
    instances: list["FakeRetrieval"] = []
    candidates_by_query: dict[int, dict[int, list[dict]]] = {}

    def __init__(self, *_args, **_kwargs):
        self.published = []
        self.searches = []
        self.__class__.instances.append(self)

    def publish(self, video_id, token, times, views):
        self.published.append((video_id, token, len(times), views.shape))

    def search(self, video_id, times, views, eligible):
        self.searches.append((video_id, set(eligible), len(times), views.shape))
        return SimpleNamespace(
            candidates_by_video=self.candidates_by_query.get(video_id, {}),
            truncated=False,
        )


class ManualVideoCopiesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.videos = []
        for video_id, duration in ((1, 10), (2, 20), (3, 30)):
            path = self.root / f"source-{video_id}.mkv"
            path.write_bytes(b"original")
            self.videos.append(
                {"id": video_id, "path": str(path), "duration_seconds": duration}
            )
        FakeRetrieval.instances.clear()
        FakeRetrieval.candidates_by_query = {}
        self.addCleanup(self.temporary.cleanup)

    def request(self):
        return {"version": 1, "videos": self.videos, "cache_dir": str(self.root)}

    def fake_index(self, video, *_args):
        count = int(video["duration_seconds"])
        return {
            "video": video,
            "identity": source_identity(video["path"]),
            "cache_key": f"cache-{video['id']}",
            "times": np.arange(float(count)),
            "views": np.zeros((count, 11, 512), dtype=np.float32),
        }

    def patches(self):
        return (
            patch("vision_service.video_copy_model.CopyModel", FakeModel),
            patch("vision_service.video_copy_retrieval.RetrievalIndex", FakeRetrieval),
            patch("vision_service.video_copy_index.index_video", side_effect=self.fake_index),
        )

    def test_only_retrieved_reference_is_loaded_and_pair_is_verified_once(self):
        candidate = {
            "start": 0,
            "end": 9,
            "speed": 1,
            "offset": 4,
            "score": 10,
            "query_indices": np.arange(10),
        }
        FakeRetrieval.candidates_by_query = {
            1: {2: [candidate]},
            # Reverse retrieval must not compare the same unordered pair again.
            2: {1: [candidate]},
            3: {},
        }

        with ExitStack() as stack:
            active = [stack.enter_context(patcher) for patcher in self.patches()]
            index = active[2]
            with patch("vision_service.video_copy_match.compare", return_value=None) as compare:
                result = video_copies.run(self.request())

        self.assertEqual(compare.call_count, 1)
        query, reference = compare.call_args.args[:2]
        self.assertEqual((query["video"]["id"], reference["video"]["id"]), (1, 2))
        self.assertEqual(result["runtime"]["retrieval_candidates"], 1)
        loaded_ids = [call.args[0]["id"] for call in index.call_args_list]
        self.assertEqual(loaded_ids.count(1), 2)
        self.assertEqual(loaded_ids.count(2), 3)
        self.assertEqual(loaded_ids.count(3), 2)
        retrieval = FakeRetrieval.instances[0]
        self.assertEqual([item[0] for item in retrieval.published], [1, 2, 3])
        self.assertTrue(all(eligible == {1, 2, 3} for _, eligible, *_ in retrieval.searches))

    def test_source_change_during_verification_rejects_the_manual_result(self):
        candidate = {
            "start": 0,
            "end": 9,
            "speed": 1,
            "offset": 4,
            "score": 10,
            "query_indices": np.arange(10),
        }
        FakeRetrieval.candidates_by_query = {1: {2: [candidate]}, 2: {}, 3: {}}

        def mutate(*_args, **_kwargs):
            Path(self.videos[1]["path"]).write_bytes(b"changed")
            return None

        with ExitStack() as stack:
            for patcher in self.patches():
                stack.enter_context(patcher)
            with patch("vision_service.video_copy_match.compare", side_effect=mutate):
                with self.assertRaisesRegex(RuntimeError, "COPY_SOURCE_CHANGED"):
                    video_copies.run(self.request())


if __name__ == "__main__":
    unittest.main()
