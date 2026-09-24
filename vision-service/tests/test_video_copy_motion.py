"""The temporal gate proves shared evolution instead of a shared background."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

from vision_service.video_copy_match import _temporal_evolution, verify_candidate


class MotionEvidenceTests(unittest.TestCase):
    def _verify_sequence(self, query_frames, reference_frames):
        frame_count = len(query_frames)
        query = {
            "video": {"id": 1, "path": "q", "duration_seconds": 10},
            "times": np.arange(float(frame_count)),
        }
        reference = {"video": {"id": 2, "path": "r", "duration_seconds": 20}}
        candidate = {
            "query_indices": np.arange(frame_count),
            "start": 0.0,
            "end": float(frame_count - 1),
            "speed": 1.0,
            "offset": 4.0,
        }

        def fake_extract(path, start, duration, **kwargs):
            frames = query_frames if path == "q" else reference_frames
            offset = 0.0 if path == "q" else 4.0
            for index, frame in enumerate(frames):
                yield offset + float(index), frame

        accepted = {
            "accepted": True,
            "inliers": 80,
            "pixel_error": 0.01,
            "gradient_similarity": 0.95,
            "transform": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        }
        with (
            patch("vision_service.video_copy_match.extract", fake_extract),
            patch("vision_service.video_copy_match.verify", return_value=accepted),
        ):
            return verify_candidate(query, reference, candidate)

    def _verify_with_failed_query_frames(
        self, failed: set[int], fixed_transform_accepted: bool = False
    ):
        background = np.full((512, 512, 3), 70, dtype=np.uint8)
        frames = []
        for index in range(10):
            frame = background.copy()
            cv2.rectangle(
                frame,
                (30 + index * 25, 190),
                (120 + index * 25, 280),
                (220, 220, 220),
                -1,
            )
            frame[0, 0] = index
            frames.append(frame)
        attempted = []

        def fake_extract(path, start, duration, **kwargs):
            offset = 0.0 if path == "q" else 4.0
            for index, frame in enumerate(frames):
                yield offset + float(index), frame

        def fake_prepare(frame):
            marker = frame[0, 0] if frame.ndim == 2 else frame[0, 0, 0]
            gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
            return SimpleNamespace(
                query_index=int(marker),
                gray=gray,
                support=np.ones((512, 512), dtype=np.uint8),
            )

        accepted = {
            "accepted": True,
            "inliers": 80,
            "pixel_error": 0.01,
            "gradient_similarity": 0.95,
            "transform": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        }

        def fake_verify(query_features, _reference_features):
            attempted.append(query_features.query_index)
            return {"accepted": False} if query_features.query_index in failed else accepted

        query = {
            "video": {"id": 1, "path": "q", "duration_seconds": 10},
            "times": np.arange(10.0),
        }
        reference = {"video": {"id": 2, "path": "r", "duration_seconds": 20}}
        candidate = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 4.0,
        }
        fixed_attempts = []

        def fake_verify_transform(*_args):
            fixed_attempts.append(True)
            return accepted if fixed_transform_accepted else {"accepted": False}

        with (
            patch("vision_service.video_copy_match.extract", fake_extract),
            patch("vision_service.video_copy_match.prepare", fake_prepare),
            patch("vision_service.video_copy_match.verify", fake_verify),
            patch(
                "vision_service.video_copy_match.verify_transform",
                side_effect=fake_verify_transform,
            ),
        ):
            result = verify_candidate(query, reference, candidate)
        return result, attempted, fixed_attempts

    def _verify_with_seed_transform(self, query_frames, reference_frames):
        def fake_extract(path, start, duration, **kwargs):
            frames = query_frames if path == "q" else reference_frames
            offset = 0.0 if path == "q" else 4.0
            for index, frame in enumerate(frames):
                yield offset + float(index), frame

        fixed = {
            "accepted": True,
            "inliers": 0,
            "pixel_error": 0.01,
            "gradient_similarity": 0.95,
            "transform": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        }
        query = {
            "video": {"id": 1, "path": "q", "duration_seconds": 10},
            "times": np.arange(10.0),
        }
        reference = {"video": {"id": 2, "path": "r", "duration_seconds": 20}}
        candidate = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 4.0,
            "_seed_transform": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            "_seed_inliers": 64,
        }
        with (
            patch("vision_service.video_copy_match.extract", fake_extract),
            patch(
                "vision_service.video_copy_match.verify", return_value={"accepted": False}
            ) as sift,
            patch("vision_service.video_copy_match.verify_transform", return_value=fixed),
        ):
            result = verify_candidate(query, reference, candidate)
        return result, sift.call_count

    def test_static_visual_correspondence_abstains_before_spatial_work(self):
        rng = np.random.default_rng(4)
        image = rng.integers(0, 255, (512, 512, 3), dtype=np.uint8)
        frames = [image.copy() for _ in range(10)]
        result = self._verify_sequence(frames, frames)

        self.assertIsNone(result)

    def test_matching_dynamic_pixels_verify_shared_recording(self):
        rng = np.random.default_rng(14)
        background = rng.integers(20, 180, (512, 512, 3), dtype=np.uint8)
        query_frames = []
        for index in range(10):
            frame = background.copy()
            cv2.rectangle(frame, (35 + index * 24, 185), (125 + index * 24, 285), (245, 30, 80), -1)
            query_frames.append(frame)
        reference_frames = [frame.copy() for frame in query_frames]

        result = self._verify_sequence(query_frames, reference_frames)

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "verified", result)
        self.assertGreaterEqual(result["temporal_informative_transitions"], 4)
        self.assertGreater(result["temporal_motion_overlap"], 0.9)

    def test_proven_crop_transform_carries_low_texture_extension(self):
        background = np.full((512, 512, 3), 65, dtype=np.uint8)
        frames = []
        for index in range(10):
            frame = background.copy()
            cv2.rectangle(
                frame,
                (45 + index * 28, 180),
                (135 + index * 28, 290),
                (235, 45, 90),
                -1,
            )
            frames.append(frame)

        result, sift_calls = self._verify_with_seed_transform(frames, frames)

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "verified", result)
        self.assertEqual(result["matched_frames"], 10)
        self.assertLessEqual(sift_calls, 5)

    def test_wrong_seed_transform_cannot_verify_different_motion(self):
        background = np.full((512, 512, 3), 65, dtype=np.uint8)
        query_frames, reference_frames = [], []
        for index in range(10):
            query = background.copy()
            reference = background.copy()
            cv2.rectangle(
                query,
                (35 + index * 25, 180),
                (125 + index * 25, 280),
                (235, 45, 90),
                -1,
            )
            cv2.rectangle(
                reference,
                (315, 35 + index * 25),
                (405, 135 + index * 25),
                (235, 45, 90),
                -1,
            )
            query_frames.append(query)
            reference_frames.append(reference)

        result, _sift_calls = self._verify_with_seed_transform(
            query_frames, reference_frames
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "ambiguous", result)
        self.assertLess(result["temporal_motion_overlap"], 0.4)

    def test_fixed_transform_selects_best_subframe_phase_for_temporal_evolution(self):
        rng = np.random.default_rng(31)
        background = rng.integers(20, 150, (512, 512, 3), dtype=np.uint8)
        query_frames = []
        for index in range(10):
            frame = background.copy()
            cv2.rectangle(
                frame,
                (35 + index * 27, 180),
                (125 + index * 27, 285),
                (235, 45, 90),
                -1,
            )
            query_frames.append(frame)

        def fake_extract(path, start, duration, **kwargs):
            end = start + duration
            if path == "q":
                for index, frame in enumerate(query_frames):
                    if start <= index < end:
                        yield float(index), frame
                return
            for index, frame in enumerate(query_frames):
                for phase in (-0.4, -0.2, 0.0, 0.2, 0.4):
                    timestamp = 4.0 + index + phase
                    if start <= timestamp < end:
                        shifted = frame if phase == 0.4 else np.roll(frame, 18, axis=1)
                        yield timestamp, shifted

        query = {
            "video": {"id": 1, "path": "q", "duration_seconds": 10},
            "times": np.arange(10.0),
        }
        reference = {"video": {"id": 2, "path": "r", "duration_seconds": 20}}
        candidate = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 4.0,
            "_seed_transform": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            "_seed_inliers": 64,
        }
        with (
            patch("vision_service.video_copy_match.extract", fake_extract),
            patch("vision_service.video_copy_match.verify", return_value={"accepted": False}),
        ):
            result = verify_candidate(query, reference, candidate)

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "verified", result)
        self.assertAlmostEqual(result["_temporal_offset"], 4.4, places=3)
        self.assertGreater(result["temporal_motion_similarity"], 0.9)

    def test_nine_samples_support_at_least_eighty_five_percent_of_ten_second_clip(self):
        rng = np.random.default_rng(19)
        background = rng.integers(20, 180, (512, 512, 3), dtype=np.uint8)
        frames = []
        for index in range(9):
            frame = background.copy()
            cv2.circle(frame, (70 + index * 32, 230), 52, (235, 45, 90), -1)
            frames.append(frame)

        result = self._verify_sequence(frames, [frame.copy() for frame in frames])

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "verified", result)
        self.assertGreaterEqual((result["a_end"] - result["a_start"]) / 10.0, 0.85)

    def test_same_room_with_different_evolution_is_ambiguous(self):
        rng = np.random.default_rng(23)
        background = rng.integers(20, 180, (512, 512, 3), dtype=np.uint8)
        query_frames, reference_frames = [], []
        for index in range(10):
            query_frame = background.copy()
            reference_frame = background.copy()
            cv2.rectangle(
                query_frame,
                (35 + index * 24, 185),
                (125 + index * 24, 285),
                (245, 30, 80),
                -1,
            )
            cv2.rectangle(
                reference_frame,
                (320, 30 + index * 24),
                (410, 130 + index * 24),
                (245, 30, 80),
                -1,
            )
            query_frames.append(query_frame)
            reference_frames.append(reference_frame)

        result = self._verify_sequence(query_frames, reference_frames)

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "ambiguous", result)
        self.assertLess(result["temporal_motion_overlap"], 0.4)

    def test_shared_lower_third_cannot_prove_different_studio_action(self):
        rng = np.random.default_rng(20260921)
        background = rng.integers(20, 160, (512, 512, 3), dtype=np.uint8)
        background = cv2.GaussianBlur(background, (5, 5), 0)
        for lower_third_top in (450, 240):
            query_frames, reference_frames = [], []
            for index in range(10):
                query = background.copy()
                reference = background.copy()
                cv2.rectangle(
                    query,
                    (80 + index * 10, 170),
                    (120 + index * 10, 210),
                    (240, 30, 60),
                    -1,
                )
                cv2.rectangle(
                    reference,
                    (330, 80 + index * 10),
                    (370, 120 + index * 10),
                    (30, 220, 80),
                    -1,
                )
                lower_third_x = 20 + (index % 3) * 55
                for frame in (query, reference):
                    cv2.rectangle(
                        frame,
                        (lower_third_x, lower_third_top),
                        (lower_third_x + 90, lower_third_top + 35),
                        (245, 245, 245),
                        -1,
                    )
                query_frames.append(query)
                reference_frames.append(reference)

            different_action = self._verify_real_sequence(
                query_frames, reference_frames
            )
            shared_recording = self._verify_real_sequence(query_frames, query_frames)

            with self.subTest(lower_third_top=lower_third_top):
                self.assertIsNotNone(different_action)
                self.assertEqual(
                    different_action["status"], "ambiguous", different_action
                )
                self.assertLess(different_action["temporal_motion_span_y"], 0.20)
                self.assertIsNotNone(shared_recording)
                self.assertEqual(shared_recording["status"], "verified", shared_recording)

    def test_motion_grid_is_normalized_to_narrow_shared_crop_support(self):
        support = np.zeros((128, 128), dtype=bool)
        support[:, 48:80] = True
        evidence = []
        for index in range(10):
            frame = np.zeros((128, 128), dtype=np.float32)
            left = 50 + (index % 4) * 6
            top = 10 + index * 9
            cv2.rectangle(frame, (left, top), (left + 9, top + 20), 220, -1)
            evidence.append(
                {
                    "q": float(index),
                    "r": 4.0 + index,
                    "query_gray": frame,
                    "reference_gray": frame.copy(),
                    "support": support,
                }
            )

        evolution = _temporal_evolution(evidence)

        self.assertTrue(evolution["confirmed"], evolution)
        self.assertGreaterEqual(evolution["grid_rows"], 2)
        self.assertGreaterEqual(evolution["grid_columns"], 2)
        self.assertGreaterEqual(evolution["span_x"], 0.20)
        self.assertGreaterEqual(evolution["span_y"], 0.20)

    def test_doomed_window_stops_geometry_after_required_evidence_is_impossible(self):
        result, attempted, _fixed = self._verify_with_failed_query_frames({0, 1})

        self.assertIsNone(result)
        self.assertEqual(set(attempted), {0, 1})

    def test_borderline_window_can_use_every_remaining_frame(self):
        result, attempted, _fixed = self._verify_with_failed_query_frames({0})

        self.assertIsNotNone(result)
        self.assertEqual(result["matched_frames"], 9)
        self.assertIn(9, attempted)

    def test_missing_interior_frame_cannot_be_bridged_into_continuous_evidence(self):
        result, attempted, _fixed = self._verify_with_failed_query_frames({5})

        self.assertIsNone(result)
        self.assertIn(9, attempted)

    def test_single_geometric_anchor_cannot_bootstrap_fixed_transform(self):
        result, attempted, fixed_attempts = self._verify_with_failed_query_frames(
            set(range(1, 10)), fixed_transform_accepted=True
        )

        self.assertIsNone(result)
        self.assertEqual(set(attempted), {0, 1, 2})
        self.assertEqual(fixed_attempts, [])

    def _verify_real_sequence(self, query_frames, reference_frames):
        query = {
            "video": {"id": 1, "path": "q", "duration_seconds": 10},
            "times": np.arange(10.0),
        }
        reference = {"video": {"id": 2, "path": "r", "duration_seconds": 20}}
        candidate = {
            "query_indices": np.arange(10),
            "start": 0.0,
            "end": 9.0,
            "speed": 1.0,
            "offset": 4.0,
        }

        def fake_extract(path, start, duration, **_kwargs):
            frames = query_frames if path == "q" else reference_frames
            offset = 0.0 if path == "q" else 4.0
            for index, frame in enumerate(frames):
                timestamp = offset + float(index)
                if start <= timestamp < start + duration:
                    yield timestamp, frame

        with patch("vision_service.video_copy_match.extract", fake_extract):
            return verify_candidate(query, reference, candidate)


if __name__ == "__main__":
    cv2.setNumThreads(2)
    unittest.main()
