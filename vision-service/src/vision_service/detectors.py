"""Provider-neutral detector contracts and adapters."""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from typing import Protocol

import numpy as np

from .config import Settings


@dataclass(frozen=True, slots=True)
class DecodedImage:
    """A decoded image whose lifetime is scoped to one request."""

    pixels: np.ndarray

    def __post_init__(self) -> None:
        if (
            self.pixels.ndim != 3
            or self.pixels.shape[0] <= 0
            or self.pixels.shape[1] <= 0
            or self.pixels.shape[2] != 3
            or self.pixels.dtype != np.uint8
        ):
            raise ValueError("Decoded image must be a positive uint8 BGR image")

    @property
    def width(self) -> int:
        return int(self.pixels.shape[1])

    @property
    def height(self) -> int:
        return int(self.pixels.shape[0])


@dataclass(frozen=True, slots=True)
class NormalizedBox:
    """Top-left/bottom-right coordinates in the closed interval [0, 1]."""

    x1: float
    y1: float
    x2: float
    y2: float

    def __post_init__(self) -> None:
        coordinates = (self.x1, self.y1, self.x2, self.y2)
        if not all(math.isfinite(value) and 0 <= value <= 1 for value in coordinates):
            raise ValueError("Normalized box coordinates must be finite and within [0, 1]")
        if self.x2 < self.x1 or self.y2 < self.y1:
            raise ValueError("Normalized box corners are inverted")


@dataclass(frozen=True, slots=True)
class Finding:
    """Canonical provider-neutral result returned by a detector."""

    capability: str
    label: str
    score: float
    box: NormalizedBox
    embedding: tuple[float, ...] | None = None
    metadata: dict[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.capability or not self.label:
            raise ValueError("Finding capability and label are required")
        if not math.isfinite(self.score) or not 0 <= self.score <= 1:
            raise ValueError("Finding score must be finite and within [0, 1]")
        if self.embedding is not None and not all(math.isfinite(value) for value in self.embedding):
            raise ValueError("Finding embedding must contain only finite values")
        try:
            json.dumps(self.metadata, allow_nan=False)
        except (TypeError, ValueError) as error:
            raise ValueError("Finding metadata must be finite JSON data") from error


@dataclass(frozen=True, slots=True)
class DetectorItemError:
    """Stable failure for one image without failing sibling items."""

    code: str
    message: str


@dataclass(frozen=True, slots=True)
class DetectorItemResult:
    """Successful findings for one image, including the valid empty case."""

    findings: tuple[Finding, ...]


DetectorItemOutcome = DetectorItemResult | DetectorItemError


class Detector(Protocol):
    """Interface implemented by each independently loadable vision capability."""

    capability: str
    model_revision: str
    taxonomy_revision: str
    providers: tuple[str, ...]

    def analyze_batch(self, images: Sequence[DecodedImage]) -> Sequence[DetectorItemOutcome]: ...

    def close(self) -> None: ...


class FaceEngineProtocol(Protocol):
    """Legacy InsightFace engine surface consumed only by its adapter."""

    def detect(self, image: np.ndarray) -> list[dict]: ...

    def get_active_providers(self) -> list[str]: ...

    def get_embedding_dimension(self) -> int: ...

    def close(self) -> None: ...


def _default_face_engine_factory() -> FaceEngineProtocol:
    # Keep heavyweight InsightFace imports outside application import and tests.
    from .face_engine import FaceEngine

    return FaceEngine()


class InsightFaceDetectorAdapter:
    """Translate InsightFace pixel results into the canonical detector contract."""

    capability = "faces"
    taxonomy_revision = "faces-v1"

    def __init__(
        self,
        settings: Settings,
        engine_factory: Callable[[], FaceEngineProtocol] = _default_face_engine_factory,
    ) -> None:
        self._engine = engine_factory()
        try:
            insightface_version = version("insightface")
        except PackageNotFoundError:
            insightface_version = "unknown"
        self.model_revision = f"insightface-{insightface_version}/{settings.insightface_model}"
        self.providers = tuple(self._engine.get_active_providers())
        self.embedding_dimension = self._engine.get_embedding_dimension()

    def analyze_batch(self, images: Sequence[DecodedImage]) -> list[DetectorItemOutcome]:
        outcomes: list[DetectorItemOutcome] = []
        for image in images:
            try:
                outcomes.append(DetectorItemResult(findings=tuple(self._analyze_image(image))))
            except Exception:
                outcomes.append(
                    DetectorItemError(
                        code="INFERENCE_FAILED",
                        message="Detector failed to analyze the image",
                    )
                )
        return outcomes

    def _analyze_image(self, image: DecodedImage) -> list[Finding]:
        findings: list[Finding] = []
        for raw_face in self._engine.detect(image.pixels):
            bbox = raw_face["bbox"]
            if len(bbox) != 4:
                raise ValueError("InsightFace returned an invalid bounding box")

            x1 = min(1.0, max(0.0, float(bbox[0]) / image.width))
            y1 = min(1.0, max(0.0, float(bbox[1]) / image.height))
            x2 = min(1.0, max(0.0, float(bbox[2]) / image.width))
            y2 = min(1.0, max(0.0, float(bbox[3]) / image.height))
            embedding = tuple(float(value) for value in raw_face["embedding"])
            if len(embedding) != self.embedding_dimension:
                raise ValueError("InsightFace returned an unexpected embedding dimension")

            findings.append(
                Finding(
                    capability=self.capability,
                    label="face",
                    score=float(raw_face["det_score"]),
                    box=NormalizedBox(x1=x1, y1=y1, x2=x2, y2=y2),
                    embedding=embedding,
                )
            )
        return findings

    def close(self) -> None:
        self._engine.close()
