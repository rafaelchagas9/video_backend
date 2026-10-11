"""Synthetic/disposable fixtures only; no live DB, outcomes, media, models or queues."""
import copy,datetime,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import whole_round_prepare as p
import whole_round_apply as a
import whole_round_intake as i

class Cursor:
 def __init__(self,rows=(),one='unchanged',count=1):self.rows=rows;self.one=one;self.rowcount=count
 def fetchall(self):return self.rows
 def fetchone(self):return [self.one]

class PG:
 def __init__(self,existing=(),changed=False,count=1):self.sql=[];self.existing=existing;self.hashes=0;self.changed=changed;self.count=count
 def execute(self,q,args=()):
  self.sql.append(q)
  if q.startswith('SELECT md5(coalesce'):self.hashes+=1;return Cursor(one='changed' if self.changed and self.hashes==2 else 'unchanged')
  if q.startswith('SELECT kind,batch'):return Cursor([[r[k] for k in p.FIELDS] for r in self.existing])
  return Cursor(count=self.count)

class WholeRoundTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.receipt={'fixture':True};self.manifest={'schema_version':1,'batch':p.BATCH,'policy':copy.deepcopy(p.POLICY),'holdout_dependency':self.receipt,'excluded_holdout_creators':[],'rows':[],'private_sources':[]}
  self.live=[]
  for position in range(4):
   c={'video_id':position+1,'analyzed_at':'2026-10-10T00:00:00Z','duration_seconds':20.,'channel':f'creator{position}','channel_key':f'creator{position}','index':{'model_revision':p.base.VISUAL_PIN,'frame_count':4,'interval_seconds':5,'storyboard_generated_at':'2026-10-10T00:00:00Z','indexed_at':'2026-10-10T00:00:00Z'},'source_fingerprint':{'size_bytes':1,'mtime_ns':'1','path_identity_sha256':'a'*64}}
   t=np.arange(4)*5.;v=np.zeros((4,1152),dtype=np.float32);v[:,0]=1.;x,visual=p.recipe.features([],20,t,v)
   origin={'kind':'recording_reviews.proposals','analyzed_at':c['analyzed_at'],'sha256':p.digest([])};identity=dict(c,duration=20.,proposals=[],proposal_origin=origin,frame_digest='0'*32);path,receipt=p.checkpoint(self.root,t,v,identity)
   private={'position':position,'candidate':c,'proposals':[],'proposal_origin':origin,'saved_review_sha256':'b'*64,'frame_digest':'0'*32,'storyboard_receipt':{'path':str(self.root/'fixture.vtt'),'sha256':'c'*64},'numeric_identity':identity,'frame_checkpoint':dict(receipt,path=path),'features':x,'visual_mean':visual,'feature_recipe':p.recipe.RECIPE,'visual_recipe':p.recipe.VISUAL_RECIPE}
   context={'target':p.labels.TARGET,'reserved_fine_holdout':False,'fine_data_role':'training','candidate':c,'original_range':[0,20.]}
   self.manifest['private_sources'].append(private);self.manifest['rows'].append({'kind':'whole-verdict','batch':p.BATCH,'position':position,'video_id':position+1,'start_seconds':0,'end_seconds':20.,'channel':c['channel'],'stratum':'explicit-whole-unknown','context':context})
   self.live.append({'video_id':position+1,'channel':c['channel'],'analyzed_at':c['analyzed_at'],'clips':[{'keep':True,'reasons':[]},{'keep':False,'reasons':[]}],'proposals':[]})
  self.tasks=[dict(copy.deepcopy(r),id=100+idx,answer=answer,reasons=[],detail=None,answered_at=datetime.datetime(2026,10,10,16)) for idx,(r,answer) in enumerate(zip(self.manifest['rows'],p.labels.ANSWERS))]
 def tearDown(self):self.temp.cleanup()
 def frozen(self):
  dep=self.root/'helper.py';dep.write_text('fixture')
  self.manifest.update(source_sha256=p.base.digest(p.__file__),consumer_sources=p.consumer_pins(),dependencies=[{'path':str(dep),'sha256':p.base.digest(dep)}])
  path=self.root/'private_manifest.json';path.write_text(json.dumps(self.manifest));return p.base.digest(path),dep
 def source(self,row):
  private=self.manifest['private_sources'][row['video_id']-1];return {k:private[k] for k in ('candidate','proposals','proposal_origin','saved_review_sha256','frame_digest','storyboard_receipt')}
 def test_balanced_unknown_selection_does_not_use_scores_duration_or_coverage(self):
  rows=copy.deepcopy(self.live)*1
  selected=p.choose(rows,set(),set(),set(),set(),4);self.assertEqual(len({r['channel'] for r in selected}),4)
  changed=copy.deepcopy(rows)
  for r in changed:r.update(duration=1e9,score=-999,kept_coverage=1.,fitted_probability=.99)
  self.assertEqual([r['video_id'] for r in selected],[r['video_id'] for r in p.choose(changed,set(),set(),set(),set(),4)])
  extra=dict(copy.deepcopy(rows[0]),video_id=99);self.assertEqual(len(p.choose(rows+[extra],set(),set(),set(),set(),4)),4)
  with self.assertRaises(ValueError):p.choose(rows,set(),set(),set(),set(),5)
 def test_known_clarified_reserved_previous_and_explicit_whole_excluded(self):
  cases=[({'creator0'},set(),set(),set()),(set(),{p.source_key({'video_id':1,'analyzed_at':self.live[0]['analyzed_at']})},set(),set()),(set(),set(),{1},set()),(set(),set(),set(),{p.source_key({'video_id':1,'analyzed_at':self.live[0]['analyzed_at']})})]
  for reserved,known,clarified,asked in cases:
   self.assertNotIn(1,[r['video_id'] for r in p.choose(self.live,reserved,known,clarified,asked,3)])
  for field in ('skip','whole'):
   rows=copy.deepcopy(self.live)
   if field=='skip':rows[0]['clips']=[{'keep':False}]
   else:rows[0]['clips']=[{'keep':True,'reasons':['keep_whole']}]
   self.assertNotIn(1,[r['video_id'] for r in p.choose(rows,set(),set(),set(),set(),3)])
 def test_historical_binding_preserves_known_and_clarified_unknown(self):
  private={'policy':'whole-recording-current-review-v1','recordings':{'a':{'video_id':1,'analyzed_at':'2026-10-10T00:00:00+00:00'},'b':{'video_id':2,'analyzed_at':'2026-10-10T00:00:01Z'}}};elig={'policy':private['policy'],'private_binding_sha256':p.digest(private),'rows':[{'row':'a','y':1,'near_full_edited_clips_still_unknown':False},{'row':'b','y':None,'near_full_edited_clips_still_unknown':True}]};before=copy.deepcopy((elig,private))
  self.assertEqual(p.history_exclusions(elig,private),({(1,'2026-10-10T00:00:00.000000+00:00')},{2}));self.assertEqual((elig,private),before)
  elig['private_binding_sha256']='bad'
  with self.assertRaises(ValueError):p.history_exclusions(elig,private)
 def test_saved_choices_are_not_read_before_creator_screen(self):
  class Local:
   def __init__(self):self.ids=None
   def execute(self,q,args):
    self.ids=args[0];return Cursor([(2,'2026-10-10T00:00:00Z',[],[])]) if q.startswith('SELECT video_id') else Cursor()
  pg=Local();rows=[dict(self.live[0],clips='must-not-read'),self.live[1]];out=p.attach_reviews(pg,rows,{'creator0'});self.assertEqual(pg.ids,[2]);self.assertEqual(len(out),1)
 def test_legacy_recovery_uses_only_exact_original_detector_bounds(self):
  row=dict(copy.deepcopy(self.live[0]),duration=20.,proposals=None,clips=[{'id':'c','keep':True,'start_seconds':7.,'end_seconds':9.,'detected':{'start_seconds':0.,'end_seconds':20.}}])
  f={'id':1,'video_id':1,'analyzed_at':row['analyzed_at'],'clip_id':'c','channel':'creator0','added':False,'detected_start':0.,'detected_end':20.,'score':2.27}
  props,receipt=p.recover_proposals(row,[f]);self.assertEqual(props[0]['start_seconds'],0.);self.assertEqual(props[0]['end_seconds'],20.);self.assertEqual(props[0]['score'],2.27)
  self.assertEqual(receipt['receipts'][0]['origin'],'feedback.detected_bounds')
  f['detected_start']=f['detected_end']=None;self.assertEqual(p.recover_proposals(row,[f])[1]['receipts'][0]['origin'],'saved_clip.detected_bounds')
  f['detected_start']=1.
  with self.assertRaises(ValueError):p.recover_proposals(row,[f])
  f['detected_start']=None
  row['clips'][0].pop('detected')
  with self.assertRaises(ValueError):p.recover_proposals(row,[f])
  row['clips'][0]['detected']={'start_seconds':0.,'end_seconds':20.};f['analyzed_at']='2026-10-09T00:00:00Z'
  with self.assertRaises(ValueError):p.recover_proposals(row,[f])
 def test_exact_manifest_and_checkpoint_with_zero_original_proposals(self):
  p.validate_manifest(self.manifest,set(),self.receipt);p.check_checkpoints(self.manifest,self.root)
  for change in ('reserved','range','identity','width','duplicate_creator','index','provenance'):
   value=copy.deepcopy(self.manifest)
   if change=='reserved':value['rows'][0]['context']['reserved_fine_holdout']=True
   elif change=='range':value['rows'][0]['end_seconds']=19
   elif change=='identity':value['private_sources'][0]['numeric_identity']['analyzed_at']='changed'
   elif change=='width':value['private_sources'][0]['visual_mean'].pop()
   elif change=='duplicate_creator':value['private_sources'][1]['candidate']['channel_key']='creator0'
   elif change=='index':value['private_sources'][0]['candidate']['index']['frame_count']=True
   else:value['private_sources'][0]['candidate']['source_fingerprint']['path_identity_sha256']='bad'
   with self.subTest(change=change),self.assertRaises(ValueError):p.validate_manifest(value,set(),self.receipt)
 def test_load_contract_binds_helpers_sha_features_and_real_holdout_return(self):
  sha,dep=self.frozen()
  with patch.object(p.safe.previous,'holdout_contract',return_value=(set(),self.receipt)),patch.object(p,'dependencies',return_value=[dep]),patch.object(p,'historical_exclusions',return_value=(set(),set())):
   value,reserved,receipt=p.load_contract(self.root,sha);self.assertEqual(receipt,self.receipt);self.assertEqual(value,self.manifest)
   dep.write_text('changed')
   with self.assertRaises(ValueError):p.load_contract(self.root,sha)
  with self.assertRaises(ValueError):p.load_contract(self.root,'0'*64)
 def test_checkpoint_tamper_feature_drift_and_decompression_bound(self):
  value=copy.deepcopy(self.manifest);value['private_sources'][0]['features'][0]+=1
  with self.assertRaises(ValueError):p.check_checkpoints(value,self.root)
  with patch.object(p,'MAX_TOTAL',1),self.assertRaises(ValueError):p.check_checkpoints(self.manifest,self.root)
  q=self.manifest['private_sources'][0];path=Path(q['frame_checkpoint']['path']);np.savez(path,t=np.arange(4)*5.,v=np.ones((4,1152)),identity_sha256='bad');q['frame_checkpoint']['sha256']=p.base.digest(path)
  with self.assertRaises(ValueError):p.check_checkpoints(self.manifest,self.root)
 def test_all_four_answers_create_only_explicit_whole_targets(self):
  out=i.checked_answers(self.tasks,self.manifest,set());self.assertEqual((out['positive'],out['negative'],out['unknown']),(1,2,1))
  for row in out['whole_rows']:
   for name in ('clip_current_acceptability_y','cut_gold','permanent_storage_y','future_replacement_y'):self.assertIsNone(row[name])
  for change in ('detail','reason','wrong_answer','reserved','stale'):
   tasks=copy.deepcopy(self.tasks)
   if change=='detail':tasks[0]['detail']={'best':{}}
   elif change=='reason':tasks[0]['reasons']=['keep_whole']
   elif change=='wrong_answer':tasks[0]['answer']='a'
   elif change=='reserved':tasks[0]['context']['reserved_fine_holdout']=True
   else:tasks[0]['answered_at']=None
   with self.subTest(change=change),self.assertRaises(ValueError):i.checked_answers(tasks,self.manifest,set())
 def test_waiting_suppresses_partial_target_snapshot(self):
  self.tasks[1].update(answer=None,answered_at=None)
  with patch.object(p,'load_contract',return_value=(self.manifest,set(),self.receipt)),patch.object(i,'immutable_write') as write:out=i.intake(self.root,'fixture',lambda _:self.tasks);write.assert_not_called()
  self.assertEqual(out['pending'],1);self.assertNotIn('whole_rows',out)
 def test_metadata_drift_prevents_any_outcome_query(self):
  pg=PG()
  with self.assertRaises(ValueError):i.fetch_tasks(pg,self.manifest)
  self.assertFalse(any('answer,reasons' in q for q in pg.sql))
 def test_live_drift_or_known_sources_block_before_insert(self):
  pg=PG()
  with patch.object(p,'load_metadata',return_value=self.live),patch.object(p,'attach_reviews',side_effect=lambda pg,rows,reserved:rows),patch.object(p,'historical_exclusions',return_value=(set(),set())),patch.object(p,'source',side_effect=lambda r:dict(self.source(r),frame_digest='drift')),self.assertRaises(ValueError):a.execute(pg,self.manifest,set(),self.receipt,'fixture',True)
  self.assertFalse(any(q.startswith('INSERT') for q in pg.sql))
  with patch.object(p,'historical_exclusions',return_value=({p.source_key({'video_id':1,'analyzed_at':self.live[0]['analyzed_at']})},set())),self.assertRaises(ValueError):a.validate_live(self.manifest,self.live,set(),self.receipt)
 def test_apply_is_atomic_idempotent_and_preserves_answers(self):
  before=copy.deepcopy(self.tasks);a.existing_match(self.tasks,self.manifest['rows']);self.assertEqual(before,self.tasks)
  with self.assertRaises(ValueError):a.existing_match(self.tasks[:1],self.manifest['rows'])
  for existing in ([],self.tasks):
   pg=PG(existing)
   with patch.object(p,'load_metadata',return_value=self.live),patch.object(p,'attach_reviews',side_effect=lambda pg,rows,reserved:rows),patch.object(p,'historical_exclusions',return_value=(set(),set())),patch.object(p,'source',side_effect=self.source):out=a.execute(pg,self.manifest,set(),self.receipt,'fixture',True)
   self.assertEqual(out['inserted'],0 if existing else 4);self.assertIn('LOCK TABLE recording_label_tasks IN SHARE ROW EXCLUSIVE MODE',pg.sql);self.assertFalse(any(q.startswith(('UPDATE','DELETE')) for q in pg.sql))
  for pg in (PG(changed=True),PG(count=0)):
   with patch.object(p,'load_metadata',return_value=self.live),patch.object(p,'attach_reviews',side_effect=lambda pg,rows,reserved:rows),patch.object(p,'historical_exclusions',return_value=(set(),set())),patch.object(p,'source',side_effect=self.source),self.assertRaises(ValueError):a.execute(pg,self.manifest,set(),self.receipt,'fixture',True)
 def test_versioned_snapshot_private_immutable_and_hash_exact(self):
  with patch.object(p,'load_contract',return_value=(self.manifest,set(),self.receipt)):
   first=i.intake(self.root,'fixture',lambda _:self.tasks);path=Path(first['snapshot_path']);data=path.read_bytes();self.assertEqual(first['snapshot_sha256'],p.base.digest(path));self.assertEqual(path.stat().st_mode&0o777,0o600)
   self.tasks[0]['answered_at']+=datetime.timedelta(seconds=1);second=i.intake(self.root,'fixture',lambda _:self.tasks);self.assertNotEqual(first['snapshot_sha256'],second['snapshot_sha256']);self.assertEqual(path.read_bytes(),data)

if __name__=='__main__':unittest.main()
