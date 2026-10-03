"""Lifecycle for the SigLIP2 embedding capability.

Loading and the first MIGraphX compile take minutes, so the engine loads in the background
after startup and reports "initializing" until a warm inference has completed. The other
capabilities never wait on it.
"""

from __future__ import annotations

import asyncio
import logging
import time

from .clip_engine import ClipEngine
from .config import Settings
from .runtime import RuntimeState

logger = logging.getLogger(__name__)

CAPABILITY = "clip"


class ClipRuntime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.state = RuntimeState.CREATED if settings.clip_enabled else RuntimeState.STOPPED
        self.failure_code: str | None = None
        self.engine: ClipEngine | None = None
        self._task: asyncio.Task[None] | None = None
        self._image_slot = asyncio.Semaphore(1)

    @property
    def enabled(self) -> bool:
        return self.settings.clip_enabled

    @property
    def ready(self) -> bool:
        return self.state == RuntimeState.READY and self.engine is not None

    @property
    def model_revision(self) -> str:
        if self.engine is not None:
            return self.engine.model_revision
        return f"siglip2/{self.settings.clip_model}"

    @property
    def providers(self) -> tuple[str, ...]:
        return self.engine.providers if self.engine is not None else ()

    def start_background(self) -> None:
        if not self.enabled or self._task is not None:
            return
        self.state = RuntimeState.INITIALIZING
        self._task = asyncio.create_task(self._load())

    async def _load(self) -> None:
        started = time.monotonic()
        try:
            engine = await asyncio.to_thread(
                ClipEngine,
                self.settings.model_cache_dir / "siglip2" / self.settings.clip_model,
                self.settings.get_clip_onnx_providers(),
                self.settings.clip_batch_size,
                self.settings.clip_fp16_enabled,
                self.settings.clip_text_threads,
            )
            await asyncio.to_thread(engine.warm)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.state = RuntimeState.FAILED
            self.failure_code = "DETECTOR_INITIALIZATION_FAILED"
            logger.exception("SigLIP2 embedding capability failed to initialise")
            return
        self.engine = engine
        self.state = RuntimeState.READY
        logger.info(
            "Vision detector warm capability=%s seconds=%.1f providers=%s",
            CAPABILITY,
            time.monotonic() - started,
            engine.providers,
        )

    async def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self.engine = None
        self.state = RuntimeState.STOPPED

    def require_engine(self) -> ClipEngine:
        if not self.ready or self.engine is None:
            raise RuntimeError("clip capability is not ready")
        return self.engine

    @property
    def image_slot(self) -> asyncio.Semaphore:
        """One image batch at a time: the GPU program is compiled for a single batch shape."""
        return self._image_slot
