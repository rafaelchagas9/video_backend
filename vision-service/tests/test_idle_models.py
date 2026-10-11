from __future__ import annotations

import asyncio
import json
import threading
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import HTTPException
from pydantic import ValidationError

from vision_service.clip_runtime import ClipRuntime
from vision_service.config import Settings, get_settings
from vision_service.detectors import DecodedImage, DetectorItemResult
from vision_service.idle import IdleModelManager, native_call
from vision_service.main import create_app
from vision_service.routes.embeddings import _require_ready
from vision_service.runtime import RuntimeNotReadyError, RuntimeState, VisionRuntime


class FakeDetector:
    capability = "faces"
    providers = ("fake",)
    model_revision = "fake-model"
    taxonomy_revision = "fake-taxonomy"

    def __init__(self):
        self.closed = False

    def analyze_batch(self, images):
        if self.closed:
            raise RuntimeError("Inference on closed detector")
        return [DetectorItemResult(()) for _ in images]

    def close(self):
        self.closed = True


class FakeClip:
    model_revision = "fake-clip"
    providers = ("fake",)
    dimension = 2

    def __init__(self, *args):
        self.closed = False

    def warm(self):
        pass

    def close(self):
        self.closed = True

    def embed_texts(self, texts):
        if self.closed:
            raise RuntimeError("Inference on closed clip")
        return np.ones((len(texts), self.dimension), dtype=np.float32)


async def invoke(app, method, path, body=b"", content_type=b"application/json"):
    messages = []
    received = False

    async def receive():
        nonlocal received
        if received:
            return {"type": "http.disconnect"}
        received = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "query_string": b"",
            "root_path": "",
            "headers": [(b"content-type", content_type)],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8100),
        },
        receive,
        send,
    )
    status = next(item["status"] for item in messages if item["type"] == "http.response.start")
    payload = json.loads(b"".join(item.get("body", b"") for item in messages))
    return status, payload


class IdleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0.0
        self.settings = Settings(_env_file=None, clip_enabled=False)
        self.created = []

        def factory():
            detector = FakeDetector()
            self.created.append(detector)
            return detector

        self.runtime = VisionRuntime(self.settings, detector_factories={"faces": factory})
        await self.runtime.start()
        self.addAsyncCleanup(self.runtime.stop)
        self.clip = ClipRuntime(self.settings)
        self.manager = IdleModelManager(self.runtime, self.clip, 1800, lambda: self.now)

    async def test_idle_unloads_and_first_inference_reloads(self):
        self.now = 1799
        self.assertFalse(await self.manager.unload_if_idle())
        self.now = 1800
        self.assertTrue(await self.manager.unload_if_idle())
        self.assertTrue(self.created[0].closed)
        self.assertTrue(self.runtime.is_ready)
        status = self.runtime.capability_statuses()[0]
        self.assertEqual(status.state, RuntimeState.IDLE)
        self.assertEqual(status.providers, ())
        self.assertEqual(status.model_revision, "fake-model")
        self.assertFalse(await self.manager.unload_if_idle())
        async with self.manager.request("faces"):
            results = await self.runtime.analyze_batch(
                "faces", [DecodedImage(np.zeros((1, 1, 3), dtype=np.uint8))]
            )
        self.assertEqual(len(results), 1)
        self.assertEqual(len(self.created), 2)
        self.assertEqual(self.runtime.state, RuntimeState.READY)

    async def test_long_request_and_completion_restart_the_idle_countdown(self):
        async with self.manager.request("faces"):
            self.now = 7200
            self.assertFalse(await self.manager.unload_if_idle())
        self.now = 8999
        self.assertFalse(await self.manager.unload_if_idle())
        self.now = 9000
        self.assertTrue(await self.manager.unload_if_idle())

    async def test_zero_disables_unloading(self):
        self.manager.timeout_seconds = 0
        self.now = 100000
        self.assertFalse(await self.manager.unload_if_idle())
        self.assertFalse(self.created[0].closed)

    async def test_stopping_an_idle_runtime_prevents_reloading(self):
        await self.runtime.unload_idle()
        await self.runtime.stop()
        self.assertFalse(self.runtime.is_ready)
        self.assertEqual(self.runtime.capability_statuses()[0].state, RuntimeState.STOPPED)
        with self.assertRaises(RuntimeNotReadyError):
            await self.runtime.analyze_batch("faces", [])

    async def test_http_health_stays_available_and_detection_wakes_idle_models(self):
        app = create_app(runtime=self.runtime, clip_runtime=self.clip)
        app.dependency_overrides[get_settings] = lambda: self.settings
        manager = app.state.idle_model_manager
        manager.clock = lambda: self.now
        manager.last_activity["faces"] = 0
        self.now = 1800
        self.assertTrue(await manager.unload_if_idle())
        for path in ("/readyz", "/health", "/v1/capabilities"):
            status, payload = await invoke(app, "GET", path)
            self.assertEqual(status, 200)
        self.assertEqual(payload["capabilities"][0]["state"], "idle")
        self.assertEqual(len(self.created), 1)
        self.assertEqual(manager.last_activity["faces"], 0)

        _, image = cv2.imencode(".jpg", np.zeros((8, 8, 3), dtype=np.uint8))
        body = (
            b'--test\r\nContent-Disposition: form-data; name="file"; filename="test.jpg"\r\n'
            b"Content-Type: image/jpeg\r\n\r\n" + image.tobytes() + b"\r\n--test--\r\n"
        )
        status, payload = await invoke(
            app, "POST", "/detect", body, b"multipart/form-data; boundary=test"
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["faces"], [])
        self.assertEqual(len(self.created), 2)
        self.assertEqual(manager.last_activity["faces"], 1800)
        self.assertEqual(manager.active_requests["faces"], 0)

    async def test_concurrent_requests_share_reload_even_when_one_is_cancelled(self):
        await self.runtime.unload_idle()
        entered, release = threading.Event(), threading.Event()

        def factory():
            entered.set()
            release.wait(2)
            self.created.append(FakeDetector())
            return self.created[-1]

        self.runtime._detector_factories["faces"] = factory
        images = [DecodedImage(np.zeros((1, 1, 3), dtype=np.uint8))]
        first = asyncio.create_task(self.runtime.analyze_batch("faces", images))
        await asyncio.to_thread(entered.wait, 1)
        second = asyncio.create_task(self.runtime.analyze_batch("faces", images))
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.now = 5000
        self.assertFalse(await self.manager.unload_if_idle())
        release.set()
        await second
        self.assertEqual(len(self.created), 2)

    async def test_reload_failure_stays_failed(self):
        await self.runtime.unload_idle()

        def fail():
            raise RuntimeError("Missing model")

        self.runtime._detector_factories["faces"] = fail
        with self.assertRaises(RuntimeNotReadyError):
            await self.runtime.analyze_batch("faces", [])
        self.assertFalse(self.runtime.is_ready)
        self.assertEqual(self.runtime.state, RuntimeState.FAILED)
        self.assertEqual(self.runtime.failure_code, "DETECTOR_INITIALIZATION_FAILED")

    async def test_watchdog_unloads_without_a_new_request(self):
        self.manager.timeout_seconds = 0.01
        self.manager.start()
        self.addAsyncCleanup(self.manager.stop)
        self.now = 1
        for _ in range(100):
            if self.created[0].closed:
                break
            await asyncio.sleep(0.01)
        self.assertTrue(self.created[0].closed)

    async def test_cancelled_native_work_finishes_before_request_is_released(self):
        entered, release = threading.Event(), threading.Event()

        def work():
            entered.set()
            release.wait(2)

        async def request():
            async with self.manager.request("faces"):
                await native_call(work)

        task = asyncio.create_task(request())
        await asyncio.to_thread(entered.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        self.now = 5000
        self.assertEqual(self.manager.active_requests["faces"], 1)
        self.assertFalse(await self.manager.unload_if_idle())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.manager.active_requests["faces"], 0)


class ClipIdleTests(unittest.IsolatedAsyncioTestCase):
    async def test_clip_unloads_and_shares_reload(self):
        clip = ClipRuntime(Settings(_env_file=None, clip_enabled=True))
        self.addAsyncCleanup(clip.stop)
        with patch("vision_service.clip_runtime.ClipEngine", FakeClip):
            clip.start_background()
            await clip.ensure_loaded()
            old = clip.engine
            self.assertTrue(await clip.unload_idle())
            self.assertTrue(old.closed)
            self.assertTrue(clip.ready)
            self.assertEqual(clip.providers, ())
            await asyncio.gather(_require_ready(clip), _require_ready(clip))
            self.assertTrue(clip.ready)
            self.assertIsNot(clip.engine, old)
            self.assertFalse(clip.engine.closed)

    async def test_initial_startup_still_reports_not_ready_without_waiting(self):
        clip = ClipRuntime(Settings(_env_file=None, clip_enabled=True))
        with patch("vision_service.clip_runtime.ClipEngine", FakeClip):
            clip.start_background()
            with self.assertRaises(HTTPException) as error:
                await _require_ready(clip)
            self.assertEqual(error.exception.status_code, 503)
            await clip.stop()

    async def test_shutdown_waits_for_native_model_initialization(self):
        entered, release = threading.Event(), threading.Event()

        class BlockingClip(FakeClip):
            def warm(self):
                entered.set()
                release.wait(2)

        clip = ClipRuntime(Settings(_env_file=None, clip_enabled=True))
        with patch("vision_service.clip_runtime.ClipEngine", BlockingClip):
            clip.start_background()
            await asyncio.to_thread(entered.wait, 1)
            stop = asyncio.create_task(clip.stop())
            await asyncio.sleep(0)
            self.assertFalse(stop.done())
            release.set()
            await stop
        self.assertIsNone(clip.engine)
        self.assertEqual(clip.state, RuntimeState.STOPPED)


class IndependentIdleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0.0
        self.settings = Settings(_env_file=None, clip_enabled=True)
        self.created = {"faces": [], "nudity": []}

        def factory(name):
            detector = FakeDetector()
            detector.capability = name
            self.created[name].append(detector)
            return detector

        self.runtime = VisionRuntime(
            self.settings,
            detector_factories={name: lambda name=name: factory(name) for name in self.created},
        )
        self.clip = ClipRuntime(self.settings)
        self.manager = IdleModelManager(self.runtime, self.clip, 1800, lambda: self.now)
        await self.runtime.start()
        self.clip_patch = patch("vision_service.clip_runtime.ClipEngine", FakeClip)
        self.clip_patch.start()
        self.addCleanup(self.clip_patch.stop)
        self.clip.start_background()
        await self.clip.ensure_loaded()
        self.addAsyncCleanup(self.runtime.stop)
        self.addAsyncCleanup(self.clip.stop)

    async def test_face_activity_does_not_keep_nudity_or_clip_resident(self):
        self.now = 1700
        await self.runtime.analyze_batch("faces", [])
        old_clip = self.clip.engine
        self.assertEqual(self.manager.last_activity, {"faces": 1700, "nudity": 0, "clip": 0})
        self.now = 1800
        self.assertTrue(await self.manager.unload_if_idle())
        self.assertFalse(self.created["faces"][0].closed)
        self.assertTrue(self.created["nudity"][0].closed)
        self.assertTrue(old_clip.closed)
        self.assertEqual(self.clip.state, RuntimeState.IDLE)
        self.assertFalse(await self.manager.unload_if_idle())
        self.now = 3500
        self.assertTrue(await self.manager.unload_if_idle())
        self.assertTrue(self.created["faces"][0].closed)

    async def test_active_clip_does_not_protect_other_capabilities(self):
        old_clip = self.clip.engine
        async with self.clip.activity():
            self.now = 7200
            self.assertTrue(await self.manager.unload_if_idle())
            self.assertTrue(self.created["faces"][0].closed)
            self.assertTrue(self.created["nudity"][0].closed)
            self.assertFalse(old_clip.closed)
        self.now = 8999
        self.assertFalse(await self.manager.unload_if_idle())
        self.now = 9000
        self.assertTrue(await self.manager.unload_if_idle())
        self.assertTrue(old_clip.closed)

    async def test_reload_protects_only_its_capability_and_resets_its_clock(self):
        await self.clip.unload_idle()
        entered, release = threading.Event(), threading.Event()

        class BlockingClip(FakeClip):
            def warm(self):
                entered.set()
                release.wait(2)

        with patch("vision_service.clip_runtime.ClipEngine", BlockingClip):
            reload = asyncio.create_task(self.clip.ensure_loaded())
            await asyncio.to_thread(entered.wait, 1)
            self.now = 5000
            self.assertTrue(await self.manager.unload_if_idle())
            self.assertTrue(self.created["faces"][0].closed)
            self.assertTrue(self.created["nudity"][0].closed)
            release.set()
            await reload
        self.assertEqual(self.manager.last_activity["clip"], 5000)
        self.assertFalse(await self.manager.unload_if_idle())
        self.assertFalse(self.clip.engine.closed)

    def make_app(self):
        app = create_app(runtime=self.runtime, clip_runtime=self.clip)
        app.dependency_overrides[get_settings] = lambda: self.settings
        self.manager = app.state.idle_model_manager
        self.manager.clock = lambda: self.now
        self.manager.last_activity = dict.fromkeys(self.manager.last_activity, 0)
        return app

    async def test_multi_capability_http_batch_resets_both_timers_only(self):
        app = self.make_app()
        self.now = 1700
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces", "nudity"],
                "items": [{"id": "frame", "timestamp_seconds": 0, "file_field": "image"}],
            }
        ).encode()
        _, image = cv2.imencode(".jpg", np.zeros((8, 8, 3), dtype=np.uint8))
        body = (
            b'--test\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n'
            + manifest
            + b'\r\n--test\r\nContent-Disposition: form-data; name="image"; filename="test.jpg"\r\n'
            b"Content-Type: image/jpeg\r\n\r\n" + image.tobytes() + b"\r\n--test--\r\n"
        )
        status, payload = await invoke(
            app, "POST", "/v1/analyze", body, b"multipart/form-data; boundary=test"
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            [outcome["status"] for outcome in payload["items"][0]["outcomes"]], ["ok", "ok"]
        )
        self.assertEqual(self.manager.last_activity, {"faces": 1700, "nudity": 1700, "clip": 0})
        self.assertEqual(self.manager.active_requests, {"faces": 0, "nudity": 0, "clip": 0})
        self.now = 1800
        self.assertTrue(await self.manager.unload_if_idle())
        self.assertEqual(self.clip.state, RuntimeState.IDLE)
        self.assertFalse(self.created["faces"][0].closed)
        self.assertFalse(self.created["nudity"][0].closed)

    async def test_embedding_http_request_resets_only_clip(self):
        app = self.make_app()
        self.now = 1700
        status, _ = await invoke(app, "POST", "/v1/embeddings/text", b'{"texts":["test"]}')
        self.assertEqual(status, 200)
        self.assertEqual(self.manager.last_activity, {"faces": 0, "nudity": 0, "clip": 1700})
        self.now = 1800
        self.assertTrue(await self.manager.unload_if_idle())
        self.assertFalse(self.clip.engine.closed)
        self.assertTrue(self.created["faces"][0].closed)
        self.assertTrue(self.created["nudity"][0].closed)

    async def test_health_and_invalid_requests_do_not_refresh_any_timer(self):
        app = self.make_app()
        self.now = 1700
        for path in ("/health", "/livez", "/readyz", "/v1/capabilities"):
            status, _ = await invoke(app, "GET", path)
            self.assertEqual(status, 200)
        status, _ = await invoke(app, "POST", "/v1/analyze", b"{}")
        self.assertEqual(status, 400)
        self.assertEqual(self.manager.last_activity, {"faces": 0, "nudity": 0, "clip": 0})


class TimeoutSettingsTests(unittest.TestCase):
    def test_timeout_default_and_validation(self):
        self.assertEqual(Settings(_env_file=None).model_idle_timeout_seconds, 1800)
        for value in (-1, float("inf"), float("nan")):
            with self.assertRaises(ValidationError):
                Settings(_env_file=None, model_idle_timeout_seconds=value)
