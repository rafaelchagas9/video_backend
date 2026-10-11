#!/usr/bin/env python3
"""Synthetic vision unit tests: offline, no deployment settings or model sessions."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKER = "VISION_OFFLINE_TEST_NAMESPACE"


def enter_isolation():
    python = ROOT / ".venv/bin/python"
    if not python.is_file():
        raise SystemExit("Provision the vision .venv dependencies before testing.")
    unshare = shutil.which("unshare")
    if unshare is None:
        raise SystemExit("unshare is required; refusing inherited host networking.")
    env = {"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHONPATH": str(ROOT / "src"), MARKER: "1"}
    os.execve(unshare, [unshare, "--user", "--map-root-user", "--net",
                       str(python), str(Path(__file__).resolve())], env)


def verify_isolation():
    # The marker alone must never bypass isolation on a connected host.
    try:
        interfaces = {line.split(":", 1)[0].strip()
                      for line in Path("/proc/net/dev").read_text().splitlines() if ":" in line}
    except OSError as error:
        raise SystemExit("Cannot verify network isolation; refusing tests.") from error
    if interfaces - {"lo"}:
        raise SystemExit("Host network interfaces are visible; refusing tests.")
    if sys.prefix != str(ROOT / ".venv"):
        raise SystemExit("Tests require the project's provisioned .venv interpreter.")


def deny_deployment_files(event, args):
    if event != "open" or not args or isinstance(args[0], int):
        return
    try:
        path = Path(os.fsdecode(args[0])).resolve()
    except (TypeError, ValueError):
        return
    forbidden = (ROOT / "models", ROOT / ".migraphx_cache")
    if path == ROOT / ".env" or any(path == base or base in path.parents for base in forbidden):
        raise AssertionError("Deployment settings, models and caches are forbidden in unit tests")


def run_tests():
    sys.addaudithook(deny_deployment_files)
    import socket
    import types
    import unittest
    from unittest.mock import patch

    original_connect = socket.socket.connect
    def offline_connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise AssertionError("Network connections are forbidden in offline tests")
        return original_connect(sock, address)

    def forbidden_session(*args, **kwargs):
        raise AssertionError("Real model engines and ONNX sessions are forbidden in unit tests")

    face_module = types.ModuleType("vision_service.face_engine")
    face_module.FaceEngine = forbidden_session
    sys.modules["vision_service.face_engine"] = face_module
    from vision_service.config import Settings
    Settings.model_config["env_file"] = None
    from vision_service.clip_engine import ClipEngine
    from vision_service import compiled_cache

    # Importing main defines a global app; prevent its deployment cache writes.
    with patch.object(socket.socket, "connect", offline_connect), patch.object(
        compiled_cache, "configure_compiled_cache", return_value=ROOT / "unused-test-cache"
    ):
        import vision_service.main  # noqa: F401

    import onnxruntime
    with (patch.object(socket.socket, "connect", offline_connect),
          patch.object(ClipEngine, "__init__", side_effect=forbidden_session),
          patch.object(onnxruntime, "InferenceSession", side_effect=forbidden_session)):
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    if os.environ.get(MARKER) != "1":
        enter_isolation()
    verify_isolation()
    os.chdir(ROOT.parent)
    raise SystemExit(run_tests())
