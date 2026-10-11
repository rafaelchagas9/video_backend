import json,tempfile,time,unittest
from unittest import mock
from types import SimpleNamespace
from pathlib import Path
import numpy as np
import final_worth_match as m

class FinalMatchTests(unittest.TestCase):
 def test_uniform_window_runtime_parity_and_exact_reuse(self):
  self.assertEqual(m.intervals(1767,2443),[1982.333,2207.667])
  self.assertEqual(m.intervals(0,20),[0.,0.])
  with self.assertRaises(ValueError):m.intervals(0,19.9)
  v=np.zeros((2,768));v[0,0]=1;v[1,1]=1
  result=m.exact_reuse([56.,122.],[64.,122.],v)
  self.assertIsNone(result[0]);np.testing.assert_array_equal(result[1],v[1])
 def test_offered_checkpoint_rejects_pin_offset_and_truncation(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'x.npz';v=np.zeros((2,768));v[:,0]=1
   def write(**change):np.savez(p,**dict(dict(v=v,offsets=[1.,2.],revision=m.aw.REVISION,decoded_samples=[320000,320000]),**change))
   write();np.testing.assert_array_equal(m.offered_vectors(p,[1.,2.]),v)
   for change in ({'revision':'wrong'},{'offsets':[1.,3.]},{'decoded_samples':[320000,319999]}):
    write(**change)
    with self.assertRaises(ValueError):m.offered_vectors(p,[1.,2.])
 def test_final_checkpoint_identity_and_atomic_roundtrip(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'embeddings/x.npz';row={'identity_sha256':'abc','window_offsets':[1.,2.]};v=np.zeros((2,768));v[:,0]=1
   m.checkpoint(row,v,p);np.testing.assert_array_equal(m.final_checkpoint(row,p),v)
   with self.assertRaises(ValueError):m.final_checkpoint(dict(row,identity_sha256='changed'),p)
 def test_staged_source_guard_never_opens_media(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);p=root/'joint-gemma/audio/a.flac';p.parent.mkdir(parents=True);p.write_bytes(b'synthetic')
   fp=m.aw.fingerprint(p);row={'cache_path':str(p),'alignment':'aresample_async_first_pts_0','rate':16000,'channels':1,'cache_fingerprint':[fp['size_bytes'],int(fp['mtime_ns'])],'complete_selected_coverage':True,'audio_start':0,'audio_end':30,'cache_sha256':'frozen','source_fingerprint':{}}
   self.assertEqual(m.cache_receipt(row,root)['fingerprint'],fp)
   with self.assertRaises(ValueError):m.cache_receipt(dict(row,cache_path=str(root/'original.mp4')),root)
   row['cache_fingerprint'][0]+=1
   with self.assertRaises(ValueError):m.cache_receipt(row,root)
 def test_owned_gpu_activity_is_not_other_worker_busy(self):
  with mock.patch.object(m.aw,'busy',return_value=False),mock.patch.object(m.aw,'gpu_idle',return_value=False) as gpu:
   m.ensure_idle(time.monotonic()+10);gpu.assert_not_called()
   with self.assertRaises(m.aw.Deferred):m.ensure_idle(time.monotonic()+10,gpu=True)
  with mock.patch.object(m.aw,'busy',return_value=True):
   with self.assertRaises(m.aw.Deferred):m.ensure_idle(time.monotonic()+10)
 def test_cross_filesystem_cache_is_rejected_by_stat(self):
  source=mock.Mock();root=mock.Mock();source.stat.return_value=SimpleNamespace(st_dev=2);root.stat.return_value=SimpleNamespace(st_dev=1)
  with self.assertRaises(ValueError):m.require_same_device(source,root)
  source.stat.return_value=SimpleNamespace(st_dev=1);m.require_same_device(source,root)
 def test_immutable_registration(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'prereg.json';m.frozen(p,{'rows':24});m.frozen(p,{'rows':24})
   with self.assertRaises(ValueError):m.frozen(p,{'rows':40})
 def test_feature_recipe_synthetic_parity(self):
  import prepare as p
  fixture=json.loads((m.ROOT/'feature_parity.json').read_text());proposals=[{'id':r['id'],'start':r['start_seconds'],'end':r['end_seconds'],'score':r['score']} for r in fixture['proposals']]
  result=p.features(proposals,fixture['duration'],np.asarray(fixture['timestamps']),np.asarray(fixture['vectors']))
  np.testing.assert_allclose(result,fixture['features'],rtol=1e-12,atol=1e-12)
if __name__=='__main__':unittest.main()
