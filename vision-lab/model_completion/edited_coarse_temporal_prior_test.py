import unittest
import numpy as np
import edited_coarse_temporal_prior as p
class EditedPriorContractTest(unittest.TestCase):
 def test_only_inward_edited_spans(self):
  row={'detected_start':0,'detected_end':100,'selected_start':0,'selected_end':100};self.assertFalse(p.edited(row))
  self.assertTrue(p.edited(dict(row,selected_start=5)))
  self.assertFalse(p.edited(dict(row,selected_start=4)))
  self.assertFalse(p.edited(dict(row,selected_start=-5,selected_end=90)))
 def test_nested_channel_exclusion(self):
  coarse=[{'group':g} for g in 'abcd'];outer,_=p.allowed(coarse,{'a','b'},{'a','b','c'});self.assertEqual([r['group'] for r in outer],list('abd'))
  inner,blocked=p.allowed(coarse,{'a'},{'a','b','c'});self.assertEqual([r['group'] for r in inner],list('ad'));self.assertEqual(blocked,{'b','c'})
 def test_exact_private_join(self):
  row={'feedback_id':1,'video_id':2,'clip_id':'c1','group':'g0','detected_start':0.,'detected_end':100.};coarse={'rows':[row],'recordings':[{'video_id':2,'group':'g0'}]};snap={'records':[{'id':1,'video_id':2,'clip_id':'c1','channel':'private-neutral','detected_start':0.,'detected_end':100.}]}
  self.assertEqual(p.verify_join(coarse,[row],snap)['groups'],1)
  for key,value in [('group','bad'),('clip_id','c2'),('detected_end',101.)]:
   with self.assertRaises(ValueError):p.verify_join(coarse,[dict(row,**{key:value})],snap)
 def test_coarse_generation_drift(self):
  row={'row':'r0','feedback_id':1,'video_id':2,'clip_id':'c1','group':'g0','detected_start':0.,'detected_end':100.,'analyzed_at':'before'};coarse={'rows':[row],'recordings':[{'video_id':2,'group':'g0'}]};snap={'records':[{'id':1,'video_id':2,'clip_id':'c1','channel':'neutral','detected_start':0.,'detected_end':100.,'analyzed_at':'after'}]}
  with self.assertRaisesRegex(ValueError,'generation'):p.verify_join(coarse,[],snap)
 def test_unknown_original_is_not_temporal_provenance(self):
  row={'feedback_id':1,'video_id':2,'clip_id':'c1','group':'g0','detected_start':0.,'detected_end':100.,'has_original_edges':False};coarse={'rows':[row],'recordings':[{'video_id':2,'group':'g0'}]};snap={'records':[{'id':1,'video_id':2,'clip_id':'c1','channel':'neutral','detected_start':None,'detected_end':None}]}
  with self.assertRaisesRegex(ValueError,'unknown original'):p.verify_join(coarse,[],snap)
  self.assertEqual(p.verify_join(dict(coarse,rows=[]),[],snap)['groups'],0)
 def test_boundary_band_cap_and_recording_weight(self):
  times=np.arange(0,1000,5.);ids=p.sample_classes(times,100,500);self.assertEqual(len(ids),80);self.assertTrue(np.all((times[ids]<=95)|(times[ids]>=105)));self.assertTrue(np.all((times[ids]<=495)|(times[ids]>=505)))
  rows=[{'video_id':1,'sample':np.arange(2)},{'video_id':1,'sample':np.arange(4)},{'video_id':2,'sample':np.arange(3)}];w=p.prior_weights(rows);self.assertAlmostEqual(w[:6].sum(),80);self.assertAlmostEqual(w[6:].sum(),80)
 def test_short_interior_does_not_create_positive(self):
  ids=p.sample_classes(np.arange(0,60,5.),10,18);self.assertTrue(np.all((np.arange(0,60,5.)[ids]<5)|(np.arange(0,60,5.)[ids]>23)))
if __name__=='__main__':unittest.main()
