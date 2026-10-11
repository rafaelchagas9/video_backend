"""Synthetic numeric fixtures only; no media, real model load, fit or dataset export."""
import copy,dataclasses,json,math,tempfile,time,unittest
from pathlib import Path
import numpy as np
import offered_face_action_features as f
from offered_state_features_test import fixture as state_fixture


def fixture():
 t,_,identity=state_fixture();key=f.state.identity_sha256(identity)
 p=np.tile([.8,0,0,.2],(15,1));p[6]=[.2,0,0,.8]
 context=f.state.OriginalStateContext(t,p,json.dumps(identity,sort_keys=True,separators=(',',':')),key,f.state.PROBE_SHA256)
 metadata=[{'index':i,'timestamp':float(timestamp),'xywh':[0,0,456,256]} for i,timestamp in enumerate(t)]
 frames=[]
 for point in metadata:
  conf=.9 if point['index']==6 else (.6 if point['index']==8 else 0.)
  boxes=[{'bbox':[0.,0.,.1,.1],'confidence':conf,'area_fraction':.01}] if conf else []
  frames.append(dict(point,boxes=boxes,detected=bool(boxes),max_confidence=conf,max_box_area_fraction=.01 if boxes else 0.))
 source={'identity':identity,'full_timestamps':t.tolist(),'frames':metadata,'frame_checkpoint':{'sha256':'b'*64,'identity_sha256':key}}
 row={'row':'row0','task_id':1,'side':'a','feedback_id':1,'group':'fixture','fine_data_role':'training','reserved_fine_holdout':False,'numeric_identity':copy.deepcopy(identity),'frame_checkpoint':copy.deepcopy(source['frame_checkpoint']),'original_range':[10.,60.],'offered_range':[20.,40.],'score':.6}
 row.update({k:identity[k] for k in ('video_id','analyzed_at','source_fingerprint','index')})
 return context,source,frames,row


def artifact_fixture():
 context,source,frames,row=fixture();rows=[];values=[]
 for i in range(92):
  r=copy.deepcopy(row);r.update(row=f'row{i}',task_id=i//2+1,side='a' if i%2==0 else 'b');rows.append(r);values.append(f.row_features(r,context,source,frames))
 receipt={'sources':{context.identity_sha256:source},'reserved_creators_excluded':['sealed']}
 value={'schema_version':1,'policy':copy.deepcopy(f.POLICY),'export_source_sha256':'c'*64,'spec_sha256':'d'*64,'parent_cohort_sha256':f.COHORT_SHA,'face_report_sha256':f.FACE_REPORT_SHA,'probe_sha256':f.state.PROBE_SHA256,'rows':values,'sources':{context.identity_sha256:{'probe_sha256':f.state.PROBE_SHA256,'frame_count':15}},'numeric_read_bytes':100,'seconds':1.,'fits':0,'production_changed':False,'reserved_outcomes_opened':False}
 return rows,receipt,value


class FaceAction(unittest.TestCase):
 def test_mean_detected_and_max_confidence_same_timestamp(self):
  context,source,frames,_=fixture();x,indices=f.cooccurrence(context,source,frames,[20,40]);self.assertEqual(indices,[4,5,6,7,8]);np.testing.assert_allclose(x,[.2,.72],atol=1e-12)
  mean_conf=np.mean([frames[i]['max_confidence']*context.probabilities[i,3] for i in indices]);self.assertNotAlmostEqual(x[1],mean_conf)
  self.assertTrue(f.FEATURE_NAMES[9].endswith('_max'));self.assertIn('MAX(',f.POLICY['cooccurrence'])
 def test_missing_duplicate_or_shifted_face_point_fails(self):
  for kind in ('missing','duplicate','timestamp','index'):
   context,source,frames,_=fixture()
   if kind=='missing':frames.pop(6)
   elif kind=='duplicate':frames.append(copy.deepcopy(frames[6]))
   elif kind=='timestamp':frames[6]['timestamp']+=.01
   else:frames[6]['index']=14
   with self.assertRaises(ValueError,msg=kind):f.cooccurrence(context,source,frames,[20,40])
 def test_source_generation_probe_and_timeline_fail(self):
  for kind in ('source','probe','timeline'):
   context,source,frames,_=fixture()
   if kind=='source':source['identity']['analyzed_at']='changed'
   elif kind=='probe':context=dataclasses.replace(context,probe_sha256='e'*64)
   else:source['full_timestamps'][6]+=.01
   with self.assertRaises(ValueError,msg=kind):f.cooccurrence(context,source,frames,[20,40])
 def test_bad_probabilities_bounds_and_detection_fail(self):
  for kind in ('shape','nan','simplex','bounds','boolean','confidence','confidence_bool','probability_bool','box'):
   context,source,frames,_=fixture();bounds=[20,40]
   if kind=='shape':context=dataclasses.replace(context,probabilities=np.zeros((15,3)))
   elif kind=='nan':p=context.probabilities.copy();p[6,3]=np.nan;context=dataclasses.replace(context,probabilities=p)
   elif kind=='simplex':p=context.probabilities.copy();p[6,3]=.2;context=dataclasses.replace(context,probabilities=p)
   elif kind=='bounds':bounds=[20,80]
   elif kind=='boolean':bounds=[True,40]
   elif kind=='confidence':frames[6]['max_confidence']=float('nan')
   elif kind=='confidence_bool':frames[6]['max_confidence']=True
   elif kind=='probability_bool':context=dataclasses.replace(context,probabilities=np.tile([True,False,False,False],(15,1)))
   else:frames[6]['boxes'][0]['bbox'][0]=2.
   with self.assertRaises(ValueError,msg=kind):f.cooccurrence(context,source,frames,bounds)
 def test_legacy_id_derivation_and_exact_explicit_id(self):
  context,source,frames,row=fixture();self.assertNotIn('original_proposal_id',row);self.assertEqual(f.original_proposal_id(row),'clip1');x=f.row_features(row,context,source,frames);self.assertEqual(x['original_proposal_id'],'clip1');self.assertEqual(len(x['features']),10)
  row['original_proposal_id']='clip1';self.assertEqual(f.original_proposal_id(row),'clip1');row['original_proposal_id']='other'
  with self.assertRaises(ValueError):f.row_features(row,context,source,frames)
 def test_ambiguous_original_score_bounds_added_fail(self):
  for kind in ('ambiguous','score','bounds','added'):
   _,_,_,row=fixture()
   if kind=='ambiguous':q=copy.deepcopy(row['numeric_identity']['proposals'][0]);q['id']='clip2';row['numeric_identity']['proposals'].append(q)
   elif kind=='score':row['score']=.7
   elif kind=='bounds':row['original_range']=[10,61]
   else:row['numeric_identity']['proposals'][0]['added']=True
   with self.assertRaises(ValueError,msg=kind):f.original_proposal_id(row)
 def test_legacy_raw_score_not_probability(self):
  _,_,_,row=fixture()
  for score in (2.27,-.3):
   row['score']=score;row['numeric_identity']['proposals'][0]['score']=score;self.assertEqual(f.original_proposal_id(row),'clip1')
 def test_no_absolute_or_cut_labels_and_annotations_inert(self):
  context,source,frames,row=fixture();reference=f.row_features(row,context,source,frames);row.update(answer='b',current_acceptability_y=1,cut_gold=[21,39],permanent_storage_worth=1)
  self.assertEqual(f.row_features(row,context,source,frames),reference);self.assertFalse(reference['labels_created']);self.assertNotIn('answer',reference);self.assertNotIn('cut_gold',reference)
 def test_pure_exact_downstream_join_and_immutable_node_consistency(self):
  rows,receipt,value=artifact_fixture();actual=f.join_features(value,rows,receipt,spec_sha256='d'*64,export_source_sha256='c'*64);self.assertEqual(len(actual),1);np.testing.assert_array_equal(next(iter(actual.values())),value['rows'][0]['features'])
  for kind in ('source','range','points','reserved','feature','node_conflict','label','pin','missing','time','budget_nan'):
   r=copy.deepcopy(rows);v=copy.deepcopy(value)
   if kind=='source':r[0]['numeric_identity']['analyzed_at']='changed'
   elif kind=='range':v['rows'][0]['offered_range']=[20,41]
   elif kind=='points':v['rows'][0]['sampled_timestamps'][0]+=.01
   elif kind=='reserved':r[0]['group']='sealed'
   elif kind=='feature':v['rows'][0]['features'][0]=True
   elif kind=='node_conflict':v['rows'][1]['features'][9]-=.01
   elif kind=='label':v['rows'][0]['current_acceptability_y']=1
   elif kind=='pin':v['probe_sha256']='e'*64
   elif kind=='missing':v['rows'].pop()
   elif kind=='budget_nan':v['numeric_read_bytes']=float('nan')
   else:v['seconds']=180
   with self.assertRaises(ValueError,msg=kind):f.join_features(v,r,receipt,spec_sha256='d'*64,export_source_sha256='c'*64)
 def test_numeric_read_budget_checksum_deadline(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'numeric.json';p.write_bytes(b'{}');reader=f.NumericReads(limit=3);self.assertEqual(reader.read(p,2),'{}'.encode())
   with self.assertRaises(ValueError):reader.read(p,2)
   with self.assertRaises(ValueError):f.NumericReads().read(p,2,'wrong')
   with self.assertRaises(ValueError):f.NumericReads().read(p,1)
  with self.assertRaises(TimeoutError):f.check(time.monotonic()-1)
 def test_policy_exploratory_not_outcome_blind_or_promotable(self):
  self.assertEqual(f.POLICY['budget_seconds'],180);self.assertEqual(f.POLICY['numeric_read_budget_bytes'],256*1024**2);self.assertTrue(f.POLICY['exploratory']);self.assertIn('no outcome-blind claim',f.POLICY['timing']);self.assertIn('personalized',f.__doc__)
  for key in ('action_proxy_is_human_action_truth','face_absence_is_truth','hard_constraints','labels_created','images_or_media_read','GPU','model_download'):self.assertFalse(f.POLICY[key])
  self.assertEqual(f.POLICY['fits'],0);self.assertEqual(f.POLICY['production_writes'],0)

if __name__=='__main__':unittest.main()
