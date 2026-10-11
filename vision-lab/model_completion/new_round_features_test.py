"""Synthetic exact-generation feature/audio guards; no actual DB/media/model/fits."""
import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import new_round_features as s
import connected_label_round_test as fixtures

class Features(unittest.TestCase):
 def setUp(self):
  self.fixture=fixtures.Connected();self.fixture.setUp();self.root=self.fixture.root;self.live=self.fixture.rows[100];self.ctx=s.base.side(self.live);self.row={'video_id':self.live['video_id'],'feedback_id':100,'group':'channel0'};self.t=np.arange(120)*5.;self.v=np.zeros((120,1152),np.float32);self.v[np.arange(120),np.arange(120)%3]=1
  self.original=[dict(id='100',start_seconds=0.,end_seconds=500.,score=.4),dict(id='other',start_seconds=500.,end_seconds=590.,score=.6)]
 def tearDown(self):self.fixture.tearDown()
 def connection(self,t=None,v=None,review=None):
  times=self.t if t is None else t;vectors=self.v if v is None else v;original=self.original;live=self.live
  class Cursor:
   def __init__(self,rows):self.rows=rows
   def fetchall(self):return self.rows
   def fetchone(self):return self.rows[0] if self.rows else None
  class Connection:
   def execute(self,sql,params):
    if sql.startswith('SELECT analyzed_at'):return Cursor([review if review is not None else (live['analyzed_at'],live['detector'],original,[])])
    if sql.startswith('SELECT timestamp_seconds'):return Cursor([(float(a),json.dumps(b.tolist())) for a,b in zip(times,vectors)])
    raise AssertionError('Only numeric review/frame queries allowed')
  return Connection()
 def test_numeric_domains_are_distinct_and_original_context_preserved(self):
  proposals=[{'id':p['id'],'start':p['start_seconds'],'end':p['end_seconds'],'score':p['score']} for p in self.original]
  before=copy.deepcopy(proposals);offered,visual=s.domain_features(self.row,self.ctx,self.live,self.t,self.v,proposals,20.,80.);cut,_=s.domain_features(self.row,self.ctx,self.live,self.t,self.v,proposals,30.,60.)
  self.assertEqual(len(offered),13);self.assertEqual(len(visual),1152);self.assertNotEqual(offered[0],cut[0]);self.assertEqual(proposals,before)
  expected=copy.deepcopy(proposals);expected[0].update(start=20.,end=80.,score=.4);np.testing.assert_allclose(offered,s.recipe.features(expected,600.,self.t,self.v)[0])
  with self.assertRaises(ValueError):s.domain_features(self.row,self.ctx,self.live,self.t,self.v,proposals,0.,501.)
 def test_live_numeric_generation_source_and_frames_failclosed(self):
  with patch.object(s.historical,'exact_archive',return_value=None):
   t,v,p,identity=s.frame_inputs(self.live,self.ctx,self.connection());self.assertEqual(identity['origin']['kind'],'live_numeric_exact_frozen_generation');self.assertEqual(len(t),120)
   badreview=('2026-10-09T00:00:00Z',self.live['detector'],self.original,[])
   with self.assertRaisesRegex(ValueError,'generation differs'):s.frame_inputs(self.live,self.ctx,self.connection(review=badreview))
   times=self.t.copy();times[1]=20
   with self.assertRaisesRegex(ValueError,'coverage'):s.frame_inputs(self.live,self.ctx,self.connection(t=times))
   bad=self.v.copy();bad[0]=0
   with self.assertRaisesRegex(ValueError,'unit'):s.frame_inputs(self.live,self.ctx,self.connection(v=bad))
  changed=copy.deepcopy(self.live);changed['indexed_at']='older'
  with self.assertRaises(Exception):s.validate_live(self.row,self.ctx,changed)
 def test_original_audio_mean_never_substitutes_trimmed_domain(self):
  cache=self.root/'cache';cache.mkdir();self.assertIsNone(s.exact_production_audio(self.row,self.ctx,self.live,20.,60.,cache))
  fp={k:self.ctx['source_fingerprint'][k] for k in ('size_bytes','mtime_ns')};identity={'schema_version':1,'video_id':self.row['video_id'],'analyzed_at':self.ctx['analyzed_at'],'index_model_revision':self.ctx['index']['model_revision'],'storyboard_generated_at':self.ctx['index']['storyboard_generated_at'],'frame_count':self.ctx['index']['frame_count'],'audio_model_revision':s.audio.PIN,'source_fingerprint':fp};vector=np.zeros(768);vector[0]=1
  original={'id':'100','start_seconds':0.,'end_seconds':500.,'status':'ready','embedding':vector.tolist(),'windows_seconds':s.audio.expected_windows({'start_seconds':0.,'end_seconds':500.}),'decoded_samples':[320000,320000]};path=cache/s.audio.cache_name(identity);path.write_text(json.dumps(dict(identity,proposals=[original])))
  self.assertIsNotNone(s.exact_production_audio(self.row,self.ctx,self.live,0.,500.,cache));self.assertIsNone(s.exact_production_audio(self.row,self.ctx,self.live,20.,60.,cache))
  changed=copy.deepcopy(identity);changed['source_fingerprint']['mtime_ns']='1';path.write_text(json.dumps(dict(changed,proposals=[original])))
  with self.assertRaisesRegex(ValueError,'generation/source/index'):s.exact_production_audio(self.row,self.ctx,self.live,0.,500.,cache)
 def test_ssd_needs_require_fingerprint_alignment_coverage_and_same_device(self):
  stage=self.root/'joint-gemma/audio';stage.mkdir(parents=True);cache=stage/'neutral.flac';cache.write_bytes(b'no audio is read');info=cache.stat();receipt={'video_id':self.row['video_id'],'source_fingerprint':{k:self.ctx['source_fingerprint'][k] for k in ('size_bytes','mtime_ns')},'alignment':'aresample_async_first_pts_0','rate':16000,'channels':1,'cache_path':str(cache),'cache_fingerprint':[info.st_size,info.st_mtime_ns],'cache_sha256':'0'*64,'audio_start':0.,'audio_end':500.};path=self.root/'joint-gemma/audio_reuse_manifest.json';path.write_text(json.dumps({'rows':[receipt]}))
  self.assertEqual(s.ssd_need(self.row,self.ctx,20.,80.,self.root)['status'],'ssd_extraction_ready')
  self.assertEqual(s.ssd_need(self.row,self.ctx,20.,30.,self.root)['status'],'shorter_than20s')
  for key,value in [('alignment','wrong'),('audio_end',25),('cache_fingerprint',[0,0]),('source_fingerprint',{'size_bytes':1,'mtime_ns':'1'})]:
   changed=copy.deepcopy(receipt);changed[key]=value;path.write_text(json.dumps({'rows':[changed]}));self.assertEqual(s.ssd_need(self.row,self.ctx,20.,80.,self.root)['status'],'missing_validated_ssd_receipt')

if __name__=='__main__':unittest.main()
