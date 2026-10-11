#!/usr/bin/env python3
"""Run synthetic enrichment tests with no deployment files or host networking."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKER = "ENRICHMENT_OFFLINE_TEST_NAMESPACE"


def enter_isolation() -> None:
    python = ROOT / ".venv/bin/python"
    if not python.is_file():
        raise SystemExit("Provision the enrichment .venv dependencies before testing.")
    unshare = shutil.which("unshare")
    if unshare is None:
        raise SystemExit("unshare is required; refusing inherited host networking.")
    env = {
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(ROOT / "src"),
        MARKER: "1",
    }
    os.execve(unshare, [unshare, "--user", "--map-root-user", "--net",
                       str(python), str(Path(__file__).resolve())], env)


def verify_isolation() -> None:
    try:
        interfaces = {line.split(":", 1)[0].strip()
                      for line in Path("/proc/net/dev").read_text().splitlines() if ":" in line}
    except OSError as error:
        raise SystemExit("Cannot verify network isolation; refusing tests.") from error
    if interfaces - {"lo"}:
        raise SystemExit("Host network interfaces are visible; refusing tests.")
    if sys.prefix != str(ROOT / ".venv"):
        raise SystemExit("Tests require the project's provisioned .venv interpreter.")


def within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def run_tests() -> int:
    import socket
    import unittest
    from unittest.mock import patch

    original_connect = socket.socket.connect

    def offline_connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise AssertionError("Network connections are forbidden in offline tests")
        return original_connect(sock, address)

    with tempfile.TemporaryDirectory(prefix="enrichment-offline-test-") as directory:
        fixture_root = Path(directory).resolve()
        runtime_roots = (Path(sys.prefix).resolve(), Path(sys.base_prefix).resolve())

        def deny_deployment_files(event, args):
            if event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.posix_spawnp"}:
                raise AssertionError("External processes are forbidden in offline unit tests")
            write_paths = {
                "os.mkdir": ((0, 2),), "os.rmdir": ((0, 1),), "os.remove": ((0, 1),),
                "os.rename": ((0, 2), (1, 3)), "os.link": ((0, 2), (1, 3)),
                "os.symlink": ((1, 2),), "os.chmod": ((0, 2),),
                "os.chown": ((0, 3),), "os.truncate": ((0, None),),
            }
            if event in write_paths:
                for index, fd_index in write_paths[event]:
                    value = args[index]
                    if isinstance(value, int):
                        path = Path(f"/proc/self/fd/{value}").resolve()
                    else:
                        path = Path(os.fsdecode(value))
                        directory_fd = args[fd_index] if fd_index is not None and len(args) > fd_index else -1
                        if not path.is_absolute() and directory_fd not in (None, -1):
                            path = Path(f"/proc/self/fd/{directory_fd}").resolve() / path
                        path = path.resolve()
                    if not within(path, fixture_root):
                        raise AssertionError("Offline tests may mutate only disposable fixtures")
                return
            if event != "open" or not args or isinstance(args[0], int):
                return
            try:
                path = Path(os.fsdecode(args[0])).resolve()
            except (TypeError, ValueError):
                return
            mode = args[1] or ""
            flags = args[2] if len(args) > 2 else 0
            writes = any(marker in mode for marker in "wax+") or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            if within(path, fixture_root):
                return
            if writes:
                raise AssertionError("Offline tests may write only disposable fixtures")
            if path.name == ".env" or within(path, ROOT / "data"):
                raise AssertionError("Deployment settings and provider credentials are forbidden in unit tests")
            if within(path, ROOT) or any(within(path, runtime) for runtime in runtime_roots):
                return
            if path == Path("/dev/null"):
                return
            raise AssertionError("Only source, runtime and synthetic fixtures may be read in offline tests")

        original_tempdir = tempfile.tempdir
        tempfile.tempdir = str(fixture_root)
        try:
            sys.addaudithook(deny_deployment_files)
            from enrichment_service.config import Settings
            Settings.model_config["env_file"] = None
            os.environ["PROVIDER_CONFIG_PATH"] = str(fixture_root / "providers.json")
            with patch.object(socket.socket, "connect", offline_connect):
                suite = unittest.defaultTestLoader.discover(str(ROOT), pattern="test_*.py")
                result = unittest.TextTestRunner(verbosity=1).run(suite)
                return 0 if result.wasSuccessful() else 1
        finally:
            tempfile.tempdir = original_tempdir


if __name__ == "__main__":
    if os.environ.get(MARKER) != "1":
        enter_isolation()
    verify_isolation()
    # Even a manually supplied namespace marker cannot retain deployment keys.
    os.environ.clear()
    os.environ.update({"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
    sys.path.insert(0, str(ROOT / "src"))
    os.chdir(ROOT)
    raise SystemExit(run_tests())
