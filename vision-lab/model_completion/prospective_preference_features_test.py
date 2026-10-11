"""Synthetic no-fit/no-export contract tests for prospective preference features."""
import copy,unittest
from unittest.mock import patch
import numpy as np
import prospective_preference_features as f


def fixture(answer='a',tid=100):
 t=np.arange(20,dtype=float)*5;v=np.zeros((20,1152),np.float32)
 for i in range(20):v[i,i%2]=1
 index={'model_revision':'siglip2/so400m-patch16-256','frame_count':20,'interval_seconds':5,'storyboard_generated_at':'2026-10-10T00:00:00.000Z','indexed_at':'2026-10-10T00:00:01.000Z'}
 fp={'size_bytes':1000,'mtime_ns':'123456789123456789','path_identity_sha256':'a'*64}
 proposals=[{'id':'clip1','start':10.,'end':90.,'score':.6},{'id':'clip2','start':0.,'end':10.,'score':.2}]
 source={'feedback_id':1,'video_id':1,'channel':'fixture','channel_key':'fixture','analyzed_at':'2026-10-10T00:00:00.000Z','index':index,'source_fingerprint':fp,'clip':[10.,90.],'score':.6,'duration_seconds':100.}
 identity={k:copy.deepcopy(source[k]) for k in ('video_id','analyzed_at','index','source_fingerprint')};identity.update(duration=100.,proposals=proposals)
 assignment={'source':source,'numeric_identity':identity,'frame_checkpoint':{'path':'/synthetic/not-read.npz','sha256':'a'*64,'identity_sha256':'b'*64},'pilot_role':'model_vs_human'}
 preference={'task_id':tid,'position':0,'batch':'synthetic-candidate','answered_at':'2026-10-10T00:00:00.000Z','answer':answer,'a':{'range':[20.,50.]},'b':{'range':[40.,80.]}}
 return preference,assignment,t,v


def rows(answer='a',tid=100):
 p,a,t,v=fixture(answer,tid);return [f.row_features(p,k,a,t,v) for k in ('a','b')]


class ProspectiveFeatures(unittest.TestCase):
 def test_exact_future_formula_for_both_offered_ranges(self):
  p,a,t,v=fixture();rr=rows()
  for side,row in zip(('a','b'),rr):
   expected,visual=f.prior.numeric.domain_features({'group':'fixture'},a['source'],{'clip_id':'clip1','duration':100.},t,v,a['numeric_identity']['proposals'],*p[side]['range'])
   np.testing.assert_array_equal(row['features'],expected);np.testing.assert_array_equal(row['visual_mean'],visual)
  self.assertEqual(len(rr[0]['features']),13);self.assertEqual(len(rr[0]['visual_mean']),1152)
 def test_all32_synthetic_future_features_match_formula(self):
  allrows=[]
  for i in range(16):
   p,a,t,v=fixture(('a','b','both','neither')[i%4],100+i)
   p['position']=i%8;p['batch']='synthetic-candidate' if i<8 else 'synthetic-control'
   a['pilot_role']='model_vs_human' if i<8 else 'same_duration_location'
   for side in ('a','b'):
    row=f.row_features(p,side,a,t,v)
    expected,visual=f.prior.numeric.domain_features({'group':'fixture'},a['source'],{'clip_id':'clip1','duration':100.},t,v,a['numeric_identity']['proposals'],*p[side]['range'])
    np.testing.assert_array_equal(row['features'],expected);np.testing.assert_array_equal(row['visual_mean'],visual);allrows.append(row)
  self.assertEqual(len(allrows),32);self.assertEqual(len(f.strict_pairs(allrows,set())),8)
 def test_ties_and_abstention_never_become_order(self):
  for answer in ('both','neither'):
   rr=rows(answer);self.assertEqual(f.strict_pairs(rr,set()),[]);self.assertTrue(all(r['ranking_y'] is None for r in rr))
   rr[0]['ranking_y']=1
   with self.assertRaises(ValueError):f.strict_pairs(rr,set())
 def test_unknown_absolute_cut_and_future_targets(self):
  for answer in ('a','b','both','neither'):
   for r in rows(answer):
    self.assertIsNone(r['absolute_y']);self.assertIsNone(r['current_acceptability_y']);self.assertIsNone(r['cut_gold']);self.assertEqual(r['future_replacement'],'unknown');self.assertEqual(r['permanent_storage_worth'],'unknown')
  for field in ('absolute_y','current_acceptability_y','cut_gold'):
   rr=rows();rr[1][field]=1
   with self.assertRaises(ValueError):f.strict_pairs(rr,set())
 def test_strict_winner_and_loser_node_direction(self):
  for answer in ('a','b'):
   rr=rows(answer);pair=f.strict_pairs(rr,set())[0];winner=next(r for r in rr if r['side']==answer);loser=next(r for r in rr if r['side']!=answer)
   self.assertEqual(pair['winner'],f.combined.old.node_key(winner));self.assertEqual(pair['loser'],f.combined.old.node_key(loser));self.assertEqual(pair['creators'],('fixture',))
   rr[0]['ranking_y']=1-rr[0]['ranking_y']
   with self.assertRaises(ValueError):f.strict_pairs(rr,set())
 def test_same_source_provenance_conflicts_rejected(self):
  for field,value in [('feedback_id',2),('video_id',2),('analyzed_at','changed'),('source_fingerprint',{}),('index',{}),('original_range',[9,90]),('original_proposal_id','other'),('duration_seconds',101)]:
   rr=rows();rr[1][field]=value
   with self.assertRaises(ValueError,msg=field):f.strict_pairs(rr,set())
 def test_scope_and_reserved_exclusion(self):
  with self.assertRaises(ValueError):f.strict_pairs(rows(),{'fixture'})
  for field,value in [('reserved_fine_holdout',True),('fine_data_role','holdout'),('comparison_scope','cross_channel'),('pair_creators',['different']),('side','c')]:
   rr=rows();rr[1][field]=value
   with self.assertRaises(ValueError):f.strict_pairs(rr,set())
 def test_finite_width_unit_and_exact_range(self):
  for field,value in [('features',[0]*12),('features',[float('nan')]*13),('visual_mean',[0]*1152),('visual_mean',[1]*2),('offered_range',[5,40]),('start',21)]:
   rr=rows();rr[1][field]=value
   with self.assertRaises(ValueError):f.strict_pairs(rr,set())
 def test_same_node_conflict_in_new_rows(self):
  first=rows(tid=100);second=rows(tid=101);second[0]['features'][0]+=.1
  with self.assertRaisesRegex(ValueError,'Same offered node'):f.strict_pairs(first+second,set())
  self.assertEqual(len(f.strict_pairs(first+rows(tid=101),set())),2)
 def test_exact_duplicate_versions_fail(self):
  rr=rows();rr[1].update(offered_range=rr[0]['offered_range'].copy(),start=rr[0]['start'],end=rr[0]['end'],features=rr[0]['features'].copy(),visual_mean=rr[0]['visual_mean'].copy())
  with self.assertRaisesRegex(ValueError,'duplicate versions'):f.strict_pairs(rr,set())
 def test_evaluation_receipt_is_required_before_join(self):
  good={'snapshot_sha256':f.SNAPSHOT_SHA,'prospective_before_append_or_refit':True,'fits':0,'production_changed':False,'reserved_opened':False}
  with patch.object(f,'read_checked',return_value=good):self.assertTrue(str(f.check_evaluation('/synthetic')).endswith(f'{f.REPORT_SHA}.json'))
  for key,value in [('snapshot_sha256','different'),('fits',1),('prospective_before_append_or_refit',False),('reserved_opened',True)]:
   bad=dict(good,**{key:value})
   with patch.object(f,'read_checked',return_value=bad),self.assertRaises(ValueError):f.check_evaluation('/synthetic')

if __name__=='__main__':unittest.main()
