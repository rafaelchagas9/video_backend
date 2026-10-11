"""Synthetic CLAP complement contracts; no experiment/media/model fitting."""
import json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import clap_span_preference as s
from structured_span_preference_test import row


def sample(name='a',end=400.):
 value=row(name,end=end);value['arrays']['clap']=np.tile(np.arange(32.),(len(value['offsets']),1))+np.arange(len(value['offsets']))[:,None]
 return value


def pre():return {'audio':(np.zeros(20),np.eye(20)[:16]),'siglip':(np.zeros(10),np.eye(10)[:8]),'clap':(np.zeros(32),np.eye(32)[:16])}


class Contract(unittest.TestCase):
 def test_fixed_dimensions_pin_no_grid_and_base_candidates(self):
  self.assertEqual(s.POLICY['model_pin'],'laion/larger_clap_general@ada0c23a36c4e8582805bb38fec3905903f18b41');self.assertEqual(s.POLICY['C'],1.)
  a=sample();b=dict(a,selected_start=77.,selected_end=88.)
  np.testing.assert_array_equal(s.spans.candidate_grid(a),s.spans.candidate_grid(b));self.assertEqual(s.features(pre(),a,a['grid']).shape[1],44)
  self.assertEqual(s.POLICY['coarse_prior'].split(':')[0],'None')

 def test_features_preserve_existing28_and_exact_window_overlap(self):
  a=sample();intervals=np.array([[11.,39.],[100.,220.]])
  output=s.features(pre(),a,intervals);np.testing.assert_array_equal(output[:,:28],s.spans.features(pre(),a,intervals))
  expected=s.spans.overlap_pool(a['offsets'],a['arrays']['clap'][:,:16],intervals);np.testing.assert_allclose(output[:,28:],expected)

 def test_equal_original_projection_only_train_inputs(self):
  train=[sample('a'),sample('b',end=600.)];calls=[]
  def svd(X,n_components,n_iter,random_state):
   calls.append((X.copy(),n_components));self.assertEqual(n_iter,3);self.assertEqual(random_state,29);return None,None,np.eye(X.shape[1])[:n_components]
  with patch.object(s,'randomized_svd',side_effect=svd):projection=s.projection(train)
  self.assertEqual([n for _,n in calls],[16,8,16])
  for family in ('audio','siglip','clap'):np.testing.assert_allclose(projection[family][0],np.mean([r['arrays'][family].mean(0) for r in train],axis=0))
  before={k:v[0].copy() for k,v in projection.items()};held=sample('held');held['arrays']['clap']*=100000;s.features(projection,held,held['grid'])
  for family in before:np.testing.assert_array_equal(before[family],projection[family][0])

 def test_pairwise_not_outside_bad_and_original_weight80(self):
  X,y,w,counts=s.symmetric_pairs(pre(),[sample('a'),sample('b',end=600.)]);cursor=0
  for count in counts:
   n=count['alternatives'];np.testing.assert_allclose(X[cursor:cursor+n],-X[cursor+n:cursor+2*n]);self.assertAlmostEqual(w[cursor:cursor+2*n].sum(),80.);self.assertTrue(np.all(y[cursor:cursor+n]==1));self.assertTrue(np.all(y[cursor+n:cursor+2*n]==0));cursor+=2*n
  self.assertEqual(X.shape[1],44);np.testing.assert_allclose(np.average(X,axis=0,weights=w),0,atol=1e-12)

 def test_matched_control_zeros_only16_with_same_scale_and_C1(self):
  calls=[]
  class Model:
   def __init__(self,**kwargs):self.args=kwargs
   def fit(self,X,y,sample_weight):calls.append((X.copy(),y.copy(),sample_weight.copy(),self.args));return self
  with patch.object(s,'projection',return_value=pre()),patch.object(s,'LogisticRegression',Model):model=s.fit([sample('a'),sample('b')],float('inf'))
  self.assertEqual(len(calls),2);self.assertTrue(np.all(calls[0][0][:,28:]==0));np.testing.assert_array_equal(calls[0][0][:,:28],calls[1][0][:,:28]);np.testing.assert_array_equal(calls[0][1],calls[1][1]);np.testing.assert_array_equal(calls[0][2],calls[1][2])
  self.assertFalse(np.all(calls[1][0][:,28:]==0));np.testing.assert_allclose(model['scale'].mean_,0,atol=1e-12)
  for call in calls:self.assertEqual(call[3]['C'],1.);self.assertFalse(call[3]['fit_intercept']);self.assertNotIn('class_weight',call[3])

 def test_prediction_control_and_ties_preserve_original(self):
  calls=[]
  class Model:
   def decision_function(self,X):calls.append(X.copy());return np.zeros(len(X))
  class Scale:
   def transform(self,X):return X
  a=sample();model={'pre':pre(),'scale':Scale(),'models':{f:Model() for f in s.FAMILIES}}
  result=s.predict(model,[a],float('inf'));self.assertEqual(result[s.FAMILIES[0]],[[0.,400.]]);self.assertEqual(result[s.FAMILIES[1]],[[0.,400.]])
  self.assertTrue(np.all(calls[0][:,28:]==0));np.testing.assert_array_equal(calls[0][:,:28],calls[1][:,:28])

 def test_checkpoint_exact_pin_ranges_sample_counts_and_unit_vectors(self):
  stage={'row':'fine1a','original_start':10.,'original_end':50.,'dense_offsets':[10.,30.],'audio_start':0.,'audio_end':60.,'cache_sha256':'a'*64,'source_fingerprint':[10,20],'alignment':'aresample_async_first_pts_0'}
  r={'row':'fine1a','detected_start':10.,'detected_end':50.,'offsets':np.array([10.,30.])};receipt='b'*64;vectors=np.zeros((2,512),np.float32);vectors[:,0]=1
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);path=root/'fine1a.npz';s.clap.checkpoint(path,vectors,stage,receipt);value,proof=s.checkpoint_receipt(path,r,stage,receipt,root);np.testing.assert_array_equal(value,vectors);self.assertEqual(proof['windows'],2)
   with self.assertRaisesRegex(ValueError,'provenance'):s.checkpoint_receipt(path,r,stage,'c'*64,root)
   with self.assertRaisesRegex(ValueError,'range'):s.checkpoint_receipt(path,dict(r,detected_end=55.),stage,receipt,root)
   s.clap.checkpoint(path,vectors[:1],stage,receipt)
   with self.assertRaisesRegex(ValueError,'incomplete'):s.checkpoint_receipt(path,r,stage,receipt,root)
   s.clap.checkpoint(path,vectors,stage,receipt)
   with np.load(path,allow_pickle=False) as z:payload={k:z[k].copy() for k in z.files}
   payload['decoded_samples'][0]=319999;np.savez(path,**payload)
   with self.assertRaisesRegex(ValueError,'sample'):s.checkpoint_receipt(path,r,stage,receipt,root)

 def test_prereg_immutable_and_missing_numeric_never_fits(self):
  with tempfile.TemporaryDirectory() as tmp:
   out=Path(tmp);s.preregister(out);first=(out/'preregistered.json').read_bytes();s.preregister(out);self.assertEqual((out/'preregistered.json').read_bytes(),first)
   with self.assertRaisesRegex(ValueError,'Immutable'):s.freeze(out/'preregistered.json',{'different':True})
   with patch.object(s,'fit') as fitting:
    with self.assertRaises(FileNotFoundError):s.run(out,out)
    fitting.assert_not_called()
   self.assertFalse((out/'attempt.json').exists());s.save(out/'attempt.json',{'one_attempt':True})
   with patch.object(s,'load') as loading:
    with self.assertRaisesRegex(ValueError,'One attempt'):s.run(out,out)
    loading.assert_not_called()

if __name__=='__main__':unittest.main()
