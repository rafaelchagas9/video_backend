"""Single-host admission and explicit bounds for persistent derived data."""

import fcntl
import os
import shutil
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def gpu_admission(cache: Path):
    """A kernel lock survives cancellation/crash safely; workers share one cache root."""
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (cache / "gpu.lock").open("a+b") as handle:
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.2)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class CacheBudget:
    def __init__(self, root: Path, maximum_bytes: int | None = None):
        self.root = root
        self.maximum = (
            maximum_bytes
            if maximum_bytes is not None
            else int(os.environ.get("COPY_CACHE_MAX_BYTES", str(128 * 1024**3)))
        )
        if self.maximum <= 0:
            raise ValueError("COPY_CACHE_FULL: cache budget must be positive")
        # CLI creates this budget only while holding gpu_admission. Remove
        # incomplete writes left by SIGKILL; published indexes are never removed.
        for partial in (root / "indexes").glob("*/.chunk-*.tmp"):
            if partial.is_file() and not partial.is_symlink():
                partial.unlink(missing_ok=True)
        self.used = sum(
            path.stat().st_size
            for path in (root / "indexes").glob("*/*.npz")
            if path.is_file() and not path.is_symlink()
        )
        self.used += sum(
            path.stat().st_size
            for folder in root.glob("retrieval*")
            if folder.is_dir() and not folder.is_symlink()
            for path in folder.glob("*")
            if path.is_file() and not path.is_symlink() and path.suffix in {".faiss", ".npz"}
        )

    def check(self, reserve: int):
        if (
            self.used + reserve > self.maximum
            or shutil.disk_usage(self.root).free < reserve + 1024**3
        ):
            raise RuntimeError(
                "COPY_CACHE_FULL: remove unused derived indexes or increase the cache budget"
            )

    def add(self, size: int):
        self.used += size

    def remove(self, size: int):
        self.used = max(0, self.used - size)
