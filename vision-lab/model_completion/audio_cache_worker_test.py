"""Numeric-only worker contract tests; no decoder/model is invoked."""
import importlib.util,json,math,tempfile,unittest
from pathlib import Path
SPEC=importlib.util.spec_from_file_location('worker',Path(__file__).with_name('audio_cache_worker.py'));worker=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(worker)
PIN=worker.PIN
class WorkerContract(unittest.TestCase):
 def test_generation_name_and_window_contract(self):
  identity=dict(video_id=123,analyzed_at='2026-10-10T01:02:03.456Z',index_model_revision='index1',storyboard_generated_at='2026-10-10T01:00:00.000Z',frame_count=120,audio_model_revision=PIN)
  self.assertEqual(worker.cache_name(identity),'784d0094a6e1a0e0c1c5441eb9ee766adb30a2eaa2130e24e1877350ccfbafc1.json')
  self.assertEqual(worker.expected_windows(dict(start_seconds=100,end_seconds=190)),[[120,140],[150,170]])
  self.assertEqual(worker.expected_windows(dict(start_seconds=0,end_seconds=20)),[[0,20],[0,20]])
  self.assertIsNone(worker.expected_windows(dict(start_seconds=0,end_seconds=19)))
 def test_original_identity_and_changed_source(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);source=root/'source.bin';source.write_bytes(b'numeric-test-source')
   identity=dict(schema_version=1,video_id=123,analyzed_at='2026-10-10T01:02:03.456Z',index_model_revision='index1',storyboard_generated_at='2026-10-10T01:00:00.000Z',frame_count=120,audio_model_revision=PIN,source_fingerprint=worker.fingerprint(source))
   path=root/worker.cache_name(identity);job=dict(identity=identity,source_path=str(source),proposals=[dict(id='p1',start_seconds=100,end_seconds=190)]);path.write_text(json.dumps(job));self.assertEqual(worker.load_job(path)[0],job)
   source.write_bytes(b'changed');self.assertRaises(ValueError,worker.load_job,path)
 def test_vectors_and_atomic_privacy(self):
  row=dict(id='p1',start_seconds=100,end_seconds=190);cache=dict(row,status='ready',embedding=[1.]+[0.]*767,windows_seconds=worker.expected_windows(row),decoded_samples=[320000,320000])
  self.assertTrue(worker.valid_cached(row,cache));self.assertFalse(worker.valid_cached(row,dict(cache,decoded_samples=[160000,320000])));self.assertFalse(worker.valid_cached(row,dict(cache,embedding=[float('nan')]+[0.]*767)))
  with tempfile.TemporaryDirectory() as temporary:
   path=Path(temporary)/'cache.json';worker.atomic(path,cache);self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertNotIn('source_path',json.loads(path.read_text()))
 def test_ready_cache_resumes_without_media_or_model(self):
  import time
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);source=root/'source.bin';source.write_bytes(b'numeric-test-source');cache_root=root/'cache'
   identity=dict(schema_version=1,video_id=123,analyzed_at='2026-10-10T01:02:03.456Z',index_model_revision='index1',storyboard_generated_at='2026-10-10T01:00:00.000Z',frame_count=120,audio_model_revision=PIN,source_fingerprint=worker.fingerprint(source))
   row=dict(id='p1',start_seconds=100,end_seconds=190);job=dict(identity=identity,source_path=str(source),proposals=[row]);path=root/worker.cache_name(identity);path.write_text(json.dumps(job))
   ready=dict(row,status='ready',embedding=[1.]+[0.]*767,windows_seconds=worker.expected_windows(row),decoded_samples=[320000,320000]);worker.atomic(cache_root/path.name,dict(identity,proposals=[ready]))
   processor=worker.Processor(time.monotonic()+10,cache_root)
   def forbidden():raise AssertionError('Valid cache resume must not load a model')
   processor.model_ready=forbidden;processor.process(path);self.assertFalse(path.exists());self.assertEqual(json.loads((cache_root/path.name).read_text())['proposals'][0],ready)
if __name__=='__main__':unittest.main()
