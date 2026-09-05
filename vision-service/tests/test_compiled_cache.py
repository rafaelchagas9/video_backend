import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from vision_service.compiled_cache import configure_compiled_cache
from vision_service.config import Settings
from vision_service.nudity import NudeNetDetectorAdapter


class CompiledCacheTests(unittest.TestCase):
    def test_precision_batch_shape_and_runtime_get_distinct_caches(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            root = Path(directory)
            fp32 = configure_compiled_cache(Settings(_env_file=None), root)
            fp16 = configure_compiled_cache(Settings(_env_file=None, nudity_fp16_enabled=True), root)
            larger_batch = configure_compiled_cache(Settings(_env_file=None, max_batch_items=32), root)
            self.assertEqual(len({fp32, fp16, larger_batch}), 3)
            self.assertEqual(configure_compiled_cache(Settings(_env_file=None), root), fp32)
            with patch("vision_service.compiled_cache._version", return_value="new-runtime"):
                self.assertNotEqual(configure_compiled_cache(Settings(_env_file=None), root), fp32)
            with patch("vision_service.compiled_cache._native_runtime_identity", return_value={"changed": True}):
                self.assertNotEqual(configure_compiled_cache(Settings(_env_file=None), root), fp32)
            self.assertTrue((fp32 / "execution.json").is_file())

    def test_precision_is_part_of_the_model_revision(self):
        regular = NudeNetDetectorAdapter(backend_factory=lambda: None)
        half = NudeNetDetectorAdapter(backend_factory=lambda: None, fp16_enabled=True)
        self.assertEqual(half.model_revision, regular.model_revision + "/fp16")

    def test_process_override_matches_ort_precedence(self):
        with patch.dict(os.environ, {"ORT_MIGRAPHX_FP16_ENABLE": "0"}):
            self.assertFalse(Settings(_env_file=None, nudity_fp16_enabled=True).effective_nudity_fp16())
        with patch.dict(os.environ, {"ORT_MIGRAPHX_FP16_ENABLE": "1"}):
            self.assertTrue(Settings(_env_file=None).effective_nudity_fp16())
