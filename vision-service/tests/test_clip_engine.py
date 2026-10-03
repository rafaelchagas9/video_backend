from __future__ import annotations

import unittest

import numpy as np

from vision_service.clip_engine import ClipEngine, TileGrid


class _Slicer:
    """Only the geometry of ClipEngine.slice_tiles, without loading ONNX sessions."""

    image_size = 4
    slice_tiles = ClipEngine.slice_tiles

    def _prepare(self, tile: np.ndarray) -> np.ndarray:
        return tile.copy()


class SliceTilesTest(unittest.TestCase):
    def test_full_page_is_read_row_major(self) -> None:
        page = np.arange(2 * 3 * 3, dtype=np.uint8).reshape(2, 3, 3)
        tiles = _Slicer().slice_tiles(page, TileGrid(1, 1, 3, 6))
        self.assertEqual([int(tile[0, 0, 0]) for tile in tiles], [0, 3, 6, 9, 12, 15])

    def test_trimmed_last_page_narrower_than_the_grid(self) -> None:
        page = np.zeros((240, 960, 3), dtype=np.uint8)
        tiles = _Slicer().slice_tiles(page, TileGrid(320, 240, 5, 3))
        self.assertEqual(len(tiles), 3)

    def test_legacy_sheet_derives_columns(self) -> None:
        page = np.zeros((20, 40, 3), dtype=np.uint8)
        tiles = _Slicer().slice_tiles(page, TileGrid(10, 10, 0, 7))
        self.assertEqual(len(tiles), 7)

    def test_grid_larger_than_page_is_rejected(self) -> None:
        page = np.zeros((10, 10, 3), dtype=np.uint8)
        with self.assertRaises(ValueError):
            _Slicer().slice_tiles(page, TileGrid(10, 10, 1, 2))


if __name__ == "__main__":
    unittest.main()
