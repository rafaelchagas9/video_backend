from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np

from vision_service.video_copy_frames import FrameSamplingGapError
from vision_service.video_copy_match import (
    MAX_VERIFICATION_WINDOWS,
    CandidateList,
    _FrameCache,
    _fixed_rate_prediction,
    _extension_windows,
    _prepared_features,
    _select_query_frames,
    compare,
    verify_candidate,
)


def index(video_id: int, duration: float) -> dict:
    return {
        "video": {
            "id": video_id,
            "path": f"/media/{video_id}.mp4",
            "duration_seconds": duration,
        }
    }


def candidate() -> dict:
    return {"start": 0.0, "end": 5.0, "speed": 1.0, "offset": 0.0}


def segment(**overrides) -> dict:
    value = {
        "a_start": 0.0,
        "a_end": 5.0,
        "b_start": 0.0,
        "b_end": 5.0,
        "speed": 1.0,
        "matched_frames": 6,
        "spatial_inliers": 20,
        "motion": 0.1,
        "timing_error_seconds": 0.01,
        "temporal_motion_similarity": 0.9,
        "temporal_motion_energy": 0.1,
        "status": "verified",
    }
    value.update(overrides)
    return value


class VideoCopyMatchReviewTests(unittest.TestCase):
    def test_long_query_verifies_on_short_grid_and_restores_result_orientation(self):
        query, reference = index(1, 30.0), index(2, 10.0)
        query["times"] = np.arange(30.0)
        reference["times"] = np.arange(10.0)
        speed = 1.1
        proposed = CandidateList(
            [
                {
                    "reference_video_id": 2,
                    "query_indices": np.arange(10, 19),
                    "start": 10.0,
                    "end": 200.0 / 11.0,
                    "speed": speed,
                    "offset": -11.0,
                    "score": 100.0,
                    "hits": [
                        {
                            "query_index": 10,
                            "query_time": 10.0,
                            "reference_time": 0.0,
                            "similarity": 0.9,
                            "query_view": 3,
                            "reference_view": 7,
                        }
                    ],
                }
            ],
            truncated=True,
        )
        diagnostics = {"candidate_limited_pairs": 0}

        def verified_on_short_grid(actual_query, actual_reference, window):
            self.assertEqual(actual_query["video"]["id"], 2)
            self.assertEqual(actual_reference["video"]["id"], 1)
            np.testing.assert_array_equal(window["query_indices"], np.arange(10))
            self.assertAlmostEqual(window["start"], 0.0)
            self.assertAlmostEqual(window["end"], 9.0)
            self.assertAlmostEqual(window["speed"], 1.0 / speed)
            self.assertAlmostEqual(window["offset"], 10.0)
            self.assertEqual(window["reference_video_id"], 1)
            self.assertEqual(window["hits"][0]["query_index"], 0)
            self.assertEqual(window["hits"][0]["query_view"], 7)
            self.assertEqual(window["hits"][0]["reference_view"], 3)
            return segment(
                a_start=0.0,
                a_end=10.0,
                b_start=10.0,
                b_end=200.0 / 11.0,
                speed=1.0 / speed,
            )

        with patch(
            "vision_service.video_copy_match.verify_candidate",
            side_effect=verified_on_short_grid,
        ):
            result = compare(
                query,
                reference,
                candidates=proposed,
                diagnostics=diagnostics,
            )

        self.assertIsNotNone(result)
        self.assertEqual((result["video_a"], result["video_b"]), (1, 2))
        self.assertAlmostEqual(result["segments"][0]["a_start"], 10.0)
        self.assertAlmostEqual(result["segments"][0]["a_end"], 200.0 / 11.0)
        self.assertAlmostEqual(result["segments"][0]["b_start"], 0.0)
        self.assertAlmostEqual(result["segments"][0]["b_end"], 10.0)
        self.assertAlmostEqual(result["segments"][0]["speed"], speed)
        self.assertAlmostEqual(
            result["segments"][0]["timing_error_seconds"], 0.01 * speed
        )
        self.assertAlmostEqual(result["coverage_a"], (90.0 / 11.0) / 30.0)
        self.assertEqual(result["coverage_b"], 1.0)
        self.assertEqual(diagnostics["verification_limited_pairs"], 0)
        self.assertEqual(diagnostics["candidate_limited_pairs"], 1)

    def test_long_query_with_empty_shorter_grid_abstains_without_argmin(self):
        query, reference = index(1, 30.0), index(2, 10.0)
        query["times"] = np.arange(30.0)
        diagnostics = {"candidate_limited_pairs": 0}
        proposed = CandidateList(
            [
                {
                    "query_indices": np.arange(10, 20),
                    "start": 10.0,
                    "end": 19.0,
                    "speed": 1.0,
                    "offset": -10.0,
                    "hits": [
                        {
                            "query_index": 10,
                            "query_time": 10.0,
                            "reference_time": 0.0,
                        }
                    ],
                }
            ],
            truncated=True,
        )

        result = compare(
            query,
            reference,
            candidates=proposed,
            diagnostics=diagnostics,
        )

        self.assertIsNone(result)
        self.assertEqual(diagnostics["verification_limited_pairs"], 0)
        self.assertEqual(diagnostics["candidate_limited_pairs"], 1)

    def test_sampling_gap_abstains_and_marks_window_incomplete(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        query["times"] = np.arange(10.0)
        proposed = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 4.0,
        }
        reasons = []

        def fake_extract(path, _start, _duration, **_kwargs):
            if path == reference["video"]["path"]:
                raise FrameSamplingGapError("sampling gap")
            for timestamp in range(10):
                yield float(timestamp), np.zeros((32, 32, 3), dtype=np.uint8)

        with (
            patch("vision_service.video_copy_match.extract", fake_extract),
            patch("vision_service.video_copy_match._query_can_evolve", return_value=True),
        ):
            result = verify_candidate(query, reference, proposed, debug=reasons.append)

        self.assertIsNone(result)
        self.assertEqual(reasons[0]["reason"], "sampling_gap")
        self.assertTrue(proposed["_verification_sampling_gap"])

    def test_fatal_decode_error_still_propagates_from_verifier(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        query["times"] = np.arange(10.0)
        proposed = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 4.0,
        }

        def fake_extract(path, _start, _duration, **_kwargs):
            if path == reference["video"]["path"]:
                raise RuntimeError("COPY_DECODE_FAILED: fatal")
            for timestamp in range(10):
                yield float(timestamp), np.zeros((32, 32, 3), dtype=np.uint8)

        with (
            patch("vision_service.video_copy_match.extract", fake_extract),
            patch("vision_service.video_copy_match._query_can_evolve", return_value=True),
            self.assertRaisesRegex(RuntimeError, "fatal"),
        ):
            verify_candidate(query, reference, proposed)

    def test_sampling_gap_marks_pair_verification_limited(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        query["times"] = np.arange(10.0)
        proposed = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 4.0,
        }
        diagnostics = {"candidate_limited_pairs": 0}

        def skipped_for_gap(_query, _reference, window):
            window["_verification_sampling_gap"] = True
            return None

        with patch(
            "vision_service.video_copy_match.verify_candidate", side_effect=skipped_for_gap
        ):
            result = compare(
                query,
                reference,
                candidates=CandidateList([proposed]),
                diagnostics=diagnostics,
            )

        self.assertIsNone(result)
        self.assertEqual(diagnostics["verification_limited_pairs"], 1)
        self.assertEqual(diagnostics["candidate_limited_pairs"], 1)

    def test_overlapping_decode_boundary_keeps_one_frame_per_query_sample(self):
        frames = [
            {"time": 15.0, "frame": object()},
            {"time": 15.08, "frame": object()},
            {"time": 16.08, "frame": object()},
        ]

        selected = _select_query_frames(
            frames,
            np.array([15, 16]),
            np.array([15.0, 16.0]),
        )

        self.assertEqual([item["time"] for item in selected], [15.0, 16.08])
        self.assertEqual([item["query_index"] for item in selected], [15, 16])

    def test_overlapping_windows_decode_only_the_missing_tail_and_reuse_features(self):
        source = {"path": "/media/1.mp4", "duration_seconds": 30.0}
        calls = []

        def fake_extract(_path, start, duration, **_kwargs):
            calls.append((start, duration))
            for offset in range(int(np.ceil(duration))):
                timestamp = start + offset
                if timestamp < start + duration:
                    yield timestamp, np.full((32, 32, 3), offset, dtype=np.uint8)

        prepared = object()
        with (
            patch("vision_service.video_copy_match.extract", fake_extract),
            patch("vision_service.video_copy_match.prepare", return_value=prepared) as prepare_mock,
        ):
            cache = _FrameCache(source, 1, 128)
            first = cache.get(0.0, 10.0)
            second = cache.get(5.0, 15.0)
            _prepared_features(first[5])
            _prepared_features(first[5])

        self.assertEqual(calls, [(0.0, 10.0), (10.0, 5.0)])
        self.assertEqual(len(first), 10)
        self.assertEqual(len(second), 10)
        self.assertEqual(prepare_mock.call_count, 1)

    def test_short_seed_refines_offset_without_extrapolating_noisy_slope(self):
        evidence = [
            {"q": 0.0, "r": 10.0},
            {"q": 1.0, "r": 10.9},
            {"q": 2.0, "r": 11.8},
        ]

        self.assertAlmostEqual(_fixed_rate_prediction(20.0, evidence), 29.9)

    def test_seed_extension_keeps_fixed_rate_and_robust_offset(self):
        query = index(1, 30.0)
        query["times"] = np.arange(30.0)
        windows = _extension_windows(
            query,
            segment(
                a_end=10.0,
                b_start=37.0,
                b_end=46.0,
                speed=0.91,
                _temporal_offset=37.4,
            ),
        )

        self.assertTrue(windows)
        self.assertTrue(all(window["speed"] == 1.0 for window in windows))
        self.assertTrue(all(window["offset"] == 37.4 for window in windows))

    def test_compare_clips_segment_endpoints_and_coverage_to_video_bounds(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        outside = segment(a_start=-0.03, a_end=10.03, b_start=-0.04, b_end=20.04)

        with (
            patch(
                "vision_service.video_copy_match.temporal_candidates",
                return_value=CandidateList([candidate()]),
            ),
            patch("vision_service.video_copy_match.verify_candidate", return_value=outside),
        ):
            result = compare(query, reference)

        self.assertIsNotNone(result)
        self.assertEqual(
            result["segments"][0],
            segment(a_start=0.0, a_end=10.0, b_start=0.0, b_end=20.0),
        )
        self.assertEqual(result["coverage_a"], 1.0)
        self.assertEqual(result["coverage_b"], 1.0)

    def test_compare_discards_interval_collapsed_by_clipping(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        before_start = segment(a_start=-2.0, a_end=-1.0)

        with (
            patch(
                "vision_service.video_copy_match.temporal_candidates",
                return_value=CandidateList([candidate()]),
            ),
            patch("vision_service.video_copy_match.verify_candidate", return_value=before_start),
        ):
            self.assertIsNone(compare(query, reference))

    def test_candidate_truncation_is_observable_even_when_no_match_verifies(self):
        diagnostics = {"candidate_limited_pairs": 0}
        with patch(
            "vision_service.video_copy_match.temporal_candidates",
            return_value=CandidateList([], truncated=True),
        ):
            result = compare(index(1, 10.0), index(2, 20.0), diagnostics=diagnostics)

        self.assertIsNone(result)
        self.assertEqual(
            diagnostics,
            {"candidate_limited_pairs": 1, "verification_limited_pairs": 0},
        )

    def test_explicit_long_candidate_is_verified_in_dense_overlapping_windows(self):
        query, reference = index(1, 45.0), index(2, 60.0)
        query["times"] = np.arange(45.0)
        proposed = {
            "query_indices": np.arange(45),
            "start": 0.0,
            "end": 44.0,
            "speed": 1.0,
            "offset": 5.0,
            "score": 100.0,
        }

        def verified_window(_query, _reference, window):
            return segment(
                a_start=window["start"],
                a_end=window["end"],
                b_start=window["start"] + 5.0,
                b_end=window["end"] + 5.0,
            )

        with (
            patch("vision_service.video_copy_match.temporal_candidates") as retrieval,
            patch(
                "vision_service.video_copy_match.verify_candidate",
                side_effect=verified_window,
            ) as verifier,
        ):
            result = compare(query, reference, candidates=CandidateList([proposed]))

        retrieval.assert_not_called()
        self.assertIsNotNone(result)
        self.assertGreaterEqual(verifier.call_count, 3)
        for call in verifier.call_args_list:
            window = call.args[2]
            self.assertLess(window["end"] - window["start"], 15.0)
        self.assertEqual(len(result["segments"]), 1)
        self.assertGreaterEqual(result["coverage_a"], 0.85)

    def test_unobserved_gap_is_not_bridged_into_coverage(self):
        query, reference = index(1, 30.0), index(2, 40.0)
        query["times"] = np.concatenate([np.arange(9.0), np.arange(20.0, 29.0)])
        proposed = {
            "query_indices": np.arange(18),
            "start": 0.0,
            "end": 28.0,
            "speed": 1.0,
            "offset": 5.0,
            "score": 100.0,
        }

        def verified_window(_query, _reference, window):
            return segment(
                a_start=window["start"],
                a_end=window["end"],
                b_start=window["start"] + 5.0,
                b_end=window["end"] + 5.0,
            )

        with patch(
            "vision_service.video_copy_match.verify_candidate", side_effect=verified_window
        ):
            result = compare(query, reference, candidates=CandidateList([proposed]))

        self.assertIsNotNone(result)
        self.assertEqual(len(result["segments"]), 2)
        self.assertAlmostEqual(result["coverage_a"], 16.0 / 30.0)

    def test_candidate_shorter_than_supported_ten_second_floor_is_not_verified(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        query["times"] = np.arange(8.0)
        proposed = {
            "query_indices": np.arange(8),
            "start": 0.0,
            "end": 7.0,
            "speed": 1.0,
            "offset": 5.0,
            "score": 100.0,
        }

        with patch("vision_service.video_copy_match.verify_candidate") as verifier:
            result = compare(query, reference, candidates=CandidateList([proposed]))

        self.assertIsNone(result)
        verifier.assert_not_called()

    def test_sparse_retrieval_hits_expand_to_dense_query_grid_for_confirmation(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        query["times"] = np.arange(10.0)
        proposed = {
            "query_indices": np.array([0, 2, 4, 6, 8, 9]),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 5.0,
            "score": 100.0,
        }

        with patch(
            "vision_service.video_copy_match.verify_candidate",
            return_value=segment(a_end=9.0, b_start=5.0, b_end=14.0),
        ) as verifier:
            result = compare(query, reference, candidates=CandidateList([proposed]))

        self.assertIsNotNone(result)
        np.testing.assert_array_equal(verifier.call_args.args[2]["query_indices"], np.arange(10))

    def test_verified_seed_extends_fragmented_retrieval_across_short_query(self):
        query, reference = index(1, 30.0), index(2, 180.0)
        query["times"] = np.arange(30.0)
        proposed = {
            "query_indices": np.arange(11),
            "start": 0.0,
            "end": 10.0,
            "speed": 1.0,
            "offset": 37.0,
            "score": 100.0,
        }

        def verified_window(_query, _reference, window):
            return segment(
                a_start=window["start"],
                a_end=window["end"] + 1.0,
                b_start=window["start"] + 37.0,
                b_end=window["end"] + 38.0,
            )

        with patch(
            "vision_service.video_copy_match.verify_candidate", side_effect=verified_window
        ) as verifier:
            result = compare(query, reference, candidates=CandidateList([proposed]))

        self.assertIsNotNone(result)
        self.assertGreaterEqual(result["coverage_a"], 0.85)
        self.assertTrue(any(call.args[2]["end"] > 10.0 for call in verifier.call_args_list))

    def test_failed_seed_extension_does_not_add_unverified_coverage(self):
        query, reference = index(1, 30.0), index(2, 180.0)
        query["times"] = np.arange(30.0)
        proposed = {
            "query_indices": np.arange(11),
            "start": 0.0,
            "end": 10.0,
            "speed": 1.0,
            "offset": 37.0,
            "score": 100.0,
        }

        def only_seed_verifies(_query, _reference, window):
            if window.get("_extension"):
                return None
            return segment(a_end=10.0, b_start=37.0, b_end=47.0)

        with patch(
            "vision_service.video_copy_match.verify_candidate", side_effect=only_seed_verifies
        ):
            result = compare(query, reference, candidates=CandidateList([proposed]))

        self.assertIsNotNone(result)
        self.assertAlmostEqual(result["coverage_a"], 1.0 / 3.0)

    def test_seed_extensions_are_interleaved_with_original_candidates(self):
        query, reference = index(1, 30.0), index(2, 180.0)
        query["times"] = np.arange(30.0)
        proposals = CandidateList(
            [
                {
                    "query_indices": np.arange(11),
                    "start": 0.0,
                    "end": 10.0,
                    "speed": 1.0,
                    "offset": 37.0,
                    "score": 100.0,
                },
                {
                    "query_indices": np.arange(20, 30),
                    "start": 20.0,
                    "end": 29.0,
                    "speed": 1.0,
                    "offset": 37.0,
                    "score": 90.0,
                },
            ]
        )

        def only_first_verifies(_query, _reference, window):
            if window["start"] == 0.0 and window["end"] == 10.0:
                return segment(a_end=10.0, b_start=37.0, b_end=47.0)
            return None

        with patch(
            "vision_service.video_copy_match.verify_candidate", side_effect=only_first_verifies
        ) as verifier:
            compare(query, reference, candidates=proposals)

        starts = [call.args[2]["start"] for call in verifier.call_args_list]
        self.assertEqual(starts[:3], [0.0, 20.0, 0.0])

    def test_long_query_seed_extension_is_bounded_to_adjacent_windows(self):
        query, reference = index(1, 4_000.0), index(2, 5_000.0)
        query["times"] = np.arange(4_000.0)
        proposed = {
            "query_indices": np.arange(1_000, 1_011),
            "start": 1_000.0,
            "end": 1_010.0,
            "speed": 1.0,
            "offset": 37.0,
            "score": 100.0,
        }

        def verified_window(_query, _reference, window):
            return segment(
                a_start=window["start"],
                a_end=window["end"] + 1.0,
                b_start=window["start"] + 37.0,
                b_end=window["end"] + 38.0,
            )

        with patch(
            "vision_service.video_copy_match.verify_candidate", side_effect=verified_window
        ) as verifier:
            result = compare(query, reference, candidates=CandidateList([proposed]))

        self.assertIsNotNone(result)
        attempted = [call.args[2] for call in verifier.call_args_list]
        self.assertLessEqual(max(window["end"] for window in attempted), 1_025.0)
        self.assertGreaterEqual(min(window["start"] for window in attempted), 985.0)

    def test_weak_speed_hypothesis_cannot_poison_verified_identity_match(self):
        query, reference = index(1, 10.0), index(2, 20.0)
        query["times"] = np.arange(10.0)
        common = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "offset": 5.0,
        }
        candidates = CandidateList(
            [
                {**common, "speed": 1.248, "score": 500.0},
                {**common, "speed": 1.0, "score": 100.0},
            ]
        )

        with patch(
            "vision_service.video_copy_match.verify_candidate",
            return_value=segment(a_end=9.0, b_start=5.0, b_end=14.0),
        ) as verifier:
            result = compare(query, reference, candidates=candidates)

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(verifier.call_count, 1)
        self.assertEqual(verifier.call_args.args[2]["speed"], 1.0)

    def test_verification_budget_grows_to_relevance_target(self):
        query, reference = index(1, 4_000.0), index(2, 5_000.0)
        query["times"] = np.arange(4_000.0)
        proposed = {
            "query_indices": np.arange(4_000),
            "start": 0.0,
            "end": 3_999.0,
            "speed": 1.0,
            "offset": 5.0,
            "score": 100.0,
        }
        diagnostics = {"candidate_limited_pairs": 0}

        with patch(
            "vision_service.video_copy_match.verify_candidate", return_value=None
        ) as verifier:
            result = compare(
                query,
                reference,
                diagnostics=diagnostics,
                candidates=CandidateList([proposed]),
            )

        self.assertIsNone(result)
        self.assertGreater(verifier.call_count, 13)
        self.assertLess(verifier.call_count, MAX_VERIFICATION_WINDOWS)
        self.assertEqual(diagnostics["verification_limited_pairs"], 1)
        self.assertEqual(diagnostics["candidate_limited_pairs"], 1)

    def test_verification_budget_has_an_explicit_hard_limit(self):
        query, reference = index(1, 40_000.0), index(2, 50_000.0)
        query["times"] = np.arange(40_000.0)
        proposed = {
            "query_indices": np.arange(40_000),
            "start": 0.0,
            "end": 39_999.0,
            "speed": 1.0,
            "offset": 5.0,
            "score": 100.0,
        }
        diagnostics = {"candidate_limited_pairs": 0}

        with patch(
            "vision_service.video_copy_match.verify_candidate", return_value=None
        ) as verifier:
            result = compare(
                query,
                reference,
                diagnostics=diagnostics,
                candidates=CandidateList([proposed]),
            )

        self.assertIsNone(result)
        self.assertEqual(verifier.call_count, MAX_VERIFICATION_WINDOWS)
        self.assertEqual(diagnostics["verification_limited_pairs"], 1)


if __name__ == "__main__":
    unittest.main()
