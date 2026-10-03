"""SigLIP2 image/text embeddings for natural-language visual search.

Images arrive as storyboard pages (grids of equally sized tiles). The vision tower runs on the
GPU with a fixed batch shape, because MIGraphX compiles one program per input shape and a
compile costs minutes; short batches are padded. The text tower is small enough per query to
stay on the CPU, which also keeps it independent of GPU warmup.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger(__name__)

TEXT_LENGTH = 64


@dataclass(frozen=True, slots=True)
class TileGrid:
    """Where the tiles of one storyboard page sit. Tiles fill rows left to right."""

    tile_width: int
    tile_height: int
    columns: int
    count: int


class ClipEngine:
    """Own the ONNX sessions for one SigLIP2 checkpoint directory."""

    def __init__(
        self,
        model_dir: Path,
        providers: list[str],
        batch_size: int,
        fp16: bool,
        text_threads: int,
    ) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        vision_path = model_dir / "vision_model.onnx"
        text_path = model_dir / "text_model.onnx"
        for path in (vision_path, text_path, model_dir / "tokenizer.json"):
            if not path.is_file():
                raise FileNotFoundError(f"SigLIP2 model file is missing: {path}")

        self.model_revision = f"siglip2/{model_dir.name}"
        self.batch_size = batch_size
        self.image_size = self._read_image_size(model_dir)

        vision_providers: list[object] = []
        for name in providers:
            if name == "MIGraphXExecutionProvider":
                vision_providers.append((name, {"device_id": 0, "migraphx_fp16_enable": fp16}))
            else:
                vision_providers.append(name)
        if "CPUExecutionProvider" not in providers:
            vision_providers.append("CPUExecutionProvider")
        self._vision = ort.InferenceSession(str(vision_path), providers=vision_providers)
        self.providers = tuple(self._vision.get_providers())
        self._vision_input = self._vision.get_inputs()[0].name

        text_options = ort.SessionOptions()
        text_options.intra_op_num_threads = text_threads
        self._text = ort.InferenceSession(
            str(text_path), text_options, providers=["CPUExecutionProvider"]
        )
        self._text_input = self._text.get_inputs()[0].name
        self._tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self._tokenizer.enable_padding(length=TEXT_LENGTH, pad_id=0, pad_token="<pad>")
        self._tokenizer.enable_truncation(max_length=TEXT_LENGTH)
        self.dimension = int(self._vision.get_outputs()[-1].shape[-1])
        self._vision_lock = threading.Lock()

    @staticmethod
    def _read_image_size(model_dir: Path) -> int:
        import json

        config = json.loads((model_dir / "preprocessor_config.json").read_text())
        size = config.get("size", {})
        return int(size.get("height") or size.get("shortest_edge") or 256)

    def _prepare(self, tile: np.ndarray) -> np.ndarray:
        # SigLIP squashes to a square (no crop), bilinear, then maps [0, 255] to [-1, 1].
        resized = cv2.resize(
            tile, (self.image_size, self.image_size), interpolation=cv2.INTER_LINEAR
        )
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)
        return (rgb / 127.5 - 1.0).transpose(2, 0, 1)

    def slice_tiles(self, page: np.ndarray, grid: TileGrid) -> list[np.ndarray]:
        height, width = page.shape[:2]
        columns = grid.columns or max(1, width // grid.tile_width)
        # The last page of a paged storyboard is trimmed to the tiles it holds.
        columns = min(columns, grid.count)
        rows = max(1, -(-grid.count // columns))
        if columns * grid.tile_width > width or rows * grid.tile_height > height:
            raise ValueError("Tile grid exceeds the page bounds")
        tiles = []
        for index in range(grid.count):
            x = (index % columns) * grid.tile_width
            y = (index // columns) * grid.tile_height
            tiles.append(self._prepare(page[y : y + grid.tile_height, x : x + grid.tile_width]))
        return tiles

    def embed_images(self, prepared: list[np.ndarray]) -> np.ndarray:
        """L2-normalised float32 embeddings, one row per prepared tile."""
        if not prepared:
            return np.zeros((0, self.dimension), dtype=np.float32)
        outputs = []
        with self._vision_lock:
            for start in range(0, len(prepared), self.batch_size):
                chunk = prepared[start : start + self.batch_size]
                batch = np.zeros(
                    (self.batch_size, 3, self.image_size, self.image_size), dtype=np.float32
                )
                batch[: len(chunk)] = np.stack(chunk)
                pooled = self._vision.run(None, {self._vision_input: batch})[-1]
                outputs.append(pooled[: len(chunk)])
        return _normalize(np.concatenate(outputs).astype(np.float32))

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        # SigLIP2 was trained on lower-cased captions.
        encodings = self._tokenizer.encode_batch([text.lower() for text in texts])
        ids = np.array([encoding.ids for encoding in encodings], dtype=np.int64)
        pooled = self._text.run(None, {self._text_input: ids})[-1]
        return _normalize(pooled.astype(np.float32))

    def warm(self) -> None:
        blank = np.zeros((3, self.image_size, self.image_size), dtype=np.float32)
        self.embed_images([blank])
        self.embed_texts(["warmup"])


def _normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)
