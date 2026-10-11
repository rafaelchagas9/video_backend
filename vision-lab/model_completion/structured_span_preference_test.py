"""Synthetic contract tests; no real data, media or experimental model fitting."""
import unittest
from unittest.mock import patch
import numpy as np
import structured_span_preference as s


def row(name='x',start=0.,end=200.,selected=(46.,93.)):
 offsets=np.arange(start,end-19,20.)
 if offsets[-1]+20<end:offsets=np.r_[offsets,end-20]
 r={'row':name,'group':name,'detected_start':start,'detected_end':end,'selected_start':selected[0],'selected_end':selected[1],'offsets':offsets,'arrays':{'audio':np.tile(np.arange(20.),(len(offsets),1))+np.arange(len(offsets))[:,None],'siglip':np.tile(np.arange(10.),(len(offsets),1))+np.arange(len(offsets))[:,None]}}
 r['grid']=s.candidate_grid(r)
 return r


class Contract(unittest.TestCase):
 def test_grid_does_not_use_gold_or_cap_duration(self):
  a=row();b=dict(a,selected_start=71.3,selected_end=82.7)
  np.testing.assert_array_equal(s.candidate_grid(a),s.candidate_grid(b))
  self.assertFalse(np.any(np.isclose(a['grid'],46.)))
  self.assertTrue(np.any(np.all(a['grid']==[0.,200.],axis=1)))
  long=row(end=600.);self.assertTrue(np.any(np.all(long['grid']==[0.,600.],axis=1)))
  self.assertTrue(np.all(a['grid'][:,1]-a['grid'][:,0]>=5.))

 def test_missing_numeric_window_coverage_fails(self):
  a=row();a['offsets']=np.array([0.,40.,60.,180.])
  with self.assertRaisesRegex(ValueError,'completely cover'):s.candidate_grid(a)

 def test_exact_overlap_pool_not_centre_interpolation(self):
  offsets=np.array([0.,20.,30.]);values=np.array([[1.,0.],[3.,2.],[5.,4.]])
  spans=np.array([[5.,35.],[20.,50.],[10.,11.]])
  overlap=np.maximum(0,np.minimum(spans[:,1,None],offsets+20)-np.maximum(spans[:,0,None],offsets))
  expected=overlap@values/overlap.sum(1)[:,None]
  np.testing.assert_allclose(s.overlap_pool(offsets,values,spans),expected)

 def test_pooled_interval_without_coverage_fails(self):
  with self.assertRaisesRegex(ValueError,'no numeric-window coverage'):s.overlap_pool([0.],[[1.]],[[25.,30.]])

 def test_fixed_alternative_indices_do_not_follow_gold(self):
  a=row(end=500.);b=dict(a,selected_start=1.123,selected_end=100.456)
  np.testing.assert_array_equal(s.alternatives(a),s.alternatives(b))
  self.assertEqual(len(s.alternatives(a)),64)
  ids=np.unique(np.linspace(0,len(a['grid'])-1,64).astype(int));chosen=a['grid'][ids[4]]
  c=dict(a,selected_start=chosen[0],selected_end=chosen[1])
  self.assertEqual(len(s.alternatives(c)),63)
  self.assertFalse(np.any(np.all(s.alternatives(c)==chosen,axis=1)))

 def test_ties_prefer_original_then_longer(self):
  a=row();self.assertEqual(s.best_span(a,np.zeros(len(a['grid']))),[0.,200.])
  scores=np.zeros(len(a['grid']));short=np.flatnonzero(np.all(a['grid']==[20.,40.],axis=1))[0];long=np.flatnonzero(np.all(a['grid']==[20.,100.],axis=1))[0]
  scores[[short,long]]=1.;self.assertEqual(s.best_span(a,scores),[20.,100.])
  with self.assertRaisesRegex(ValueError,'Invalid span scores'):s.best_span(a,np.full(len(scores),np.nan))

 def test_training_only_weighted_projection(self):
  train=[row('a'),row('b',end=100.)];calls=[]
  def svd(X,n_components,n_iter,random_state):
   calls.append(X.copy());self.assertEqual(n_iter,3);self.assertEqual(random_state,29)
   return None,None,np.eye(X.shape[1])[:n_components]
  with patch.object(s,'randomized_svd',side_effect=svd):pre=s.projection(train)
  for family in ('audio','siglip'):
   expected=np.mean([r['arrays'][family].mean(0) for r in train],axis=0)
   np.testing.assert_allclose(pre[family][0],expected)
  self.assertEqual(len(calls),2)
  unseen=row('held',start=1000.,end=1200.,selected=(1046.,1093.));unseen['arrays']['audio']*=10000
  before={k:v[0].copy() for k,v in pre.items()};s.features(pre,unseen,unseen['grid'])
  for key in pre:np.testing.assert_array_equal(pre[key][0],before[key])

 def test_symmetric_pairs_equal_original_weight_and_gold_train_only(self):
  rows=[row('a'),row('b',end=500.)]
  pre={'audio':(np.zeros(20),np.eye(20)[:16]),'siglip':(np.zeros(10),np.eye(10)[:8])}
  X,y,w,counts=s.symmetric_pairs(pre,rows);cursor=0
  for item in counts:
   n=item['alternatives'];np.testing.assert_allclose(X[cursor:cursor+n],-X[cursor+n:cursor+2*n]);self.assertAlmostEqual(w[cursor:cursor+2*n].sum(),80.)
   self.assertTrue(np.all(y[cursor:cursor+n]==1));self.assertTrue(np.all(y[cursor+n:cursor+2*n]==0));cursor+=2*n
  np.testing.assert_allclose(np.average(X,axis=0,weights=w),0.,atol=1e-12)

 def test_geometry_rejects_outside_original(self):
  with self.assertRaisesRegex(ValueError,'outside original'):s.geometry(row(),[[-1.,20.]])

 def test_fixed_models_scaling_train_pairs_and_zero_control(self):
  rows=[row('a'),row('b',end=100.)];pre={'audio':(np.zeros(20),np.eye(20)[:16]),'siglip':(np.zeros(10),np.eye(10)[:8])};calls=[]
  class FakeModel:
   def __init__(self,**kwargs):self.kwargs=kwargs
   def fit(self,X,y,sample_weight):
    calls.append((X.copy(),y.copy(),sample_weight.copy(),self.kwargs));return self
  with patch.object(s,'projection',return_value=pre),patch.object(s,'LogisticRegression',FakeModel):model=s.fit(rows,float('inf'))
  self.assertEqual(model['train_groups'],['a','b']);self.assertEqual(len(calls),2)
  self.assertTrue(np.all(calls[0][0][:,:24]==0));np.testing.assert_allclose(calls[0][0][:,-4:],calls[1][0][:,-4:])
  np.testing.assert_allclose(model['scale'].mean_,0.,atol=1e-12)
  for _,_,_,args in calls:self.assertEqual(args['C'],1.);self.assertFalse(args['fit_intercept']);self.assertNotIn('class_weight',args)

if __name__=='__main__':unittest.main()
