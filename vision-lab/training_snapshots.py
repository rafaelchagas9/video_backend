"""Read reviewed recordings without PostgreSQL or source video access.

The backend archives existing embeddings/timestamps on Save. No inference runs here.
Format: KURAFEAT + uint32 little-endian JSON-header length + header + float64-le
frame timestamps + row-major float32-le embeddings. Manifest hashes detect corruption.
"""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent / "data" / "recording-training-snapshots"
MAX_BYTES = 64 * 1024 * 1024 + 65536


def manifests(video_id: int, root: Path = ROOT) -> list[dict]:
    """Current batch decisions per analysis; all proposals, including skips, are retained."""
    if video_id <= 0:
        raise ValueError("Invalid recording id")
    result = []
    for path in sorted((root / str(video_id)).glob("review-*.json")):
        manifest = json.loads(path.read_text())
        if manifest.get("format") != "kura-recording-training" or manifest.get("version") != 1:
            raise ValueError(f"Unsupported training manifest: {path.name}")
        if manifest["source"]["videoId"] != video_id:
            raise ValueError("Training snapshot recording ids do not match")
        result.append(manifest)
    return result


def frames(manifest: dict, root: Path = ROOT) -> tuple[np.ndarray, np.ndarray]:
    """Read exact archived timestamps and stored embedding values, verifying their identity."""
    video_id = manifest["source"]["videoId"]
    features = manifest["features"]
    file = features["file"]
    if not isinstance(video_id, int) or video_id <= 0 or Path(file).name != file or not file.startswith("features-"):
        raise ValueError("Invalid training feature path")
    path = root / str(video_id) / file
    size = path.stat().st_size
    if size != features["bytes"] or size > MAX_BYTES or size < 12:
        raise ValueError("Training feature size does not match its manifest")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != features["sha256"]:
        raise ValueError("Training feature checksum does not match its manifest")
    if raw[:8] != b"KURAFEAT":
        raise ValueError("Unsupported training feature format")
    header_size = struct.unpack_from("<I", raw, 8)[0]
    if header_size > 65536 or header_size + 12 > len(raw):
        raise ValueError("Invalid training feature header")
    header = json.loads(raw[12:12 + header_size])
    if (header.get("version") != 1 or header.get("identity") != features["identity"]
            or header.get("index") != features["index"] or header.get("dimension") != features["dimension"]
            or header.get("timestamps") != "float64-le" or header.get("embeddings") != "float32-le"):
        raise ValueError("Training feature identity does not match its manifest")
    count, dimension = header["index"]["frameCount"], header["dimension"]
    if not isinstance(count, int) or count <= 0 or dimension != 1152:
        raise ValueError("Invalid training feature dimensions")
    offset = 12 + header_size
    if offset + count * (8 + dimension * 4) != len(raw):
        raise ValueError("Training feature frame count does not match its payload")
    timestamps = np.frombuffer(raw, dtype="<f8", count=count, offset=offset).copy()
    vectors = np.frombuffer(raw, dtype="<f4", count=count * dimension, offset=offset + count * 8).reshape(count, dimension).copy()
    if (not np.isfinite(timestamps).all() or np.any(timestamps < 0) or np.any(np.diff(timestamps) <= 0)
            or not np.isfinite(vectors).all()):
        raise ValueError("Training feature values are invalid")
    return timestamps, vectors
