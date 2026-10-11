"""Synthetic/disposable metadata and mock learners only; no real labels/model fits."""
import copy,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import whole_current_train as f


def fixture(historical=12):
 holdout={'fixture':'sealed'};reserved={'sealed'};manifest={'schema_version':1,'batch':f.intake.contract.BATCH,'policy':copy.deepcopy(f.intake.contract.POLICY),'holdout_dependency':holdout,'excluded_holdout_creators':sorted(reserved),'rows':[],'private_sources':[]}
 rows=[];identities={};t=np.arange(4)*5.;v=np.zeros((4,1152));v[:,0]=1.;x,visual=f.recipe.features([],20.,t,v)
 for i in range(16):
  channel=f'new{i}';at='2026-10-10T00:00:00Z';c={'video_id':i+1,'analyzed_at':at,'duration_seconds':20.,'channel':channel,'channel_key':channel,'index':{'model_revision':f.intake.base.VISUAL_PIN,'frame_count':4,'interval_seconds':5,'storyboard_generated_at':at,'indexed_at':at},'source_fingerprint':{'size_bytes':1,'mtime_ns':'1','path_identity_sha256':'a'*64}};origin={'kind':'recording_reviews.proposals','analyzed_at':at,'sha256':f.intake.contract.digest([])};identity=dict(c,duration=20.,proposals=[],proposal_origin=origin,frame_digest='0'*32);cp={'path':'/synthetic/numeric.npz','sha256':'b'*64,'bytes':100,'identity_sha256':f.intake.contract.digest(identity)}
  private={'position':i,'candidate':c,'proposals':[],'proposal_origin':origin,'frame_digest':'0'*32,'numeric_identity':identity,'frame_checkpoint':cp,'features':x,'visual_mean':visual,'feature_recipe':f.recipe.RECIPE,'visual_recipe':f.recipe.VISUAL_RECIPE};task={'kind':'whole-verdict','batch':manifest['batch'],'position':i,'video_id':c['video_id'],'start_seconds':0,'end_seconds':20.,'channel':channel,'stratum':'explicit-whole-unknown','context':{'target':f.recipe.TARGET,'reserved_fine_holdout':False,'fine_data_role':'training','candidate':copy.deepcopy(c),'original_range':[0,20.]}};manifest['rows'].append(task);manifest['private_sources'].append(private);alias=f'n{i:03d}';rows.append(f.inputs.row(alias,channel,None,'prospective_whole_round_unanswered_no_intake',x,visual));identities[alias]={'kind':'new_frozen_whole_manifest','batch':task['batch'],'position':i,'candidate':c,'original_proposals':[],'proposal_origin':origin,'numeric_identity':identity,'frame_checkpoint':cp}
 for i in range(historical):
  alias=f'w{i:03d}';positive=i<historical//2;channel=f'{"pos" if positive else "neg"}{i//2 if positive else (i-historical//2)//2}';p={'video_id':100+i,'analyzed_at':at,'channel':channel,'feedback_ids':[100+i],'original_clip_ids':[]};vv=np.zeros(1152);vv[i]=1.;r=f.inputs.row(alias,channel,int(positive),f.inputs.history.POLICY,x,vv.tolist());rows.insert(i,r);identities[alias]={'kind':'historical_exact_generation_archive','historical':p,'source':{'videoId':p['video_id'],'durationSeconds':20.},'analyzed_at':at,'frame_identity':'c'*64,'frame_sha256':'d'*64,'original_proposals':[]}
 cohort={'schema_version':1,'policy':f.inputs.POLICY,'target':f.recipe.TARGET,'feature_recipe':f.recipe.RECIPE,'feature_names':f.recipe.FEATURES,'visual_recipe':f.recipe.VISUAL_RECIPE,'rows':rows,'counts':{'historical_features_available':historical,'historical_unavailable':38,'new_unlabeled':16},'unavailable':[{'row':'supp','reason':'missing'}],'new_labels_intaken':False,'historical_near_full_reinterpreted':False,'whole_fit_count':0,'probability_calibrated':False,'automatic_action':False,'enabled':False};binding={'policy':f.inputs.POLICY,'rows':identities};tasks=[dict(copy.deepcopy(p),id=1000+i,answer='unsure',answered_at='2026-10-10T10:00:00Z',reasons=[],detail=None) for i,p in enumerate(manifest['rows'])];snapshot={'schema_version':1,'manifest_sha256':f.digest_bytes(f.intake.contract.canonical(manifest)+b'\n'),'intake_source_sha256':f.sha(f.intake.__file__),'labels_source_sha256':f.sha(f.intake.contract.labels.__file__),'answers':f.intake.checked_answers(tasks,manifest,reserved)}
 return cohort,binding,manifest,snapshot,reserved,holdout,tasks


def pins(paths):return [{'path':str(Path(p).resolve()),'sha256':f.sha(p)} for p in paths]
def save(path,value):path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(f.intake.contract.canonical(value)+b'\n');return f.sha(path)
def stat_receipt(path):
 path=Path(path).resolve();s=path.stat();return {'path':str(path),'sha256':f.sha(path),'stat':[s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns]}


class FakePCA:
 calls=[]
 def __init__(self,**kw):self.kw=kw
 def fit(self,v):self.calls.append(v.copy());self.mean_=v.mean(0);self.components_=np.eye(8,1152);return self
 def transform(self,v):return (v-self.mean_)@self.components_.T
class FakeScaler:
 calls=[]
 def fit(self,z,sample_weight):
  self.calls.append((z.copy(),sample_weight.copy()));self.mean_=np.average(z,axis=0,weights=sample_weight);self.scale_=np.sqrt(np.average((z-self.mean_)**2,axis=0,weights=sample_weight));self.scale_[self.scale_<1e-12]=1;return self
 def transform(self,z):return (z-self.mean_)/self.scale_
class FakeLogistic:
 calls=[]
 def __init__(self,**kw):self.kw=kw
 def fit(self,z,y,sample_weight):self.calls.append((self.kw,z.copy(),y.copy(),sample_weight.copy()));self.coef_=np.linspace(-.3,.3,z.shape[1])[None,:];self.intercept_=np.array([.1]);self.n_iter_=np.array([1]);return self
 def decision_function(self,z):return z@self.coef_[0]+self.intercept_[0]
 def predict_proba(self,z):p=1/(1+np.exp(-self.decision_function(z)));return np.c_[1-p,p]


class WholeCurrentTrainTests(unittest.TestCase):
 def test_exact_answers_unsure_unknown_and_historical_unchanged(self):
  cohort,binding,manifest,snapshot,reserved,holdout,tasks=fixture();before=copy.deepcopy(cohort);tasks[0]['answer']='keep_entire';tasks[1]['answer']='edited_parts_only';tasks[2]['answer']='nothing_worth_keeping';snapshot['answers']=f.intake.checked_answers(tasks,manifest,reserved);joined=f.join_answers(cohort,binding,manifest,snapshot,reserved,holdout)
  self.assertEqual(cohort,before);self.assertEqual(joined[:12],cohort['rows'][:12]);self.assertEqual([r['y'] for r in joined[12:16]],[1,0,0,None]);self.assertTrue(all(r['cut_gold'] is None and r['permanent_storage_y'] is None for r in joined))
 def test_answer_semantics_generation_role_or_partial_drift_rejected(self):
  for kind in ('label','source','answer','counts','partial','reserved'):
   cohort,binding,manifest,snapshot,reserved,holdout,_=fixture()
   if kind=='label':snapshot['answers']['whole_rows'][0]['y']=1
   elif kind=='source':snapshot['answers']['whole_rows'][0]['analyzed_at']='2026-10-11T00:00:00Z'
   elif kind=='answer':snapshot['answers']['whole_rows'][0]['answer']='a'
   elif kind=='counts':snapshot['answers']['positive']=999
   elif kind=='partial':snapshot['answers']['whole_rows'].pop()
   else:manifest['rows'][0]['context']['reserved_fine_holdout']=True
   with self.assertRaises(ValueError,msg=kind):f.join_answers(cohort,binding,manifest,snapshot,reserved,holdout)
 def test_metadata_invalid_before_outcome_object_access(self):
  cohort,binding,manifest,_,reserved,holdout,_=fixture();cohort['rows'][-1]['features'][0]+=1
  class Poison(dict):
   def get(self,*args,**kwargs):raise AssertionError('Outcomes visited before metadata')
  with self.assertRaises(ValueError):f.join_answers(cohort,binding,manifest,Poison(),reserved,holdout)
 def test_allfold_class_and_centered_pca9_preflight_no_fit(self):
  cohort,*_=fixture();rows=cohort['rows'];self.assertEqual(f.preflight(rows)['status'],'eligible');self.assertEqual(f.SPEC['minimum_training_nodes'],9)
  for r in rows:
   if r['y']==0:r['group']='z_negative'
  status=f.preflight(rows);self.assertEqual(status['status'],'insufficient');self.assertTrue(any('fold_training_class_missing:z_negative'==r for r in status['reasons']))
  with tempfile.TemporaryDirectory() as root:
   spec={'policy':f.SPEC,'features_root':root,'round_root':root,'pins':{'manifest_sha256':'a','snapshot_sha256':'b'},'preflight':status};save(Path(root)/'before-fit.json',spec)
   with patch.object(f,'load_inputs',return_value=(rows,spec['pins'])),patch.object(f.Fit,'fit',side_effect=AssertionError('Fit forbidden')):result=f.run(root)
   self.assertEqual(result['model_fits'],0);self.assertFalse((Path(root)/'attempt.json').exists())
  # Both class counts and creator counts can pass while one late creator leaves <9nodes.
  known=[]
  for label in (0,1):
   for i in range(5):
    r=copy.deepcopy(cohort['rows'][0]);r.update(row=f'{label}-{i}',y=label,group='z' if i<2 else f'{label}g{i}');known.append(r)
  status=f.preflight(known);self.assertIn('fold_PCA8_nodes_missing:z',status['reasons'])
 def test_trainonly_pca_scalers_balanced_weights_portable_disabled(self):
  cohort,*_=fixture();known=[r for r in cohort['rows'] if r['y'] is not None];train=[r for r in known if r['group']!=known[0]['group']];FakePCA.calls=[];FakeScaler.calls=[];FakeLogistic.calls=[]
  with patch.object(f,'PCA',FakePCA),patch.object(f,'StandardScaler',FakeScaler),patch.object(f,'LogisticRegression',FakeLogistic):model=f.Fit().fit(train)
  self.assertNotIn(known[0]['group'],model.groups);self.assertEqual(FakePCA.calls[0].shape,(10,1152));self.assertEqual(len(FakeScaler.calls),2)
  for kw,z,y,w in FakeLogistic.calls:
   self.assertEqual(kw['C'],1);self.assertTrue(kw['fit_intercept']);self.assertEqual(kw['random_state'],42)
   for g in model.groups:self.assertAlmostEqual(sum(w[i] for i,r in enumerate(train) if r['group']==g),1.)
  for kind in ('numeric','visual'):
   head=model.export(kind);self.assertFalse(head['enabled']);self.assertFalse(head['automatic_action']);self.assertFalse(head['probability_calibrated']);actual=model.models[kind].decision_function(model.scalers[kind].transform(model.design(known,kind)));portable=[f.recipe.score(head,r['features'],r['visual_mean']) for r in known];np.testing.assert_allclose(actual,portable,atol=1e-12,rtol=0)
 def test_creator_class_macro_recalls_not_row_accuracy(self):
  y=[1]*10+[0]*10;p=[.8]*9+[.2]+[.2]*9+[.8];g=['a']*9+['b']+['c']*9+['d'];m=f.metrics(y,p,g);self.assertEqual(m['class_creator_macro_recall'],{'0':.5,'1':.5});self.assertEqual(m['macro_balanced_accuracy'],.5);self.assertEqual(m['creator_macro_correct'],.5)
 def test_paired_creator_bootstrap_invalid_draws_and_gate(self):
  y=[1,1,0,0];a=[.9,.8,.2,.1];g=['pos','pos','neg','neg'];b=f.bootstrap(y,a,a,g);self.assertEqual(b['valid']+b['invalid_single_class'],2000);self.assertGreater(b['invalid_single_class'],0);self.assertEqual(b['gain_CI95'],[0,0])
  with self.assertRaises(TimeoutError):f.bootstrap(y,a,a,g,time.monotonic()-1)
  v={'macro_balanced_accuracy':.8,'AUC':.9};n={'AUC':.8};ci={'valid':1000,'gain_CI95':[.01,.2]};self.assertTrue(f.gate(v,n,ci));self.assertFalse(f.gate(v,n,dict(ci,valid=999)));self.assertFalse(f.gate(v,n,dict(ci,gain_CI95=[0,.2])));self.assertFalse(f.gate(dict(v,macro_balanced_accuracy=.74),n,ci))
 def test_timing_and_unknown_scope_fixed_no_activation(self):
  self.assertIn('AFTER',f.SPEC['timing']);self.assertIn('NOT outcome-blind',f.SPEC['timing']);self.assertIn('14',f.SPEC['historical_near_full_unknowns']);self.assertIn('not population prevalence',f.SPEC['interpretation']);self.assertEqual(f.SPEC['bootstrap_draws'],2000)
  for key in ('enabled','automatic_action','probability_calibrated','production_promotion','hyperparameter_search'):self.assertFalse(f.SPEC[key])
 def test_v2_parent_chain_realistic_binding_and_tamper(self):
  cohort,binding,manifest,snapshot,reserved,holdout,_=fixture(4)
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);parent=root/'parent';child=root/'v2';parent.mkdir();child.mkdir();sources=[Path(f.inputs.__file__),Path(f.inputs.__file__).with_name('whole_feature_inputs_test.py'),Path(f.recipe.__file__),Path(f.inputs.history.__file__),Path(f.intake.contract.__file__),Path(f.inputs.archive.__file__),Path(f.inputs.snapshots.__file__)]
   parent_receipt={'policy':f.inputs.POLICY,'holdout_dependency':holdout,'excluded_holdout_creators':sorted(reserved),'cohort_sha256':save(parent/'feature_cohort.json',cohort),'private_binding_sha256':save(parent/'private_identity.json',binding),'new_manifest_sha256':snapshot['manifest_sha256'],'source_pins':pins(sources),'inputs':[],'source_media_reads':0,'database_access':False,'outcome_intake':False,'model_fits':0,'enabled':False};save(parent/'input_receipt.json',parent_receipt)
   added=copy.deepcopy(cohort['rows'][0]);added.update(row='supp');new=copy.deepcopy(cohort);new.update(policy=f.supplement.POLICY,supplement_count=1,rows=cohort['rows']+[added],unavailable=[]);private=copy.deepcopy(binding);private['policy']=f.supplement.POLICY;at='2026-10-10T00:00:00Z';identity={'video_id':999,'analyzed_at':at,'duration':20.,'proposals':[],'index':copy.deepcopy(manifest['private_sources'][0]['candidate']['index']),'source_fingerprint':copy.deepcopy(manifest['private_sources'][0]['candidate']['source_fingerprint'])};iid=f.intake.contract.digest(identity);private['rows']['supp']={'kind':'historical_exact_generation_numeric_checkpoint','historical':{'video_id':999,'analyzed_at':at,'channel':'pos0'},'numeric_identity':identity,'original_proposals':[],'frame_checkpoint':{'identity_sha256':iid,'sha256':'a'*64},'historical_index':list(identity['index'].values()),'training_cohort_sha256':f.supplement.TRAINING_SHA}
   # Dict order for oldindex is prescribed rather than assumed.
   private['rows']['supp']['historical_index']=[identity['index'][k] for k in ('model_revision','frame_count','interval_seconds','storyboard_generated_at','indexed_at')]
   receipt={'policy':f.supplement.POLICY,'holdout_dependency':holdout,'excluded_holdout_creators':sorted(reserved),'source_pins':pins(f.supplement.source_paths()),'inputs':[],'parent_inputs':[{'path':str(parent/n),'sha256':f.sha(parent/n)} for n in ('feature_cohort.json','private_identity.json','input_receipt.json')],'supplement_count':1,'new_manifest_sha256':snapshot['manifest_sha256'],'source_media_reads':0,'database_access':False,'outcome_intake':False,'model_fits':0,'enabled':False}
   f.check_preparation_chain(child,new,private,receipt,reserved,holdout)
   with patch.object(f.supplement,'CACHE_IDENTITY',iid):f.validate_metadata(new,private,manifest,reserved,holdout);joined=f.join_answers(new,private,manifest,snapshot,reserved,holdout)
   self.assertEqual(joined[-1]['y'],1);self.assertEqual(sum(r['y'] is None for r in joined),16)
   # Exercise the complete v2 loader, including parent history/metadata validation
   # BEFORE the synthetic completed-answer file, with no actual archives or frames.
   hist=root/'history';hist.mkdir();historical_mapping={r['row']:binding['rows'][r['row']]['historical'] for r in cohort['rows'] if binding['rows'][r['row']]['kind']=='historical_exact_generation_archive'};historical_mapping['supp']=private['rows']['supp']['historical'];labels=[]
   for r in [*cohort['rows'][:4],added]:labels.append({'row':r['row'],'y':r['y'],'label_policy':f.inputs.history.POLICY,'label_target':f.recipe.TARGET,'reason':'explicit_keep_whole' if r['y']==1 else 'saved_all_proposals_skipped','near_full_edited_clips_still_unknown':False,'future_replacement_y':None,'permanent_storage_y':None})
   for i in range(14):
    alias=f'unknown{i}';historical_mapping[alias]={'video_id':2000+i,'analyzed_at':at,'channel':f'unknown{i}'};labels.append({'row':alias,'y':None,'label_policy':f.inputs.history.POLICY,'label_target':f.recipe.TARGET,'near_full_edited_clips_still_unknown':True,'future_replacement_y':None,'permanent_storage_y':None})
   historical_private={'policy':f.inputs.history.POLICY,'recordings':historical_mapping};eligibility={'policy':f.inputs.history.POLICY,'private_binding_sha256':f.inputs.digest(historical_private),'semantics_sha256':f.inputs.digest(f.inputs.history.SEMANTICS),'source_sha256':{},'rows':labels}
   history_paths=[hist/n for n in f.intake.contract.HISTORY_FILES];save(history_paths[0],eligibility);save(history_paths[1],historical_private)
   round_root=root/'round';round_root.mkdir()
   with patch.object(f.intake.contract,'HIST',hist),patch.object(f.intake.contract.safe.previous,'holdout_contract',return_value=(reserved,holdout)),patch.object(f.supplement,'CACHE_IDENTITY',iid):
    manifest.update(source_sha256=f.sha(f.intake.contract.__file__),consumer_sources=f.intake.contract.consumer_pins(),dependencies=pins(f.intake.contract.dependencies()));manifest_sha=save(round_root/'private_manifest.json',manifest);snapshot['manifest_sha256']=manifest_sha;snapshot_sha=save(round_root/'answer-snapshots'/'temporary.json',snapshot);(round_root/'answer-snapshots'/'temporary.json').rename(round_root/'answer-snapshots'/f'answers.{snapshot_sha}.json')
    parent_receipt.update(new_manifest_sha256=manifest_sha,inputs=[stat_receipt(p) for p in history_paths]);save(parent/'input_receipt.json',parent_receipt);receipt.update(parent_inputs=[{'path':str(parent/n),'sha256':f.sha(parent/n)} for n in ('feature_cohort.json','private_identity.json','input_receipt.json')],inputs=[stat_receipt(parent/n) for n in ('feature_cohort.json','private_identity.json','input_receipt.json')],new_manifest_sha256=manifest_sha,cohort_sha256=save(child/'feature_cohort.json',new),private_binding_sha256=save(child/'private_identity.json',private));save(child/'input_receipt.json',receipt)
    loaded,checked_pins=f.load_inputs(child,round_root,manifest_sha,snapshot_sha,time.monotonic()+180);self.assertEqual(len(loaded),21);self.assertEqual(sum(r['y'] is None for r in loaded),16);self.assertEqual(checked_pins['historical_near_full_unknowns_relabelled'],0)
    # A historical source/receipt drift must fail before the new-answer path is read.
    original=f.read_json;calls=[]
    def watched(path,*args,**kwargs):calls.append(str(path));return original(path,*args,**kwargs)
    history_paths[0].write_bytes(b'changed')
    with patch.object(f,'read_json',side_effect=watched),self.assertRaises(ValueError):f.load_inputs(child,round_root,manifest_sha,snapshot_sha,time.monotonic()+180)
    self.assertFalse(any('answer-snapshots' in p for p in calls))
   broken=copy.deepcopy(new);broken['rows'][0]['y']=1-broken['rows'][0]['y']
   with self.assertRaises(ValueError):f.check_preparation_chain(child,broken,private,receipt,reserved,holdout)
   (parent/'feature_cohort.json').write_bytes(b'changed')
   with self.assertRaises(ValueError):f.check_preparation_chain(child,new,private,receipt,reserved,holdout)

if __name__=='__main__':unittest.main()
