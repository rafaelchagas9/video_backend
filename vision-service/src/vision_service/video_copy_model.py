"""Copy-specific SSCD inference, with explicit AMD execution and reproducible cache identity."""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

MODEL_SOURCE_SHA256 = "9f26bd4c848cc19b73d2ae92eea6e04886f61a7b764ceb7a13aeee62e6a6db56"


class CopyModel:
    batch_size = 8

    def __init__(self, cache_dir: Path):
        model_path = Path(
            os.environ.get(
                "COPY_MODEL_PATH",
                Path(__file__).resolve().parents[2] / "models/copies/sscd_disc_mixup.onnx",
            )
        )
        if not model_path.is_file():
            raise RuntimeError("COPY_MODEL_MISSING: install the official exported SSCD model")
        self.digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
        manifest = json.loads(model_path.with_suffix(".json").read_text())
        if (
            manifest.get("source_sha256") != MODEL_SOURCE_SHA256
            or manifest.get("onnx_sha256") != self.digest
        ):
            raise RuntimeError("COPY_MODEL_INVALID: model provenance or checksum mismatch")
        if os.environ.get("ORT_MIGRAPHX_FP16_ENABLE", "0") != "0":
            raise RuntimeError(
                "COPY_PRECISION_INVALID: Copy verification requires FP32; remove the process FP16 override"
            )
        import platform

        from .compiled_cache import _native_runtime_identity

        identity = hashlib.sha256(
            json.dumps(
                {
                    "model": self.digest,
                    "ort": ort.__version__,
                    "native": _native_runtime_identity(),
                    "kernel": platform.release(),
                    "precision": "fp32",
                    "device": {
                        key: os.environ.get(key, "")
                        for key in (
                            "HIP_VISIBLE_DEVICES",
                            "ROCR_VISIBLE_DEVICES",
                            "HSA_OVERRIDE_GFX_VERSION",
                        )
                    },
                    "options": {
                        key: value
                        for key, value in os.environ.items()
                        if key.startswith(("ORT_MIGRAPHX_", "MIGRAPHX_"))
                        and key not in ("ORT_MIGRAPHX_MODEL_CACHE_PATH", "MIGRAPHX_CACHE_ROOT")
                    },
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()[:32]
        compiled = cache_dir / "compiled" / identity
        compiled.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.environ["ORT_MIGRAPHX_MODEL_CACHE_PATH"] = str(compiled)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
        options.enable_profiling = True
        options.profile_file_prefix = str(compiled / "execution")
        if "MIGraphXExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("COPY_GPU_UNAVAILABLE: MIGraphX execution provider is required")
        started = time.monotonic()
        self.session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=[("MIGraphXExecutionProvider", {"migraphx_fp16_enable": "0"})],
        )
        self.session.disable_fallback()
        if self.session.get_inputs()[0].shape != [8, 3, 288, 288]:
            raise RuntimeError("COPY_MODEL_INVALID: unexpected input shape")
        self.embed([np.zeros((288, 288, 3), dtype=np.uint8)])
        profile = Path(self.session.end_profiling())
        events = json.loads(profile.read_text())
        providers = sorted(
            {e.get("args", {}).get("provider") for e in events if e.get("args", {}).get("provider")}
        )
        profile.unlink(missing_ok=True)
        if providers != ["MIGraphXExecutionProvider"]:
            raise RuntimeError(
                "COPY_GPU_UNVERIFIED: warmup did not execute exclusively on MIGraphX"
            )
        self.runtime = {
            "inference_provider": providers[0],
            "onnxruntime": ort.__version__,
            "precision": "fp32",
            "decode": "vaapi",
            "model_sha256": self.digest,
            "initialization_seconds": round(time.monotonic() - started, 3),
        }

    def embed(self, frames: list[np.ndarray]) -> np.ndarray:
        if not 0 < len(frames) <= self.batch_size:
            raise ValueError("Invalid embedding batch size")
        batch = np.zeros((self.batch_size, 3, 288, 288), dtype=np.float32)
        batch[: len(frames)] = np.stack(frames).transpose(0, 3, 1, 2).astype(np.float32) / 255
        batch -= np.array([0.485, 0.456, 0.406], dtype=np.float32)[None, :, None, None]
        batch /= np.array([0.229, 0.224, 0.225], dtype=np.float32)[None, :, None, None]
        result = self.session.run(None, {self.session.get_inputs()[0].name: batch})[0][
            : len(frames)
        ]
        norms = np.linalg.norm(result, axis=1, keepdims=True)
        if (
            result.shape != (len(frames), 512)
            or not np.isfinite(result).all()
            or (norms < 0.01).any()
        ):
            raise RuntimeError("COPY_MODEL_INVALID: Invalid copy descriptor output")
        return result / norms


class GpuFrameSearch:
    """Exact cosine top-K in bounded GPU blocks, avoiding a CPU all-pairs scan."""

    def __init__(self):
        import onnx
        from onnx import TensorProto, helper, numpy_helper

        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
        options.log_severity_level = 3
        graph = helper.make_graph(
            [
                helper.make_node("Transpose", ["reference"], ["transposed"], perm=[1, 0]),
                helper.make_node("MatMul", ["query", "transposed"], ["cosines"]),
                helper.make_node("Add", ["cosines", "mask"], ["masked"]),
                helper.make_node("TopK", ["masked", "k"], ["values", "indices"], axis=1),
            ],
            "exact-copy-search",
            [
                helper.make_tensor_value_info("query", TensorProto.FLOAT, [128, 512]),
                helper.make_tensor_value_info("reference", TensorProto.FLOAT, [4096, 512]),
                helper.make_tensor_value_info("mask", TensorProto.FLOAT, [4096]),
            ],
            [
                helper.make_tensor_value_info("values", TensorProto.FLOAT, [128, 3]),
                helper.make_tensor_value_info("indices", TensorProto.INT64, [128, 3]),
            ],
            [numpy_helper.from_array(np.array([3], dtype=np.int64), "k")],
        )
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=9)
        onnx.checker.check_model(model)
        self.session = ort.InferenceSession(
            model.SerializeToString(),
            sess_options=options,
            providers=[("MIGraphXExecutionProvider", {"migraphx_fp16_enable": "0"})],
        )

        self.session.disable_fallback()
        if "MIGraphXExecutionProvider" not in self.session.get_providers():
            raise RuntimeError("COPY_GPU_UNVERIFIED: GPU search provider is unavailable")

    def nearest(self, query: np.ndarray, reference: np.ndarray, k: int = 3):
        if k != 3:
            raise ValueError("GPU search requires three neighbors")
        for start in range(0, len(query), 128):
            block = query[start : start + 128]
            q_input = np.zeros((128, 512), dtype=np.float32)
            q_input[: len(block)] = block
            values = np.full((len(block), 3), -np.inf, dtype=np.float32)
            indices = np.zeros((len(block), 3), dtype=np.int64)
            for offset in range(0, len(reference), 4096):
                ref = reference[offset : offset + 4096]
                r_input = np.zeros((4096, 512), dtype=np.float32)
                r_input[: len(ref)] = ref
                mask = np.full(4096, -2.0, dtype=np.float32)
                mask[: len(ref)] = 0
                scores, found = self.session.run(
                    None, {"query": q_input, "reference": r_input, "mask": mask}
                )
                scores, found = scores[: len(block)], found[: len(block)]
                scores[found >= len(ref)] = -np.inf
                found[found >= len(ref)] = 0
                merged_values = np.concatenate([values, scores], axis=1)
                merged_indices = np.concatenate([indices, found + offset], axis=1)
                keep = np.argpartition(merged_values, -3, axis=1)[:, -3:]
                values = np.take_along_axis(merged_values, keep, axis=1)
                indices = np.take_along_axis(merged_indices, keep, axis=1)
            yield start, values, indices
