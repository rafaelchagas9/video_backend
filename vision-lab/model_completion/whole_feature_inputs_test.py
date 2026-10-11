"""Disposable synthetic files only; no database, real outcomes, archive/media or fits."""
import copy,json,os,struct,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import whole_feature_inputs as w

class WholePreparationTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.budget=w.Budget(self.root,time.monotonic());self.at='2026-10-10T00:00:00Z';self.index={'modelRevision':w.whole.base.VISUAL_PIN,'storyboardGeneratedAt':self.at,'indexedAt':self.at,'intervalSeconds':5,'frameCount':4}
  self.p={'video_id':1,'analyzed_at':self.at,'channel':'creator','feedback_ids':[11],'original_clip_ids':['c']}
  self.f={'id':11,'video_id':1,'analyzed_at':self.at,'clip_id':'c','channel':'creator','added':False,'detected_start':0.,'detected_end':20.,'score':2.27}
  self.saved={'format':'kura-recording-training','version':1,'analyzedAt':self.at,'source':{'videoId':1,'fileName':'fixture','fileHash':'hash','fileSizeBytes':10,'durationSeconds':20.},'features':{'index':self.index,'dimension':1152,'file':'features-fixture.bin'},'proposals':[{'id':'c','start_seconds':0.,'end_seconds':20.,'score':2.27}],'clips':[{'id':'c','start_seconds':7.,'end_seconds':9.,'detected':{'start_seconds':0.,'end_seconds':20.}}]};self.saved['features']['identity']=w.archive.feature_identity(self.saved)
  self.t=np.arange(4)*5.;self.v=np.zeros((4,1152),dtype=np.float32);self.v[:,0]=1.
 def tearDown(self):self.tmp.cleanup()
 def binary(self):
  f=self.saved['features'];header=json.dumps({'version':1,'identity':f['identity'],'index':self.index,'dimension':1152,'timestamps':'float64-le','embeddings':'float32-le'}).encode();raw=b'KURAFEAT'+struct.pack('<I',len(header))+header+self.t.astype('<f8').tobytes()+self.v.astype('<f4').tobytes();directory=self.root/'1';directory.mkdir(exist_ok=True);path=directory/f['file'];path.write_bytes(raw);f.update(bytes=len(raw),sha256=w.sha(raw));return path
 def hist(self):
  private={'policy':w.history.POLICY,'recordings':{'w0':self.p,'secret':dict(self.p,video_id=2,channel='reserved')}}
  label={'row':'w0','group':'g','y':1,'label_target':w.recipe.TARGET,'label_policy':w.history.POLICY,'reason':'explicit_keep_whole','near_full_edited_clips_still_unknown':False,'future_replacement_y':None,'permanent_storage_y':None}
  root={'policy':w.history.POLICY,'private_binding_sha256':w.digest(private),'semantics_sha256':w.digest(w.history.SEMANTICS),'source_sha256':{'cohort.json':'a','private_snapshot.json':'b'},'rows':[label,{'row':'secret','y':'DO_NOT_DECODE_OUTCOME'}]};return root,private
 def test_reserved_screen_before_outcomes_and_lexical_tasks_skip(self):
  root,private=self.hist();original=json.loads
  def guarded(s,*args,**kwargs):
   if 'DO_NOT_DECODE_OUTCOME' in s:raise AssertionError('Excluded outcome decoded')
   return original(s,*args,**kwargs)
  with patch.object(w.json,'loads',side_effect=guarded):selected,_,excluded=w.allowed_history(json.dumps(root),private,{'reserved'})
  self.assertEqual((len(selected),excluded),(1,1))
  snapshot={'records':[dict(self.f,verdict='DO_NOT_DECODE_OUTCOME',reasons=['DO_NOT_DECODE_OUTCOME']),dict(self.f,video_id=2,channel='reserved',verdict='DO_NOT_DECODE_OUTCOME')],'tasks':[{'answer':'DO_NOT_DECODE_OUTCOME','detail':{'best':{}}}]}
  with patch.object(w.json,'loads',side_effect=guarded):feedback=w.feedback_inputs(json.dumps(snapshot),selected)
  self.assertEqual(feedback[w.whole.source_key(self.p)][0],self.f)
 def test_feedback_generation_creator_and_universe_fail_closed(self):
  root,private=self.hist();selected,_,_=w.allowed_history(json.dumps(root),private,{'reserved'})
  for field,value in [('channel','wrong'),('clip_id','wrong'),('analyzed_at','2026-10-11T00:00:00Z')]:
   f=dict(self.f,**{field:value})
   with self.subTest(field=field),self.assertRaises(ValueError):w.feedback_inputs(json.dumps({'records':[f],'tasks':[]}),selected)
  with self.assertRaises(ValueError):w.feedback_inputs(json.dumps({'records':[self.f,self.f]}),selected)
 def test_missing_original_never_uses_final_trim_and_raw_score_preserved(self):
  props=w.original_proposals(self.saved,self.p,[self.f]);self.assertEqual(props,[{'id':'c','start':0.,'end':20.,'score':2.27}])
  f=dict(self.f,detected_start=None,detected_end=None)
  with self.assertRaises(w.Unavailable):w.original_proposals(self.saved,self.p,[f])
  saved=copy.deepcopy(self.saved);saved['proposals'][0]['start_seconds']=7.
  with self.assertRaises(ValueError):w.original_proposals(saved,self.p,[self.f])
  saved=copy.deepcopy(self.saved);saved['proposals']=[]
  with self.assertRaises(w.Unavailable):w.original_proposals(saved,self.p,[self.f])
  saved=copy.deepcopy(self.saved);saved['proposals']=None;self.assertEqual(w.original_proposals(saved,self.p,[self.f]),props)
 def test_exact_generation_archive_not_latest_and_identity_pin(self):
  self.binary();directory=self.root/'1';path=directory/'review-exact.json';path.write_text(json.dumps(self.saved));later=dict(self.saved,analyzedAt='2026-10-11T00:00:00Z');(directory/'review-latest.json').write_text(json.dumps(later))
  saved,chosen=w.exact_archive(self.p,self.budget,self.root);self.assertEqual(chosen,path);self.assertEqual(saved,self.saved)
  p=dict(self.p,analyzed_at='2026-10-12T00:00:00Z')
  with self.assertRaises(w.Unavailable):w.exact_archive(p,self.budget,self.root)
  bad=copy.deepcopy(self.saved);bad['features']['identity']='0'*64;path.write_text(json.dumps(bad))
  with self.assertRaises(ValueError):w.exact_archive(self.p,w.Budget(self.root,time.monotonic()),self.root)
 def test_archived_binary_header_hash_and_full_sequence_recipe(self):
  path=self.binary();t,v=w.archive_frames(self.saved,self.budget,self.root);self.assertTrue(np.array_equal(t,self.t));self.assertTrue(np.array_equal(v,self.v));x,mean=w.recipe.features(w.original_proposals(self.saved,self.p,[self.f]),20,t,v);self.assertEqual(x[2],2.27);self.assertAlmostEqual(sum(z*z for z in mean),1.)
  raw=bytearray(path.read_bytes());raw[-1]^=1;path.write_bytes(raw)
  with self.assertRaises(ValueError):w.archive_frames(self.saved,w.Budget(self.root,time.monotonic()),self.root)
  with self.assertRaises(ValueError):w.recipe.features([],40,t,v)
 def test_new_npz_identity_recipe_expansion_and_zero_proposals(self):
  identity={'fixture':'no-outcome'};path,r=w.whole.checkpoint(self.root,self.t,self.v,identity);x,mean=w.recipe.features([],20,self.t,self.v);p={'candidate':{'duration_seconds':20.,'index':{'frame_count':4}},'proposals':[],'numeric_identity':identity,'frame_checkpoint':dict(r,path=path),'features':x,'visual_mean':mean}
  self.assertEqual(w.new_frames(p,self.budget),(x,mean));changed=copy.deepcopy(p);changed['features'][0]+=1
  with self.assertRaises(ValueError):w.new_frames(changed,w.Budget(self.root,time.monotonic()))
  with self.assertRaises(ValueError):w.new_frames(p,w.Budget(self.root,time.monotonic(),max_bytes=Path(path).stat().st_size+1))
  changed=copy.deepcopy(p);changed['numeric_identity']={'fixture':'wrong'}
  with self.assertRaises(ValueError):w.new_frames(changed,w.Budget(self.root,time.monotonic()))
 def test_budget_device_symlink_total_deadline_and_end_drift(self):
  p=self.root/'data';p.write_bytes(b'fixture');self.assertEqual(self.budget.read(p),b'fixture');p.write_bytes(b'changed-size')
  with self.assertRaises(ValueError):self.budget.stable()
  with self.assertRaises(ValueError):w.Budget(self.root,time.monotonic(),max_bytes=1).read(p)
  with self.assertRaises(TimeoutError):w.Budget(self.root,time.monotonic()-181).read(p)
  link=self.root/'alias';link.symlink_to(p)
  with self.assertRaises(ValueError):self.budget.read(link)
  b=w.Budget(self.root,time.monotonic());b.device=-1
  with self.assertRaises(ValueError):b.read(p)
 def test_atomic_private_publication_and_immutable_collision(self):
  out=self.root/'output';w.publish(out,{'rows':[{'y':None}]},{'source':'fixture'},{'fits':0});self.assertEqual(out.stat().st_mode&0o777,0o700)
  self.assertTrue(all(p.stat().st_mode&0o777==0o600 for p in out.iterdir()));w.publish(out,{'rows':[{'y':None}]},{'source':'fixture'},{'fits':0})
  with self.assertRaises(ValueError):w.publish(out,{'rows':[{'y':1}]},{'source':'fixture'},{'fits':0})
 def test_lexical_duplicate_keys_and_nested_escapes(self):
  text=json.dumps({'records':[{'video_id':1,'other':'[escaped \\" } ]'},{'video_id':2}],'tasks':[{'answer':'never-read'}]});f=w.fields(text);self.assertEqual(len(list(w.items(f['records']))),2)
  with self.assertRaises(ValueError):w.fields('{"records":[],"records":[]}')
  with self.assertRaises(ValueError):w.fields('{"records":[]} trailing')
 def test_complete_mocked_build_new16_unlabeled_historical_missing_explicit(self):
  import whole_round_test as fixtures
  case=fixtures.WholeRoundTest();case.setUp()
  try:
   manifest=copy.deepcopy(case.manifest);manifest['rows']=[];manifest['private_sources']=[]
   for idx in range(16):
    task=copy.deepcopy(case.manifest['rows'][idx%4]);p=copy.deepcopy(case.manifest['private_sources'][idx%4]);c=p['candidate'];c.update(video_id=100+idx,channel=f'new{idx}',channel_key=f'new{idx}');task.update(position=idx,video_id=100+idx,channel=f'new{idx}');task['context']['candidate']=copy.deepcopy(c);p['position']=idx
    p['numeric_identity']=dict(c,duration=20.,proposals=p['proposals'],proposal_origin=p['proposal_origin'],frame_digest=p['frame_digest']);path,r=w.whole.checkpoint(self.root,self.t,self.v,p['numeric_identity']);p['frame_checkpoint']=dict(r,path=path);manifest['rows'].append(task);manifest['private_sources'].append(p)
   manifest.update(excluded_holdout_creators=['reserved'],dependencies=[],consumer_sources=w.whole.consumer_pins(),source_sha256=w.whole.base.digest(w.whole.__file__))
   newroot=self.root/'new';newroot.mkdir();raw=json.dumps(manifest).encode();(newroot/'private_manifest.json').write_bytes(raw)
   hist=self.root/'history';hist.mkdir();elig,private=self.hist();cohort=b'{"old_unsafe_features":"never_reused"}';snapshot=json.dumps({'records':[self.f],'tasks':[{'answer':'DO_NOT_DECODE_OUTCOME'}]}).encode();(self.root/'cohort.json').write_bytes(cohort);(self.root/'private_snapshot.json').write_bytes(snapshot);elig['source_sha256']={'cohort.json':w.sha(cohort),'private_snapshot.json':w.sha(snapshot)}
   (hist/w.whole.HISTORY_FILES[0]).write_text(json.dumps(elig));(hist/w.whole.HISTORY_FILES[1]).write_text(json.dumps(private))
   with patch.object(w.whole,'HIST',hist),patch.object(w,'source_pins',return_value=[]):
    result,binding,receipt=w.build(self.root,newroot,w.sha(raw),self.budget,{'reserved'},case.receipt,self.root/'no-archives')
   self.assertEqual(result['counts']['new_unlabeled'],16);self.assertEqual(result['counts']['historical_unavailable'],1);self.assertEqual(len(result['rows']),16);self.assertTrue(all(r['y'] is None for r in result['rows']));self.assertEqual(len(binding['rows']),16);self.assertFalse(receipt['database_access']);self.assertFalse(receipt['outcome_intake']);self.assertEqual(receipt['model_fits'],0)
   self.assertIn('exact_generation_archive_missing',result['unavailable'][0]['reason'])
   # Recover only this exact generation archive, never any old proposal-level aggregates.
   self.binary();(self.root/'1'/'review-exact.json').write_text(json.dumps(self.saved))
   with patch.object(w.whole,'HIST',hist),patch.object(w,'source_pins',return_value=[]):
    complete,identity,receipt=w.build(self.root,newroot,w.sha(raw),w.Budget(self.root,time.monotonic()),{'reserved'},case.receipt,self.root)
   self.assertEqual((complete['counts']['positive'],complete['counts']['historical_features_available']),(1,1));self.assertEqual(complete['rows'][0]['y'],1);self.assertEqual(complete['rows'][0]['features'][2],2.27);self.assertTrue(all(r['y'] is None for r in complete['rows'][1:]))
   out=self.root/'prepared';w.publish(out,complete,identity,receipt)
   self.assertEqual(receipt['cohort_sha256'],w.sha((out/'feature_cohort.json').read_bytes()));self.assertEqual(receipt['private_binding_sha256'],w.sha((out/'private_identity.json').read_bytes()))
   # A corrupt new checkpoint causes failure before ANY receipt is published.
   path=Path(manifest['private_sources'][0]['frame_checkpoint']['path']);path.write_bytes(b'corrupt')
   with patch.object(w.whole,'HIST',hist),patch.object(w,'source_pins',return_value=[]),self.assertRaises(ValueError):w.build(self.root,newroot,w.sha(raw),w.Budget(self.root,time.monotonic()),{'reserved'},case.receipt,self.root/'no-archives')
  finally:case.tearDown()
 def test_preparation_row_has_no_clip_cut_future_or_new_label(self):
  x,mean=w.recipe.features([],20,self.t,self.v);r=w.row('n000','creator',None,'unanswered',x,mean);self.assertIsNone(r['y'])
  for field in ('clip_current_acceptability_y','cut_gold','permanent_storage_y','future_replacement_y'):self.assertIsNone(r[field])

if __name__=='__main__':unittest.main()
