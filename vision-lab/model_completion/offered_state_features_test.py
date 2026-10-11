import copy,dataclasses,json,subprocess,unittest
from pathlib import Path
import numpy as np
import offered_state_features as f


def fixture():
 rng=np.random.default_rng(42);v=rng.normal(size=(15,1152));v=(v/np.linalg.norm(v,axis=1)[:,None]).astype(np.float32);t=np.arange(15)*5.
 identity={'video_id':1,'analyzed_at':'2026-10-10T00:00:00.000Z','duration':75.,'index':{'model_revision':f.VISUAL_PIN,'frame_count':15,'interval_seconds':5.,'storyboard_generated_at':'2026-10-10T00:00:00.000Z','indexed_at':'2026-10-10T00:00:01.000Z'},'source_fingerprint':{'size_bytes':123,'mtime_ns':'123456789123456789','path_identity_sha256':'a'*64},'proposals':[{'id':'clip1','start':10.,'end':60.,'score':.6}]}
 return t,v,identity


class StateFeatures(unittest.TestCase):
 @classmethod
 def setUpClass(cls):cls.probe=f.load_probe()
 def context(self):
  t,v,i=fixture();return f.classify_original_context(self.probe,t,v,identity=i,expected_identity=copy.deepcopy(i))
 def test_actual_bun_classifier_parity(self):
  t,v,i=fixture();ctx=f.classify_original_context(self.probe,t,v,identity=i,expected_identity=i)
  root=Path(__file__).resolve().parents[2];payload={'synthetic_only':True,'probe_path':str(root/'data/models/recordings-highlight-probe.json'),'probe_sha256':f.PROBE_SHA256,'vectors':v.tolist()}
  result=subprocess.run(['bun','run',str(Path(__file__).with_name('offered_state_parity.ts'))],cwd=root,input=json.dumps(payload),capture_output=True,text=True,timeout=20)
  self.assertEqual(result.returncode,0,result.stderr);actual=json.loads(result.stdout);self.assertEqual(actual['classes'],list(f.STATES));np.testing.assert_allclose(actual['probabilities'],ctx.probabilities,atol=1e-7,rtol=0)
 def test_inclusive_pool_and_mass_no_normalization(self):
  ctx=self.context();p=np.tile(np.array([.2,.2,.2,.4],dtype=np.float32),(15,1));ctx=dataclasses.replace(ctx,probabilities=p)
  x=f.pool_state_features(ctx,original_proposal_id='clip1',original_range=[10,60],offered_range=[20,40])
  np.testing.assert_allclose(x[:4],[.2,.2,.2,.4],atol=1e-7);self.assertAlmostEqual(x[7],5/11);self.assertEqual(x[6],0)
  full=f.pool_state_features(ctx,original_proposal_id='clip1',original_range=[10,60],offered_range=[10,60]);self.assertEqual(full[7],1)
 def test_percentile_threshold_and_zero_mass(self):
  ctx=self.context();p=np.tile(np.array([1.,0,0,0],dtype=np.float32),(15,1));zero=dataclasses.replace(ctx,probabilities=p)
  x=f.pool_state_features(zero,original_proposal_id='clip1',original_range=[10,60],offered_range=[20,40]);self.assertEqual(x[7],0)
  p[4:9]=np.array([[1-a,0,0,a] for a in [.1,.3,.55,.8,.9]],np.float32);mixed=dataclasses.replace(ctx,probabilities=p)
  x=f.pool_state_features(mixed,original_proposal_id='clip1',original_range=[10,60],offered_range=[20,40]);self.assertAlmostEqual(x[5],.86,places=6);self.assertEqual(x[6],.6)
 def test_context_is_recording_not_recropped_proposal(self):
  ctx=self.context();t,v,i=fixture();indices=np.arange(2,13);cropped_i=copy.deepcopy(i);cropped_i['index']['frame_count']=len(indices)
  with self.assertRaisesRegex(ValueError,'Complete actual'):f.classify_original_context(self.probe,t[indices],v[indices],identity=cropped_i,expected_identity=cropped_i)
  self.assertEqual(ctx.probabilities.shape,(15,4));self.assertFalse(ctx.probabilities.flags.writeable)
  def expected(neighbour):
   logits=self.probe.bias+v[2].astype(float)@self.probe.weights[:,:1152].astype(float).T+neighbour@self.probe.weights[:,1152:].astype(float).T
   exp=np.exp(logits-logits.max());return exp/exp.sum()
  np.testing.assert_allclose(ctx.probabilities[2],expected(v[:5].astype(float).mean(0)),atol=1e-7,rtol=0)
  self.assertGreater(float(np.max(np.abs(ctx.probabilities[2]-expected(v[2:5].astype(float).mean(0))))),1e-5)
 def test_source_generation_index_and_wrong_pin_fail(self):
  t,v,i=fixture()
  for key in ('analyzed_at','source_fingerprint','index'):
   wrong=copy.deepcopy(i);wrong[key]={} if isinstance(wrong[key],dict) else 'changed'
   with self.assertRaises(ValueError):f.classify_original_context(self.probe,t,v,identity=i,expected_identity=wrong)
  wrong=copy.deepcopy(i);wrong['video_id']=True
  with self.assertRaises(ValueError):f.classify_original_context(self.probe,t,v,identity=i,expected_identity=wrong)
  bad=dataclasses.replace(self.probe,sha256='f'*64)
  with self.assertRaises(ValueError):f.classify_original_context(bad,t,v,identity=i,expected_identity=i)
 def test_gaps_duration_width_zero_nonunit_nan_fail(self):
  t,v,i=fixture()
  cases=[(t,v[:,:2],i),(t,np.zeros_like(v),i),(t,v*2,i),(t,np.full_like(v,np.nan),i)]
  # A true missing internal frame creates a 15-second gap; exact index count alone is not coverage.
  keep=np.ones(15,dtype=bool);keep[5:7]=False;j=copy.deepcopy(i);j['index']['frame_count']=13;cases.append((t[keep],v[keep],j))
  j=copy.deepcopy(i);j['duration']=65;cases.append((t,v,j))
  for a,b,j in cases:
   with self.assertRaises(ValueError):f.classify_original_context(self.probe,a,b,identity=j,expected_identity=j)
 def test_ranges_proposal_mismatch_and_empty_observation_fail(self):
  ctx=self.context()
  for original,offered,clip in [([10,61],[20,40],'clip1'),([10,60],[5,40],'clip1'),([10,60],[20,20],'clip1'),([10,60],[21,22],'clip1'),([10,60],[20,40],'other')]:
   with self.assertRaises(ValueError):f.pool_state_features(ctx,original_proposal_id=clip,original_range=original,offered_range=offered)
 def test_annotation_not_features(self):
  t,v,i=fixture();first=f.classify_original_context(self.probe,t,v,identity=i,expected_identity=i);j=copy.deepcopy(i);j['proposals'][0].update(keep=False,reviewed=True,reasons=['face'],best=[20,40]);second=f.classify_original_context(self.probe,t,v,identity=j,expected_identity=j)
  np.testing.assert_array_equal(first.probabilities,second.probabilities)
  np.testing.assert_array_equal(f.pool_state_features(first,original_proposal_id='clip1',original_range=[10,60],offered_range=[20,40]),f.pool_state_features(second,original_proposal_id='clip1',original_range=[10,60],offered_range=[20,40]))
 def test_original_score_is_finite_context_not_probability(self):
  t,v,i=fixture();reference=None
  for score in (2.27,-.3):
   j=copy.deepcopy(i);j['proposals'][0]['score']=score
   ctx=f.classify_original_context(self.probe,t,v,identity=j,expected_identity=j)
   result=f.pool_state_features(ctx,original_proposal_id='clip1',original_range=[10,60],offered_range=[20,40])
   if reference is not None:np.testing.assert_array_equal(reference,result)
   reference=result
 def test_boolean_frames_rejected(self):
  t,v,i=fixture()
  with self.assertRaises(ValueError):f.classify_original_context(self.probe,t,np.ones(v.shape,dtype=bool),identity=i,expected_identity=i)

if __name__=='__main__':unittest.main()
