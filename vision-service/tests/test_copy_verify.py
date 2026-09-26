import unittest
from unittest.mock import patch

import cv2
import numpy as np

from vision_service import copy_verify
from vision_service.copy_verify import compare, sample_times, verify_times

FPS = 30
H, W = 360, 640


def textured_room(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = np.zeros((H, W), np.float32)
    for scale in (4, 16, 64):
        noise = rng.random((H // scale + 1, W // scale + 1)).astype(np.float32)
        img += cv2.resize(noise, (W, H), interpolation=cv2.INTER_CUBIC) * scale
    img = (img - img.min()) / (img.max() - img.min()) * 200 + 20
    # furniture-like edges and corners: real rooms register with 100+ SIFT inliers
    for _ in range(60):
        x, y = int(rng.integers(0, W - 40)), int(rng.integers(0, H - 40))
        w, h = int(rng.integers(10, 80)), int(rng.integers(10, 80))
        cv2.rectangle(img, (x, y), (x + w, y + h), float(rng.integers(0, 255)), -1)
    return img


def render(room: np.ndarray, t: float, phase: float, blob_seed: int) -> np.ndarray:
    """The shared room plus a textured 'performer' moving along a phase-dependent path."""
    frame = room.copy()
    x = int(320 + 150 * np.sin(1.3 * t + phase))
    y = int(180 + 80 * np.cos(0.9 * t + phase))
    blob = cv2.GaussianBlur(
        np.random.default_rng(blob_seed).random((90, 70)).astype(np.float32) * 255, (5, 5), 0
    )
    y0, x0 = max(0, y - 45), max(0, x - 35)
    frame[y0 : y0 + 90, x0 : x0 + 70] = blob[: min(90, H - y0), : min(70, W - x0)]
    return frame.clip(0, 255).astype(np.uint8)


class FakeSource:
    def __init__(self, room, phase=0.0, crop=None, scale=1.0, static=False, blob_seed=3):
        self.room, self.phase, self.crop, self.scale = room, phase, crop, scale
        self.static, self.blob_seed = static, blob_seed

    def frames(self, start, duration):
        out = []
        for k in range(int(round(duration * FPS))):
            f = render(
                self.room, 0.0 if self.static else start + k / FPS, self.phase, self.blob_seed
            )
            if self.crop:
                x0, y0, x1, y1 = self.crop
                f = f[y0:y1, x0:x1]
            if self.scale != 1.0:
                f = cv2.resize(f, None, fx=self.scale, fy=self.scale, interpolation=cv2.INTER_AREA)
            out.append(f)
        return np.stack(out)


class CopyVerifyTests(unittest.TestCase):
    def test_cropped_and_scaled_copy_is_the_same_footage(self):
        room = textured_room(1)
        sample = compare(
            FakeSource(room), 10.0, FakeSource(room, crop=(100, 40, 560, 340), scale=0.8), 10.0
        )
        self.assertEqual(sample.verdict, "same", sample)
        self.assertGreater(sample.motion, 0.8)
        self.assertAlmostEqual(sample.scale, 1 / 0.8, delta=0.05)

    def test_same_room_with_a_different_performance_is_different(self):
        room = textured_room(1)
        sample = compare(FakeSource(room), 10.0, FakeSource(room, phase=2.0, blob_seed=9), 10.0)
        self.assertEqual(sample.verdict, "different", sample)

    def test_unrelated_footage_under_the_same_soundtrack_is_rejected(self):
        a, b = FakeSource(textured_room(1)), FakeSource(textured_room(5), blob_seed=11)
        verdict = verify_times(a, b, [(4.0, 4.0), (8.0, 8.0), (12.0, 12.0)])
        self.assertEqual(verdict.status, "rejected")
        self.assertTrue(all(s.reason == "no_correspondence" for s in verdict.samples))

    def test_static_identical_footage_is_not_verified_without_motion(self):
        room = textured_room(2)
        a, b = FakeSource(room, static=True), FakeSource(room, static=True)
        verdict = verify_times(a, b, [(5.0, 5.0), (9.0, 9.0), (13.0, 13.0)])
        self.assertEqual(verdict.status, "ambiguous")

    def test_group_verdict_stops_once_two_moving_samples_agree(self):
        room = textured_room(1)
        with patch.object(copy_verify, "compare", wraps=copy_verify.compare) as spy:
            verdict = verify_times(
                FakeSource(room),
                FakeSource(room, crop=(0, 0, 600, 360)),
                [(t, t) for t in (4.0, 8.0, 12.0, 16.0)],
            )
        self.assertEqual(verdict.status, "verified")
        self.assertEqual(spy.call_count, 2)

    def test_sample_times_stay_inside_ranges_and_apply_offset(self):
        times = sample_times([(10.0, 40.0), (100.0, 110.0)], 5.0, 3)
        self.assertEqual(len(times), 3)
        for ta, tb in times:
            self.assertAlmostEqual(ta - tb, 5.0)
            inside_first = 11.0 <= tb <= 39.0 - copy_verify.WINDOW
            inside_second = 101.0 <= tb <= 109.0 - copy_verify.WINDOW
            self.assertTrue(inside_first or inside_second, tb)
        self.assertEqual(sample_times([(0.0, 2.0)], 0.0, 3), [])


if __name__ == "__main__":
    unittest.main()
