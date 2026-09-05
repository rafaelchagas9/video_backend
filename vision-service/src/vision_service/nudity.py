"""Pinned NudeNet capability isolated behind the generic detector contract."""

from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from importlib.resources import files
from pathlib import Path
from typing import Protocol

import numpy as np

from .detectors import (
    DecodedImage,
    DetectorItemError,
    DetectorItemOutcome,
    DetectorItemResult,
    Finding,
    NormalizedBox,
)

logger = logging.getLogger(__name__)

SELECTED_NUDITY_LABELS = frozenset(
    {
        "BUTTOCKS_EXPOSED",
        "FEMALE_BREAST_EXPOSED",
        "FEMALE_GENITALIA_EXPOSED",
        "MALE_BREAST_EXPOSED",
        "ANUS_EXPOSED",
        "FEET_EXPOSED",
        "ARMPITS_EXPOSED",
        "BELLY_EXPOSED",
        "MALE_GENITALIA_EXPOSED",
        "ANUS_COVERED",
        "FEMALE_GENITALIA_COVERED",
    }
)
NUDENET_VERSION = "3.4.2"
NUDENET_320N_SHA256 = "c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f"
NUDENET_640M_SHA256 = "04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb"
NUDENET_640M_URL = "https://github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/640m.onnx"
DEFAULT_NUDITY_PROVIDERS = ("MIGraphXExecutionProvider", "CPUExecutionProvider")
# MIGraphX compiles one program per distinct input shape, and each compile costs
# roughly 100 seconds. Every batch is padded to this one size so the session only
# ever compiles (and caches) a single program.
DEFAULT_NUDITY_BATCH_SIZE = 16


@dataclass(frozen=True, slots=True)
class NudeNetModelSpec:
    name: str
    inference_resolution: int
    sha256: str
    source_url: str | None

    @property
    def model_revision(self) -> str:
        return f"nudenet-{NUDENET_VERSION}/{self.name}@sha256:{self.sha256}"


NUDENET_320N_SPEC = NudeNetModelSpec(
    name="320n",
    inference_resolution=320,
    sha256=NUDENET_320N_SHA256,
    source_url=None,
)
NUDENET_640M_SPEC = NudeNetModelSpec(
    name="640m",
    inference_resolution=640,
    sha256=NUDENET_640M_SHA256,
    source_url=NUDENET_640M_URL,
)
NUDENET_MODEL_SPECS = {
    NUDENET_320N_SPEC.name: NUDENET_320N_SPEC,
    NUDENET_640M_SPEC.name: NUDENET_640M_SPEC,
}
NUDENET_DEFAULT_MODEL = NUDENET_640M_SPEC.name
NUDENET_MODEL_REVISION = NUDENET_640M_SPEC.model_revision
DEFAULT_MODEL_CACHE_DIR = Path(__file__).resolve().parents[2] / "models"


class OnnxSession(Protocol):
    def get_inputs(self) -> Sequence[object]: ...

    def get_providers(self) -> list[str]: ...

    def run(self, output_names: None, inputs: dict[str, np.ndarray]) -> list[np.ndarray]: ...


class OnnxSessionFactory(Protocol):
    def __call__(self, model_path: str, *, providers: list[str | tuple[str, dict[str, str]]]) -> OnnxSession: ...


RawDetection = Mapping[str, object]
RawItemOutcome = Sequence[RawDetection] | DetectorItemError


class NudeNetBackend(Protocol):
    providers: tuple[str, ...]

    def detect_batch(self, images: Sequence[DecodedImage]) -> Sequence[RawItemOutcome]: ...

    def close(self) -> None: ...


class NudeNetOnnxBackend:
    """Pinned NudeNet preprocessing/model/postprocessing with an owned ONNX session."""

    def __init__(
        self,
        *,
        model_spec: NudeNetModelSpec,
        model_path: Path,
        session_factory: OnnxSessionFactory,
        read_image: Callable[..., tuple],
        postprocess: Callable[..., list[dict[str, object]]],
        providers: Sequence[str] = DEFAULT_NUDITY_PROVIDERS,
        require_gpu: bool = True,
        batch_size: int = DEFAULT_NUDITY_BATCH_SIZE,
        fp16_enabled: bool = False,
    ) -> None:
        if batch_size < 1:
            raise ValueError("NudeNet batch size must be at least 1")
        if not model_path.is_file():
            raise RuntimeError(f"NudeNet {model_spec.name} model is not provisioned")
        if _sha256(model_path) != model_spec.sha256:
            raise RuntimeError(
                f"NudeNet {model_spec.name} model hash does not match the pinned artifact"
            )

        requested_providers = list(dict.fromkeys(providers))
        if "CPUExecutionProvider" not in requested_providers:
            requested_providers.append("CPUExecutionProvider")
        if require_gpu and "MIGraphXExecutionProvider" not in requested_providers:
            raise RuntimeError("MIGraphXExecutionProvider is required for NudeNet")
        session_providers = [
            (provider, {"migraphx_fp16_enable": "1"})
            if provider == "MIGraphXExecutionProvider" and fp16_enabled else provider
            for provider in requested_providers
        ]
        try:
            self._session: OnnxSession | None = session_factory(
                str(model_path), providers=session_providers
            )
        except Exception:
            if require_gpu or requested_providers == ["CPUExecutionProvider"]:
                raise
            logger.warning("NudeNet GPU session initialization failed; falling back to CPU")
            self._session = session_factory(str(model_path), providers=["CPUExecutionProvider"])

        self.providers = tuple(self._session.get_providers())
        if require_gpu and "MIGraphXExecutionProvider" not in self.providers:
            self._session = None
            raise RuntimeError("MIGraphXExecutionProvider is not active for NudeNet")
        self._read_image = read_image
        self._postprocess = postprocess
        self._input_width = model_spec.inference_resolution
        self._input_height = model_spec.inference_resolution
        self._batch_size = batch_size
        model_inputs = self._session.get_inputs()
        if not model_inputs or not isinstance(getattr(model_inputs[0], "name", None), str):
            raise RuntimeError("NudeNet model has no usable image input")
        self._input_name = model_inputs[0].name

    def detect_batch(self, images: Sequence[DecodedImage]) -> list[RawItemOutcome]:
        session = self._session
        if session is None:
            raise RuntimeError("NudeNet backend is closed")

        results: list[RawItemOutcome | None] = [None] * len(images)
        inputs: list[np.ndarray] = []
        metadata: list[tuple] = []
        valid_indexes: list[int] = []
        for index, image in enumerate(images):
            try:
                preprocessed, *image_metadata = self._read_image(image.pixels, self._input_width)
            except Exception:
                results[index] = DetectorItemError(
                    code="IMAGE_PREPROCESSING_FAILED",
                    message="Detector could not preprocess the image",
                )
                continue
            inputs.append(preprocessed)
            metadata.append(tuple(image_metadata))
            valid_indexes.append(index)

        if inputs:
            # One padded run per fixed-size group keeps the compiled-program count at
            # one regardless of how many frames the caller supplied.
            predictions: list[np.ndarray] = []
            for group_start in range(0, len(inputs), self._batch_size):
                group = inputs[group_start : group_start + self._batch_size]
                batch_input = np.vstack(group)
                padding = self._batch_size - len(group)
                if padding > 0:
                    batch_input = np.vstack(
                        [batch_input, np.repeat(batch_input[:1], padding, axis=0)]
                    )
                group_output = session.run(None, {self._input_name: batch_input})[0]
                # Padded rows are discarded; detection is independent per row.
                predictions.extend(
                    group_output[offset : offset + 1] for offset in range(len(group))
                )

            for batch_index, (item_index, image_metadata) in enumerate(
                zip(valid_indexes, metadata, strict=True)
            ):
                try:
                    results[item_index] = self._postprocess(
                        [predictions[batch_index]],
                        image_metadata[2],
                        image_metadata[3],
                        image_metadata[0],
                        image_metadata[1],
                        image_metadata[4],
                        image_metadata[5],
                        self._input_width,
                        self._input_height,
                    )
                except Exception:
                    results[item_index] = DetectorItemError(
                        code="MALFORMED_DETECTOR_OUTPUT",
                        message="Detector returned malformed output for the image",
                    )

        if any(result is None for result in results):
            raise RuntimeError("NudeNet backend did not produce one outcome per image")
        return [result for result in results if result is not None]

    def close(self) -> None:
        self._session = None


class NudeNet320Backend(NudeNetOnnxBackend):
    """Compatibility constructor for the bundled pinned 320n model."""

    def __init__(
        self,
        *,
        model_path: Path,
        session_factory: OnnxSessionFactory,
        read_image: Callable[..., tuple],
        postprocess: Callable[..., list[dict[str, object]]],
        providers: Sequence[str] = DEFAULT_NUDITY_PROVIDERS,
        require_gpu: bool = True,
        batch_size: int = DEFAULT_NUDITY_BATCH_SIZE,
    ) -> None:
        super().__init__(
            model_spec=NUDENET_320N_SPEC,
            model_path=model_path,
            session_factory=session_factory,
            read_image=read_image,
            postprocess=postprocess,
            providers=providers,
            require_gpu=require_gpu,
            batch_size=batch_size,
        )


def resolve_nudenet_model_path(model_spec: NudeNetModelSpec, model_cache_dir: Path) -> Path:
    """Resolve a pinned artifact without downloading it during service operation."""
    if model_spec.name == "320n":
        return Path(str(files("nudenet").joinpath("320n.onnx")))
    return model_cache_dir / "nudenet" / f"{model_spec.name}.onnx"


class NudeNetDetectorAdapter:
    """Lazy provider adapter exposing only the selected canonical taxonomy."""

    capability = "nudity"
    taxonomy_revision = "nudenet-selected-11-v1"
    model_revision = NUDENET_MODEL_REVISION

    def __init__(
        self,
        backend_factory: Callable[[], NudeNetBackend] | None = None,
        *,
        model_name: str = NUDENET_DEFAULT_MODEL,
        model_cache_dir: Path = DEFAULT_MODEL_CACHE_DIR,
        providers: Sequence[str] = DEFAULT_NUDITY_PROVIDERS,
        require_gpu: bool = True,
        fp16_enabled: bool = False,
        initialization_retry_seconds: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if initialization_retry_seconds < 0:
            raise ValueError("Initialization retry cooldown cannot be negative")
        model_spec = get_nudenet_model_spec(model_name)
        self.model_revision = model_spec.model_revision + ("/fp16" if fp16_enabled else "")
        self._backend_factory = backend_factory or (
            lambda: create_nudenet_backend(
                model_name=model_name,
                model_cache_dir=model_cache_dir,
                providers=providers,
                require_gpu=require_gpu,
                fp16_enabled=fp16_enabled,
            )
        )
        self._backend: NudeNetBackend | None = None
        self._initialization_lock = threading.Lock()
        self._require_gpu = require_gpu
        self._initialization_retry_seconds = initialization_retry_seconds
        self._clock = clock
        self._initialization_failed_at: float | None = None
        self.providers: tuple[str, ...] = ()
        self.runtime_state = "created"
        self.failure_code: str | None = None

    @property
    def ready(self) -> bool:
        return self.runtime_state == "ready" and self._backend is not None

    def analyze_batch(self, images: Sequence[DecodedImage]) -> list[DetectorItemOutcome]:
        backend = self._get_backend()
        if backend is None:
            return [
                DetectorItemError(
                    code="DETECTOR_INITIALIZATION_FAILED",
                    message="Nudity detector could not be initialized",
                )
                for _image in images
            ]

        try:
            raw_outcomes = backend.detect_batch(images)
        except Exception:
            return [
                DetectorItemError(
                    code="INFERENCE_FAILED",
                    message="Nudity detector failed to analyze the image",
                )
                for _image in images
            ]
        if len(raw_outcomes) != len(images):
            return [
                DetectorItemError(
                    code="INFERENCE_FAILED",
                    message="Nudity detector returned an invalid batch",
                )
                for _image in images
            ]

        outcomes: list[DetectorItemOutcome] = []
        for image, raw_outcome in zip(images, raw_outcomes, strict=True):
            if isinstance(raw_outcome, DetectorItemError):
                outcomes.append(raw_outcome)
                continue
            try:
                outcomes.append(
                    DetectorItemResult(findings=tuple(self._convert_findings(image, raw_outcome)))
                )
            except Exception:
                outcomes.append(
                    DetectorItemError(
                        code="MALFORMED_DETECTOR_OUTPUT",
                        message="Nudity detector returned malformed output for the image",
                    )
                )
        return outcomes

    def _get_backend(self) -> NudeNetBackend | None:
        if self._backend is not None:
            return self._backend
        if not self._initialization_retry_is_due():
            return None

        with self._initialization_lock:
            if self._backend is not None:
                return self._backend
            if not self._initialization_retry_is_due():
                return None
            self.runtime_state = "initializing"
            try:
                backend = self._backend_factory()
                if self._require_gpu and "MIGraphXExecutionProvider" not in backend.providers:
                    backend.close()
                    raise RuntimeError("MIGraphXExecutionProvider is not active for NudeNet")
            except Exception:
                self.failure_code = "DETECTOR_INITIALIZATION_FAILED"
                self.runtime_state = "failed"
                self._initialization_failed_at = self._clock()
                logger.exception("NudeNet detector initialization failed")
                return None

            self._backend = backend
            self.providers = tuple(backend.providers)
            self.failure_code = None
            self._initialization_failed_at = None
            self.runtime_state = "ready"
            return backend

    def _initialization_retry_is_due(self) -> bool:
        if self.runtime_state != "failed":
            return True
        failed_at = self._initialization_failed_at
        if failed_at is None:
            return True
        return self._clock() - failed_at >= self._initialization_retry_seconds

    def _convert_findings(
        self,
        image: DecodedImage,
        raw_detections: Sequence[RawDetection],
    ) -> list[Finding]:
        findings: list[Finding] = []
        for raw in raw_detections:
            provider_label = raw.get("class")
            if provider_label not in SELECTED_NUDITY_LABELS:
                continue
            raw_box = raw.get("box")
            if (
                not isinstance(raw_box, Sequence)
                or isinstance(raw_box, (str, bytes))
                or len(raw_box) != 4
            ):
                raise ValueError("NudeNet returned an invalid bounding box")
            x, y, width, height = (float(value) for value in raw_box)
            if not all(math.isfinite(value) for value in (x, y, width, height)):
                raise ValueError("NudeNet returned non-finite geometry")
            if width <= 0 or height <= 0:
                raise ValueError("NudeNet returned non-positive geometry")

            findings.append(
                Finding(
                    capability=self.capability,
                    label=str(provider_label),
                    score=float(raw["score"]),
                    box=NormalizedBox(
                        x1=_clamp(x / image.width),
                        y1=_clamp(y / image.height),
                        x2=_clamp((x + width) / image.width),
                        y2=_clamp((y + height) / image.height),
                    ),
                    metadata={"provider_label": provider_label},
                )
            )
        return findings

    def close(self) -> None:
        backend = self._backend
        self._backend = None
        if backend is not None:
            backend.close()
        self.providers = ()
        self.runtime_state = "stopped"


def create_nudenet_320_backend(
    providers: Sequence[str] = DEFAULT_NUDITY_PROVIDERS,
    require_gpu: bool = True,
) -> NudeNet320Backend:
    """Load only the pinned bundled model and helpers when nudity is first requested."""
    try:
        installed_version = version("nudenet")
    except PackageNotFoundError as error:
        raise RuntimeError("Pinned NudeNet package is not installed") from error
    if installed_version != NUDENET_VERSION:
        raise RuntimeError("Installed NudeNet package does not match the pinned version")

    import onnxruntime
    from nudenet.nudenet import _postprocess, _read_image

    model_path = Path(str(files("nudenet").joinpath("320n.onnx")))
    return NudeNet320Backend(
        model_path=model_path,
        session_factory=onnxruntime.InferenceSession,
        read_image=_read_image,
        postprocess=_postprocess,
        providers=providers,
        require_gpu=require_gpu,
    )


def create_nudenet_backend(
    *,
    model_name: str,
    model_cache_dir: Path,
    providers: Sequence[str] = DEFAULT_NUDITY_PROVIDERS,
    require_gpu: bool = True,
    batch_size: int = DEFAULT_NUDITY_BATCH_SIZE,
    fp16_enabled: bool = False,
) -> NudeNetOnnxBackend:
    """Create a pinned offline backend; model provisioning is an operator action."""
    try:
        installed_version = version("nudenet")
    except PackageNotFoundError as error:
        raise RuntimeError("Pinned NudeNet package is not installed") from error
    if installed_version != NUDENET_VERSION:
        raise RuntimeError("Installed NudeNet package does not match the pinned version")

    import onnxruntime
    from nudenet.nudenet import _postprocess, _read_image

    model_spec = get_nudenet_model_spec(model_name)
    model_path = resolve_nudenet_model_path(model_spec, model_cache_dir)
    return NudeNetOnnxBackend(
        model_spec=model_spec,
        model_path=model_path,
        session_factory=onnxruntime.InferenceSession,
        read_image=_read_image,
        postprocess=_postprocess,
        providers=providers,
        require_gpu=require_gpu,
        batch_size=batch_size,
        fp16_enabled=fp16_enabled,
    )


def get_nudenet_model_spec(model_name: str) -> NudeNetModelSpec:
    try:
        return NUDENET_MODEL_SPECS[model_name]
    except KeyError as error:
        raise ValueError(f"Unsupported NudeNet model: {model_name}") from error


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))
