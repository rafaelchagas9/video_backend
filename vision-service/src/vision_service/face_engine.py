"""Face detection and embedding extraction engine using InsightFace."""

import logging
import time

import numpy as np
import onnxruntime as ort
from insightface.app import FaceAnalysis

from .config import get_settings

logger = logging.getLogger(__name__)


class FaceEngine:
    """Face detection engine using InsightFace.

    Uses a hybrid dual-detector approach:
    - High-res detector (1280x1280) on GPU (MIGraphX) for large images
    - Low-res detector (640x640) on CPU for small images

    This avoids MIGraphX multi-session GPU crashes while maintaining
    high performance and accuracy.
    """

    def __init__(self) -> None:
        settings = get_settings()
        self._setup_providers(settings)

    def _build_gpu_providers(self, settings) -> list:
        """Build ONNX providers list for GPU (MIGraphX)."""
        available = ort.get_available_providers()
        configured = settings.get_onnx_providers()
        providers = []

        for provider_name in configured:
            if provider_name not in available:
                continue

            if provider_name == "MIGraphXExecutionProvider":
                providers.append(
                    (
                        "MIGraphXExecutionProvider",
                        {
                            "device_id": "0",
                            "migraphx_fp16_enable": "1",
                            "migraphx_int8_enable": "0",
                            "migraphx_exhaustive_tune": "1",
                        },
                    )
                )
            else:
                providers.append(provider_name)

        # Fallback to CPU if no GPU provider found/configured
        if not providers or providers == ["CPUExecutionProvider"]:
            providers = ["CPUExecutionProvider"]

        # Ensure CPU is always last
        if "CPUExecutionProvider" not in [p if isinstance(p, str) else p[0] for p in providers]:
            providers.append("CPUExecutionProvider")

        return providers

    def _build_cpu_providers(self) -> list:
        """Build ONNX providers list for CPU only."""
        return ["CPUExecutionProvider"]

    def _setup_providers(self, settings) -> None:
        """Configure and initialize hybrid face analysis models."""
        gpu_providers = self._build_gpu_providers(settings)
        cpu_providers = self._build_cpu_providers()

        logger.info(f"GPU Providers: {gpu_providers}")
        logger.info(f"CPU Providers: {cpu_providers}")

        self.det_size_threshold = settings.det_size_threshold
        self.use_dual_detectors = settings.det_size > settings.det_size_fallback

        if self.use_dual_detectors:
            logger.info("Initializing Hybrid Dual-Detector Setup:")

            # 1. High-Res Detector on GPU
            logger.info(
                f"1. High-Res (GPU): {settings.det_size}x{settings.det_size} [MIGraphX] -- Model: {settings.insightface_model}"
            )
            start_time = time.time()
            self.app_high = FaceAnalysis(
                name=settings.insightface_model,
                providers=gpu_providers,
                allowed_modules=["detection", "recognition"],
                root=settings.model_cache_dir,
            )
            self.app_high.prepare(ctx_id=0, det_size=(settings.det_size, settings.det_size))

            # Verify active providers for High-Res
            try:
                # Inspect the detection model session
                det_providers = self.app_high.det_model.session.get_providers()
                logger.info(f"   -> Active providers (High-Res): {det_providers}")

                # Check if MIGraphX is actually active
                if "MIGraphXExecutionProvider" not in det_providers:
                    logger.warning(
                        "   -> WARNING: MIGraphX requested but NOT active! Running on CPU?"
                    )
            except Exception as e:
                logger.warning(f"   -> Could not verify active providers: {e}")

            logger.info(f"   -> Ready in {time.time() - start_time:.1f}s")

            # 2. Low-Res Detector on CPU
            logger.info(
                f"2. Low-Res (CPU): {settings.det_size_fallback}x{settings.det_size_fallback} [CPU]"
            )
            start_time = time.time()
            self.app_low = FaceAnalysis(
                name=settings.insightface_model,
                providers=cpu_providers,
                allowed_modules=["detection", "recognition"],
                root=settings.model_cache_dir,
            )
            self.app_low.prepare(
                ctx_id=0, det_size=(settings.det_size_fallback, settings.det_size_fallback)
            )
            logger.info(f"   -> Ready in {time.time() - start_time:.1f}s")

            # Pre-warm
            self._prewarm_detectors()

            self.app = self.app_high  # Default

        else:
            # Single detector mode (GPU)
            logger.info(
                f"Initializing Single Detector (GPU): {settings.det_size}x{settings.det_size}"
            )
            self.app = FaceAnalysis(
                name=settings.insightface_model,
                providers=gpu_providers,
                allowed_modules=["detection", "recognition"],
                root=settings.model_cache_dir,
            )
            self.app.prepare(ctx_id=0, det_size=(settings.det_size, settings.det_size))
            self.app_high = self.app
            self.app_low = self.app

            self._prewarm_single()

    def _prewarm_detectors(self) -> None:
        """Pre-warm both detectors."""
        logger.info("Pre-warming detectors...")

        # High-res (GPU) - Triggers compilation
        logger.info("Pre-warming High-Res (GPU)...")
        t0 = time.time()
        self.app_high.get(np.zeros((64, 64, 3), dtype=np.uint8))
        logger.info(f"-> Done in {time.time() - t0:.1f}s")

        # Low-res (CPU)
        logger.info("Pre-warming Low-Res (CPU)...")
        t0 = time.time()
        self.app_low.get(np.zeros((64, 64, 3), dtype=np.uint8))
        logger.info(f"-> Done in {time.time() - t0:.1f}s")

    def _prewarm_single(self) -> None:
        logger.info("Pre-warming single detector...")
        self.app.get(np.zeros((64, 64, 3), dtype=np.uint8))
        logger.info("Pre-warm complete.")

    def detect(self, image: np.ndarray) -> list[dict]:
        """
        Detect faces using the appropriate detector based on image size.
        """
        height, width = image.shape[:2]
        max_dim = max(height, width)

        # Select detector
        if self.use_dual_detectors and max_dim < self.det_size_threshold:
            detector = self.app_low
            det_type = "Low-Res (CPU)"
        else:
            detector = self.app_high
            det_type = "High-Res (GPU)"

        logger.debug(f"Detecting faces in {width}x{height} image using {det_type}")

        start_time = time.time()
        faces = detector.get(image)
        elapsed = time.time() - start_time

        logger.debug(f"Detection finished in {elapsed * 1000:.1f}ms. Found {len(faces)} faces.")

        return [
            {
                "bbox": [float(x) for x in face.bbox],
                "embedding": face.embedding.tolist(),
                "det_score": float(face.det_score),
            }
            for face in faces
        ]

    def get_embedding_dimension(self) -> int:
        recognition = self.app_high.models.get("recognition")
        if recognition is None:
            raise RuntimeError("Configured InsightFace model has no recognition capability")

        output_dimension = recognition.session.get_outputs()[0].shape[-1]
        if not isinstance(output_dimension, int) or output_dimension <= 0:
            raise RuntimeError("Could not determine recognition embedding dimension")
        return output_dimension

    def get_active_providers(self) -> list[str]:
        """Return providers actually active in the loaded ONNX sessions."""
        providers: list[str] = []
        applications = [self.app_high]
        if self.app_low is not self.app_high:
            applications.append(self.app_low)

        for application in applications:
            for model in application.models.values():
                for provider in model.session.get_providers():
                    if provider not in providers:
                        providers.append(provider)
        return providers

    def close(self) -> None:
        """Release references to ONNX sessions during application shutdown."""
        self.app = None
        self.app_high = None
        self.app_low = None
