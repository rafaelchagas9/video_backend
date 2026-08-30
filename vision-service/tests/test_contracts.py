from __future__ import annotations

import asyncio
import os
import threading
import unittest
from pathlib import Path
from tempfile import SpooledTemporaryFile, TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import ValidationError
from starlette.middleware.cors import CORSMiddleware

from vision_service.config import VISION_SERVICE_ROOT, Settings, get_settings
from vision_service.main import create_app
from vision_service.routes.detect import (
    FaceResult,
    detect_faces,
    extract_embedding_base64,
    require_internal_auth,
)
from vision_service.routes.health import capabilities, health_check, livez, readyz
from vision_service.runtime import (
    InferenceFailedError,
    RuntimeBusyError,
    RuntimeNotReadyError,
    RuntimeState,
    VisionRuntime,
)


def make_upload(contents: bytes) -> UploadFile:
    file = SpooledTemporaryFile(max_size=max(1, len(contents) + 1))
    file.write(contents)
    file.seek(0)
    return UploadFile(filename="frame.jpg", file=file)


class FakeEngine:
    def __init__(self) -> None:
        self.detect_thread_id: int | None = None

    def detect(self, image: np.ndarray) -> list[dict]:
        self.detect_thread_id = threading.get_ident()
        return [{"bbox": [1.0, 2.0, 3.0, 4.0], "embedding": [0.0] * 512, "det_score": 0.9}]

    def get_active_providers(self) -> list[str]:
        return ["CPUExecutionProvider"]

    def get_embedding_dimension(self) -> int:
        return 512

    def close(self) -> None:
        return None


class BlockingEngine(FakeEngine):
    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def detect(self, image: np.ndarray) -> list[dict]:
        self.entered.set()
        self.release.wait(timeout=2)
        return []


def make_settings(**overrides: object) -> Settings:
    return Settings(
        _env_file=None,
        model_cache_dir=VISION_SERVICE_ROOT / "models",
        **overrides,
    )


class SettingsTests(unittest.TestCase):
    def tearDown(self) -> None:
        get_settings.cache_clear()

    def test_defaults_are_independent_from_current_working_directory(self) -> None:
        original_cwd = Path.cwd()
        with TemporaryDirectory() as temporary_directory:
            os.chdir(temporary_directory)
            try:
                settings = Settings(_env_file=None)
            finally:
                os.chdir(original_cwd)

        self.assertEqual(settings.model_cache_dir, VISION_SERVICE_ROOT / "models")

    def test_project_env_file_is_loaded_from_vision_service_root(self) -> None:
        original_cwd = Path.cwd()
        with TemporaryDirectory() as temporary_directory:
            os.chdir(temporary_directory)
            try:
                settings = get_settings()
            finally:
                os.chdir(original_cwd)

        self.assertIsInstance(settings, Settings)

    def test_relative_model_cache_is_resolved_from_vision_service_root(self) -> None:
        settings = Settings(_env_file=None, model_cache_dir="custom-models")

        self.assertEqual(settings.model_cache_dir, VISION_SERVICE_ROOT / "custom-models")


class ContractTests(unittest.TestCase):
    def test_face_response_does_not_advertise_age_or_gender(self) -> None:
        runtime = VisionRuntime(make_settings(), engine_factory=FakeEngine)
        schema = create_app(runtime=runtime).openapi()
        properties = schema["components"]["schemas"]["FaceResult"]["properties"]

        self.assertNotIn("age", properties)
        self.assertNotIn("gender", properties)

    def test_face_response_rejects_invalid_shape_dimension_and_score(self) -> None:
        valid = {
            "bbox": [0.0, 0.0, 10.0, 10.0],
            "embedding": [0.01] * 512,
            "det_score": 0.9,
        }
        FaceResult(**valid)

        for invalid in (
            {**valid, "bbox": [0.0, 0.0, 10.0]},
            {**valid, "embedding": [0.01] * 511},
            {**valid, "det_score": 1.1},
        ):
            with self.subTest(fields=list(invalid)):
                with self.assertRaises(ValidationError):
                    FaceResult(**invalid)

    def test_operational_routes_are_exposed(self) -> None:
        runtime = VisionRuntime(make_settings(), engine_factory=FakeEngine)
        paths = create_app(runtime=runtime).openapi()["paths"]

        self.assertIn("/livez", paths)
        self.assertIn("/readyz", paths)
        self.assertIn("/capabilities", paths)
        self.assertIn("/health", paths)

    def test_cors_is_not_enabled_for_the_internal_service(self) -> None:
        runtime = VisionRuntime(make_settings(), engine_factory=FakeEngine)
        application = create_app(runtime=runtime)

        self.assertFalse(
            any(middleware.cls is CORSMiddleware for middleware in application.user_middleware)
        )

    def test_only_inference_routes_advertise_bearer_auth(self) -> None:
        runtime = VisionRuntime(make_settings(), engine_factory=FakeEngine)
        paths = create_app(runtime=runtime).openapi()["paths"]

        self.assertTrue(paths["/detect"]["post"]["security"])
        self.assertTrue(paths["/extract-embedding"]["post"]["security"])
        for public_path in ("/health", "/livez", "/readyz", "/capabilities"):
            self.assertNotIn("security", paths[public_path]["get"])


class InternalAuthTests(unittest.TestCase):
    def test_authentication_is_disabled_when_secret_is_not_configured(self) -> None:
        require_internal_auth(credentials=None, settings=make_settings())

    def test_missing_or_invalid_credentials_have_the_same_stable_error(self) -> None:
        settings = make_settings(internal_api_secret="top-secret")
        cases = [
            None,
            HTTPAuthorizationCredentials(scheme="Bearer", credentials="wrong"),
            HTTPAuthorizationCredentials(scheme="Basic", credentials="top-secret"),
        ]

        for credentials in cases:
            with self.subTest(credentials=credentials):
                with self.assertRaises(HTTPException) as captured:
                    require_internal_auth(credentials=credentials, settings=settings)

                self.assertEqual(captured.exception.status_code, 401)
                self.assertEqual(captured.exception.detail["code"], "INTERNAL_AUTH_REQUIRED")
                self.assertNotIn("top-secret", str(captured.exception.detail))

    def test_valid_bearer_secret_is_accepted(self) -> None:
        settings = make_settings(internal_api_secret="top-secret")
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="top-secret")

        require_internal_auth(credentials=credentials, settings=settings)
        self.assertNotIn("top-secret", repr(settings))


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_inference_runs_outside_the_event_loop_thread(self) -> None:
        engine = FakeEngine()
        runtime = VisionRuntime(make_settings(), engine_factory=lambda: engine)
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        event_loop_thread = threading.get_ident()
        result = await runtime.detect(np.zeros((1, 1, 3), dtype=np.uint8))

        self.assertEqual(len(result), 1)
        self.assertNotEqual(engine.detect_thread_id, event_loop_thread)

    async def test_runtime_rejects_work_when_capacity_is_exhausted(self) -> None:
        engine = BlockingEngine()
        runtime = VisionRuntime(
            make_settings(max_concurrent_inferences=1, inference_acquire_timeout_seconds=0.01),
            engine_factory=lambda: engine,
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        first = asyncio.create_task(runtime.detect(np.zeros((1, 1, 3), dtype=np.uint8)))
        await asyncio.to_thread(engine.entered.wait, 1)
        with self.assertRaises(RuntimeBusyError):
            await runtime.detect(np.zeros((1, 1, 3), dtype=np.uint8))

        engine.release.set()
        await first

    async def test_cancelled_request_keeps_its_slot_until_native_inference_finishes(self) -> None:
        engine = BlockingEngine()
        runtime = VisionRuntime(
            make_settings(max_concurrent_inferences=1, inference_acquire_timeout_seconds=0.01),
            engine_factory=lambda: engine,
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        first = asyncio.create_task(runtime.detect(np.zeros((1, 1, 3), dtype=np.uint8)))
        await asyncio.to_thread(engine.entered.wait, 1)
        first.cancel()
        await asyncio.sleep(0)

        self.assertFalse(first.done())
        with self.assertRaises(RuntimeBusyError):
            await runtime.detect(np.zeros((1, 1, 3), dtype=np.uint8))

        engine.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await first

    async def test_initialization_failure_keeps_liveness_but_fails_readiness(self) -> None:
        def fail() -> FakeEngine:
            raise RuntimeError("model unavailable")

        runtime = VisionRuntime(make_settings(), engine_factory=fail)
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        self.assertEqual(runtime.state, RuntimeState.FAILED)
        self.assertFalse(runtime.is_ready)


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.runtime = VisionRuntime(make_settings(), engine_factory=FakeEngine)
        await self.runtime.start()

    async def asyncTearDown(self) -> None:
        await self.runtime.stop()

    async def test_upload_larger_than_limit_has_stable_error(self) -> None:
        upload = make_upload(b"1234")
        try:
            with self.assertRaises(HTTPException) as captured:
                await detect_faces(
                    file=upload,
                    runtime=self.runtime,
                    settings=make_settings(max_image_bytes=3),
                )
        finally:
            await upload.close()

        self.assertEqual(captured.exception.status_code, 413)
        self.assertEqual(captured.exception.detail["code"], "IMAGE_TOO_LARGE")

    async def test_pixel_limit_is_checked_after_decode(self) -> None:
        settings = make_settings(max_image_pixels=8)
        upload = make_upload(b"encoded")
        try:
            with patch(
                "vision_service.routes.detect.cv2.imdecode",
                return_value=np.zeros((3, 3, 3), dtype=np.uint8),
            ):
                with self.assertRaises(HTTPException) as captured:
                    await detect_faces(file=upload, runtime=self.runtime, settings=settings)
        finally:
            await upload.close()

        self.assertEqual(captured.exception.status_code, 413)
        self.assertEqual(captured.exception.detail["code"], "IMAGE_PIXELS_EXCEEDED")

    async def test_invalid_base64_has_stable_error(self) -> None:
        request = SimpleNamespace(image_base64="!!!not-base64!!!")
        with self.assertRaises(HTTPException) as captured:
            await extract_embedding_base64(
                request=request,
                runtime=self.runtime,
                settings=make_settings(),
            )

        self.assertEqual(captured.exception.status_code, 400)
        self.assertEqual(captured.exception.detail["code"], "INVALID_BASE64")

    async def test_runtime_errors_have_stable_http_codes(self) -> None:
        cases = [
            (RuntimeNotReadyError("not ready"), 503, "VISION_NOT_READY"),
            (RuntimeBusyError("busy"), 429, "VISION_BUSY"),
            (InferenceFailedError("failed"), 500, "INFERENCE_FAILED"),
        ]
        for runtime_error, status_code, code in cases:
            runtime = SimpleNamespace(detect=unittest.mock.AsyncMock(side_effect=runtime_error))
            upload = make_upload(b"encoded")
            try:
                with self.subTest(code=code):
                    with patch(
                        "vision_service.routes.detect.cv2.imdecode",
                        return_value=np.zeros((1, 1, 3), dtype=np.uint8),
                    ):
                        with self.assertRaises(HTTPException) as captured:
                            await detect_faces(
                                file=upload,
                                runtime=runtime,
                                settings=make_settings(),
                            )
                    self.assertEqual(captured.exception.status_code, status_code)
                    self.assertEqual(captured.exception.detail["code"], code)
            finally:
                await upload.close()

    async def test_inference_failure_log_does_not_include_image_or_filename(self) -> None:
        runtime = SimpleNamespace(
            detect=unittest.mock.AsyncMock(side_effect=InferenceFailedError("failed"))
        )
        upload = make_upload(b"SENSITIVE_IMAGE_BYTES")
        upload.filename = "private-frame.jpg"
        try:
            with patch(
                "vision_service.routes.detect.cv2.imdecode",
                return_value=np.zeros((1, 1, 3), dtype=np.uint8),
            ):
                with self.assertLogs("vision_service.routes.detect", level="ERROR") as logs:
                    with self.assertRaises(HTTPException):
                        await detect_faces(
                            file=upload,
                            runtime=runtime,
                            settings=make_settings(),
                        )
        finally:
            await upload.close()

        rendered_logs = "\n".join(logs.output)
        self.assertNotIn("private-frame.jpg", rendered_logs)
        self.assertNotIn("SENSITIVE_IMAGE_BYTES", rendered_logs)


class HealthRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_routes_report_runtime_state_and_active_provider(self) -> None:
        runtime = VisionRuntime(make_settings(), engine_factory=FakeEngine)
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(vision_runtime=runtime))
        )

        live_response = await livez()
        self.assertEqual(live_response.status, "alive")

        not_ready_response = SimpleNamespace(status_code=200)
        ready_payload = await readyz(request, not_ready_response)
        self.assertEqual(not_ready_response.status_code, 503)
        self.assertEqual(ready_payload.status, "not_ready")

        await runtime.start()
        self.addAsyncCleanup(runtime.stop)
        ready_response = SimpleNamespace(status_code=200)
        ready_payload = await readyz(request, ready_response)
        self.assertEqual(ready_response.status_code, 200)
        self.assertEqual(ready_payload.status, "ready")

        health_response = SimpleNamespace(status_code=200)
        health_payload = await health_check(request, health_response)
        self.assertEqual(health_payload.onnx_providers, ["CPUExecutionProvider"])
        self.assertEqual(health_payload.status, "healthy")

        capabilities_payload = await capabilities(request)
        self.assertTrue(capabilities_payload.ready)
        self.assertEqual(capabilities_payload.capabilities, ["face_detection", "face_embedding"])


if __name__ == "__main__":
    unittest.main()
