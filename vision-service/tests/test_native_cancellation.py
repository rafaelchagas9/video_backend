"""Native cancellation regression coverage with fake threads and no model imports."""
import asyncio
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from vision_service.idle import IdleModelManager, native_call


class NativeCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cancel_retains_activity_until_native_worker_drains(self):
        entered = threading.Event()
        release = threading.Event()
        now = [0]
        runtime = SimpleNamespace(capability_names=("faces",), is_capability_loading=lambda name: False,
                                  unload_idle=AsyncMock(return_value=False))
        clip = SimpleNamespace(enabled=False)
        manager = IdleModelManager(runtime, clip, 1, clock=lambda: now[0])

        def native():
            entered.set()
            if not release.wait(2):
                raise RuntimeError("Fake native worker was not released")
            return 1

        async def request():
            async with manager.request("faces"):
                return await native_call(native)

        running = asyncio.create_task(request())
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            now[0] = 10
            for _ in range(3):
                running.cancel()
                await asyncio.sleep(0)
                self.assertFalse(running.done())
                self.assertEqual(manager.active_requests["faces"], 1)
                await manager.unload_if_idle()
                runtime.unload_idle.assert_not_awaited()
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await running
        self.assertEqual(manager.active_requests["faces"], 0)
        now[0] = 20
        await manager.unload_if_idle()
        runtime.unload_idle.assert_awaited_once_with("faces")

    async def test_native_errors_after_cancel_are_retrieved_and_cancellation_wins(self):
        entered = threading.Event()
        release = threading.Event()

        def failing():
            entered.set()
            release.wait(2)
            raise RuntimeError("Synthetic native failure")

        running = asyncio.create_task(native_call(failing))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            for _ in range(2):
                running.cancel()
                await asyncio.sleep(0)
            release.set()
            with self.assertLogs("vision_service.idle", level="ERROR"):
                with self.assertRaises(asyncio.CancelledError):
                    await running
        finally:
            release.set()


if __name__ == "__main__":
    unittest.main()
