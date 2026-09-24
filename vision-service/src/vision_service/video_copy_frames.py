"""Bounded VAAPI extraction with source presentation timestamps (no synthetic FPS grid)."""

from __future__ import annotations

import math
import os
import queue
import re
import subprocess
import threading
from pathlib import Path

import numpy as np

# FFmpeg's explicit severity distinguishes recoverable metadata warnings from
# decode errors even when both contain words such as "failed" or "invalid".
ERROR_LEVEL = re.compile(
    r"^(?:\[[^\]\r\n]+ @ 0x[0-9a-fA-F]+\]\s*)?\[(?:error|fatal|panic)\](?:\s|$)"
)
PTS = re.compile(r"showinfo.*\bn:\s*\d+.*\bpts_time:\s*([+\-\deE.]+)")


class FrameSamplingGapError(RuntimeError):
    """Source PTS are monotonic but cannot provide a continuous sample window."""


def source_identity(path: str) -> dict:
    stat = Path(path).stat()
    if not Path(path).is_file():
        raise ValueError("Source is not a regular file")
    return {
        k: getattr(stat, k) for k in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    }


def extract(path: str, start: float, duration: float, *, size: int = 288, rate: float = 1):
    """Yield RGB frames. Hardware failures are explicit, never silently decoded on CPU."""
    if not (0 <= start and 0 < duration <= 120 and 0 < rate <= 5 and size in (288, 512)):
        raise ValueError("Invalid extraction window")
    end = start + duration
    selection = (
        f"select='gte(t,{start})*lt(t,{end})*"
        f"(isnan(prev_selected_t)+gte(t-prev_selected_t,{1 / rate - 0.001}))',showinfo,"
    )
    scaling = (
        f"scale_vaapi=w={size}:h={size}:format=nv12"
        + (
            ":force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1"
            if size == 512
            else ""
        )
        + ",hwdownload,format=nv12"
        + (f",pad={size}:{size}:(ow-iw)/2:(oh-ih)/2" if size == 512 else "")
        + ",format=rgb24"
    )
    args = [
        os.environ.get("FFMPEG_PATH", "ffmpeg"),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "level+info",
        "-threads",
        "2",
        "-filter_threads",
        "1",
        "-copyts",
        "-start_at_zero",
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        os.environ.get("VAAPI_DEVICE", "/dev/dri/renderD128"),
        "-hwaccel_output_format",
        "vaapi",
        "-ss",
        str(start),
        "-t",
        str(duration),
        "-discard:a",
        "all",
        "-discard:s",
        "all",
        "-discard:d",
        "all",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        selection + scaling,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    timestamps: queue.Queue[float] = queue.Queue()
    process = subprocess.Popen(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    timed_out = threading.Event()

    def expire():
        timed_out.set()
        process.kill()

    timer = threading.Timer(180, expire)
    errors: list[str] = []

    def read_errors():
        for line in process.stderr:
            text = line.decode(errors="replace")
            match = PTS.search(text)
            if match:
                timestamps.put(float(match[1]))
            elif len(errors) < 5 and ERROR_LEVEL.match(text):
                errors.append("FFmpeg reported a decode/filter error")

    reader = threading.Thread(target=read_errors, daemon=True)
    timer.start()
    reader.start()
    count = 0
    previous = None
    try:
        while True:
            raw = process.stdout.read(size * size * 3)
            if not raw:
                break
            if len(raw) != size * size * 3:
                raise RuntimeError("COPY_DECODE_FAILED: Incomplete decoded frame")
            timestamp = timestamps.get(timeout=5)
            if not math.isfinite(timestamp) or timestamp < start - 0.05 or timestamp >= end + 0.05:
                raise RuntimeError(
                    "COPY_DECODE_FAILED: Source timestamps lie outside extraction window"
                )
            timestamp = min(max(timestamp, start), math.nextafter(end, start))
            if previous is not None and timestamp - previous > 2.5 / rate:
                raise FrameSamplingGapError(
                    "COPY_DECODE_FAILED: Source timestamps contain a sampling gap"
                )
            if previous is not None and timestamp <= previous:
                raise RuntimeError(
                    "COPY_DECODE_FAILED: Source timestamps contain a regression"
                )
            if previous is None and timestamp > start + 2.5 / rate:
                raise RuntimeError(
                    "COPY_DECODE_FAILED: Source starts after requested extraction window"
                )
            count += 1
            if count > math.ceil(duration * rate) + 3:
                raise RuntimeError("COPY_DECODE_FAILED: Extraction exceeded frame budget")
            previous = timestamp
            yield timestamp, np.frombuffer(raw, dtype=np.uint8).reshape(size, size, 3)
        code = process.wait(timeout=5)
        reader.join(timeout=5)
        if timed_out.is_set() or code != 0 or errors:
            raise RuntimeError("COPY_DECODE_FAILED: VAAPI extraction failed or timed out")
        if previous is None or end - previous > 2.5 / rate:
            raise RuntimeError(
                "COPY_DECODE_FAILED: Source ended before requested extraction window"
            )
    finally:
        timer.cancel()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdout.close()
        process.stderr.close()
        reader.join(timeout=2)
