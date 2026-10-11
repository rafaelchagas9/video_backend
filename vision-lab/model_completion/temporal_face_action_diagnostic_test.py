"""Synthetic only: no live metadata, outcomes, detector, media or model fitting."""
import copy, io, json, tempfile, unittest
from pathlib import Path
import numpy as np
import temporal_face_action_diagnostic as d


def signals():
 t=np.arange(0,1201,5,dtype=float);p=np.zeros((len(t),4));p[:,0]=.2;p[:,3]=.8
 return t,p

def faces(indices,t,positive=True):return [{'index':int(i),'timestamp':float(t[i]),'detected':positive,'max_confidence':.9 if positive else 0.} for i in indices]

def manifest_fixture():
 manifest={'excluded_holdout_creators':['reserved'],'rows':[],'private_assignments':[]};receipt={'reserved_creators_excluded':['reserved'],'sources':{}}
 for i in range(8):
  video=d.KNOWN_VIDEO if i==0 else 100+i;fid=d.KNOWN_FEEDBACK if i==0 else 1000+i;group=f'g{i}'
  identity={'video_id':video,'analyzed_at':'frozen','source_fingerprint':{'frozen':i},'index':{'frozen':i},'duration':1200,'proposals':[{'id':f'p{i}','start':0.,'end':1200.}]}
  key=d.aux.state.identity_sha256(identity);frame={'path':f'neutral{i}.npz','sha256':str(i)*64,'identity_sha256':key}
  receipt['sources'][key]={'identity':identity,'group':group,'frame_checkpoint':frame}
  side={'video_id':video,'feedback_id':fid,'analyzed_at':'frozen','source_fingerprint':identity['source_fingerprint'],'index':identity['index'],'channel_key':group,'range':[1020.,1200.],'original_range':[0.,1200.]}
  manifest['rows'].append({'batch':'b','position':i,'context':{'a':side,'b':dict(side,range=[0.,1200.]),'fine_data_role':'training','reserved_fine_holdout':False}})
  manifest['private_assignments'].append({'batch':'b','position':i,'pilot_role':'model_vs_human','numeric_identity':identity,'frame_checkpoint':frame,'assignments':{'a':'frozen_primary_best','b':'current_human_approved'},'predictions':{'unused':999}})
 return manifest,receipt

class Tests(unittest.TestCase):
 def test_temporal_challenger_exact_same_length_observed_cluster(self):
  t,p=signals();r=d.propose(t,p,faces([40,44,210,220],t),[0.,1200.],[1020.,1200.])
  self.assertEqual(r['status'],'distinct_sampled_episode_challenger');self.assertEqual(r['candidate_range'][1]-r['candidate_range'][0],180)
  self.assertTrue(all(r['candidate_range'][0]<=a['timestamp']<=r['candidate_range'][1] for a in r['retained_omitted_joint_points']))
  self.assertLessEqual(r['control_iou'],.8);self.assertTrue(r['missing_face_is_unknown'])
 def test_missing_and_isolated_points_cannot_create_episode(self):
  t,p=signals()
  for ff in ([],faces([40],t),faces([40,100],t)):
   r=d.propose(t,p,ff,[0.,1200.],[1020.,1200.]);self.assertIsNone(r['candidate_range']);self.assertFalse(r['coverage_original']['continuous_face_coverage_known'])
  self.assertEqual(d.propose(t,p,[],[0.,1200.],[1020.,1200.])['coverage_original']['face_unknown_frame_points'],len(t))
  one=d.propose(t,p,faces([40],t),[0.,1200.],[1020.,1200.]);self.assertEqual(one['status'],'single_observed_joint_anchor_insufficient');self.assertEqual(len(one['observed_joint_anchors']),1);self.assertTrue(one['single_anchor_is_not_user_minimum'])
 def test_face_without_action_and_control_included_cluster_not_emit(self):
  t,p=signals();p[:,0]=.8;p[:,3]=.2
  self.assertIsNone(d.propose(t,p,faces([40,44],t),[0.,1200.],[1020.,1200.])['candidate_range'])
  t,p=signals();self.assertIsNone(d.propose(t,p,faces([210,220],t),[0.,1200.],[1020.,1200.])['candidate_range'])
 def test_duration_is_not_15min_hard_cap(self):
  t=np.arange(0,3601,5,dtype=float);p=np.zeros((len(t),4));p[:,0]=.2;p[:,3]=.8
  r=d.propose(t,p,faces([40,44],t),[0.,3600.],[2400.,3600.])
  self.assertEqual(r['candidate_range'][1]-r['candidate_range'][0],1200)
 def test_timestamp_duplicate_range_and_simplex_failclosed(self):
  t,p=signals();f=faces([40,44],t)
  bad=copy.deepcopy(f);bad[0]['timestamp']+=1
  for ff in (bad,f+[f[0]]):
   with self.assertRaises(ValueError):d.propose(t,p,ff,[0.,1200.],[1020.,1200.])
  with self.assertRaises(ValueError):d.propose(t,p+.1,f,[0.,1200.],[1020.,1200.])
  with self.assertRaises(ValueError):d.propose(t,p,f,[0.,1200.],[-5.,175.])
 def test_preanswer_selection_is_deterministic_and_score_label_independent(self):
  m,r=manifest_fixture();selected=d.select_sources(m,r);self.assertEqual(len(selected),6);self.assertTrue(selected[0]['known_debug'])
  self.assertEqual(sum(x['known_debug'] for x in selected),1)
  m['rows'].reverse();m['private_assignments'].reverse()
  for x in m['private_assignments']:x['predictions']={'unused':-999};x['answer']='b'
  self.assertEqual(d.select_sources(m,r),selected)
 def test_source_index_creator_and_reserve_failclosed(self):
  m,r=manifest_fixture()
  mutations=[lambda m,r:m['rows'][0]['context']['a']['index'].update(frozen=999),lambda m,r:m['rows'][0]['context']['a'].update(channel_key='wrong'),lambda m,r:m['rows'][0]['context'].update(reserved_fine_holdout=True),lambda m,r:m['rows'][0]['context'].update(fine_data_role='holdout')]
  for mutate in mutations:
   mm,rr=copy.deepcopy((m,r));mutate(mm,rr)
   with self.assertRaises(ValueError):d.select_sources(mm,rr)
 def test_exact_numeric_archive_shape_members_identity_and_timeline(self):
  m,r=manifest_fixture();source=copy.deepcopy(next(iter(r['sources'].values())));source['identity']['index']['frame_count']=4;source['full_timestamps']=[0.,5.,10.,15.]
  key=d.aux.state.identity_sha256(source['identity']);t=np.asarray(source['full_timestamps']);v=np.zeros((4,1152),np.float32);v[:,0]=1
  def pack(**changes):
   data={'t':t,'v':v,'identity_sha256':np.asarray(key)};data.update(changes);b=io.BytesIO();np.savez_compressed(b,**data);return b.getvalue()
  actual_t,actual_v=d.decode_numeric_checkpoint(pack(),source);np.testing.assert_array_equal(actual_t,t);np.testing.assert_array_equal(actual_v,v)
  for change in ({'identity_sha256':np.asarray([key])},{'identity_sha256':np.asarray('0'*64)},{'v':np.zeros((4,1151),np.float32)},{'v':v.astype(np.float64)},{'t':np.array([])},{'t':t+1},{'unexpected':np.array([1])}):
   with self.assertRaises(ValueError):d.decode_numeric_checkpoint(pack(**change),source)
 def test_content_addressed_immutable_private_output(self):
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'new.json';one=d.frozen(path,{'fits':0});self.assertEqual(one,d.frozen(path,{'fits':0}));self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertEqual(path.parent.stat().st_mode&0o777,0o700)
   with self.assertRaises(ValueError):d.frozen(path,{'fits':1})
   self.assertEqual(json.loads(path.read_text()),{'fits':0});self.assertEqual(list(path.parent.glob('*.tmp')),[])

if __name__=='__main__':unittest.main()
