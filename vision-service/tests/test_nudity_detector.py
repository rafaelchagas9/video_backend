from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from tempfile import SpooledTemporaryFile, TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from fastapi import UploadFile
from starlette.datastructures import FormData

from vision_service.config import VISION_SERVICE_ROOT, Settings
from vision_service.detectors import DecodedImage, DetectorItemError, DetectorItemResult
from vision_service.nudity import (
    NUDENET_320N_SHA256,
    NUDENET_640M_SHA256,
    NUDENET_640M_URL,
    SELECTED_NUDITY_LABELS,
    NudeNet320Backend,
    NudeNetDetectorAdapter,
    NudeNetModelSpec,
    NudeNetOnnxBackend,
    resolve_nudenet_model_path,
)
from vision_service.routes.health import livez
from vision_service.routes.v1 import analyze, v1_capabilities
from vision_service.runtime import RuntimeState, VisionRuntime


def make_settings(**overrides: object) -> Settings:
    return Settings(
        _env_file=None,
        model_cache_dir=VISION_SERVICE_ROOT / "models",
        **overrides,
    )


def image(width: int = 100, height: int = 50, marker: int = 0) -> DecodedImage:
    return DecodedImage(np.full((height, width, 3), marker, dtype=np.uint8))


def upload(contents: bytes) -> UploadFile:
    file = SpooledTemporaryFile(max_size=max(1, len(contents) + 1))
    file.write(contents)
    file.seek(0)
    return UploadFile(filename="synthetic.jpg", file=file, size=len(contents))


class FakeNudeNetBackend:
    def __init__(
        self,
        outputs: list[list[dict[str, object]]],
        providers: tuple[str, ...] = (
            "MIGraphXExecutionProvider",
            "CPUExecutionProvider",
        ),
    ) -> None:
        self.outputs = outputs
        self.providers = providers
        self.calls: list[list[DecodedImage]] = []
        self.closed = False

    def detect_batch(self, images: list[DecodedImage]) -> list[list[dict[str, object]]]:
        self.calls.append(list(images))
        return self.outputs

    def close(self) -> None:
        self.closed = True


class FakeFaceEngine:
    def detect(self, _image: np.ndarray) -> list[dict]:
        return []

    def get_active_providers(self) -> list[str]:
        return ["CPUExecutionProvider"]

    def get_embedding_dimension(self) -> int:
        return 512

    def close(self) -> None:
        return None


class NudeNetAdapterTests(unittest.TestCase):
    def test_selected_taxonomy_is_exact_and_other_provider_labels_are_ignored(self) -> None:
        raw_findings = [
            {"class": label, "score": 0.75, "box": [10, 5, 20, 10]}
            for label in sorted(SELECTED_NUDITY_LABELS)
        ]
        raw_findings.extend(
            [
                {"class": "FACE_FEMALE", "score": 0.99, "box": [0, 0, 10, 10]},
                {"class": "BUTTOCKS_COVERED", "score": 0.99, "box": [0, 0, 10, 10]},
            ]
        )
        backend = FakeNudeNetBackend([raw_findings])
        adapter = NudeNetDetectorAdapter(backend_factory=lambda: backend)

        outcome = adapter.analyze_batch([image()])[0]

        self.assertIsInstance(outcome, DetectorItemResult)
        assert isinstance(outcome, DetectorItemResult)
        self.assertEqual(
            {finding.label for finding in outcome.findings},
            set(SELECTED_NUDITY_LABELS),
        )
        self.assertTrue(
            all(
                finding.metadata == {"provider_label": finding.label}
                for finding in outcome.findings
            )
        )

    def test_xywh_geometry_is_normalized_and_clamped(self) -> None:
        backend = FakeNudeNetBackend(
            [
                [
                    {
                        "class": "BUTTOCKS_EXPOSED",
                        "score": 0.8,
                        "box": [-10, 5, 120, 60],
                    }
                ]
            ]
        )
        adapter = NudeNetDetectorAdapter(backend_factory=lambda: backend)

        outcome = adapter.analyze_batch([image(width=100, height=50)])[0]

        self.assertIsInstance(outcome, DetectorItemResult)
        assert isinstance(outcome, DetectorItemResult)
        finding = outcome.findings[0]
        self.assertEqual((finding.box.x1, finding.box.y1), (0.0, 0.1))
        self.assertEqual((finding.box.x2, finding.box.y2), (1.0, 1.0))
        self.assertEqual(finding.score, 0.8)

    def test_malformed_provider_output_fails_only_its_item(self) -> None:
        backend = FakeNudeNetBackend(
            [
                [{"class": "ANUS_EXPOSED", "score": 0.9, "box": [1, 2, 3]}],
                [{"class": "BELLY_EXPOSED", "score": 0.7, "box": [1, 2, 3, 4]}],
            ]
        )
        adapter = NudeNetDetectorAdapter(backend_factory=lambda: backend)

        outcomes = adapter.analyze_batch([image(marker=1), image(marker=2)])

        self.assertIsInstance(outcomes[0], DetectorItemError)
        assert isinstance(outcomes[0], DetectorItemError)
        self.assertEqual(outcomes[0].code, "MALFORMED_DETECTOR_OUTPUT")
        self.assertIsInstance(outcomes[1], DetectorItemResult)
        self.assertEqual(len(backend.calls), 1)
        self.assertEqual(len(backend.calls[0]), 2)

    def test_backend_is_initialized_lazily_once(self) -> None:
        backend = FakeNudeNetBackend([[], []])
        initializations = 0

        def factory() -> FakeNudeNetBackend:
            nonlocal initializations
            initializations += 1
            return backend

        adapter = NudeNetDetectorAdapter(backend_factory=factory)
        self.assertEqual(initializations, 0)
        self.assertFalse(adapter.ready)
        self.assertEqual(adapter.runtime_state, "created")

        adapter.analyze_batch([image()])
        adapter.analyze_batch([image()])

        self.assertEqual(initializations, 1)
        self.assertTrue(adapter.ready)
        self.assertEqual(adapter.runtime_state, "ready")
        self.assertEqual(
            adapter.providers,
            ("MIGraphXExecutionProvider", "CPUExecutionProvider"),
        )

    def test_failed_lazy_initialization_retries_only_after_cooldown(self) -> None:
        backend = FakeNudeNetBackend([[]])
        now = 100.0
        attempts = 0

        def clock() -> float:
            return now

        def factory() -> FakeNudeNetBackend:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("GPU temporarily unavailable")
            return backend

        adapter = NudeNetDetectorAdapter(
            backend_factory=factory,
            initialization_retry_seconds=60,
            clock=clock,
        )

        first = adapter.analyze_batch([image()])[0]
        now = 159.9
        during_cooldown = adapter.analyze_batch([image()])[0]
        now = 160.0
        after_cooldown = adapter.analyze_batch([image()])[0]

        self.assertIsInstance(first, DetectorItemError)
        self.assertIsInstance(during_cooldown, DetectorItemError)
        self.assertIsInstance(after_cooldown, DetectorItemResult)
        self.assertEqual(attempts, 2)
        self.assertTrue(adapter.ready)

    def test_zero_sized_provider_box_is_rejected_for_its_item(self) -> None:
        backend = FakeNudeNetBackend(
            [[{"class": "ANUS_EXPOSED", "score": 0.9, "box": [1, 2, 0, 4]}]]
        )
        adapter = NudeNetDetectorAdapter(backend_factory=lambda: backend)

        outcome = adapter.analyze_batch([image()])[0]

        self.assertIsInstance(outcome, DetectorItemError)
        assert isinstance(outcome, DetectorItemError)
        self.assertEqual(outcome.code, "MALFORMED_DETECTOR_OUTPUT")

    def test_required_gpu_rejects_cpu_only_backend_and_closes_it(self) -> None:
        backend = FakeNudeNetBackend([[]], providers=("CPUExecutionProvider",))
        adapter = NudeNetDetectorAdapter(
            backend_factory=lambda: backend,
            require_gpu=True,
        )

        outcome = adapter.analyze_batch([image()])[0]

        self.assertIsInstance(outcome, DetectorItemError)
        assert isinstance(outcome, DetectorItemError)
        self.assertEqual(outcome.code, "DETECTOR_INITIALIZATION_FAILED")
        self.assertTrue(backend.closed)
        self.assertEqual(adapter.runtime_state, "failed")
        self.assertEqual(adapter.providers, ())

    def test_default_backend_factory_receives_cpu_only_opt_in(self) -> None:
        backend = FakeNudeNetBackend([[]], providers=("CPUExecutionProvider",))
        with patch(
            "vision_service.nudity.create_nudenet_backend",
            return_value=backend,
        ) as backend_factory:
            adapter = NudeNetDetectorAdapter(require_gpu=False)
            outcome = adapter.analyze_batch([image()])[0]

        self.assertIsInstance(outcome, DetectorItemResult)
        backend_factory.assert_called_once_with(
            model_name="640m",
            model_cache_dir=VISION_SERVICE_ROOT / "models",
            providers=("MIGraphXExecutionProvider", "CPUExecutionProvider"),
            require_gpu=False,
            fp16_enabled=False,
        )


class NudeNetBackendTests(unittest.TestCase):
    def test_missing_offline_model_fails_before_session_creation(self) -> None:
        session_calls = 0

        def session_factory(_model_path: str, *, providers: list[str]) -> object:
            nonlocal session_calls
            session_calls += 1
            raise AssertionError(f"session must not be created with {providers}")

        with TemporaryDirectory() as directory:
            model_path = Path(directory) / "nudenet" / "640m.onnx"
            with self.assertRaisesRegex(RuntimeError, "not provisioned"):
                NudeNetOnnxBackend(
                    model_spec=NudeNetModelSpec(
                        name="640m",
                        inference_resolution=640,
                        sha256=NUDENET_640M_SHA256,
                        source_url=NUDENET_640M_URL,
                    ),
                    model_path=model_path,
                    session_factory=session_factory,
                    read_image=lambda *_args: (),
                    postprocess=lambda *_args: [],
                )

        self.assertEqual(session_calls, 0)

    def test_640m_uses_explicit_cache_path_and_640_inference_resolution(self) -> None:
        model_contents = b"synthetic-640m-model"
        model_sha = hashlib.sha256(model_contents).hexdigest()
        read_resolutions: list[int] = []
        session_paths: list[str] = []

        class FakeSession:
            def get_inputs(self) -> list[SimpleNamespace]:
                return [SimpleNamespace(name="images")]

            def get_providers(self) -> list[str]:
                return ["MIGraphXExecutionProvider", "CPUExecutionProvider"]

            def run(self, _outputs: None, inputs: dict[str, np.ndarray]) -> list[np.ndarray]:
                return [np.zeros((inputs["images"].shape[0], 1, 1), dtype=np.float32)]

        def session_factory(model_path: str, *, providers: list[str]) -> FakeSession:
            session_paths.append(model_path)
            self.assertEqual(
                providers,
                ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
            )
            return FakeSession()

        def read_image(
            decoded: np.ndarray, target_size: int
        ) -> tuple[np.ndarray, float, float, int, int, int, int]:
            read_resolutions.append(target_size)
            return (
                np.zeros((1, 3, target_size, target_size), dtype=np.float32),
                1.0,
                1.0,
                0,
                0,
                decoded.shape[1],
                decoded.shape[0],
            )

        spec = NudeNetModelSpec(
            name="640m",
            inference_resolution=640,
            sha256=model_sha,
            source_url=NUDENET_640M_URL,
        )
        with TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            model_path = cache_dir / "nudenet" / "640m.onnx"
            model_path.parent.mkdir()
            model_path.write_bytes(model_contents)

            self.assertEqual(
                resolve_nudenet_model_path(spec, cache_dir),
                model_path,
            )
            backend = NudeNetOnnxBackend(
                model_spec=spec,
                model_path=model_path,
                session_factory=session_factory,
                read_image=read_image,
                postprocess=lambda *_args: [],
            )
            backend.detect_batch([image()])

        self.assertEqual(session_paths, [str(model_path)])
        self.assertEqual(read_resolutions, [640])

    def test_pinned_backend_prefers_migraphx_and_keeps_cpu_fallback(self) -> None:
        model_contents = b"synthetic-model-placeholder"
        expected_hash = hashlib.sha256(model_contents).hexdigest()
        session_calls: list[tuple[str, list[str]]] = []
        run_batches: list[int] = []
        read_resolutions: list[int] = []

        class FakeSession:
            def get_inputs(self) -> list[SimpleNamespace]:
                return [SimpleNamespace(name="images")]

            def run(self, _outputs: None, inputs: dict[str, np.ndarray]) -> list[np.ndarray]:
                run_batches.append(inputs["images"].shape[0])
                return [np.zeros((inputs["images"].shape[0], 1, 1), dtype=np.float32)]

            def get_providers(self) -> list[str]:
                return ["MIGraphXExecutionProvider", "CPUExecutionProvider"]

        def session_factory(model_path: str, *, providers: list[str]) -> FakeSession:
            session_calls.append((model_path, providers))
            return FakeSession()

        def read_image(
            decoded: np.ndarray, target_size: int
        ) -> tuple[np.ndarray, float, float, int, int, int, int]:
            read_resolutions.append(target_size)
            return (
                np.zeros((1, 3, target_size, target_size), dtype=np.float32),
                1.0,
                1.0,
                0,
                0,
                decoded.shape[1],
                decoded.shape[0],
            )

        def postprocess(*_args: object) -> list[dict[str, object]]:
            return []

        with TemporaryDirectory() as directory:
            model_path = Path(directory) / "320n.onnx"
            model_path.write_bytes(model_contents)
            synthetic_spec = NudeNetModelSpec(
                name="320n",
                inference_resolution=320,
                sha256=expected_hash,
                source_url=None,
            )
            with patch("vision_service.nudity.NUDENET_320N_SPEC", synthetic_spec):
                backend = NudeNet320Backend(
                    model_path=model_path,
                    session_factory=session_factory,
                    read_image=read_image,
                    postprocess=postprocess,
                    providers=("MIGraphXExecutionProvider", "CPUExecutionProvider"),
                )
                results = backend.detect_batch([image(marker=1), image(marker=2)])

        self.assertEqual(results, [[], []])
        self.assertEqual(
            session_calls,
            [
                (
                    str(model_path),
                    ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
                )
            ],
        )
        self.assertEqual(
            backend.providers,
            ("MIGraphXExecutionProvider", "CPUExecutionProvider"),
        )
        # Runs are padded to one fixed shape so MIGraphX compiles a single program.
        self.assertEqual(run_batches, [16])
        self.assertEqual(read_resolutions, [320, 320])
        self.assertEqual(len(NUDENET_320N_SHA256), 64)

    def test_every_run_uses_one_fixed_input_shape(self) -> None:
        """MIGraphX compiles per input shape, so the shape must never vary."""
        model_contents = b"synthetic-model-placeholder"
        expected_hash = hashlib.sha256(model_contents).hexdigest()
        run_batches: list[int] = []

        class FakeSession:
            def get_inputs(self) -> list[SimpleNamespace]:
                return [SimpleNamespace(name="images")]

            def run(self, _outputs: None, inputs: dict[str, np.ndarray]) -> list[np.ndarray]:
                run_batches.append(inputs["images"].shape[0])
                return [np.arange(inputs["images"].shape[0], dtype=np.float32).reshape(-1, 1, 1)]

            def get_providers(self) -> list[str]:
                return ["MIGraphXExecutionProvider", "CPUExecutionProvider"]

        def read_image(
            decoded: np.ndarray, target_size: int
        ) -> tuple[np.ndarray, float, float, int, int, int, int]:
            return (
                np.zeros((1, 3, target_size, target_size), dtype=np.float32),
                1.0,
                1.0,
                0,
                0,
                decoded.shape[1],
                decoded.shape[0],
            )

        seen_predictions: list[float] = []

        def postprocess(predictions: list[np.ndarray], *_args: object) -> list[dict[str, object]]:
            seen_predictions.append(float(predictions[0].ravel()[0]))
            return []

        synthetic_spec = NudeNetModelSpec(
            name="320n",
            inference_resolution=320,
            sha256=expected_hash,
            source_url=None,
        )
        with TemporaryDirectory() as directory:
            model_path = Path(directory) / "320n.onnx"
            model_path.write_bytes(model_contents)
            with patch("vision_service.nudity.NUDENET_320N_SPEC", synthetic_spec):
                backend = NudeNet320Backend(
                    model_path=model_path,
                    session_factory=lambda *_a, **_k: FakeSession(),
                    read_image=read_image,
                    postprocess=postprocess,
                    providers=("MIGraphXExecutionProvider", "CPUExecutionProvider"),
                    batch_size=16,
                )
                for count in (1, 3, 16):
                    run_batches.clear()
                    seen_predictions.clear()
                    results = backend.detect_batch([image() for _ in range(count)])
                    self.assertEqual(len(results), count)
                    self.assertEqual(run_batches, [16])
                    # Each item is postprocessed with its own row, padding discarded.
                    self.assertEqual(seen_predictions, [float(i) for i in range(count)])

                # A batch larger than the fixed size splits into fixed-size runs.
                run_batches.clear()
                results = backend.detect_batch([image() for _ in range(17)])
                self.assertEqual(len(results), 17)
                self.assertEqual(run_batches, [16, 16])

    def test_backend_falls_back_to_cpu_only_when_gpu_is_optional(self) -> None:
        model_contents = b"synthetic-model-placeholder"
        expected_hash = hashlib.sha256(model_contents).hexdigest()
        requested: list[list[str]] = []

        class CpuSession:
            def get_inputs(self) -> list[SimpleNamespace]:
                return [SimpleNamespace(name="images")]

            def get_providers(self) -> list[str]:
                return ["CPUExecutionProvider"]

            def run(self, _outputs: None, _inputs: dict[str, np.ndarray]) -> list[np.ndarray]:
                return [np.zeros((1, 1, 1), dtype=np.float32)]

        def session_factory(_model_path: str, *, providers: list[str]) -> CpuSession:
            requested.append(providers)
            if "MIGraphXExecutionProvider" in providers:
                raise RuntimeError("GPU unavailable")
            return CpuSession()

        with TemporaryDirectory() as directory:
            model_path = Path(directory) / "320n.onnx"
            model_path.write_bytes(model_contents)
            synthetic_spec = NudeNetModelSpec(
                name="320n",
                inference_resolution=320,
                sha256=expected_hash,
                source_url=None,
            )
            with patch("vision_service.nudity.NUDENET_320N_SPEC", synthetic_spec):
                backend = NudeNet320Backend(
                    model_path=model_path,
                    session_factory=session_factory,
                    read_image=lambda *_args: (),
                    postprocess=lambda *_args: [],
                    require_gpu=False,
                )

        self.assertEqual(
            requested,
            [
                ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
                ["CPUExecutionProvider"],
            ],
        )
        self.assertEqual(backend.providers, ("CPUExecutionProvider",))

    def test_backend_does_not_fall_back_when_gpu_is_required(self) -> None:
        model_contents = b"synthetic-model-placeholder"
        expected_hash = hashlib.sha256(model_contents).hexdigest()
        requested: list[list[str]] = []

        def session_factory(_model_path: str, *, providers: list[str]) -> object:
            requested.append(providers)
            raise RuntimeError("GPU unavailable")

        with TemporaryDirectory() as directory:
            model_path = Path(directory) / "320n.onnx"
            model_path.write_bytes(model_contents)
            synthetic_spec = NudeNetModelSpec(
                name="320n",
                inference_resolution=320,
                sha256=expected_hash,
                source_url=None,
            )
            with patch("vision_service.nudity.NUDENET_320N_SPEC", synthetic_spec):
                with self.assertRaisesRegex(RuntimeError, "GPU unavailable"):
                    NudeNet320Backend(
                        model_path=model_path,
                        session_factory=session_factory,
                        read_image=lambda *_args: (),
                        postprocess=lambda *_args: [],
                        require_gpu=True,
                    )

        self.assertEqual(
            requested,
            [["MIGraphXExecutionProvider", "CPUExecutionProvider"]],
        )

    def test_backend_rejects_session_without_active_migraphx_when_required(self) -> None:
        model_contents = b"synthetic-model-placeholder"
        expected_hash = hashlib.sha256(model_contents).hexdigest()

        class CpuOnlySession:
            def get_inputs(self) -> list[SimpleNamespace]:
                return [SimpleNamespace(name="images")]

            def get_providers(self) -> list[str]:
                return ["CPUExecutionProvider"]

        def session_factory(_model_path: str, *, providers: list[str]) -> CpuOnlySession:
            self.assertEqual(
                providers,
                ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
            )
            return CpuOnlySession()

        with TemporaryDirectory() as directory:
            model_path = Path(directory) / "320n.onnx"
            model_path.write_bytes(model_contents)
            synthetic_spec = NudeNetModelSpec(
                name="320n",
                inference_resolution=320,
                sha256=expected_hash,
                source_url=None,
            )
            with patch("vision_service.nudity.NUDENET_320N_SPEC", synthetic_spec):
                with self.assertRaisesRegex(RuntimeError, "MIGraphXExecutionProvider"):
                    NudeNet320Backend(
                        model_path=model_path,
                        session_factory=session_factory,
                        read_image=lambda *_args: (),
                        postprocess=lambda *_args: [],
                        require_gpu=True,
                    )


class NuditySettingsTests(unittest.TestCase):
    def test_gpu_is_required_and_initialization_retry_defaults_to_sixty_seconds(self) -> None:
        settings = make_settings()

        self.assertTrue(settings.nudity_require_gpu)
        self.assertEqual(settings.nudity_initialization_retry_seconds, 60)

    def test_640m_is_the_default_pinned_model(self) -> None:
        settings = make_settings()

        self.assertEqual(settings.nudity_model, "640m")
        self.assertEqual(
            NUDENET_640M_SHA256,
            "04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb",
        )
        self.assertEqual(
            NUDENET_640M_URL,
            "https://github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/640m.onnx",
        )


class NudityRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_capability_is_registered_without_initializing_backend(self) -> None:
        runtime = VisionRuntime(make_settings(), engine_factory=FakeFaceEngine)
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(vision_runtime=runtime))
        )

        payload = await v1_capabilities(request)
        capabilities = {capability.name: capability for capability in payload.capabilities}

        self.assertEqual(set(capabilities), {"faces", "nudity"})
        self.assertFalse(capabilities["nudity"].ready)
        self.assertEqual(capabilities["nudity"].state, "created")
        self.assertEqual(capabilities["nudity"].providers, [])
        self.assertEqual(capabilities["nudity"].taxonomy_revision, "nudenet-selected-11-v1")
        self.assertEqual(
            capabilities["nudity"].model_revision,
            f"nudenet-3.4.2/640m@sha256:{NUDENET_640M_SHA256}",
        )

    async def test_nudity_capability_is_accepted_by_the_versioned_manifest(self) -> None:
        backend = FakeNudeNetBackend(
            [[{"class": "ANUS_COVERED", "score": 0.6, "box": [1, 2, 3, 4]}]]
        )
        runtime = VisionRuntime(
            make_settings(),
            detector_factories={
                "faces": lambda: SimpleNamespace(
                    capability="faces",
                    model_revision="fake-face-1",
                    taxonomy_revision="faces-v1",
                    providers=("fake",),
                    analyze_batch=lambda images: [
                        DetectorItemResult(findings=()) for _image in images
                    ],
                    close=lambda: None,
                ),
                "nudity": lambda: NudeNetDetectorAdapter(backend_factory=lambda: backend),
            },
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)
        file = upload(b"synthetic")
        manifest = json.dumps(
            {
                "version": "1",
                "capabilities": ["nudity"],
                "items": [{"id": "frame", "timestamp_seconds": 2.5, "file_field": "image"}],
            }
        )
        form = FormData([("manifest", manifest), ("image", file)])
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(vision_runtime=runtime)),
            form=lambda: None,
        )

        async def request_form() -> FormData:
            return form

        request.form = request_form
        try:
            with patch(
                "vision_service.routes.v1._decode_image",
                return_value=np.zeros((50, 100, 3), dtype=np.uint8),
            ):
                payload = await analyze(request=request, runtime=runtime, settings=runtime.settings)
        finally:
            await file.close()

        outcome = payload.items[0].outcomes[0]
        self.assertEqual(outcome.capability, "nudity")
        self.assertEqual(outcome.status, "ok")
        self.assertEqual(outcome.findings[0].label, "ANUS_COVERED")
        capability_payload = await v1_capabilities(request)
        nudity_capability = next(
            capability
            for capability in capability_payload.capabilities
            if capability.name == "nudity"
        )
        self.assertTrue(nudity_capability.ready)
        self.assertEqual(
            nudity_capability.providers,
            ["MIGraphXExecutionProvider", "CPUExecutionProvider"],
        )

    async def test_runtime_allows_cpu_backend_only_when_gpu_requirement_is_disabled(self) -> None:
        backend = FakeNudeNetBackend([[]], providers=("CPUExecutionProvider",))
        runtime = VisionRuntime(
            make_settings(nudity_require_gpu=False),
            engine_factory=FakeFaceEngine,
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        with patch(
            "vision_service.runtime.create_nudenet_backend",
            return_value=backend,
        ) as backend_factory:
            outcomes = await runtime.analyze_batch("nudity", [image()])

        self.assertIsInstance(outcomes[0], DetectorItemResult)
        backend_factory.assert_called_once_with(
            model_name="640m",
            model_cache_dir=runtime.settings.model_cache_dir,
            providers=("MIGraphXExecutionProvider", "CPUExecutionProvider"),
            require_gpu=False,
            batch_size=16,
            fp16_enabled=False,
        )
        statuses = {status.name: status for status in runtime.capability_statuses()}
        self.assertTrue(statuses["nudity"].ready)
        self.assertEqual(statuses["nudity"].providers, ("CPUExecutionProvider",))

    async def test_runtime_uses_configured_320n_model_and_reports_its_revision(self) -> None:
        backend = FakeNudeNetBackend([[]])
        settings = make_settings(nudity_model="320n")
        runtime = VisionRuntime(settings, engine_factory=FakeFaceEngine)
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        with patch(
            "vision_service.runtime.create_nudenet_backend",
            return_value=backend,
        ) as backend_factory:
            outcomes = await runtime.analyze_batch("nudity", [image()])

        self.assertIsInstance(outcomes[0], DetectorItemResult)
        backend_factory.assert_called_once_with(
            model_name="320n",
            model_cache_dir=settings.model_cache_dir,
            providers=("MIGraphXExecutionProvider", "CPUExecutionProvider"),
            require_gpu=True,
            batch_size=16,
            fp16_enabled=False,
        )
        statuses = {status.name: status for status in runtime.capability_statuses()}
        self.assertIn("nudenet-3.4.2/320n@sha256:", statuses["nudity"].model_revision)

    async def test_lazy_initialization_failure_does_not_affect_faces_or_liveness(self) -> None:
        def fail_backend():
            raise RuntimeError("backend unavailable")

        nudity = NudeNetDetectorAdapter(backend_factory=fail_backend)
        runtime = VisionRuntime(
            make_settings(),
            detector_factories={
                "faces": lambda: SimpleNamespace(
                    capability="faces",
                    model_revision="fake-face-1",
                    taxonomy_revision="faces-v1",
                    providers=("fake",),
                    analyze_batch=lambda images: [
                        DetectorItemResult(findings=()) for _image in images
                    ],
                    close=lambda: None,
                ),
                "nudity": lambda: nudity,
            },
        )
        await runtime.start()
        self.addAsyncCleanup(runtime.stop)

        outcomes = await runtime.analyze_batch("nudity", [image()])

        self.assertIsInstance(outcomes[0], DetectorItemError)
        assert isinstance(outcomes[0], DetectorItemError)
        self.assertEqual(outcomes[0].code, "DETECTOR_INITIALIZATION_FAILED")
        self.assertTrue(runtime.is_capability_ready("faces"))
        self.assertFalse(runtime.is_capability_ready("nudity"))
        self.assertEqual(runtime.state, RuntimeState.READY)
        statuses = {status.name: status for status in runtime.capability_statuses()}
        self.assertEqual(statuses["nudity"].state, RuntimeState.FAILED)
        self.assertEqual(statuses["nudity"].failure_code, "DETECTOR_INITIALIZATION_FAILED")
        self.assertEqual((await livez()).status, "alive")


if __name__ == "__main__":
    unittest.main()
