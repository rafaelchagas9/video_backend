"""Synthetic supplement fixtures only; no live data, outcomes, media, DB or fits."""
import copy,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import whole_feature_supplement as s

class SupplementTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.at='2026-10-10T00:00:00Z';self.p={'video_id':1,'analyzed_at':self.at,'channel':'creator','feedback_ids':[1],'original_clip_ids':['c']};self.label={'row':'w0','y':1,'label_target':s.w.recipe.TARGET,'label_policy':s.w.history.POLICY,'reason':'explicit_keep_whole','near_full_edited_clips_still_unknown':False,'future_replacement_y':None,'permanent_storage_y':None};self.index={'model_revision':s.w.whole.base.VISUAL_PIN,'frame_count':4,'interval_seconds':5,'storyboard_generated_at':self.at,'indexed_at':self.at};self.fp={'size_bytes':1,'mtime_ns':'1','path_identity_sha256':'a'*64};self.identity={'video_id':1,'analyzed_at':self.at,'index':self.index,'source_fingerprint':self.fp,'duration':20.,'origin':{'kind':'live_numeric_exact_frozen_generation'},'proposals':[{'id':'c','start':0.,'end':20.,'score':2.27}]};self.f={'id':1,'video_id':1,'analyzed_at':self.at,'clip_id':'c','channel':'creator','added':False,'detected_start':0.,'detected_end':20.,'score':2.27}
  self.sha=s.w.digest(self.identity);self.t=np.arange(4)*5.;self.v=np.zeros((4,1152),dtype=np.float32);self.v[:,0]=1.;directory=self.root/'new-round-training';directory.mkdir();path,r=s.w.whole.checkpoint(directory,self.t,self.v,self.identity);self.cache=Path(path);self.numeric={'numeric_identity':self.identity,'frame_checkpoint':r,'duration_seconds':20.,'source_fingerprint':self.fp,'index':self.index};self.trainrow={'video_id':1,'analyzed_at':self.at,'channel':'creator','group':'creator','reserved_fine_holdout':False,'fine_data_role':'training','pair_creators':['creator'],'frame_cache':path,**self.numeric,'answer':'DO_NOT_DECODE_FINE','cut_gold':{'value':'DO_NOT_DECODE_FINE'}}
  self.training=json.dumps({'rows':[self.trainrow]}).encode();(directory/'feature_cohort.json').write_bytes(self.training);self.parent=self.root/'whole-feature-inputs-v1';self.parent.mkdir();self.hist=self.root/'history';self.hist.mkdir();self.holdout={'fixture':True}
  hp={'policy':s.w.history.POLICY,'recordings':{'w0':self.p}};snapshot={'records':[dict(self.f,verdict='DO_NOT_DECODE_FINE',reasons=['DO_NOT_DECODE_FINE'])],'indices':{'1':list(self.index.values())},'tasks':[{'answer':'DO_NOT_DECODE_FINE'}]};snapshotraw=json.dumps(snapshot).encode();(self.root/'private_snapshot.json').write_bytes(snapshotraw);elig={'policy':s.w.history.POLICY,'private_binding_sha256':s.w.digest(hp),'semantics_sha256':s.w.digest(s.w.history.SEMANTICS),'rows':[self.label],'source_sha256':{'cohort.json':'irrelevant','private_snapshot.json':s.w.sha(snapshotraw)}}
  hpaths=[self.hist/n for n in s.w.whole.HISTORY_FILES]
  for path,value in zip(hpaths,[elig,hp]):path.write_text(json.dumps(value))
  self.x,self.mean=s.w.recipe.features([],20,self.t,self.v);rows=[s.w.row(f'h{k}',f'historical{k}',int(k==0),s.w.history.POLICY,self.x,self.mean) for k in range(4)]+[s.w.row(f'n{k:03d}',f'new{k}',None,'unanswered',self.x,self.mean) for k in range(16)];self.old={'schema_version':1,'policy':s.w.POLICY,'target':s.w.recipe.TARGET,'feature_recipe':s.w.recipe.RECIPE,'feature_names':s.w.recipe.FEATURES,'visual_recipe':s.w.recipe.VISUAL_RECIPE,'rows':rows,'counts':{'historical_features_available':4,'historical_unavailable':38,'new_unlabeled':16,'positive':1,'negative':3},'unavailable':[{'row':'w0','reason':'exact_generation_archive_missing'}]+[{'row':f'm{i}','reason':'missing'} for i in range(37)],'new_labels_intaken':False,'historical_near_full_reinterpreted':False,'enabled':False,'whole_fit_count':0};self.private={'policy':s.w.POLICY,'rows':{r['row']:{'kind':'new_frozen_whole_manifest' if r['row'].startswith('n') else 'historical_exact_generation_archive'} for r in rows}};oldraw=s.w.whole.canonical(self.old)+b'\n';pr=s.w.whole.canonical(self.private)+b'\n';(self.parent/'feature_cohort.json').write_bytes(oldraw);(self.parent/'private_identity.json').write_bytes(pr);self.receipt={'policy':s.w.POLICY,'holdout_dependency':self.holdout,'excluded_holdout_creators':[],'cohort_sha256':s.w.sha(oldraw),'private_binding_sha256':s.w.sha(pr),'new_manifest_sha256':'a'*64,'inputs':[{'path':str(p),'sha256':s.w.sha(p.read_bytes())} for p in hpaths]};(self.parent/'input_receipt.json').write_text(json.dumps(self.receipt))
 def tearDown(self):self.tmp.cleanup()
 def build(self):
  with patch.object(s,'CACHE_IDENTITY',self.sha),patch.object(s,'TRAINING_SHA',s.w.sha(self.training)),patch.object(s.w.whole,'HIST',self.hist),patch.object(s,'source_paths',return_value=[self.parent/'input_receipt.json']):return s.build(self.root,self.parent,s.Budget(self.root,time.monotonic()),set(),self.holdout)
 def test_complete_supplement_one_source_parent_and_new16_unchanged(self):
  before={p.name:p.read_bytes() for p in self.parent.iterdir()};value,private,receipt=self.build();self.assertEqual((len(value['rows']),value['counts']['historical_features_available'],value['counts']['historical_unavailable']),(21,5,37));self.assertEqual(value['rows'][:20],self.old['rows']);self.assertEqual(value['rows'][-1]['y'],1);self.assertEqual(value['rows'][-1]['features'][2],2.27);self.assertTrue(all(r['y'] is None for r in value['rows'] if r['row'].startswith('n')));self.assertEqual({p.name:p.read_bytes() for p in self.parent.iterdir()},before)
  out=self.root/'v2';s.w.publish(out,value,private,receipt);self.assertEqual(receipt['cohort_sha256'],s.w.sha((out/'feature_cohort.json').read_bytes()));self.assertEqual(receipt['private_binding_sha256'],s.w.sha((out/'private_identity.json').read_bytes()));self.assertEqual(receipt['supplement_count'],1);self.assertFalse(receipt['outcome_intake'])
 def test_no_fine_outcome_decode_in_training_or_snapshot(self):
  original=json.loads
  def guarded(raw,*args,**kwargs):
   if 'DO_NOT_DECODE_FINE' in (raw.decode() if isinstance(raw,bytes) else raw):raise AssertionError('Fine outcome decoded')
   return original(raw,*args,**kwargs)
  with patch.object(s.json,'loads',side_effect=guarded):self.build()
 def test_reserved_creator_and_either_pair_role_excluded_before_numeric(self):
  bad=dict(self.trainrow,channel='reserved',numeric_identity='DO_NOT_DECODE_FINE')
  with self.assertRaises(ValueError):s.candidates(json.dumps({'rows':[bad]}),[(self.label,self.p)],{'reserved'},self.cache)
  bad=dict(self.trainrow,pair_creators=['creator','reserved'],numeric_identity='DO_NOT_DECODE_FINE')
  with self.assertRaises(ValueError):s.candidates(json.dumps({'rows':[bad]}),[(self.label,self.p)],{'reserved'},self.cache)
  bad=dict(self.trainrow,fine_data_role='holdout',numeric_identity='DO_NOT_DECODE_FINE')
  with self.assertRaises(ValueError):s.candidates(json.dumps({'rows':[bad]}),[(self.label,self.p)],set(),self.cache)
 def test_identity_index_source_generation_and_universe_fail_closed(self):
  with patch.object(s,'CACHE_IDENTITY',self.sha):s.verify_identity(self.numeric,self.p,list(self.index.values()))
  for field,value in [('analyzed_at','2026-10-11T00:00:00Z'),('video_id',2),('duration',21.)]:
   n=copy.deepcopy(self.numeric);n['numeric_identity'][field]=value
   with self.subTest(field=field),patch.object(s,'CACHE_IDENTITY',self.sha),self.assertRaises(ValueError):s.verify_identity(n,self.p,list(self.index.values()))
  old=list(self.index.values());old[1]=5
  with self.assertRaises(ValueError):s.verify_identity(self.numeric,self.p,old)
  for field,value in [('detected_start',7.),('detected_end',None),('score',.1)]:
   f=dict(self.f,**{field:value})
   with self.subTest(field=field),self.assertRaises(ValueError):s.exact_originals(self.identity,self.p,[f])
 def test_cache_tamper_and_parent_literal_hash_fail_closed(self):
  self.cache.write_bytes(b'corrupt')
  with self.assertRaises(ValueError):self.build()
  self.receipt['cohort_sha256']='0'*64;(self.parent/'input_receipt.json').write_text(json.dumps(self.receipt))
  with self.assertRaises(ValueError):self.build()
 def test_supplement_never_reads_unreviewed_new_whole_answers(self):
  self.old['rows'][4]['y']=1;raw=s.w.whole.canonical(self.old)+b'\n';(self.parent/'feature_cohort.json').write_bytes(raw);self.receipt['cohort_sha256']=s.w.sha(raw);(self.parent/'input_receipt.json').write_text(json.dumps(self.receipt))
  with self.assertRaises(ValueError):self.build()
 def test_duplicate_cache_candidates_and_nonfixed_checkpoint_reject(self):
  with self.assertRaises(ValueError):s.candidates(json.dumps({'rows':[self.trainrow,self.trainrow]}),[(self.label,self.p)],set(),self.cache)
  with self.assertRaises(ValueError):s.candidates(json.dumps({'rows':[self.trainrow]}),[(self.label,self.p)],set(),self.root/'other.npz')
 def test_budget64mib_and_120seconds(self):
  b=s.Budget(self.root,time.monotonic());b.charge(s.MAX_BYTES)
  with self.assertRaises(ValueError):b.charge(1)
  with self.assertRaises(TimeoutError):s.Budget(self.root,time.monotonic()-121).check()

if __name__=='__main__':unittest.main()
