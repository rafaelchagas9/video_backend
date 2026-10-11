"""Unload each resident capability after its own inference traffic has been quiet."""

from __future__ import annotations

import asyncio
import ctypes
import gc
import logging
import time
from contextlib import AsyncExitStack, asynccontextmanager

logger = logging.getLogger(__name__)


def release_native_memory() -> None:
    """Collect session cycles and return unused glibc heap pages where supported."""
    gc.collect()
    try:
        trim = ctypes.CDLL(None).malloc_trim
    except (AttributeError, OSError):
        return
    trim.argtypes = [ctypes.c_size_t]
    trim.restype = ctypes.c_int
    trim(0)


async def drain_native_task(task):
    """Repeated request cancellation cannot release a still-running native worker."""
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
        except Exception:
            break
    return task.result()


async def native_call(function, *args):
    """A cancelled coroutine must wait for its native worker before releasing models."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await drain_native_task(task)
        except Exception:
            logger.exception("Native work failed after request cancellation")
        raise


class IdleModelManager:
    def __init__(self, runtime, clip_runtime, timeout_seconds: float, clock=time.monotonic):
        self.runtime = runtime
        self.clip_runtime = clip_runtime
        self.timeout_seconds = timeout_seconds
        self.clock = clock
        names = (
            *getattr(runtime, "capability_names", ()),
            *(("clip",) if clip_runtime.enabled else ()),
        )
        self.last_activity = {name: clock() for name in names}
        self.active_requests = {name: 0 for name in names}
        self._locks = {name: asyncio.Lock() for name in names}
        runtime.idle_manager = self
        clip_runtime.idle_manager = self
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        for name in self.last_activity:
            self.touch(name)
        logger.info(
            "Vision idle timeout seconds=%.0f capabilities=%s",
            self.timeout_seconds,
            tuple(self.last_activity),
        )
        if self.timeout_seconds > 0:
            self._task = asyncio.create_task(self._watch())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def touch(self, capability: str) -> None:
        if capability in self.last_activity:
            self.last_activity[capability] = self.clock()

    @asynccontextmanager
    async def request(self, *capabilities: str):
        names = sorted(set(capabilities) & self._locks.keys())
        # Reserve every requested capability before batch decoding or queueing.
        # Admission and unloading share its lock; unrelated models remain independent.
        async with AsyncExitStack() as stack:
            for name in names:
                await stack.enter_async_context(self._locks[name])
            for name in names:
                self.active_requests[name] += 1
                self.touch(name)
        try:
            yield
        finally:
            for name in names:
                self.active_requests[name] -= 1
                self.touch(name)

    async def unload_if_idle(self) -> bool:
        if self.timeout_seconds <= 0:
            return False
        unloaded = False
        for capability, lock in self._locks.items():
            async with lock:
                loading = (
                    self.clip_runtime.is_loading
                    if capability == "clip"
                    else self.runtime.is_capability_loading(capability)
                )
                if self.active_requests[capability] or loading:
                    continue
                idle_seconds = self.clock() - self.last_activity[capability]
                if idle_seconds < self.timeout_seconds:
                    continue
                released = (
                    await self.clip_runtime.unload_idle()
                    if capability == "clip"
                    else await self.runtime.unload_idle(capability)
                )
                if released:
                    unloaded = True
                    logger.info(
                        "Vision model unloaded capability=%s idle_seconds=%.0f",
                        capability,
                        idle_seconds,
                    )
        if unloaded:
            await native_call(release_native_memory)
        return unloaded

    async def _watch(self) -> None:
        interval = min(30.0, self.timeout_seconds)
        while True:
            await asyncio.sleep(interval)
            try:
                await self.unload_if_idle()
            except Exception:
                logger.exception("Idle model cleanup failed")
