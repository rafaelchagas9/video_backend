"""Disposable numeric fixtures; fake decoder/model, no source media or GPU."""
import contextlib, io, json, tempfile, time, types, unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import audio_cache_worker as worker

class CompletionTests(unittest.TestCase):
 def test_success_and_reused_generation_are_distinct(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);source=root/'source.fixture';source.write_text('numeric fixture')
   identity=dict(schema_version=1,video_id=7,analyzed_at='2026-10-10T00:00:00.000Z',index_model_revision='fixture',storyboard_generated_at='2026-10-10T00:00:00.000Z',frame_count=1,audio_model_revision=worker.PIN,source_fingerprint=worker.fingerprint(source))
   job=root/worker.cache_name(identity);payload=dict(identity=identity,source_path=str(source),proposals=[dict(id='c1',start_seconds=0,end_seconds=60)])
   def write():job.write_text(json.dumps(payload))
   vectors=np.zeros((2,768));vectors[:,0]=1
   fake=types.SimpleNamespace(encode=lambda *args,**kwargs:vectors)
   torch=types.SimpleNamespace(inference_mode=contextlib.nullcontext)
   process=worker.Processor(time.monotonic()+10,root/'cache');process.model=fake;write()
   with patch.object(worker,'await_idle'),patch.object(worker,'decode',return_value=np.zeros(worker.SAMPLES)),patch.dict('sys.modules',{'torch':torch}):process.process(job)
   output=io.StringIO()
   with contextlib.redirect_stdout(output):process.completion()
   self.assertEqual(json.loads(output.getvalue()),dict(event='recordings:model-ready',video_ids=[7]))
   write();reused=worker.Processor(time.monotonic()+10,root/'cache')
   with patch.object(worker,'decode',side_effect=AssertionError('cached audio must not decode')):reused.process(job)
   output=io.StringIO()
   with contextlib.redirect_stdout(output):reused.completion()
   self.assertEqual(output.getvalue(),'')
 def test_partial_success_then_deferred_still_reports_only_durable_change(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);source=root/'source.fixture';source.write_text('numeric fixture')
   identity=dict(schema_version=1,video_id=9,analyzed_at='2026-10-10T00:00:00.000Z',index_model_revision='fixture',storyboard_generated_at='2026-10-10T00:00:00.000Z',frame_count=1,audio_model_revision=worker.PIN,source_fingerprint=worker.fingerprint(source))
   job=root/worker.cache_name(identity)
   job.write_text(json.dumps(dict(identity=identity,source_path=str(source),proposals=[dict(id='c1',start_seconds=0,end_seconds=60),dict(id='c2',start_seconds=60,end_seconds=120)])))
   vectors=np.zeros((2,768));vectors[:,0]=1
   process=worker.Processor(time.monotonic()+10,root/'cache');process.model=types.SimpleNamespace(encode=lambda *args,**kwargs:vectors)
   with patch.object(worker,'await_idle'),patch.object(worker,'decode',side_effect=[np.zeros(worker.SAMPLES),np.zeros(worker.SAMPLES),worker.Deferred()]),patch.dict('sys.modules',{'torch':types.SimpleNamespace(inference_mode=contextlib.nullcontext)}):
    with self.assertRaises(worker.Deferred):process.process(job)
   self.assertTrue(job.exists())
   self.assertEqual(len(json.loads((root/'cache'/worker.cache_name(identity)).read_text())['proposals']),1)
   output=io.StringIO()
   with contextlib.redirect_stdout(output):process.completion()
   self.assertEqual(json.loads(output.getvalue()),dict(event='recordings:model-ready',video_ids=[9]))
 def test_deferred_without_writes_is_silent(self):
  process=worker.Processor(time.monotonic()+10,Path('/unused'))
  output=io.StringIO()
  with contextlib.redirect_stdout(output):process.completion()
  self.assertEqual(output.getvalue(),'')
if __name__=='__main__':unittest.main()
