from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np

from vision_service.video_copy_index import index_video, LEGACY_REVISION
import hashlib
import json

IDENTITY_A = {"st_dev": 1, "st_ino": 2, "st_size": 3, "st_mtime_ns": 4, "st_ctime_ns": 5}
IDENTITY_B = {**IDENTITY_A, "st_mtime_ns": 6, "st_ctime_ns": 7}


class FakeModel:
    batch_size = 8
    digest = "model-a"

    def __init__(self):
        self.batch_lengths = []

    def embed(self, frames):
        self.batch_lengths.append(len(frames))
        result = np.zeros((len(frames), 512), dtype=np.float32)
        result[:, 0] = 1.0
        return result


def frame(value: int = 1) -> np.ndarray:
    return np.full((288, 288, 3), value, dtype=np.uint8)


def one_frame_extract(path, start, duration):
    del path, duration
    yield start, frame(int(start) % 255)


class VideoCopyIndexTests(unittest.TestCase):
    def setUp(self):
        self.video = {
            "id": "video-a",
            "path": "/media/video-a.mp4",
            "duration_seconds": 2.0,
        }
        self.model = FakeModel()

    def test_source_identity_change_uses_a_new_cache_key(self):
        current = {"value": IDENTITY_A}
        with (
            TemporaryDirectory() as directory,
            patch(
                "vision_service.video_copy_index.source_identity",
                side_effect=lambda path: current["value"],
            ),
            patch(
                "vision_service.video_copy_index.extract", side_effect=one_frame_extract
            ) as extract_mock,
        ):
            cache = Path(directory)
            first = index_video(self.video, self.model, cache)
            cached = index_video(self.video, self.model, cache)
            self.assertEqual(extract_mock.call_count, 1)
            current["value"] = IDENTITY_B
            second = index_video(self.video, self.model, cache)

            self.assertEqual(extract_mock.call_count, 2)
            self.assertEqual(first["identity"], IDENTITY_A)
            self.assertEqual(cached["identity"], IDENTITY_A)
            self.assertEqual(second["identity"], IDENTITY_B)
            self.assertEqual(len(list((cache / "indexes").glob("*/*.npz"))), 2)

    def test_reuses_legacy_horizontal_vectors_but_adds_height_views_in_new_generation(self):
        with (TemporaryDirectory() as directory,
              patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
              patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract)):
            cache = Path(directory)
            key = hashlib.sha256(json.dumps({
                "source": IDENTITY_A, "model": self.model.digest, "revision": LEGACY_REVISION,
                "start": 0.0, "duration": 2.0,
            }, sort_keys=True).encode()).hexdigest()
            old = cache / "indexes" / key / "0.000000.npz"
            old.parent.mkdir(parents=True)
            views = np.zeros((1, 6, 512), dtype=np.float32)
            views[:, :, 2] = 1
            np.savez_compressed(old, times=np.array([0.0]), views=views)
            before = old.read_bytes()
            result = index_video(self.video, self.model, cache)
            np.testing.assert_array_equal(result["views"][:, :6], views)
            self.assertEqual(result["views"].shape, (1, 11, 512))
            self.assertEqual(self.model.batch_lengths, [5])
            self.assertNotEqual(result["cache_key"], key)
            self.assertEqual(old.read_bytes(), before)

    def test_fp16_storage_has_bounded_loss_and_identical_cold_warm_results(self):
        original = []
        def embed(frames):
            vectors = np.random.default_rng(42).normal(size=(len(frames), 512)).astype(np.float32)
            vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
            original.append(vectors.copy())
            return vectors
        with (TemporaryDirectory() as directory,
              patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
              patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract),
              patch.object(self.model, "embed", side_effect=embed)):
            cache = Path(directory)
            cold = index_video(self.video, self.model, cache)
            warm = index_video(self.video, self.model, cache)
            np.testing.assert_array_equal(cold["views"], warm["views"])
            actual = cold["views"].reshape(-1, 512)
            cosine = np.sum(actual * np.concatenate(original), axis=1)
            self.assertTrue(np.all(cosine > 0.999999))
            with np.load(next((cache / "indexes").glob("*/*.npz"))) as saved:
                self.assertEqual(saved["views"].dtype, np.float16)
                self.assertNotIn("vectors", saved.files)

    def test_source_change_during_index_does_not_publish_chunk(self):
        identities = iter((IDENTITY_A, IDENTITY_B))
        with (
            TemporaryDirectory() as directory,
            patch(
                "vision_service.video_copy_index.source_identity",
                side_effect=lambda path: next(identities),
            ),
            patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract),
        ):
            cache = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "changed during"):
                index_video(self.video, self.model, cache)

            self.assertEqual(list((cache / "indexes").glob("*/*.npz")), [])

    def test_corrupt_cache_is_removed_and_requires_retry(self):
        with (
            TemporaryDirectory() as directory,
            patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
            patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract),
        ):
            cache = Path(directory)
            index_video(self.video, self.model, cache)
            target = next((cache / "indexes").glob("*/*.npz"))
            target.write_bytes(b"not an npz archive")

            with self.assertRaisesRegex(RuntimeError, "Corrupt copy index removed"):
                index_video(self.video, self.model, cache)

            self.assertFalse(target.exists())

    def test_truncated_zip_cache_is_removed_and_requires_retry(self):
        with (
            TemporaryDirectory() as directory,
            patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
            patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract),
        ):
            cache = Path(directory)
            index_video(self.video, self.model, cache)
            target = next((cache / "indexes").glob("*/*.npz"))
            target.write_bytes(b"PK\x03\x04" + bytes(20))

            with self.assertRaisesRegex(RuntimeError, "COPY_CACHE_CORRUPT"):
                index_video(self.video, self.model, cache)

            self.assertFalse(target.exists())

    def test_failed_compressed_write_leaves_no_partial_or_published_chunk(self):
        with (
            TemporaryDirectory() as directory,
            patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
            patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract),
            patch(
                "vision_service.video_copy_index.np.savez_compressed",
                side_effect=OSError("simulated write failure"),
            ),
        ):
            cache = Path(directory)
            with self.assertRaisesRegex(OSError, "simulated write failure"):
                index_video(self.video, self.model, cache)

            self.assertEqual(list((cache / "indexes").glob("*/.chunk-*.tmp")), [])
            self.assertEqual(list((cache / "indexes").glob("*/*.npz")), [])

    def test_malformed_cache_dimensions_are_removed(self):
        with (
            TemporaryDirectory() as directory,
            patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
            patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract),
        ):
            cache = Path(directory)
            index_video(self.video, self.model, cache)
            target = next((cache / "indexes").glob("*/*.npz"))
            np.savez_compressed(
                target,
                times=np.array([0.0]),
                vectors=np.zeros((1, 511), dtype=np.float32),
                thumbnails=np.zeros((1, 16, 16), dtype=np.uint8),
                views=np.zeros((1, 6, 512), dtype=np.float32),
            )

            with self.assertRaisesRegex(RuntimeError, "Corrupt copy index removed"):
                index_video(self.video, self.model, cache)

            self.assertFalse(target.exists())

    def test_cache_rejects_bad_timing_frame_budget_and_vector_norm(self):
        cases = (
            ("timestamp regression", np.array([0.0, 1.0, 0.5]), 1.0, 1.0),
            ("frame budget", np.linspace(0.0, 1.9, 6), 1.0, 1.0),
            ("vector norm", np.array([0.0]), 2.0, 1.0),
            ("view norm", np.array([0.0]), 1.0, 2.0),
        )
        for label, times, vector_norm, view_norm in cases:
            with (
                self.subTest(label=label),
                TemporaryDirectory() as directory,
                patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
                patch("vision_service.video_copy_index.extract", side_effect=one_frame_extract),
            ):
                cache = Path(directory)
                index_video(self.video, self.model, cache)
                target = next((cache / "indexes").glob("*/*.npz"))
                vectors = np.zeros((len(times), 512), dtype=np.float32)
                vectors[:, 0] = vector_norm
                views = np.zeros((len(times), 6, 512), dtype=np.float32)
                views[:, :, 0] = view_norm
                np.savez_compressed(
                    target,
                    times=times,
                    vectors=vectors,
                    thumbnails=np.zeros((len(times), 16, 16), dtype=np.uint8),
                    views=views,
                )

                with self.assertRaisesRegex(RuntimeError, "Corrupt copy index removed"):
                    index_video(self.video, self.model, cache)

                self.assertFalse(target.exists())

    def test_fractional_duration_uses_integer_chunk_count_and_exact_tail(self):
        video = {**self.video, "start_seconds": 4.5, "duration_seconds": 60.25}
        calls = []

        def extract_chunks(path, start, duration):
            calls.append((path, start, duration))
            yield start, frame(int(start) % 255)

        with (
            TemporaryDirectory() as directory,
            patch("vision_service.video_copy_index.source_identity", return_value=IDENTITY_A),
            patch("vision_service.video_copy_index.extract", side_effect=extract_chunks),
        ):
            result = index_video(video, self.model, Path(directory))

        self.assertEqual(
            calls,
            [
                (video["path"], 4.5, 60.0),
                (video["path"], 64.5, 0.25),
            ],
        )
        np.testing.assert_allclose(result["times"], np.array([0.0, 60.0]))
        self.assertEqual(result["vectors"].shape, (2, 512))
        self.assertEqual(result["views"].shape, (2, 11, 512))
        self.assertEqual(result["thumbnails"].shape, (2, 16, 16))
        self.assertEqual(self.model.batch_lengths, [8, 3, 8, 3])


if __name__ == "__main__":
    unittest.main()
