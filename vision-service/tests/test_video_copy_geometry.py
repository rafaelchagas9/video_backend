from __future__ import annotations

import unittest

import cv2
import numpy as np

from vision_service.video_copy_geometry import prepare, verify


def textured_frame(seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    image = rng.integers(15, 85, size=(512, 512, 3), dtype=np.uint8)
    image = cv2.GaussianBlur(image, (5, 5), 0)
    for index in range(42):
        color = tuple(int(value) for value in rng.integers(70, 245, size=3))
        center = tuple(int(value) for value in rng.integers(25, 487, size=2))
        radius = int(rng.integers(5, 24))
        cv2.circle(image, center, radius, color, 2 if index % 3 else -1)
    for index in range(18):
        start = tuple(int(value) for value in rng.integers(0, 512, size=2))
        end = tuple(int(value) for value in rng.integers(0, 512, size=2))
        color = tuple(int(value) for value in rng.integers(90, 255, size=3))
        cv2.line(image, start, end, color, 2)
    cv2.putText(image, "KURA 2026", (105, 265), cv2.FONT_HERSHEY_DUPLEX, 1.2, (245, 230, 30), 3)
    return image


def jpeg_round_trip(image: np.ndarray, quality: int = 48) -> np.ndarray:
    ok, encoded = cv2.imencode(
        ".jpg",
        cv2.cvtColor(image, cv2.COLOR_RGB2BGR),
        [cv2.IMWRITE_JPEG_QUALITY, quality],
    )
    if not ok:
        raise AssertionError("JPEG encoding failed")
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    return cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)


def letterbox(image: np.ndarray, width: int = 512, height: int = 512) -> np.ndarray:
    source_height, source_width = image.shape[:2]
    scale = min(width / source_width, height / source_height)
    resized_width = max(1, int(round(source_width * scale)))
    resized_height = max(1, int(round(source_height * scale)))
    resized = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    output = np.zeros((height, width, 3), dtype=np.uint8)
    left = (width - resized_width) // 2
    top = (height - resized_height) // 2
    output[top : top + resized_height, left : left + resized_width] = resized
    return output


class VideoCopyGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.reference = textured_frame()
        cls.reference_features = prepare(cls.reference)

    def test_accepts_horizontal_crop_rescale_and_compression(self) -> None:
        cropped = self.reference[:, 77:435]
        query = cv2.resize(cropped, (512, 512), interpolation=cv2.INTER_AREA)
        result = verify(prepare(jpeg_round_trip(query)), self.reference_features)

        self.assertTrue(result["accepted"], result)
        self.assertGreaterEqual(result["inliers"], 12)
        self.assertGreater(result["query_coverage"], 0.10)
        self.assertGreater(result["reference_coverage"], 0.065)

    def test_accepts_offset_crop_with_small_overlay(self) -> None:
        cropped = self.reference[36:476, 44:452]
        query = cv2.resize(cropped, (512, 512), interpolation=cv2.INTER_LINEAR)
        cv2.rectangle(query, (15, 435), (250, 490), (245, 245, 245), -1)
        cv2.putText(query, "LIVE", (35, 475), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (10, 10, 10), 2)
        result = verify(prepare(jpeg_round_trip(query, quality=55)), self.reference_features)

        self.assertTrue(result["accepted"], result)

    def test_accepts_fixed_width_and_height_crop_with_aspect_preserved(self) -> None:
        wide_scene = cv2.resize(self.reference, (910, 512), interpolation=cv2.INTER_LINEAR)
        reference = letterbox(wide_scene)
        cropped = wide_scene[72:452, 205:735]
        query = jpeg_round_trip(letterbox(cropped), quality=55)

        result = verify(prepare(query), prepare(reference))

        self.assertTrue(result["accepted"], result)
        self.assertLess(result["anisotropy"], 1.08)
        self.assertGreater(result["mapped_overlap"], 0.08)

    def test_accepts_vertical_recrop_retaining_thirty_two_percent_width(self) -> None:
        # A 16:9 source cropped to 9:16 retains 31.64% of its width.  Padding
        # both decoded frames preserves geometry, so the remaining transform is
        # an ordinary isotropic scale plus translation.
        wide_scene = cv2.resize(self.reference, (910, 512), interpolation=cv2.INTER_LINEAR)
        reference = letterbox(wide_scene)
        retained_width = 288
        left = (wide_scene.shape[1] - retained_width) // 2
        vertical_crop = wide_scene[:, left : left + retained_width]
        query = jpeg_round_trip(letterbox(vertical_crop), quality=55)

        result = verify(prepare(query), prepare(reference))

        self.assertTrue(result["accepted"], result)
        self.assertLess(result["anisotropy"], 1.05)
        self.assertGreater(result["reference_coverage"], 0.065)

    def test_accepts_moving_severe_crop_across_frame_width(self) -> None:
        wide_scene = cv2.resize(self.reference, (910, 512), interpolation=cv2.INTER_LINEAR)
        reference_features = prepare(letterbox(wide_scene))
        retained_width = 273

        for left in (45, 318, 592):
            with self.subTest(left=left):
                vertical_crop = wide_scene[:, left : left + retained_width]
                query = jpeg_round_trip(letterbox(vertical_crop), quality=55)

                result = verify(prepare(query), reference_features)

                self.assertTrue(result["accepted"], result)
                self.assertGreater(result["reference_coverage"], 0.065)

    def test_accepts_edge_crop_inside_one_global_reference_grid_column(self) -> None:
        wide_scene = cv2.resize(self.reference, (910, 512), interpolation=cv2.INTER_LINEAR)
        reference_features = prepare(letterbox(wide_scene))
        # This crop maps to x=0..102 in the 512 reference: entirely inside the
        # first 128-pixel column of the old global 4x4 grid.
        edge_crop = wide_scene[:, :182]
        query = jpeg_round_trip(letterbox(edge_crop), quality=55)

        result = verify(prepare(query), reference_features)

        self.assertTrue(result["accepted"], result)
        self.assertLess(result["reference_coverage"], 0.065)
        self.assertGreater(result["reference_coverage_normalized"], 0.16)
        self.assertGreater(result["mapped_overlap"], 0.08)

    def test_severe_crop_with_square_distortion_is_rejected(self) -> None:
        # This captures an extraction contract: independently stretching the
        # full 16:9 source and its 9:16 crop to squares creates >3x anisotropy.
        # SIFT loses the correspondences before an affine threshold can help.
        retained_width = int(round(self.reference.shape[1] * 0.30))
        left = (self.reference.shape[1] - retained_width) // 2
        distorted = cv2.resize(
            self.reference[:, left : left + retained_width],
            (512, 512),
            interpolation=cv2.INTER_LINEAR,
        )

        result = verify(prepare(jpeg_round_trip(distorted, quality=55)), self.reference_features)

        self.assertFalse(result["accepted"], result)
        self.assertLess(result.get("matches", 0), 12)

    def test_rejects_unrelated_textured_frame(self) -> None:
        result = verify(prepare(textured_frame(seed=99)), self.reference_features)

        self.assertFalse(result["accepted"], result)

    def test_rejects_repeated_texture_false_alignment(self) -> None:
        checker = np.indices((512, 512)).sum(axis=0) // 16 % 2
        first = np.repeat((checker * 255).astype(np.uint8)[..., None], 3, axis=2)
        second_checker = (np.indices((512, 512))[0] // 13 + np.indices((512, 512))[1] // 19) % 2
        second = np.repeat((second_checker * 255).astype(np.uint8)[..., None], 3, axis=2)

        result = verify(prepare(second), prepare(first))

        self.assertFalse(result["accepted"], result)

    def test_rejects_same_background_when_large_foreground_changes(self) -> None:
        changed = self.reference.copy()
        cv2.rectangle(changed, (115, 85), (430, 430), (5, 245, 210), -1)
        for row in range(110, 420, 30):
            cv2.line(changed, (130, row), (415, row + 15), (230, 15, 50), 6)

        result = verify(prepare(changed), self.reference_features)

        self.assertFalse(result["accepted"], result)
        self.assertGreater(result.get("changed_fraction", 0.0), 0.36)

    def test_rejects_different_frames_that_share_only_a_local_logo(self) -> None:
        first = textured_frame(seed=31)
        second = textured_frame(seed=63)
        logo = np.zeros((110, 150, 3), dtype=np.uint8)
        cv2.rectangle(logo, (4, 4), (145, 105), (245, 245, 245), 4)
        cv2.putText(logo, "KURA", (14, 72), cv2.FONT_HERSHEY_DUPLEX, 1.4, (25, 25, 25), 3)
        first[18:128, 18:168] = logo
        second[18:128, 18:168] = logo

        result = verify(prepare(second), prepare(first))

        self.assertFalse(result["accepted"], result)

    def test_rejects_featureless_frames_without_throwing(self) -> None:
        black = np.zeros((512, 512, 3), dtype=np.uint8)
        result = verify(prepare(black), prepare(black))

        self.assertFalse(result["accepted"])
        self.assertEqual(result["inliers"], 0)

    def test_prepare_validates_shape(self) -> None:
        with self.assertRaises(ValueError):
            prepare(np.zeros((12, 12, 3), dtype=np.uint8))


if __name__ == "__main__":
    unittest.main()
