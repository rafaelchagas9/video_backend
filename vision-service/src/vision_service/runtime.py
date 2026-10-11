"""Lifecycle, capability registry, and admission control for vision detectors."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass, replace
from enum import StrEnum

import numpy as np

from .config import Settings
from .detectors import (
    DecodedImage,
    Detector,
    DetectorItemError,
    DetectorItemOutcome,
    DetectorItemResult,
    FaceEngineProtocol,
    InsightFaceDetectorAdapter,
)
from .idle import IdleModelManager, drain_native_task, native_call
from .nudity import NudeNetDetectorAdapter, create_nudenet_backend

logger = logging.getLogger(__name__)


class RuntimeState(StrEnum):
    CREATED = "created"
    INITIALIZING = "initializing"
    READY = "ready"
    IDLE = "idle"
    FAILED = "failed"
    STOPPING = "stopping"
    STOPPED = "stopped"


class RuntimeNotReadyError(RuntimeError):
    """Raised when a requested capability is not ready."""


class RuntimeBusyError(RuntimeError):
    """Raised when inference admission capacity is exhausted."""


class InferenceFailedError(RuntimeError):
    """Raised when a detector violates its contract or fails globally."""


@dataclass(frozen=True, slots=True)
class CapabilityStatus:
    name: str
    state: RuntimeState
    failure_code: str | None
    providers: tuple[str, ...]
    model_revision: str
    taxonomy_revision: str

    @property
    def ready(self) -> bool:
        return self.state in (RuntimeState.READY, RuntimeState.IDLE)


def _default_engine_factory() -> FaceEngineProtocol:
    # The adapter remains the only generic-module seam that knows FaceEngine.
    from .face_engine import FaceEngine

    return FaceEngine()


class VisionRuntime:
    """Own independently loadable detectors and bound native inference work."""

    def __init__(
        self,
        settings: Settings,
        engine_factory: Callable[[], FaceEngineProtocol] | None = None,
        detector_factories: Mapping[str, Callable[[], Detector]] | None = None,
    ) -> None:
        if engine_factory is not None and detector_factories is not None:
            raise ValueError("Configure either engine_factory or detector_factories, not both")

        self.settings = settings
        self.idle_manager: IdleModelManager | None = None
        if detector_factories is None:
            face_engine_factory = engine_factory or _default_engine_factory
            detector_factories = {
                "faces": lambda: InsightFaceDetectorAdapter(settings, face_engine_factory)
            }
            if settings.nudity_enabled:
                nudity_providers = tuple(settings.get_nudity_onnx_providers())
                detector_factories["nudity"] = lambda: NudeNetDetectorAdapter(
                    backend_factory=lambda: create_nudenet_backend(
                        model_name=settings.nudity_model,
                        model_cache_dir=settings.model_cache_dir,
                        providers=nudity_providers,
                        require_gpu=settings.nudity_require_gpu,
                        batch_size=settings.max_batch_items,
                        fp16_enabled=settings.effective_nudity_fp16(),
                    ),
                    model_name=settings.nudity_model,
                    fp16_enabled=settings.effective_nudity_fp16(),
                    require_gpu=settings.nudity_require_gpu,
                    initialization_retry_seconds=(settings.nudity_initialization_retry_seconds),
                )

        self._detector_factories = dict(detector_factories)
        self._detectors: dict[str, Detector] = {}
        self._capability_states = {
            capability: RuntimeState.CREATED for capability in self._detector_factories
        }
        self._capability_failures: dict[str, str | None] = {
            capability: None for capability in self._detector_factories
        }
        self._semaphores = {
            capability: asyncio.Semaphore(settings.max_concurrent_inferences)
            for capability in self._detector_factories
        }
        self._idle_statuses: dict[str, CapabilityStatus] = {}
        self._reload_tasks: dict[str, asyncio.Task[None]] = {}
        self._warming: set[str] = set()
        self._warmup_tasks: list[asyncio.Task[None]] = []
        self.state = RuntimeState.CREATED
        self.failure_code: str | None = None
        self.active_providers: list[str] = []
        self.embedding_dimension = 512

    @property
    def is_ready(self) -> bool:
        """Legacy readiness means the face capability is ready."""
        return self.is_capability_ready("faces")

    def has_capability(self, capability: str) -> bool:
        return capability in self._detector_factories

    def is_capability_ready(self, capability: str) -> bool:
        if self._capability_states.get(capability) == RuntimeState.IDLE:
            return True
        if capability in self._warming:
            return False
        detector = self._detectors.get(capability)
        if self._capability_states.get(capability) != RuntimeState.READY or detector is None:
            return False
        return bool(getattr(detector, "ready", True))

    @property
    def capability_names(self) -> tuple[str, ...]:
        return tuple(self._detector_factories)

    def activity(self, *capabilities: str):
        return self.idle_manager.request(*capabilities) if self.idle_manager else nullcontext()

    def is_capability_loading(self, capability: str) -> bool:
        task = self._reload_tasks.get(capability)
        return (
            capability in self._warming
            or (task is not None and not task.done())
            or self._capability_states.get(capability) == RuntimeState.INITIALIZING
        )

    @property
    def is_loading(self) -> bool:
        return any(self.is_capability_loading(name) for name in self.capability_names)

    def capability_statuses(self) -> list[CapabilityStatus]:
        statuses: list[CapabilityStatus] = []
        for name, factory in self._detector_factories.items():
            detector = self._detectors.get(name)
            if name in self._idle_statuses and detector is None:
                statuses.append(
                    replace(
                        self._idle_statuses[name],
                        state=self._capability_states[name],
                        failure_code=self._capability_failures[name],
                    )
                )
                continue
            reported_state = getattr(detector, "runtime_state", None)
            state = (
                RuntimeState(reported_state) if reported_state else self._capability_states[name]
            )
            if name in self._warming:
                state = RuntimeState.INITIALIZING
            statuses.append(
                CapabilityStatus(
                    name=name,
                    state=state,
                    failure_code=getattr(detector, "failure_code", self._capability_failures[name]),
                    providers=tuple(getattr(detector or factory, "providers", ())),
                    model_revision=str(
                        getattr(
                            detector or factory,
                            "model_revision",
                            self.settings.insightface_model if name == "faces" else "unknown",
                        )
                    ),
                    taxonomy_revision=str(
                        getattr(
                            detector or factory,
                            "taxonomy_revision",
                            "faces-v1" if name == "faces" else "unknown",
                        )
                    ),
                )
            )
        return statuses

    async def start(self) -> None:
        if self.state in (RuntimeState.INITIALIZING, RuntimeState.READY):
            return

        self.state = RuntimeState.INITIALIZING
        self.failure_code = None
        for capability in self._detector_factories:
            if self.is_capability_ready(capability):
                continue
            await self._load_detector(capability)

        self._refresh_face_status()

    async def _load_detector(self, capability: str) -> None:
        self._capability_states[capability] = RuntimeState.INITIALIZING
        detector: Detector | None = None
        try:
            detector = await native_call(self._detector_factories[capability])
            if detector.capability != capability:
                raise ValueError("Detector capability does not match its registry key")
        except Exception:
            if detector is not None:
                try:
                    await native_call(detector.close)
                except Exception:
                    logger.exception(
                        "Failed to close partially initialized detector capability=%s",
                        capability,
                    )
            self._capability_states[capability] = RuntimeState.FAILED
            self._capability_failures[capability] = "DETECTOR_INITIALIZATION_FAILED"
            logger.exception("Detector initialization failed capability=%s", capability)
            if capability == "faces":
                self._refresh_face_status()
            return

        self._detectors[capability] = detector
        self._capability_states[capability] = RuntimeState.READY
        self._capability_failures[capability] = None
        logger.info(
            "Vision detector registered capability=%s state=%s providers=%s model_revision=%s",
            capability,
            getattr(detector, "runtime_state", RuntimeState.READY.value),
            detector.providers,
            detector.model_revision,
        )
        self._refresh_face_status()
        if self.idle_manager:
            self.idle_manager.touch(capability)

    def _refresh_face_status(self) -> None:
        face_detector = self._detectors.get("faces")
        if isinstance(face_detector, InsightFaceDetectorAdapter):
            self.active_providers = list(face_detector.providers)
            self.embedding_dimension = face_detector.embedding_dimension

        if self._capability_states.get("faces") == RuntimeState.IDLE:
            self.state = RuntimeState.IDLE
        elif self.is_capability_ready("faces"):
            self.state = RuntimeState.READY
            self.failure_code = None
        else:
            self.state = RuntimeState.FAILED
            self.failure_code = "DETECTOR_INITIALIZATION_FAILED"

    async def unload_idle(self, capability: str | None = None) -> bool:
        """Release selected idle sessions; caller holds their activity admission locks."""
        statuses = {item.name: item for item in self.capability_statuses()}
        unloaded = False
        names = [capability] if capability is not None else list(self._detectors)
        for capability in names:
            if (
                capability not in self._detectors
                or self.is_capability_loading(capability)
                or not statuses[capability].ready
            ):
                continue
            detector = self._detectors.pop(capability)
            await native_call(detector.close)
            previous = statuses[capability]
            self._idle_statuses[capability] = CapabilityStatus(
                name=capability,
                state=RuntimeState.IDLE,
                failure_code=None,
                providers=(),
                model_revision=previous.model_revision,
                taxonomy_revision=previous.taxonomy_revision,
            )
            self._capability_states[capability] = RuntimeState.IDLE
            unloaded = True
        if self._capability_states.get("faces") == RuntimeState.IDLE:
            self.state = RuntimeState.IDLE
            self.active_providers = []
        return unloaded

    async def _reload_capability(self, capability: str) -> None:
        await self._load_detector(capability)
        detector = self._detectors.get(capability)
        if getattr(detector, "runtime_state", None) == RuntimeState.CREATED.value:
            self._warming.add(capability)
            await self._warm_capability(capability)

    def warm_lazy_capabilities(self) -> None:
        """Schedule background warmup for detectors that load on first use.

        Registration deliberately leaves those detectors uninitialized, so this
        is opt-in and driven by the application lifespan rather than start().
        Until a warmup finishes its capability reports as initializing, which
        keeps callers from sending work that would block on the compile.
        """
        for capability, detector in self._detectors.items():
            if getattr(detector, "runtime_state", None) != RuntimeState.CREATED.value:
                continue
            if capability in self._warming:
                continue
            self._warming.add(capability)
            task = asyncio.create_task(self._warm_capability(capability))
            self._warmup_tasks.append(task)
            task.add_done_callback(self._discard_warmup_task)

    def _discard_warmup_task(self, task: asyncio.Task[None]) -> None:
        if task in self._warmup_tasks:
            self._warmup_tasks.remove(task)

    async def _warm_capability(self, capability: str) -> None:
        """Pay a lazy detector's first-inference compile before reporting it ready.

        MIGraphX compiles the model on the first run of each input shape, which
        takes about 100 seconds. Doing that here keeps it off the first real
        request, which would otherwise exceed the caller's timeout.
        """
        detector = self._detectors.get(capability)
        if detector is None:
            self._warming.discard(capability)
            return
        try:
            images = [
                DecodedImage(np.zeros((640, 640, 3), dtype=np.uint8))
                for _ in range(self.settings.max_batch_items)
            ]
            started = time.monotonic()
            await native_call(detector.analyze_batch, images)
            logger.info(
                "Vision detector warm capability=%s seconds=%.1f providers=%s",
                capability,
                time.monotonic() - started,
                getattr(detector, "providers", ()),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Detector warmup failed capability=%s", capability)
        finally:
            self._warming.discard(capability)
            if self.idle_manager:
                self.idle_manager.touch(capability)

    async def stop(self) -> None:
        # Native loading/warmup must finish before closing its sessions.
        tasks = [*self._warmup_tasks, *self._reload_tasks.values()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._warmup_tasks = []
        self._reload_tasks = {}
        self._warming.clear()
        detectors = list(self._detectors.items())
        self.state = RuntimeState.STOPPING
        self._detectors = {}
        try:
            for capability, detector in detectors:
                try:
                    await native_call(detector.close)
                except Exception:
                    logger.exception("Failed to close detector capability=%s", capability)
                finally:
                    self._capability_states[capability] = RuntimeState.STOPPED
        finally:
            for capability in self._capability_states:
                self._capability_states[capability] = RuntimeState.STOPPED
            self.active_providers = []
            self.state = RuntimeState.STOPPED

    async def analyze_batch(
        self,
        capability: str,
        images: Sequence[DecodedImage],
    ) -> Sequence[DetectorItemOutcome]:
        async with self.activity(capability):
            return await self._analyze_batch(capability, images)

    async def analyze_visibility_batch(self, images: Sequence[DecodedImage]) -> Sequence[DetectorItemOutcome]:
        # Same model lifecycle, admission and native cancellation drain as faces.
        async with self.activity("faces"):
            return await self._analyze_batch("faces", images, visibility=True)

    async def _analyze_batch(
        self, capability: str, images: Sequence[DecodedImage], *, visibility: bool = False
    ) -> Sequence[DetectorItemOutcome]:
        task = self._reload_tasks.get(capability)
        if self._capability_states.get(capability) == RuntimeState.IDLE:
            task = asyncio.create_task(self._reload_capability(capability))
            self._reload_tasks[capability] = task
            # Set synchronously so concurrent requests share one reload.
            self._capability_states[capability] = RuntimeState.INITIALIZING
            if capability == "faces":
                self.state = RuntimeState.INITIALIZING
        if task is not None and not task.done():
            await asyncio.shield(task)
        detector = self._detectors.get(capability)
        if self._capability_states.get(capability) != RuntimeState.READY or detector is None:
            raise RuntimeNotReadyError(f"Vision capability is not ready: {capability}")

        semaphore = self._semaphores[capability]
        try:
            await asyncio.wait_for(
                semaphore.acquire(),
                timeout=self.settings.inference_acquire_timeout_seconds,
            )
        except TimeoutError as error:
            raise RuntimeBusyError("Vision detector capacity is exhausted") from error

        try:
            analyze = detector.analyze_visibility_batch if visibility else detector.analyze_batch
            inference = asyncio.create_task(asyncio.to_thread(analyze, images))
            try:
                outcomes = await asyncio.shield(inference)
            except asyncio.CancelledError:
                # Native inference cannot be interrupted. Retain admission until it ends.
                try:
                    await drain_native_task(inference)
                except Exception:
                    logger.exception(
                        "Vision inference failed after cancellation capability=%s", capability
                    )
                raise

            if len(outcomes) != len(images):
                raise ValueError("Detector returned a different number of item outcomes")
            for outcome in outcomes:
                if not isinstance(outcome, (DetectorItemResult, DetectorItemError)):
                    raise TypeError("Detector returned an invalid item outcome")
                if isinstance(outcome, DetectorItemResult) and any(
                    finding.capability != ("face_visibility" if visibility else capability) for finding in outcome.findings
                ):
                    raise ValueError("Detector returned a finding for another capability")
            return outcomes
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise InferenceFailedError("Vision inference failed") from error
        finally:
            semaphore.release()

    async def detect(self, image: np.ndarray) -> list[dict]:
        """Compatibility adapter for the legacy face routes."""
        decoded = DecodedImage(image)
        outcomes = await self.analyze_batch("faces", [decoded])
        outcome = outcomes[0]
        if isinstance(outcome, DetectorItemError):
            raise InferenceFailedError(outcome.message)

        faces: list[dict] = []
        for finding in outcome.findings:
            if finding.embedding is None:
                raise InferenceFailedError("Face finding has no embedding")
            faces.append(
                {
                    "bbox": [
                        finding.box.x1 * decoded.width,
                        finding.box.y1 * decoded.height,
                        finding.box.x2 * decoded.width,
                        finding.box.y2 * decoded.height,
                    ],
                    "embedding": list(finding.embedding),
                    "det_score": finding.score,
                }
            )
        return faces
