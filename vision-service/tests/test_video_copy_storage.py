import select
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from vision_service.video_copy_storage import CacheBudget, gpu_admission


class CopyStorageTests(unittest.TestCase):
    def test_budget_removes_only_stale_chunk_temporaries_and_counts_published_indexes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "indexes" / ("a" * 64)
            folder.mkdir(parents=True)
            published = folder / "0.npz"
            partial = folder / ".chunk-interrupted.tmp"
            unrelated = folder / "keep.tmp"
            published.write_bytes(b"published")
            partial.write_bytes(b"partial")
            unrelated.write_bytes(b"unrelated")

            budget = CacheBudget(root, maximum_bytes=100)

            self.assertFalse(partial.exists())
            self.assertEqual(published.read_bytes(), b"published")
            self.assertEqual(unrelated.read_bytes(), b"unrelated")
            self.assertEqual(budget.used, len(b"published"))

    def test_cache_limit_counts_existing_indexes_and_reserves_next_chunk(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "indexes" / ("a" * 64)
            folder.mkdir(parents=True)
            (folder / "0.npz").write_bytes(b"0123456789")
            budget = CacheBudget(root, maximum_bytes=20)
            self.assertEqual(budget.used, 10)
            budget.check(10)
            with self.assertRaisesRegex(RuntimeError, "COPY_CACHE_FULL"):
                budget.check(11)
            budget.add(5)
            with self.assertRaisesRegex(RuntimeError, "COPY_CACHE_FULL"):
                budget.check(6)

    def test_admission_releases_lock_after_exception(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "failure"):
                with gpu_admission(root):
                    raise ValueError("failure")
            with gpu_admission(root):
                self.assertTrue((root / "gpu.lock").exists())

    def test_admission_serializes_processes_and_releases_after_forced_exit(self):
        holder_script = """
import sys
import time
from pathlib import Path
from vision_service.video_copy_storage import gpu_admission

with gpu_admission(Path(sys.argv[1])):
    print("locked", flush=True)
    time.sleep(30)
"""
        contender_script = """
import sys
from pathlib import Path
from vision_service.video_copy_storage import gpu_admission

with gpu_admission(Path(sys.argv[1])):
    print("acquired", flush=True)
"""
        with tempfile.TemporaryDirectory() as temporary:
            holder = subprocess.Popen(
                [sys.executable, "-c", holder_script, temporary],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            contender = None
            try:
                ready, _, _ = select.select([holder.stdout], [], [], 2)
                self.assertTrue(ready, "holder did not acquire the lock")
                self.assertEqual(holder.stdout.readline().strip(), "locked")

                contender = subprocess.Popen(
                    [sys.executable, "-c", contender_script, temporary],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                ready, _, _ = select.select([contender.stdout], [], [], 0.4)
                self.assertFalse(ready, "contender acquired an already-held lock")

                started = time.monotonic()
                holder.kill()
                holder.wait(timeout=3)
                ready, _, _ = select.select([contender.stdout], [], [], 2)
                self.assertTrue(ready, "lock was not released when the holder exited")
                self.assertEqual(contender.stdout.readline().strip(), "acquired")
                self.assertEqual(contender.wait(timeout=3), 0)
                self.assertLess(time.monotonic() - started, 3)
            finally:
                for process in (holder, contender):
                    if process is None:
                        continue
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=3)


if __name__ == "__main__":
    unittest.main()
