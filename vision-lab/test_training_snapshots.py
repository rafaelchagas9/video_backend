"""Synthetic Bun/Python contract checks; never contacts PostgreSQL or reads source media."""
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from training_snapshots import frames, manifests


class TrainingSnapshotsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="training-snapshot-interop-")
        cls.fixture_root = Path(cls.fixture.name)
        script = r'''
            import { RecordingTrainingSnapshots } from "./src/modules/recordings/recordings.snapshots.ts";
            const archive = new RecordingTrainingSnapshots(process.argv[1]);
            const source = { videoId: 1, fileName: "synthetic.mkv", fileHash: "synthetic", fileSizeBytes: 100,
                durationSeconds: 10, width: 456, height: 256, codec: "h264", audioCodec: "aac", fps: 30, channel: "synthetic" };
            const index = { modelRevision: "synthetic-model", storyboardGeneratedAt: "2026-10-08T00:00:00Z",
                indexedAt: "2026-10-08T00:01:00Z", intervalSeconds: 5, frameCount: 2 };
            await archive.save({ source, analyzedAt: "2026-10-08T00:02:00Z", detectorRevision: "synthetic-probe",
                status: "proposed", event: "save", curve: [], clips: [
                    { id: "c1", start_seconds: 0, end_seconds: 5, peak_seconds: 2, keep: true, score: 0.9,
                      label: "synthetic", detected: { start_seconds: 0, end_seconds: 5 }, reasons: ["keep_clear"], output_video_id: 11 },
                    { id: "c2", start_seconds: 5, end_seconds: 10, peak_seconds: 7, keep: false, score: 0.6, label: "synthetic" }
                ] }, index, async () => ({ timestamps: [0, 5.000000123],
                    vectors: [new Float32Array(1152).fill(0.125), new Float32Array(1152).fill(-0.5)] }));
        '''
        subprocess.run(["bun", "-e", script, str(cls.fixture_root)],
                       cwd=Path(__file__).resolve().parent.parent, check=True, capture_output=True)
        cls.manifest = manifests(1, cls.fixture_root)[0]
        cls.payload = (cls.fixture_root / "1" / cls.manifest["features"]["file"]).read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="training-snapshot-reader-")
        self.root = Path(self.scratch.name)
        directory = self.root / "1"
        directory.mkdir()
        self.manifest_path = directory / "review-1.json"
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.feature_path = directory / self.manifest["features"]["file"]
        self.feature_path.write_bytes(self.payload)

    def tearDown(self):
        self.scratch.cleanup()

    def test_bun_snapshot_is_readable_without_database_or_original(self):
        review = manifests(1, self.root)[0]
        timestamps, vectors = frames(review, self.root)
        np.testing.assert_array_equal(timestamps, [0, 5.000000123])
        self.assertEqual(vectors.shape, (2, 1152))
        np.testing.assert_array_equal(vectors[0], np.full(1152, 0.125, dtype=np.float32))
        np.testing.assert_array_equal(vectors[1], np.full(1152, -0.5, dtype=np.float32))
        self.assertEqual([clip["keep"] for clip in review["clips"]], [True, False])
        self.assertEqual(review["clips"][0]["output_video_id"], 11)

    def test_corrupted_or_missing_features_fail_explicitly(self):
        changed = bytearray(self.payload)
        changed[-1] ^= 1
        self.feature_path.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "checksum"):
            frames(self.manifest, self.root)
        self.feature_path.unlink()
        with self.assertRaises(FileNotFoundError):
            frames(self.manifest, self.root)

    def test_wrong_identity_or_counts_are_not_silently_used(self):
        wrong = json.loads(json.dumps(self.manifest))
        wrong["features"]["identity"] = "wrong"
        with self.assertRaisesRegex(ValueError, "identity"):
            frames(wrong, self.root)
        wrong = json.loads(json.dumps(self.manifest))
        wrong["features"]["index"]["frameCount"] = 3
        with self.assertRaisesRegex(ValueError, "identity"):
            frames(wrong, self.root)
        wrong = json.loads(json.dumps(self.manifest))
        truncated = self.payload[:-4]
        self.feature_path.write_bytes(truncated)
        wrong["features"]["bytes"] = len(truncated)
        wrong["features"]["sha256"] = hashlib.sha256(truncated).hexdigest()
        with self.assertRaisesRegex(ValueError, "frame count"):
            frames(wrong, self.root)

    def test_path_traversal_and_wrong_recording_are_rejected(self):
        wrong = json.loads(json.dumps(self.manifest))
        wrong["features"]["file"] = "../features-other.bin"
        with self.assertRaisesRegex(ValueError, "path"):
            frames(wrong, self.root)
        wrong = json.loads(json.dumps(self.manifest))
        wrong["source"]["videoId"] = 2
        self.manifest_path.write_text(json.dumps(wrong))
        with self.assertRaisesRegex(ValueError, "ids"):
            manifests(1, self.root)


if __name__ == "__main__":
    unittest.main()
