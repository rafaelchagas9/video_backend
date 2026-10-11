"""Pure synthetic and mock-fit tests: no realPCA/logistic/model or artifact runs."""
import copy,types,unittest,json,tempfile
from pathlib import Path
from unittest.mock import patch
import numpy as np
import paired_face_preference as f


def graph():
 nodes={};lengths={};faces={};pairs=[]
 for i in range(16):
  key=f'node{i:02}';v=np.zeros(1152);v[i]=1;nodes[key]=(f'g{i//2}',np.arange(13,dtype=float)+i/10,v);lengths[key]=120+80*i;faces[key]=np.array([.2,.6,.03,.09])+i/100
 for i in range(0,16,2):pairs.append({'task_id':i,'winner':f'node{i:02}','loser':f'node{i+1:02}','creators':[f'g{i//2}'],'cohort_kind':'ordinary','subkind':'ordinary'})
 return nodes,pairs,lengths,faces


class FakePCA:
 fits=[]
 def __init__(self,**kwargs):self.kwargs=kwargs
 def fit(self,v):
  self.fits.append(v.copy());self.mean_=v.mean(0);self.components_=np.eye(8,1152);return self
 def transform(self,v):return (v-self.mean_)@self.components_.T
class FakeScaler:
 fits=[]
 def fit(self,z):
  self.fits.append(z.copy());self.mean_=z.mean(0);self.scale_=z.std(0);self.scale_[self.scale_<1e-12]=1;return self
 def transform(self,z):return (z-self.mean_)/self.scale_
class FakeLogistic:
 calls=[]
 def __init__(self,**kwargs):self.kwargs=kwargs
 def fit(self,z,y,sample_weight):
  self.calls.append((self.kwargs,z.copy(),y.copy(),sample_weight.copy()));self.coef_=np.linspace(-.5,.5,z.shape[1])[None,:];return self
 def decision_function(self,z):return z@self.coef_[0]


def face_fixture():
 identity={'video_id':1,'analyzed_at':'2026-10-10T00:00:00.000Z','source_fingerprint':{'size_bytes':1,'mtime_ns':'1','path_identity_sha256':'a'*64},'index':{'frame_count':15,'model_revision':'siglip2/so400m-patch16-256'},'duration':75.,'proposals':[{'id':'clip1','start':10.,'end':60.,'score':.6}]}
 key=f.face.source_key(identity);timeline=(np.arange(15)*5.).tolist();plans=[];observed=[];rows=[]
 for i in range(92):
  span=[20.,40.] if i%2 else [30.,50.];ids=f.face.sample_indices(np.asarray(timeline),span);label=f'detector_label{i}'
  plans.append({'row':label,'feedback_id':1,'original_range':[10.,60.],'offered_range':span,'point_indices':ids});observed.append({'row':label,'offered_range':span,'point_indices':ids,'sample_count':len(ids),'sampled_timestamps':[timeline[j] for j in ids],'features':[.5,.7,.03,.08],'availability':True,'absence_is_ground_truth':False,'continuous_coverage_estimated':False})
  rows.append({'row':f'learner_LABEL_DIFFERENT{i}','feedback_id':1,'video_id':1,'group':'fixture','numeric_identity':copy.deepcopy(identity),'original_range':[10.,60.],'offered_range':span,'frame_checkpoint':{'sha256':'b'*64,'identity_sha256':key},'analyzed_at':identity['analyzed_at'],'source_fingerprint':identity['source_fingerprint'],'index':identity['index']})
 source={'identity':identity,'group':'fixture','full_timestamps':timeline,'frame_checkpoint':{'sha256':'b'*64},'rows':plans};receipt={'policy':f.face.POLICY,'source_sha256':f.prior.old.sha(f.face.__file__),'pilot_helper_sha256':f.prior.old.sha(f.face.face.__file__),'model':{'sha256':f.face.face.MODEL_SHA},'sources':{key:source}}
 report={'status':'complete','available_version_count':92,'planned_version_count':92,'policy':f.face.POLICY,'sources':{key:{'source_key':key,'identity_sha256':key,'rows':observed}},'answers_used':False,'predictions_used':False,'fits':0,'raw_media_reads':0,'GPU':False,'DB_writes':0,'automatic_action':False}
 return rows,report,receipt,key


class PairedFaceTests(unittest.TestCase):
 def test_exact_range_identity_join_not_row_label(self):
  rows,report,receipt,_=face_fixture();result=f.join_face(rows,report,receipt);self.assertEqual(len(result),2)
  for value in result.values():np.testing.assert_array_equal(value,[.5,.7,.03,.08])
 def test_all92_available_no_missing_zero_imputation(self):
  rows,report,receipt,key=face_fixture()
  for field,value in [('status','partial_failed'),('available_version_count',91),('answers_used',True)]:
   bad=copy.deepcopy(report);bad[field]=value
   with self.assertRaises(ValueError):f.join_face(rows,bad,receipt)
  report['sources'][key]['rows'][0]['availability']=False
  with self.assertRaises(ValueError):f.join_face(rows,report,receipt)
 def test_wrong_range_generation_point_or_conflict_fails(self):
  for change in ('range','generation','point','feature','model','frame','duplicate'):
   rows,report,receipt,key=face_fixture()
   if change=='range':rows[0]['offered_range']=[30,51]
   elif change=='generation':rows[0]['numeric_identity']['analyzed_at']='changed'
   elif change=='point':report['sources'][key]['rows'][0]['sampled_timestamps'][0]+=.1
   elif change=='feature':report['sources'][key]['rows'][0]['features'][0]=float('nan')
   elif change=='model':receipt['model']['sha256']='wrong'
   elif change=='frame':rows[0]['frame_checkpoint']['sha256']='changed'
   else:report['sources'][key]['rows'][2]['features'][0]=.9
   with self.assertRaises(ValueError,msg=change):f.join_face(rows,report,receipt)
 def test_regenerate_v3_summary_from_exact_numeric_checkpoint(self):
  rows,report,receipt,key=face_fixture();source=receipt['sources'][key];ids=sorted({i for p in source['rows'] for i in p['point_indices']})
  expected=[{'index':i,'timestamp':source['full_timestamps'][i],'xywh':[0,0,456,256]} for i in ids];source['frames']=expected
  frames=[dict(p,boxes=[],detected=False,max_confidence=0.,max_box_area_fraction=0.) for p in expected]
  report['sources'][key]['rows']=f.face.aggregate(source['rows'],frames)
  value={'input_receipt_sha256':'a'*64,'source_key':key,'identity':source['identity'],'policy':f.face.POLICY,'frames':frames,'complete':True}
  with tempfile.TemporaryDirectory() as temp:
   directory=Path(temp)/'sources'/key;directory.mkdir(parents=True);payload=json.dumps(value,sort_keys=True).encode();sha=f.face.face.digest(payload);path=directory/f'checkpoint.{sha}.json';path.write_bytes(payload)
   self.assertTrue(f.validate_completed_checkpoints(report,receipt,'a'*64,temp))
   report['sources'][key]['rows'][0]['features'][0]=.9
   with self.assertRaisesRegex(ValueError,'summary differs'):f.validate_completed_checkpoints(report,receipt,'a'*64,temp)
   path.unlink()
   with self.assertRaisesRegex(ValueError,'checkpoint missing'):f.validate_completed_checkpoints(report,receipt,'a'*64,temp)
 def test_v3_recipe_and_exact_parent_cohort_pin(self):
  self.assertEqual(f.face.POLICY['schema_version'],3);self.assertIn('finalpage_v3',f.SPEC['face_recipe']);self.assertEqual(f.SPEC['parent_cohort_sha256'],'6a5aa01427e6832ac25243ec2ee4c0c9111d18a9c1bf15fcdd0a23bf5cdaade3')
 def test_remove_entire_cross_pair_if_either_creator_held(self):
  pairs=[{'creators':['a','b']},{'creators':['b','c']},{'creators':['c','d']}]
  self.assertEqual(f.training_pairs(pairs,{'a'}),pairs[1:]);self.assertEqual(f.training_pairs(pairs,{'b'}),pairs[2:])
 def test_trainonly_pca_scaler_and_signed_totalweight1(self):
  nodes,pairs,lengths,faces=graph();train=f.training_pairs(pairs,{'g0'});FakePCA.fits=[];FakeScaler.fits=[];FakeLogistic.calls=[]
  with patch.object(f.prior.old,'PCA',FakePCA),patch.object(f.prior.old,'StandardScaler',FakeScaler),patch.object(f.prior.old,'LogisticRegression',FakeLogistic):model=f.Fit().fit(nodes,train,lengths,faces)
  self.assertNotIn('g0',model.groups);self.assertNotIn('node00',model.keys);self.assertEqual(FakePCA.fits[0].shape,(14,1152));self.assertEqual(FakeScaler.fits[0].shape,(14,27))
  for kwargs,z,y,weights in FakeLogistic.calls:
   self.assertEqual(kwargs['C'],1);self.assertFalse(kwargs['fit_intercept']);np.testing.assert_array_equal(z[:7],-z[7:]);np.testing.assert_array_equal(weights[:7]+weights[7:],np.ones(7));np.testing.assert_array_equal(y,np.r_[np.ones(7),np.zeros(7)])
 def test_matched_head_masks_and_portable_parity(self):
  nodes,pairs,lengths,faces=graph()
  with patch.object(f.prior.old,'PCA',FakePCA),patch.object(f.prior.old,'StandardScaler',FakeScaler),patch.object(f.prior.old,'LogisticRegression',FakeLogistic):model=f.Fit().fit(nodes,pairs,lengths,faces)
  X=np.stack([n[1] for n in nodes.values()]);V=np.stack([n[2] for n in nodes.values()]);H=np.stack([f.prior.hinges(x) for x in lengths.values()]);F=np.stack(list(faces.values()))
  d=model.design(X,V,H,F,'face');c=model.design(X,V,H,F,'duration');np.testing.assert_array_equal(d[:,:23],c[:,:23]);self.assertTrue(np.all(c[:,23:]==0));self.assertTrue(np.all(model.design(X,V,H,F,'numeric')[:,13:]==0))
  for kind in f.KINDS:
   head=model.export(kind);direct=model.score(nodes,lengths,faces,kind);actual=f.portable(head,nodes,lengths,faces)
   np.testing.assert_allclose(list(direct.values()),list(actual.values()),atol=1e-12,rtol=0)
   if kind!='face':self.assertEqual(head['face_weights'],[0]*4)
 def test_preflight_all_folds_before_fit_and_finite_coverage(self):
  nodes,pairs,lengths,faces=graph();self.assertEqual(len(f.preflight(nodes,pairs,lengths,faces)),8)
  faces.pop('node00')
  with self.assertRaises(ValueError):f.preflight(nodes,pairs,lengths,faces)
  nodes,pairs,lengths,faces=graph();nodes['node00']=(nodes['node00'][0],np.full(13,np.nan),nodes['node00'][2])
  with self.assertRaises(ValueError):f.preflight(nodes,pairs,lengths,faces)
 def test_gate_fixed_counts_accuracy_gain_and_strict_ci(self):
  pairs=[{}]*12;groups=['g']*6
  self.assertTrue(f.gate(.8,[.1]*6,[.01,.2],pairs,groups));self.assertFalse(f.gate(.8,[.1]*6,[0,.2],pairs,groups));self.assertFalse(f.gate(.8,[.04]*6,[.01,.2],pairs,groups));self.assertFalse(f.gate(.74,[.1]*6,[.01,.2],pairs,groups));self.assertFalse(f.gate(.8,[.1]*6,[.01,.2],pairs[:-1],groups))
 def test_timing_scope_no_state_or_positivity_constraint(self):
  self.assertIn('AFTER22',f.SPEC['timing']);self.assertIn('NOT outcome-blind',f.SPEC['timing']);self.assertIn('No positivity',f.SPEC['selection_policy']);self.assertIn('No Stage1',f.SPEC['state_auxiliary']);self.assertFalse(f.SPEC['production_promotion'])
 def test_portable_shape_pin_and_boolean_guard(self):
  nodes,pairs,lengths,faces=graph()
  with patch.object(f.prior.old,'PCA',FakePCA),patch.object(f.prior.old,'StandardScaler',FakeScaler),patch.object(f.prior.old,'LogisticRegression',FakeLogistic):model=f.Fit().fit(nodes,pairs,lengths,faces)
  good=model.export('face')
  for key,value in [('face_weights',[1]*3),('face_weights',[True,0,0,0]),('bias',float('nan')),('face_recipe','changed'),('face_model_sha256','changed'),('automatic_action',True)]:
   head=copy.deepcopy(good);head[key]=value
   with self.assertRaises(ValueError):f.portable(head,nodes,lengths,faces)

if __name__=='__main__':unittest.main()
