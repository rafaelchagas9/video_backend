import json
import unittest
from unittest.mock import patch

import numpy as np

from vision_service.video_copies import parse_request
from vision_service.video_copy_match import compare, nearest_frames, temporal_candidates


class TemporalCopyTests(unittest.TestCase):
    def fixture(self, speed=1.0, offset=31):
        rng = np.random.default_rng(5)
        ref = rng.normal(size=(180, 64)).astype(np.float32)
        ref /= np.linalg.norm(ref, axis=1, keepdims=True)
        times = np.arange(30, dtype=float)
        indices = np.round(times * speed + offset).astype(int)
        query = ref[indices].copy()
        return ({"times": times, "vectors": query}, {"times": np.arange(180.0), "vectors": ref})

    def test_exact_blocked_search_equals_dense(self):
        rng = np.random.default_rng(3)
        query, reference = (
            rng.normal(size=(139, 12)).astype("float32"),
            rng.normal(size=(4107, 12)).astype("float32"),
        )
        for start, values, indices in nearest_frames(query, reference):
            expected = np.sort(query[start : start + 128] @ reference.T, axis=1)[:, -3:]
            np.testing.assert_allclose(np.sort(values, axis=1), expected, rtol=1e-5)

    def test_clip_offset_and_continuous_speed(self):
        for speed in (1.0, 1.2, 0.8):
            query, reference = self.fixture(speed)
            best = temporal_candidates(query, reference)[0]
            self.assertAlmostEqual(best["offset"], 31, delta=0.6)
            self.assertAlmostEqual(best["speed"], speed, delta=0.03)

    def test_reverse_and_unrelated_do_not_form_forward_sequence(self):
        query, reference = self.fixture()
        query["vectors"] = query["vectors"][::-1]
        self.assertEqual(temporal_candidates(query, reference), [])
        query["vectors"] *= -1
        self.assertEqual(temporal_candidates(query, reference), [])

    def test_semantic_candidates_never_publish_without_spatial_evidence(self):
        query, reference = self.fixture()
        with patch("vision_service.video_copy_match.verify_candidate", return_value=None):
            self.assertIsNone(compare(query, reference))

    def test_request_bounds(self):
        request = {
            "version": 1,
            "cache_dir": "/private/cache",
            "videos": [
                {"id": 1, "path": "/library/a.mp4", "duration_seconds": 30},
                {"id": 2, "path": "/library/b.mp4", "duration_seconds": 50},
            ],
        }
        self.assertEqual(parse_request(json.dumps(request)), request)
        request["videos"][1]["id"] = 1
        with self.assertRaises(ValueError):
            parse_request(json.dumps(request))


if __name__ == "__main__":
    unittest.main()
