from __future__ import annotations

import io
import unittest
from unittest.mock import patch

import numpy as np

from vision_service.video_copy_frames import FrameSamplingGapError, extract

SIZE = 288


class FakeTimer:
    instances: list["FakeTimer"] = []

    def __init__(self, interval, function):
        self.interval = interval
        self.function = function
        self.started = False
        self.cancelled = False
        self.__class__.instances.append(self)

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True


class FakeProcess:
    def __init__(self, timestamps: list[float], *, frames: int | None = None, exit_code: int = 0):
        frame_count = len(timestamps) if frames is None else frames
        image = np.zeros((SIZE, SIZE, 3), dtype=np.uint8).tobytes()
        self.stdout = io.BytesIO(image * frame_count)
        lines = [
            f"[Parsed_showinfo_1] n: {index} pts: {index} pts_time:{timestamp}\n".encode()
            for index, timestamp in enumerate(timestamps)
        ]
        self.stderr = io.BytesIO(b"".join(lines))
        self.exit_code = exit_code
        self.status = None
        self.terminated = False
        self.killed = False

    def wait(self, timeout=None):
        if self.status is None:
            self.status = self.exit_code
        return self.status

    def poll(self):
        return self.status

    def terminate(self):
        self.terminated = True
        self.status = -15

    def kill(self):
        self.killed = True
        self.status = -9


class VideoCopyFrameTests(unittest.TestCase):
    def setUp(self):
        FakeTimer.instances.clear()

    def _extract(self, process: FakeProcess, *, start=0.0, duration=5.0, rate=1.0):
        popen = patch("vision_service.video_copy_frames.subprocess.Popen", return_value=process)
        timer = patch("vision_service.video_copy_frames.threading.Timer", FakeTimer)
        return popen, timer, extract("/media/source.mp4", start, duration, rate=rate)

    def test_recovers_metadata_warning_without_rejecting_valid_frames(self):
        process = FakeProcess([0.0, 1.0, 2.0, 3.0, 4.0])
        process.stderr = io.BytesIO(
            b"[in#0 @ 0x123abc] [warning] UDTA parsing failed retrying raw\n"
            + b"[info] Input #0 from '/media/failed-error-invalid.mp4'\n"
            + process.stderr.getvalue()
        )
        popen, timer, frames = self._extract(process)
        with popen as child, timer:
            self.assertEqual(len(list(frames)), 5)
            args = child.call_args.args[0]
            self.assertEqual(args[args.index("-loglevel") + 1], "level+info")

    def test_error_severity_fails_even_when_ffmpeg_exits_successfully(self):
        for level in ("error", "fatal", "panic"):
            for context in ("", "[hevc @ 0x123abc] "):
                with self.subTest(level=level, context=context):
                    process = FakeProcess([0.0, 1.0, 2.0, 3.0, 4.0])
                    process.stderr = io.BytesIO(
                        f"{context}[{level}] corrupt decoded picture\n".encode()
                        + process.stderr.getvalue()
                    )
                    popen, timer, frames = self._extract(process)
                    with popen, timer, self.assertRaisesRegex(RuntimeError, "VAAPI extraction"):
                        list(frames)

    def test_nonzero_exit_fails_without_diagnostic_keywords(self):
        process = FakeProcess([0.0, 1.0, 2.0, 3.0, 4.0], exit_code=1)
        popen, timer, frames = self._extract(process)
        with popen, timer, self.assertRaisesRegex(RuntimeError, "VAAPI extraction"):
            list(frames)

    def test_rejects_timestamp_gap_and_cleans_up_child(self):
        process = FakeProcess([0.0, 3.0])
        popen, timer, frames = self._extract(process, duration=5.0)

        with popen, timer, self.assertRaisesRegex(FrameSamplingGapError, "sampling gap"):
            list(frames)

        self.assertTrue(process.terminated)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)
        self.assertTrue(FakeTimer.instances[0].cancelled)

    def test_timestamp_regression_remains_fatal_not_a_sampling_gap(self):
        process = FakeProcess([0.0, 1.0, 0.5])
        popen, timer, frames = self._extract(process)
        with popen, timer, self.assertRaisesRegex(RuntimeError, "regression") as error:
            list(frames)
        self.assertNotIsInstance(error.exception, FrameSamplingGapError)
        self.assertTrue(process.terminated)

    def test_rejects_source_that_ends_before_requested_window(self):
        process = FakeProcess([0.0, 1.0])
        popen, timer, frames = self._extract(process, duration=5.0)

        with popen, timer, self.assertRaisesRegex(RuntimeError, "ended before"):
            list(frames)

        self.assertFalse(process.terminated)
        self.assertEqual(process.status, 0)
        self.assertTrue(FakeTimer.instances[0].cancelled)

    def test_closing_generator_terminates_child_and_closes_pipes(self):
        process = FakeProcess([0.0, 1.0, 2.0])
        popen, timer, frames = self._extract(process, duration=3.0)

        with popen, timer:
            timestamp, image = next(frames)
            self.assertEqual(timestamp, 0.0)
            self.assertEqual(image.shape, (SIZE, SIZE, 3))
            frames.close()

        self.assertTrue(process.terminated)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)
        self.assertTrue(FakeTimer.instances[0].cancelled)

    def test_enforces_frame_budget(self):
        process = FakeProcess([0.0, 0.2, 0.4, 0.6, 0.8])
        popen, timer, frames = self._extract(process, duration=1.0)

        with popen, timer, self.assertRaisesRegex(RuntimeError, "frame budget"):
            list(frames)

        self.assertTrue(process.terminated)

    def test_validates_window_before_starting_ffmpeg(self):
        with patch("vision_service.video_copy_frames.subprocess.Popen") as popen:
            invalid = (
                {"start": -0.1, "duration": 1.0, "rate": 1.0},
                {"start": 0.0, "duration": 0.0, "rate": 1.0},
                {"start": 0.0, "duration": 121.0, "rate": 1.0},
                {"start": 0.0, "duration": 1.0, "rate": 5.1},
            )
            for values in invalid:
                with self.subTest(values=values), self.assertRaisesRegex(ValueError, "Invalid"):
                    next(extract("/media/source.mp4", **values))
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
