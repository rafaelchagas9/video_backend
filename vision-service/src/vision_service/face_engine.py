"""Face detection and embedding extraction engine using InsightFace."""

import hashlib
import logging
import os
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from insightface.app import FaceAnalysis
from insightface.model_zoo import model_zoo

from .config import get_settings

logger = logging.getLogger(__name__)


def fixed_shape_model(source: Path, size: int, directory: Path) -> Path:
    """Copy of a detector ONNX with its input pinned to 1x3xSIZExSIZE.

    MIGraphX names compiled programs by a hash of the model graph, not the input shape.
    Two sessions of the same dynamic-shape detector at different sizes therefore share
    one cache file: the second loads the first one's program, writes outputs sized for
    the other shape and the GPU page-faults (gfxhub PROTECTION_FAULT, then SIGABRT).
    Pinning the shape changes the graph and so the cache file.
    """
    target = directory / f"{source.stem}_{size}.onnx"
    if target.is_file():
        return target
    model = onnx.load(str(source))
    dims = model.graph.input[0].type.tensor_type.shape.dim
    for dim, value in zip(dims, (1, 3, size, size), strict=True):
        dim.ClearField("dim_param")
        dim.dim_value = value
    directory.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(f".{os.getpid()}.partial")
    onnx.save(model, str(partial))
    partial.replace(target)
    return target


class FaceEngine:
    """Face detection engine using InsightFace.

    Uses a hybrid dual-detector approach:
    - High-res detector (1280x1280) on GPU (MIGraphX) for large images
    - Low-res detector (640x640) for small images and face visibility: on the CPU by
      default, or as its own fixed-shape GPU session with FACE_FALLBACK_ON_GPU=true

    !!! EVERY MIGraphX SESSION RUNS AT EXACTLY ONE INPUT SHAPE !!!

    Never run the 1280 GPU session at any other input size, and keep the GPU 1280
    detector on its fixed-shape model copy (`fixed_shape_model`). MIGraphX caches
    compiled programs under a hash of the model graph, not the input shape, so the
    dynamic det_10g model at 1280 and at 640 would share one cache file. Whichever
    size loads second runs the other size's program. Outputs come back sized for the
    wrong shape and the GPU page-faults (gfxhub PROTECTION_FAULT, SIGABRT).

    That collision is what broke earlier attempts. From January 2026 the 640 detector
    stayed on the CPU to "avoid MIGraphX multi-session GPU crashes". A second fixed-640
    GPU session on 2026-10-14 page-faulted, and running 640 on the 1280 session
    returned wrong-shape outputs. The whole-PC freezes from that period were the GPU
    running on one daisy-chained PCIe power cable (fixed 2026-10-21). With the
    1280 detector on its pinned copy, FACE_FALLBACK_ON_GPU=true runs the 640 detector
    as its own GPU session (verified 2026-10-21 in isolation, no faults).

    A cache directory written before the pinned copy holds the 1280 program under the
    dynamic model's name. Delete that file before enabling the GPU 640 session,
    otherwise the 640 session loads it and faults.
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
        fallback_on_gpu = settings.face_fallback_on_gpu
        low_providers = gpu_providers if fallback_on_gpu else cpu_providers
        self._low_label = "GPU" if fallback_on_gpu else "CPU"

        logger.info(f"GPU Providers: {gpu_providers}")
        logger.info(f"Low-Res Providers: {low_providers}")

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
            self._pin_detector_shape(self.app_high, settings.det_size, gpu_providers, settings)
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

            # 2. Low-Res Detector (CPU, or its own fixed-shape GPU session)
            logger.info(
                f"2. Low-Res ({self._low_label}): "
                f"{settings.det_size_fallback}x{settings.det_size_fallback}"
            )
            start_time = time.time()
            self.app_low = FaceAnalysis(
                name=settings.insightface_model,
                providers=low_providers,
                # On the GPU, reuse the high-res recognition session rather than open
                # another one: recognition always runs at 112x112 either way.
                allowed_modules=["detection"] if fallback_on_gpu else ["detection", "recognition"],
                root=settings.model_cache_dir,
            )
            if fallback_on_gpu:
                self.app_low.models["recognition"] = self.app_high.models["recognition"]
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
            self._pin_detector_shape(self.app, settings.det_size, gpu_providers, settings)
            self.app.prepare(ctx_id=0, det_size=(settings.det_size, settings.det_size))
            self.app_high = self.app
            self.app_low = self.app

            self._prewarm_single()

    @staticmethod
    def _pin_detector_shape(app: FaceAnalysis, size: int, providers: list, settings) -> None:
        """Swap a MIGraphX detector for its fixed-shape copy (see `fixed_shape_model`)."""
        names = [p if isinstance(p, str) else p[0] for p in providers]
        if "MIGraphXExecutionProvider" not in names:
            return
        pinned = fixed_shape_model(
            Path(app.det_model.model_file), size, settings.model_cache_dir / "fixed-shape"
        )
        detector = model_zoo.get_model(str(pinned), providers=providers)
        app.models["detection"] = detector
        app.det_model = detector

    def _prewarm_detectors(self) -> None:
        """Pre-warm both detectors."""
        logger.info("Pre-warming detectors...")

        # High-res (GPU) - Triggers compilation
        logger.info("Pre-warming High-Res (GPU)...")
        t0 = time.time()
        self.app_high.get(np.zeros((64, 64, 3), dtype=np.uint8))
        logger.info(f"-> Done in {time.time() - t0:.1f}s")

        logger.info(f"Pre-warming Low-Res ({self._low_label})...")
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
            det_type = f"Low-Res ({self._low_label})"
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

    def observe_visibility(self, image: np.ndarray) -> dict:
        """Detection only on the existing 640 low-res session; never recognize identities.

        Explicit 640 input matches the experimental SCRFD preprocessing recipe.
        That session is the CPU one, or the fixed-640 GPU one with
        FACE_FALLBACK_ON_GPU. Never run 640 on the 1280 GPU session (see the class
        docstring). The detector must already be prepared at 640, so this call
        never changes any session's input shape.
        Shared runtime admission serializes this call with face recognition.
        """
        detector = self.app_low.det_model
        if tuple(detector.input_size or ()) != (640, 640):
            raise RuntimeError("Face visibility requires a detector prepared at 640x640")
        if detector.det_thresh != 0.5 or detector.nms_thresh != 0.4:
            raise RuntimeError("Face visibility detector thresholds differ")
        providers = detector.session.get_providers()
        model_path = Path(detector.model_file)
        model_sha = getattr(self, "_visibility_model_sha", None)
        if model_sha is None:
            model_sha = hashlib.sha256(model_path.read_bytes()).hexdigest()
            self._visibility_model_sha = model_sha
        if model_sha != "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91":
            raise RuntimeError("Face visibility model bytes differ")
        boxes, _landmarks = detector.detect(image, input_size=(640, 640))
        scores = [float(box[4]) for box in boxes]
        if any(not np.isfinite(score) or not 0.5 <= score <= 1 for score in scores):
            raise ValueError("Face visibility confidence is invalid")
        return {
            "detected": bool(scores),
            "max_confidence": max(scores, default=0.0),
            "model_sha256": model_sha,
            "input_size": [640, 640],
            "confidence": 0.5,
            "nms": 0.4,
            "providers": providers,
            "identity_embeddings": False,
            "service": "shared-vision",
        }

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
