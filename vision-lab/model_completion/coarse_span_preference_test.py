"""Synthetic fixed-recipe checks; no real inputs, model fitting, GPU or media."""
import tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import coarse_span_preference as c
import structured_span_preference as s


def row(name='a',video=1,group='train',end=200.,selected=(46.,93.)):
 t=np.arange(0,end,5.);v=np.zeros((len(t),1152));v[:,0]=np.cos(np.arange(len(t)));v[:,1]=np.sin(np.arange(len(t)))
 r=dict(row=name,video_id=video,group=group,detected_start=0.,detected_end=end,selected_start=selected[0],selected_end=selected[1],**c.visual_cells(t,v,0.,end));r['grid']=c.coarse_grid(r);return r


class WeakSpanContract(unittest.TestCase):
 def tearDown(self):c.COARSE.clear();c.FINE_GROUPS.clear();c.PRIORS.clear();c.PRIOR_RECEIPTS.clear()

 def test_eight_second_span_has_full_pooled_coverage_no_frame_class_labels(self):
  r=row(selected=(1.,9.));pooled=c.pool_cells(r,r['cell_vectors'],[[1.,9.]])
  expected=(4*r['cell_vectors'][0]+4*r['cell_vectors'][1])/8
  np.testing.assert_allclose(pooled[0],expected);self.assertNotIn('y',r);self.assertNotIn('sample',r)

 def test_exact5s_overlap_and_same_pooling_after_coarse_fine_application(self):
  r=row();values=np.c_[np.arange(len(r['cell_starts'])),np.ones(len(r['cell_starts']))];spans=np.array([[1.,9.],[3.,18.],[20.,21.]])
  overlap=np.maximum(0,np.minimum(spans[:,1,None],r['cell_ends'])-np.maximum(spans[:,0,None],r['cell_starts']));expected=overlap@values/overlap.sum(1)[:,None]
  np.testing.assert_allclose(c.pool_cells(r,values,spans),expected)
  pre=(np.zeros(1152),np.eye(1152)[:8]);same=dict(r,offsets=np.arange(0,181,20),arrays={'siglip':np.full((10,1152),1000.)})
  np.testing.assert_array_equal(c.prior_features(pre,r,spans),c.prior_features(pre,same,spans))

 def test_cell_gaps_and_outside_spans_fail_closed(self):
  r=row();t=np.r_[0.,5.,20.,25.];v=np.zeros((4,1152));v[:,0]=1
  with self.assertRaisesRegex(ValueError,'5s visual'):c.visual_cells(t,v,0.,30.)
  with self.assertRaisesRegex(ValueError,'coverage'):c.visual_cells(np.arange(5.,30.,5.),np.tile(np.eye(1152)[0],(5,1)),0.,30.)
  with self.assertRaisesRegex(ValueError,'outside original'):c.pool_cells(r,r['cell_vectors'],[[-1.,6.]])

 def test_coarse_partial_pool_never_extrapolates_and_filter_is_gold_independent(self):
  t=np.arange(0,90,5.);v=np.tile(np.eye(1152)[0],(len(t),1));r=dict(row='partial',detected_start=0.,detected_end=100.,selected_start=2.,selected_end=10.,**c.visual_cells(t,v,0.,100.,complete=False));r['grid']=c.coarse_grid(r)
  self.assertGreater(r['zero_observed_grid_exclusions'],0);self.assertTrue(np.all(c.observed_mass(r,r['grid'])>0));self.assertEqual(c.coverage_receipt(r)['missing_tail_seconds'],10.);self.assertEqual(c.coverage_receipt(r)['original_observed_fraction'],.9)
  values=np.full((len(t),1),3.);self.assertAlmostEqual(c.pool_cells(r,values,[[80.,100.]])[0,0],3.)
  with self.assertRaisesRegex(ValueError,'observed visual'):c.pool_cells(r,values,[[90.,100.]])
  other=dict(r,selected_start=50.,selected_end=85.);np.testing.assert_array_equal(c.coarse_grid(r),c.coarse_grid(other))
  with self.assertRaisesRegex(ValueError,'coverage'):c.visual_cells(t,v,0.,100.,complete=True)

 def test_zero_or_nonunit_raw_frames_are_rejected(self):
  t=np.arange(0,20,5.)
  for v in [np.zeros((4,1152)),np.tile(np.eye(1152)[0]*2,(4,1))]:
   with self.assertRaisesRegex(ValueError,'zero/nonunit'):c.visual_cells(t,v,0.,20.)

 def test_gold_independent_candidate_grid_alternatives_and_unlimited_duration(self):
  r=row(end=600.);other=dict(r,selected_start=1.123,selected_end=9.123)
  np.testing.assert_array_equal(c.coarse_grid(r),c.coarse_grid(other));np.testing.assert_array_equal(s.alternatives(r),s.alternatives(other));self.assertEqual(len(s.alternatives(r)),64);self.assertTrue(np.any(np.all(r['grid']==[0.,600.],1)))
  chosen=s.alternatives(r)[5];selfcompare=dict(r,selected_start=chosen[0],selected_end=chosen[1]);self.assertEqual(len(s.alternatives(selfcompare)),63)

 def test_partial_projection_still_balances_each_recording_total_one(self):
  a=row('a',video=1);b=row('b',video=1);b['cell_starts']=b['cell_starts'][:-2];b['cell_ends']=b['cell_ends'][:-2];b['cell_vectors']=b['cell_vectors'][:-2];b['visual_complete']=False;d=row('d',video=2)
  weights=c.projection_weights([a,b,d]);n=len(a['cell_starts']);m=len(b['cell_starts']);self.assertAlmostEqual(weights[:n].sum(),.5);self.assertAlmostEqual(weights[n:n+m].sum(),.5);self.assertAlmostEqual(weights[n+m:].sum(),1.)

 def test_exact_archive_index_matches_float16_cache_and_rejects_other_generation(self):
  from task_generation_inputs_test import TaskGenerationTests
  fixture=TaskGenerationTests();fixture.setUp()
  try:
   t,v=c.historical.snapshots.frames(fixture.old_manifest,fixture.archives);receipt=c.archive_index_receipt(fixture.old,t,v.astype(np.float16),fixture.archives)
   self.assertEqual(receipt['analyzed_at'],fixture.old_manifest['analyzedAt']);self.assertEqual(receipt['index']['modelRevision'],c.historical.VISUAL_PIN)
   with self.assertRaisesRegex(ValueError,'differs from exact'):c.archive_index_receipt(fixture.new,t,v.astype(np.float16),fixture.archives)
   wrong=dict(fixture.old,analyzed_at='2026-10-07T01:00:00')
   with self.assertRaisesRegex(ValueError,'absent'):c.archive_index_receipt(wrong,t,v.astype(np.float16),fixture.archives)
  finally:fixture.doCleanups()

 def test_recording_balanced_projection_and_symmetric_span_pairs(self):
  rows=[row('a',video=1),row('b',video=1,end=100.),row('c',video=2)];weights=c.projection_weights(rows);at=0
  for r,expected in zip(rows,[.5,.5,1.]):
   n=len(r['cell_vectors']);self.assertAlmostEqual(weights[at:at+n].sum(),expected);at+=n
  pre=(np.zeros(1152),np.eye(1152)[:8]);X,y,w,receipts=c.prior_pairs(pre,rows);at=0
  for receipt,expected in zip(receipts,[40.,40.,80.]):
   n=receipt['alternatives'];np.testing.assert_array_equal(X[at:at+n],-X[at+n:at+2*n]);self.assertAlmostEqual(w[at:at+2*n].sum(),expected);self.assertTrue(np.all(y[at:at+n]==1));self.assertTrue(np.all(y[at+n:at+2*n]==0));at+=2*n
  np.testing.assert_allclose(np.average(X,axis=0,weights=w),0.,atol=1e-12)

 def test_inner_prior_excludes_outer_and_inner_held_channels(self):
  c.COARSE.extend([row(group=g,video=i+1) for i,g in enumerate(['train','inner-held','outer-held','coarse-only'])]);c.FINE_GROUPS.update(['train','inner-held','outer-held'])
  pool,blocked=c.allowed({'train'});self.assertEqual(blocked,{'inner-held','outer-held'});self.assertEqual({r['group'] for r in pool},{'train','coarse-only'})

 def test_mock_prior_only_projects_allowed_originals_and_fits_span_differences(self):
  train=row(group='train');held=row(group='held',video=2);held['cell_vectors']*=10000;c.COARSE.extend([train,held]);c.FINE_GROUPS.update(['train','held']);svds=[];fits=[]
  def svd(X,**kwargs):svds.append(X.copy());self.assertEqual(kwargs,dict(n_components=8,n_iter=3,random_state=29));return None,None,np.eye(1152)[:8]
  class Model:
   def __init__(self,**kwargs):self.kwargs=kwargs
   def fit(self,X,y,sample_weight):fits.append((X.copy(),y.copy(),sample_weight.copy(),self.kwargs));return self
  with patch.object(c,'randomized_svd',side_effect=svd),patch.object(c,'LogisticRegression',Model):p=c.prior({'train'},float('inf'))
  self.assertEqual(len(svds[0]),len(train['cell_vectors']));self.assertLess(np.max(np.abs(svds[0])),2.);self.assertEqual(len(fits),1);self.assertEqual(fits[0][3]['C'],.1);self.assertFalse(fits[0][3]['fit_intercept']);self.assertNotIn('class_weight',fits[0][3]);self.assertEqual(c.PRIOR_RECEIPTS[0]['blocked_fine_channels'],['held']);self.assertEqual(c.PRIOR_RECEIPTS[0]['coarse_rows'],['a'])
  before=len(fits);self.assertIs(c.prior({'train'},float('inf')),p);self.assertEqual(len(fits),before)

 def test_matched_fine29_scalarzero_control_and_trainonly_scaling_mock(self):
  rows=[row('a'),row('b',video=2,end=100.)];fits=[]
  def features(model,r,intervals):
   geometry=s.geometry(r,intervals);return np.c_[np.zeros((len(intervals),24)),geometry,np.asarray(intervals)[:,0]*.01]
  class Model:
   def __init__(self,**kwargs):self.kwargs=kwargs
   def fit(self,X,y,sample_weight):fits.append((X.copy(),y.copy(),sample_weight.copy(),self.kwargs));return self
  with patch.object(c.spans,'projection',return_value={}),patch.object(c,'prior',return_value={}),patch.object(c,'fine_features',side_effect=features),patch.object(c,'LogisticRegression',Model):model=c.fit(rows,float('inf'))
  self.assertEqual(fits[0][0].shape[1],29);self.assertTrue(np.all(fits[0][0][:,-1]==0));self.assertTrue(np.any(fits[1][0][:,-1]!=0));np.testing.assert_array_equal(fits[0][0][:,:28],fits[1][0][:,:28]);np.testing.assert_array_equal(fits[0][1],fits[1][1]);np.testing.assert_array_equal(fits[0][2],fits[1][2]);np.testing.assert_allclose(model['scale'].mean_,0.,atol=1e-12)
  for _,_,_,kwargs in fits:self.assertEqual(kwargs['C'],1.);self.assertFalse(kwargs['fit_intercept'])

 def test_immutable_preregistration_and_no_second_attempt(self):
  with tempfile.TemporaryDirectory() as temporary:
   out=Path(temporary);c.frozen(out/'preregistered.json',{'policy':c.POLICY});c.frozen(out/'preregistered.json',{'policy':c.POLICY})
   with self.assertRaisesRegex(ValueError,'Immutable'):c.frozen(out/'preregistered.json',{'policy':'changed'})
   (out/'attempt.json').write_text('{}')
   with patch.object(c,'load',side_effect=AssertionError('must not load or fit')):
    with self.assertRaisesRegex(ValueError,'One attempt'):c.run(out,out)

if __name__=='__main__':unittest.main()
