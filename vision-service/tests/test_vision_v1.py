from __future__ import annotations

import json
import unittest
from tempfile import SpooledTemporaryFile
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import numpy as np
from fastapi import HTTPException, UploadFile
from starlette.datastructures import FormData

from vision_service.config import VISION_SERVICE_ROOT, Settings
from vision_service.detectors import (
    DecodedImage,
    DetectorItemError,
    DetectorItemResult,
    Finding,
    InsightFaceDetectorAdapter,
    NormalizedBox,
)
from vision_service.main import create_app
from vision_service.routes.v1 import analyze, v1_capabilities
from vision_service.runtime import RuntimeBusyError, VisionRuntime


def make_settings(**overrides: object) -> Settings:
    return Settings(
        _env_file=None,
        model_cache_dir=VISION_SERVICE_ROOT / "models",
        **overrides,
    )


def make_upload(
    filename: str,
    contents: bytes,
    *,
    declared_size: int | None = None,
) -> UploadFile:
    file = SpooledTemporaryFile(max_size=max(1, len(contents) + 1))
    file.write(contents)
    file.seek(0)
    return UploadFile(
        filename=filename,
        file=file,
        size=len(contents) if declared_size is None else declared_size,
    )


class ReadTrackingUploadFile(UploadFile):
    def __init__(self, filename: str, contents: bytes, *, declared_size: int) -> None:
        file = SpooledTemporaryFile(max_size=max(1, len(contents) + 1))
        file.write(contents)
        file.seek(0)
        super().__init__(filename=filename, file=file, size=declared_size)
        self.read_calls = 0

    async def read(self, size: int = -1) -> bytes:
        self.read_calls += 1
        return await super().read(size)


class FakeDetector:
    capability = "faces"
    model_revision = "fake-faces-1"
    taxonomy_revision = "faces-v1"
    providers = ("fake",)

    def analyze_batch(self, images: list[DecodedImage]) -> list[DetectorItemResult]:
        return [
            DetectorItemResult(
                findings=(
                    Finding(
                        capability="faces",
                        label="face",
                        score=0.9,
                        box=NormalizedBox(x1=0.1, y1=0.2, x2=0.3, y2=0.4),
                        embedding=tuple([0.0] * 512),
                    ),
                )
            )
            for _image in images
        ]

    def close(self) -> None:
        return None


class FailingDetector(FakeDetector):
    capability = "broken"

    def __init__(self) -> None:
        raise RuntimeError("model unavailable")


class EmptySecondaryDetector:
    capability = "secondary"
    model_revision = "fake-secondary-1"
    taxonomy_revision = "secondary-v1"
    providers = ("fake",)

    def analyze_batch(self, images: list[DecodedImage]) -> list[DetectorItemResult]:
        return [DetectorItemResult(findings=()) for _image in images]

    def close(self) -> None:
        return None


class FakeRequest:
    def __init__(self, runtime: VisionRuntime, form: FormData | None = None) -> None:
        self.app = SimpleNamespace(state=SimpleNamespace(vision_runtime=runtime))
        self._form = form or FormData()

    async def form(self) -> FormData:
        return self._form


class DetectorAdapterTests(unittest.TestCase):
    def test_insightface_adapter_normalizes_and_clamps_pixel_boxes(self) -> None:
        engine = SimpleNamespace(
            detect=lambda _image: [
                {
                    "bbox": [-10.0, 5.0, 120.0, 60.0],
                    "embedding": [0.0] * 512,
                    "det_score": 0.9,
                }
            ],
            get_active_providers=lambda: ["CPUExecutionProvider"],
            get_embedding_dimension=lambda: 512,
            close=lambda: None,
        )
        adapter = InsightFaceDetectorAdapter(
            make_settings(insightface_model="buffalo_l"), engine_factory=lambda: engine
        )

        batches = adapter.analyze_batch([DecodedImage(np.zeros((50, 100, 3), dtype=np.uint8))])

        self.assertEqual(len(batches), 1)
        finding = batches[0].findings[0]
        self.assertEqual(finding.capability, "faces")
        self.assertEqual(finding.label, "face")
        self.assertEqual(
            finding.box,
            NormalizedBox(x1=0.0, y1=0.1, x2=1.0, y2=1.0),
        )
        self.assertEqual(adapter.providers, ("CPUExecutionProvider",))
        self.assertIn("/buffalo_l", adapter.model_revision)


class GenericRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_capability_initialization_failure_is_isolated(self) -> None:
        runtime = VisionRuntime(
            make_settings(),
            detector_factories={"faces": FakeDetector, "broken": FailingDetector},
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        self.assertTrue(runtime.is_capability_ready("faces"))
        self.assertFalse(runtime.is_capability_ready("broken"))
        self.assertTrue(runtime.is_ready)
        statuses = {status.name: status for status in runtime.capability_statuses()}
        self.assertEqual(statuses["faces"].state.value, "ready")
        self.assertEqual(statuses["broken"].failure_code, "DETECTOR_INITIALIZATION_FAILED")

    async def test_legacy_face_adapter_preserves_pixel_box_and_embedding(self) -> None:
        engine = SimpleNamespace(
            detect=lambda _image: [
                {
                    "bbox": [10.0, 5.0, 30.0, 20.0],
                    "embedding": [0.25] * 512,
                    "det_score": 0.8,
                }
            ],
            get_active_providers=lambda: ["CPUExecutionProvider"],
            get_embedding_dimension=lambda: 512,
            close=lambda: None,
        )
        runtime = VisionRuntime(make_settings(), engine_factory=lambda: engine)
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)
        pixels = np.zeros((50, 100, 3), dtype=np.uint8)

        generic = (await runtime.analyze_batch("faces", [DecodedImage(pixels)]))[0]
        legacy = await runtime.detect(pixels)

        self.assertIsInstance(generic, DetectorItemResult)
        assert isinstance(generic, DetectorItemResult)
        self.assertEqual(generic.findings[0].box, NormalizedBox(0.1, 0.1, 0.3, 0.4))
        self.assertEqual(legacy[0]["bbox"], [10.0, 5.0, 30.0, 20.0])
        self.assertEqual(legacy[0]["embedding"], [0.25] * 512)


class V1RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.settings = make_settings(max_batch_items=2, max_batch_bytes=32)
        self.runtime = VisionRuntime(
            self.settings,
            detector_factories={"faces": FakeDetector},
        )
        await self.runtime.start()

    async def asyncTearDown(self) -> None:
        await self.runtime.stop()

    async def test_capabilities_report_revision_provider_readiness_and_limits(self) -> None:
        payload = await v1_capabilities(FakeRequest(self.runtime))

        self.assertEqual(payload.version, "1")
        self.assertEqual(len(payload.capabilities), 1)
        capability = payload.capabilities[0]
        self.assertEqual(capability.name, "faces")
        self.assertTrue(capability.ready)
        self.assertEqual(capability.providers, ["fake"])
        self.assertEqual(capability.model_revision, "fake-faces-1")
        self.assertEqual(capability.taxonomy_revision, "faces-v1")
        self.assertEqual(capability.max_batch_items, 2)
        self.assertEqual(capability.max_batch_bytes, 32)
        self.assertEqual(capability.max_image_pixels, self.settings.max_image_pixels)

    async def test_analyze_echoes_identity_and_timestamp_and_keeps_bad_frame_error(self) -> None:
        first = make_upload("good.jpg", b"good")
        second = make_upload("bad.jpg", b"bad")
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces"],
                "items": [
                    {"id": "frame-001", "timestamp_seconds": 12.5, "file_field": "frame_good"},
                    {"id": "frame-002", "timestamp_seconds": 18.75, "file_field": "frame_bad"},
                ],
            }
        )
        form = FormData([("manifest", manifest), ("frame_good", first), ("frame_bad", second)])
        try:
            with patch(
                "vision_service.routes.v1._decode_image",
                side_effect=[
                    np.zeros((50, 100, 3), dtype=np.uint8),
                    HTTPException(
                        status_code=400,
                        detail={
                            "code": "INVALID_IMAGE",
                            "message": "Image data could not be decoded",
                        },
                    ),
                ],
            ):
                payload = await analyze(
                    request=FakeRequest(self.runtime, form),
                    runtime=self.runtime,
                    settings=self.settings,
                )
        finally:
            await first.close()
            await second.close()

        self.assertEqual(payload.version, "1")
        self.assertEqual([item.id for item in payload.items], ["frame-001", "frame-002"])
        self.assertEqual(
            [item.timestamp_seconds for item in payload.items],
            [12.5, 18.75],
        )
        self.assertEqual((payload.items[0].width, payload.items[0].height), (100, 50))
        self.assertEqual(len(payload.items[0].outcomes), 1)
        success = payload.items[0].outcomes[0]
        self.assertEqual(success.status, "ok")
        self.assertEqual(success.findings[0].box.space, "normalized")
        self.assertEqual(success.findings[0].box.x1, 0.1)
        failure = payload.items[1].outcomes[0]
        self.assertEqual(failure.status, "error")
        self.assertEqual(failure.error.code, "INVALID_IMAGE")

    async def test_overload_is_returned_as_an_item_error(self) -> None:
        upload = make_upload("busy.jpg", b"busy")
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces"],
                "items": [{"id": "busy", "timestamp_seconds": 1.0, "file_field": "frame"}],
            }
        )
        form = FormData([("manifest", manifest), ("frame", upload)])
        try:
            with (
                patch(
                    "vision_service.routes.v1._decode_image",
                    return_value=np.zeros((1, 1, 3), dtype=np.uint8),
                ),
                patch.object(
                    self.runtime,
                    "analyze_batch",
                    side_effect=RuntimeBusyError("busy"),
                ),
            ):
                payload = await analyze(
                    request=FakeRequest(self.runtime, form),
                    runtime=self.runtime,
                    settings=self.settings,
                )
        finally:
            await upload.close()

        outcome = payload.items[0].outcomes[0]
        self.assertEqual(outcome.status, "error")
        self.assertEqual(outcome.error.code, "OVERLOADED")
        self.assertEqual(outcome.capability, "faces")

    async def test_capability_error_does_not_erase_another_capability_success(self) -> None:
        class ErrorDetector:
            capability = "secondary"
            model_revision = "secondary-1"
            taxonomy_revision = "secondary-v1"
            providers = ("fake",)

            def analyze_batch(self, images: list[DecodedImage]) -> list[DetectorItemError]:
                return [
                    DetectorItemError(code="INFERENCE_FAILED", message="Secondary failed")
                    for _image in images
                ]

            def close(self) -> None:
                return None

        runtime = VisionRuntime(
            self.settings,
            detector_factories={"faces": FakeDetector, "secondary": ErrorDetector},
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)
        upload = make_upload("frame.jpg", b"frame")
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces", "secondary"],
                "items": [{"id": "one", "timestamp_seconds": 4.5, "file_field": "frame"}],
            }
        )
        form = FormData([("manifest", manifest), ("frame", upload)])
        try:
            with patch(
                "vision_service.routes.v1._decode_image",
                return_value=np.zeros((1, 1, 3), dtype=np.uint8),
            ):
                payload = await analyze(
                    request=FakeRequest(runtime, form),
                    runtime=runtime,
                    settings=self.settings,
                )
        finally:
            await upload.close()

        outcomes = payload.items[0].outcomes
        self.assertEqual([outcome.capability for outcome in outcomes], ["faces", "secondary"])
        self.assertEqual([outcome.status for outcome in outcomes], ["ok", "error"])
        self.assertEqual(outcomes[1].error.code, "INFERENCE_FAILED")

    async def test_analyze_calls_runtime_once_per_capability_with_all_valid_items(self) -> None:
        settings = make_settings(max_batch_items=3, max_batch_bytes=64)
        runtime = VisionRuntime(
            settings,
            detector_factories={"faces": FakeDetector, "secondary": EmptySecondaryDetector},
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)
        uploads = [make_upload(f"{index}.jpg", bytes([index])) for index in range(3)]
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces", "secondary"],
                "items": [
                    {
                        "id": f"frame-{index}",
                        "timestamp_seconds": index + 0.5,
                        "file_field": f"file_{index}",
                    }
                    for index in range(3)
                ],
            }
        )
        form = FormData(
            [("manifest", manifest)]
            + [(f"file_{index}", upload) for index, upload in enumerate(uploads)]
        )
        original_analyze_batch = runtime.analyze_batch
        analyze_batch_mock = AsyncMock(wraps=original_analyze_batch)
        try:
            with (
                patch(
                    "vision_service.routes.v1._decode_image",
                    side_effect=[
                        np.full((10, 20, 3), 1, dtype=np.uint8),
                        HTTPException(
                            status_code=400,
                            detail={"code": "INVALID_IMAGE", "message": "Invalid image"},
                        ),
                        np.full((30, 40, 3), 3, dtype=np.uint8),
                    ],
                ),
                patch.object(runtime, "analyze_batch", analyze_batch_mock),
            ):
                payload = await analyze(
                    request=FakeRequest(runtime, form),
                    runtime=runtime,
                    settings=settings,
                )
        finally:
            for upload in uploads:
                await upload.close()

        self.assertEqual(analyze_batch_mock.await_count, 2)
        self.assertEqual(
            [call.args[0] for call in analyze_batch_mock.await_args_list],
            ["faces", "secondary"],
        )
        for call in analyze_batch_mock.await_args_list:
            images = call.args[1]
            self.assertEqual(len(images), 2)
            self.assertEqual([int(image.pixels[0, 0, 0]) for image in images], [1, 3])
        self.assertEqual([item.id for item in payload.items], ["frame-0", "frame-1", "frame-2"])
        self.assertEqual(
            [item.timestamp_seconds for item in payload.items],
            [0.5, 1.5, 2.5],
        )
        self.assertEqual((payload.items[0].width, payload.items[0].height), (20, 10))
        self.assertEqual((payload.items[2].width, payload.items[2].height), (40, 30))
        self.assertEqual(
            [outcome.status for outcome in payload.items[1].outcomes], ["error", "error"]
        )

    async def test_analyze_rejects_unreferenced_multipart_part(self) -> None:
        referenced = make_upload("frame.jpg", b"frame")
        extra = make_upload("extra.jpg", b"extra")
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces"],
                "items": [{"id": "one", "timestamp_seconds": 1, "file_field": "frame"}],
            }
        )
        form = FormData([("manifest", manifest), ("frame", referenced), ("not_referenced", extra)])
        try:
            with self.assertRaises(HTTPException) as captured:
                await analyze(
                    request=FakeRequest(self.runtime, form),
                    runtime=self.runtime,
                    settings=self.settings,
                )
        finally:
            await referenced.close()
            await extra.close()

        self.assertEqual(captured.exception.status_code, 400)
        self.assertEqual(captured.exception.detail["code"], "INVALID_MANIFEST")

    async def test_batch_count_and_byte_limits_have_stable_errors(self) -> None:
        too_many = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces"],
                "items": [
                    {"id": str(index), "timestamp_seconds": index, "file_field": f"f{index}"}
                    for index in range(3)
                ],
            }
        )
        with self.assertRaises(HTTPException) as captured:
            await analyze(
                request=FakeRequest(self.runtime, FormData([("manifest", too_many)])),
                runtime=self.runtime,
                settings=self.settings,
            )
        self.assertEqual(captured.exception.status_code, 413)
        self.assertEqual(captured.exception.detail["code"], "BATCH_TOO_LARGE")

    async def test_real_aggregate_upload_size_is_rejected_before_reading_files(self) -> None:
        settings = make_settings(max_batch_items=2, max_batch_bytes=5)
        first = ReadTrackingUploadFile("one.jpg", b"a", declared_size=3)
        second = ReadTrackingUploadFile("two.jpg", b"b", declared_size=3)
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces"],
                "items": [
                    {"id": "one", "timestamp_seconds": 1, "file_field": "first"},
                    {"id": "two", "timestamp_seconds": 2, "file_field": "second"},
                ],
            }
        )
        form = FormData([("manifest", manifest), ("first", first), ("second", second)])
        try:
            with self.assertRaises(HTTPException) as captured:
                await analyze(
                    request=FakeRequest(self.runtime, form),
                    runtime=self.runtime,
                    settings=settings,
                )
        finally:
            await first.close()
            await second.close()

        self.assertEqual(captured.exception.status_code, 413)
        self.assertEqual(captured.exception.detail["code"], "BATCH_TOO_LARGE")
        self.assertEqual((first.read_calls, second.read_calls), (0, 0))

        upload = make_upload("large.jpg", b"x" * 33)
        too_large = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces"],
                "items": [{"id": "large", "timestamp_seconds": 0, "file_field": "frame"}],
            }
        )
        form = FormData([("manifest", too_large), ("frame", upload)])
        try:
            with self.assertRaises(HTTPException) as captured:
                await analyze(
                    request=FakeRequest(self.runtime, form),
                    runtime=self.runtime,
                    settings=self.settings,
                )
        finally:
            await upload.close()
        self.assertEqual(captured.exception.status_code, 413)
        self.assertEqual(captured.exception.detail["code"], "BATCH_TOO_LARGE")

    async def test_real_individual_upload_size_is_an_item_error_without_reading(self) -> None:
        settings = make_settings(max_batch_bytes=10, max_image_bytes=4)
        upload = ReadTrackingUploadFile("large.jpg", b"x", declared_size=5)
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["faces"],
                "items": [{"id": "large", "timestamp_seconds": 0, "file_field": "frame"}],
            }
        )
        try:
            response = await analyze(
                request=FakeRequest(
                    self.runtime,
                    FormData([("manifest", manifest), ("frame", upload)]),
                ),
                runtime=self.runtime,
                settings=settings,
            )
        finally:
            await upload.close()

        outcome = response.items[0].outcomes[0]
        self.assertEqual(outcome.status, "error")
        self.assertEqual(outcome.error.code, "IMAGE_TOO_LARGE")
        self.assertEqual(upload.read_calls, 0)

    def test_versioned_routes_are_exposed_and_only_analyze_requires_auth(self) -> None:
        application = create_app(runtime=self.runtime)
        paths = application.openapi()["paths"]

        self.assertIn("/v1/capabilities", paths)
        self.assertIn("/v1/analyze", paths)
        self.assertNotIn("security", paths["/v1/capabilities"]["get"])
        self.assertTrue(paths["/v1/analyze"]["post"]["security"])
        self.assertIn("/detect", paths)
        self.assertIn("/extract-embedding", paths)


if __name__ == "__main__":
    unittest.main()
