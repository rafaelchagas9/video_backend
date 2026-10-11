"""Synthetic frozen interval-choice contracts; no real cohorts/media or experimental fits."""
import copy,time,unittest
from unittest.mock import patch
import numpy as np
import visual_span_round as s
import fine_labels as fl

def row(original='o',group='creator',gold=(10.,30.)):
 t=np.arange(0,100,5,dtype=float);v=np.eye(12)[np.arange(len(t))%12]
 return {'original':original,'row':original+str(gold),'group':group,'a':0.,'b':100.,'t':t,'v':v,'lo':t,'hi':t+5,'grid':s.grid(0,100,t,v),'gold':list(gold),'all_gold':[gold],'reserved_fine_holdout':False,'fine_data_role':'training'}

class Span(unittest.TestCase):
 def test_grid_is_outcome_independent_aligned_uncapped_and_bounded(self):
  t=np.arange(0,5400,5.);v=np.eye(12)[np.arange(len(t))%12];g=s.grid(0,5400,t,v)
  self.assertLessEqual(len(np.unique(g)),128);self.assertLessEqual(len(g),8128);self.assertTrue(np.any(np.all(g==[0,5400],axis=1)));self.assertTrue(np.all(g%5==0));self.assertTrue(np.all(g[:,1]-g[:,0]>=5))
  a=row();b=copy.deepcopy(a);b['gold']=[1,99];b['all_gold']=[(1,99)]
  self.assertTrue(np.array_equal(s.grid(a['a'],a['b'],a['t'],a['v']),s.grid(b['a'],b['b'],b['t'],b['v'])))
 def test_all_legitimate_ranges_removed_without_replacement(self):
  r=row();r['all_gold']=[tuple(r['grid'][0]),tuple(r['grid'][3])]
  selected=r['grid'][np.unique(np.linspace(0,len(r['grid'])-1,64).astype(int))];actual=s.alternatives(r)
  for gold in r['all_gold']:self.assertFalse(np.any(np.all(actual==gold,axis=1)))
  self.assertTrue(all(any(np.array_equal(x,y) for y in selected) for x in actual));self.assertLessEqual(len(actual),64)
 def test_duration_overlap_pool_respects_exact_fractional_edges(self):
  r={'lo':np.array([0.,5.]),'hi':np.array([5.,10.])};v=np.array([[0.],[10.]])
  actual=s.pooled(r,v,[[2.,7.],[5.,10.]])
  self.assertTrue(np.allclose(actual,[[4.],[10.]]))
 def test_ties_prefer_identity_and_then_longer(self):
  r=row();self.assertEqual(s.best(r,np.zeros(len(r['grid']))),[0.,100.])
  r['grid']=np.array([[0.,20.],[10.,40.],[20.,30.]])
  self.assertEqual(s.best(r,np.zeros(3)),[10.,40.])
 def test_original_balancing_no_duplicate_pca_weight(self):
  a=row('a');b=row('b',gold=(20,40));a2=copy.deepcopy(a);a2['gold']=[15,25]
  one=s.projection([a,b]);two=s.projection([a,a2,b]);self.assertTrue(np.allclose(one[0],two[0]));self.assertTrue(np.allclose(np.abs(one[1]),np.abs(two[1])))
  captured=[]
  class Dummy:
   def __init__(self,**kw):pass
   def fit(self,x,y,sample_weight):captured.append(sample_weight.copy());return self
  with patch.object(s,'LogisticRegression',Dummy):s.fit([a,a2,b],time.monotonic()+30)
  self.assertAlmostEqual(float(captured[0].sum()),2.)
 def test_reserved_pca_and_fit_fail_before_transform(self):
  r=row();r.update(reserved_fine_holdout=True,fine_data_role='holdout')
  with self.assertRaises(fl.ReservedFineHoldoutError):s.projection([r])
  with self.assertRaises(fl.ReservedFineHoldoutError):s.fit([r],time.monotonic()+30)
 def test_multiple_gold_not_easiest_target_metric(self):
  a=row(gold=(0,50));b=copy.deepcopy(a);b['gold']=[50,100]
  m=s.metrics([a,b],[[0,50],[0,50]])
  self.assertAlmostEqual(m['creator_macro_iou'],.5);self.assertAlmostEqual(m['creator_macro_retained'],.5);self.assertEqual(m['originals'],1)
 def test_zero_mass_bootstrap_prevents_false_positive(self):
  rows=[row(str(i),str(i)) for i in range(4)];pred=s.identity(rows)
  b=s.bootstrap(rows,pred,pred);self.assertEqual(b['exact_zero_gain_mass'],1.);self.assertEqual(b['exact_zero_control_gain_mass'],1.);self.assertEqual(b['iou_gain_ci95'],[0.,0.])
 def test_disabled_export_and_no_duration_cap(self):
  class Scale:scale_=np.ones(12)
  class Model:coef_=np.ones((1,12))
  model={'pre':(np.zeros(12),np.zeros((8,12))),'scale':Scale(),'models':{s.FAMILIES[0]:Model()}}
  x=s.export(model,'argmax',{});self.assertFalse(x['enabled']);self.assertIsNone(x['max_duration_seconds']);self.assertEqual(x['fallback'],'original_range')


 def test_exported_score_and_range_parity(self):
  # An independent portable calculation uses only the exported JSON numbers.
  r=row();pre=(np.linspace(-.1,.1,12),np.eye(12)[:8]);weights=np.linspace(-.4,.7,12)
  class Scale:
   scale_=np.linspace(.6,1.7,12)
   def transform(self,x):return x/self.scale_
  class Model:
   coef_=weights[None,:]
   def decision_function(self,x):return x@self.coef_[0]
  model={'pre':pre,'scale':Scale(),'models':{f:Model() for f in s.FAMILIES}}
  envelope=s.export(model,'argmax',{});scores=[]
  for a,b in r['grid']:
   lengths=np.maximum(0,np.minimum(r['hi'],b)-np.maximum(r['lo'],a))
   mean=(lengths[:,None]*r['v']).sum(0)/lengths.sum()
   visual=(mean-np.asarray(envelope['pca_mean']))@np.asarray(envelope['pca_components']).T
   x=np.r_[visual,np.log(b-a),(b-a)/100,a/100,b/100]
   scores.append(float((x/np.asarray(envelope['numeric_scale']))@np.asarray(envelope['weights'])+envelope['bias']))
  actual=model['models'][s.FAMILIES[0]].decision_function(model['scale'].transform(s.features(pre,r,r['grid'])))
  self.assertTrue(np.allclose(scores,actual,rtol=1e-12,atol=1e-12))
  peak=max(scores);tied=[i for i,z in enumerate(scores) if abs(z-peak)<=envelope['score_tie_tolerance']]
  i=max(tied,key=lambda i:(bool(np.array_equal(r['grid'][i],[r['a'],r['b']])),r['grid'][i,1]-r['grid'][i,0],-r['grid'][i,0],-r['grid'][i,1]))
  self.assertEqual(r['grid'][i].tolist(),s.predict(model,[r],time.monotonic()+10)[s.FAMILIES[0]][0])

if __name__=='__main__':unittest.main()
