"""Synthetic only: pool eligibility, point identity, balancing and cluster metrics."""
import copy,unittest
import numpy as np
import temporal_validation50 as v


def source(i,group=None):
 group=group or f'g{i}'
 return {'feedback_id':i+1,'video_id':i+101,'channel':group,'channel_key':group,'analyzed_at':'2026-10-10','source_fingerprint':{'size_bytes':100,'mtime_ns':'1','path_identity_sha256':'a'*64},'index':{'frame_count':121,'interval_seconds':5,'model_revision':v.base.VISUAL_PIN,'indexed_at':'2026-10-10T00:00:00Z','storyboard_generated_at':'2026-10-10T00:00:00Z'},'clip':[0.,600.],'best':[0.,600.],'duration_seconds':600.,'score':.8,'detector':{'frozen':True}}

def record(i,group=None):
 s=source(i,group);identity={k:s[k] for k in ('video_id','analyzed_at','source_fingerprint','index')};identity.update(duration=600.,proposals=[{'id':f'p{i}','start':0.,'end':600.,'score':.8}]);key=v.temporal.aux.state.identity_sha256(identity)
 return {'source':s,'source_key':key,'numeric_identity':identity,'frame_checkpoint':{'path':'neutral.npz','sha256':'a'*64,'identity_sha256':key},'known_debug':i==0,'face_checkpoint_sha256':'f'*64,'control_range':[420.,600.],'diagnostic':{'candidate_range':[120.,300.]}}

class Tests(unittest.TestCase):
 def test_actual_frozen_metadata_receipt_shape_no_DB_reads(self):
  import json
  inventory=v.ROOT/'validation50-eligibility/metadata-original240.8fc5004056772ae4ece889b8a0bc8b2bf66101af177a94741730a1151e58bb92.json'
  value=json.loads(inventory.read_text())
  self.assertEqual(len(v.validate_sources(value['sources'],set(value['excluded_holdout_creators']))),67)
  self.assertEqual(len({s['video_id'] for s in value['sources']}),54)
  self.assertEqual(sum(s['best'][1]-s['best'][0]>=180 for s in value['sources']),64)
 def test_reference_free_proof_never_changes_actual_comparator(self):
  original=[0.,1000.];reference=[30.,430.];ranges=v.old.grid(original,reference)
  scores=[{'primary':10 if r==reference else 1 if r==[0.,180.] else 0} for r in ranges]
  self.assertEqual(ranges[v.old.best(ranges,scores)],reference)
  self.assertEqual(v.generic_selection(ranges,scores,original),[0.,180.])
  scores=[{'primary':1 if r==[0.,180.] else 0} for r in ranges]
  self.assertEqual(v.generic_selection(ranges,scores,original),ranges[v.old.best(ranges,scores)])
 def test_debug_retained_without_outcome_lookahead(self):
  rows=[record(i,f'g{i}') for i in range(55)]
  rows[0]['known_debug']=False;rows[54]['known_debug']=True
  chosen,_=v.select_pairs(rows)
  self.assertIn(rows[54],chosen);self.assertEqual(len(chosen),50)

 def test_original_eligibility_not_short_saved_worth(self):
  s=source(0);s['best']=[100.,130.];self.assertEqual(v.validate_sources([s],{'reserved'}),[s])
  s['clip']=[0.,239.]
  with self.assertRaises(ValueError):v.validate_sources([s],{'reserved'})
  s=source(0,'reserved')
  with self.assertRaises(ValueError):v.validate_sources([s],{'reserved'})
 def test_uniform_face_requests_are_outcome_free_and_exact_inside(self):
  t=np.arange(0,601,5,dtype=float);a=v.uniform_indices(t,[0.,600.],72);b=v.uniform_indices(t,[420.,600.],24)
  self.assertEqual(len(a),72);self.assertEqual(len(b),24);self.assertEqual(a,v.uniform_indices(t,[0.,600.],72));self.assertTrue(all(420<=t[i]<=600 for i in b))
 def test_complete_face_request_shape_identity_and_missing_unknown(self):
  r=record(1);req={'identity':r['numeric_identity'],'full_timestamps':np.arange(0,601,5).tolist(),'planned_indices':[20,24]};key=v.temporal.aux.state.identity_sha256(req['identity'])
  cp={'request_sha256':'a'*64,'source_key':key,'identity':req['identity'],'model_sha256':v.temporal.aux.paired.face.face.MODEL_SHA,'provider':'CPUExecutionProvider','identity_embeddings':False,'complete':True,'frames':[{'index':i,'timestamp':req['full_timestamps'][i],'detected':True,'max_confidence':.8} for i in req['planned_indices']]}
  self.assertEqual(len(v.validate_face_points(cp,req,'a'*64)),2)
  for mutate in (lambda x:x['frames'].pop(),lambda x:x.update(complete=False),lambda x:x['frames'][0].update(timestamp=101),lambda x:x.update(model_sha256='0'*64),lambda x:x.update(identity_embeddings=True)):
   bad=copy.deepcopy(cp);mutate(bad)
   with self.assertRaises(ValueError):v.validate_face_points(bad,req,'a'*64)
 def test_creator_roundrobin_limit3_and_no_forced_fill(self):
  records=[record(i,'g0') for i in range(6)]+[record(i+6,f'g{i+1}') for i in range(10)]
  chosen,suppressed=v.select_pairs(records);self.assertEqual(sum(r['source']['channel_key']=='g0' for r in chosen),3);self.assertEqual(len(chosen),13);self.assertEqual(len(suppressed),3)
  self.assertEqual(chosen,v.select_pairs(list(reversed(records)))[0])
 def test_exact50_manifest_blind_balance_and_dependency(self):
  selected=[record(i,f'g{i//2}') for i in range(50)];selection={'policy':v.POLICY,'metric_policy':v.METRIC_POLICY,'status':'ready50_distinct_for_review','selected':selected,'eligible_distinct':50,'selected_creators':25,'all_inventory_sources':67,'agreement_or_unavailable':[],'suppressed':[]};m=v.make_manifest(selection,{'reserved'},{'frozen':'holdout'})
  self.assertEqual(len(m['rows']),50);self.assertEqual(sum(p['assignments']['a']=='new_temporal' for p in m['private_assignments']),25);self.assertEqual(sum(p['known_debug'] for p in m['private_assignments']),1)
  public=str(m['rows'])
  for hidden in ('new_temporal','old_C','known_debug','joint_proxy'):self.assertNotIn(hidden,public)
  selection['selected']=selected[:49]
  with self.assertRaises(ValueError):v.make_manifest(selection,{'reserved'},{'frozen':'holdout'})
 def test_creator_metrics_not50_independent_and_debug_excluded(self):
  rows=[{'creator':f'g{i//2}','outcome':'new','known_debug':False} for i in range(48)]+[{'creator':'debug','outcome':'new','known_debug':True}]
  r=v.metrics(rows);self.assertEqual(r['primary_creator_count'],24);self.assertEqual(r['primary_creator_macro_net'],1);self.assertEqual(r['creator_cluster_net_ci95'],[1.,1.]);self.assertTrue(r['release_signal_passed']);self.assertFalse(r['automatic_model_promotion']);self.assertFalse(r['50_independent_sample_claim'])
  rows[-1]['outcome']='old';self.assertFalse(v.metrics(rows)['release_signal_passed'])
 def test_ties_abstentions_null_and_inconclusive(self):
  for outcome in ('both','neither'):
   rows=[{'creator':f'g{i}','outcome':outcome,'known_debug':False} for i in range(25)]+[{'creator':'debug','outcome':'both','known_debug':True}];r=v.metrics(rows);self.assertFalse(r['release_signal_passed']);self.assertIsNone(r['primary_creator_macro_strict_win'])
  rows=[{'creator':f'g{i}','outcome':'new' if i<13 else 'old','known_debug':False} for i in range(25)]+[{'creator':'debug','outcome':'new','known_debug':True}];r=v.metrics(rows);self.assertLessEqual(r['creator_cluster_net_ci95'][0],0);self.assertFalse(r['release_signal_passed'])
 def test_creator_cap_not_hidden_by_repeated_rows(self):
  rows=[{'creator':'same','outcome':'new','known_debug':False} for _ in range(4)]
  with self.assertRaises(ValueError):v.metrics(rows)

if __name__=='__main__':unittest.main()
