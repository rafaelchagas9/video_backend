"""Namespace native compiled programs by the settings that determine their execution."""

import hashlib
import json
import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from .config import VISION_SERVICE_ROOT, Settings
from .nudity import get_nudenet_model_spec


def _version(distribution: str) -> str:
    try:
        return version(distribution)
    except PackageNotFoundError:
        return "unavailable"


def _native_runtime_identity() -> dict[str, object]:
    # MIGraphX is commonly installed by the OS rather than as Python metadata.
    # Include the actual library and GPU identifiers in that case as well.
    libraries = {}
    for directory in {Path(os.environ.get("ROCM_PATH", "/opt/rocm")) / "lib", Path("/usr/lib")}:
        for path in directory.glob("libmigraphx.so*"):
            resolved = path.resolve()
            stat = resolved.stat()
            libraries[str(resolved)] = [stat.st_size, stat.st_mtime_ns]
    devices = {}
    for device in Path("/sys/class/drm").glob("renderD*/device"):
        devices[device.parent.name] = {
            name: (device / name).read_text().strip()
            for name in ("vendor", "device", "revision") if (device / name).is_file()
        }
    return {"libraries": libraries, "devices": devices}


def cache_identity(settings: Settings) -> dict[str, object]:
    return {
        "version": 1,
        "nudity_model": get_nudenet_model_spec(settings.nudity_model).model_revision,
        "nudity_fp16": settings.effective_nudity_fp16(),
        "batch_size": settings.max_batch_items,
        "face_model": settings.insightface_model,
        "onnxruntime": _version("onnxruntime-migraphx"),
        "migraphx": _version("migraphx"),
        "native_runtime": _native_runtime_identity(),
        "environment": {key: value for key, value in os.environ.items()
                        if key.startswith(("ORT_MIGRAPHX_", "MIGRAPHX_"))
                        and key not in {"ORT_MIGRAPHX_MODEL_CACHE_PATH", "MIGRAPHX_CACHE_ROOT"}},
        "gpu": {key: os.environ.get(key, "") for key in
                ("HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "HSA_OVERRIDE_GFX_VERSION")},
    }


def configure_compiled_cache(settings: Settings, root: Path | None = None) -> Path:
    """Call before any ONNX sessions are constructed, once during process startup."""
    base = root or Path(os.environ.get("MIGRAPHX_CACHE_ROOT", VISION_SERVICE_ROOT / ".migraphx_cache"))
    identity = cache_identity(settings)
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode()).hexdigest()[:24]
    precision = "fp16" if identity["nudity_fp16"] else "fp32"
    target = base / f"{precision}-{digest}"
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    (target / "execution.json").write_text(encoded + "\n")
    os.environ["ORT_MIGRAPHX_MODEL_CACHE_PATH"] = str(target.resolve())
    return target
