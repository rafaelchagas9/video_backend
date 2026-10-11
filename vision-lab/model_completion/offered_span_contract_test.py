"""Disposable fixtures only; no real outcomes, DB connections, media or fits."""
import copy,datetime,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import offered_span_intake as s
import offered_span_apply as a

class Fixture(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.receipt={'fixture':True};self.manifest={'schema_version':1,'batch_stem':s.STEM,'batches':s.BATCHES,'holdout_dependency':self.receipt,'excluded_holdout_creators':[],'rows':[],'private_assignments':[]}
  self.source={'feedback_id':10,'video_id':100,'channel':'creator','channel_key':'creator','analyzed_at':'2026-10-10T00:00:00Z','source_fingerprint':{'size_bytes':1,'mtime_ns':'1','path_identity_sha256':'0'*64},'index':{'frame_count':401,'interval_seconds':5,'model_revision':'siglip2/so400m-patch16-256'},'detector':'{}','duration_seconds':2000.,'clip':[0.,2000.],'best':[300.,900.],'score':.8}
  identity={k:self.source[k] for k in ('video_id','analyzed_at','source_fingerprint','index')};identity.update(duration=2000.,proposals=[{'id':'c1','start':0.,'end':2000.,'score':.8}])
  frame=self.root/'frames.npz';v=np.zeros((401,1152),dtype=np.float32);v[:,0]=1;np.savez(frame,t=np.arange(401)*5.,v=v,identity_sha256=s.digest(identity));frame_receipt={'path':str(frame),'sha256':s.base.digest(frame),'identity_sha256':s.digest(identity)}
  for batch,role,rangea,rangeb in [(s.BATCHES[0],'model_vs_human',[0.,2000.],[300.,900.]),(s.BATCHES[1],'same_duration_location',[0.,600.],[1400.,2000.])]:
   def side(bounds,label):
    value={k:copy.deepcopy(self.source[k]) for k in ('feedback_id','video_id','channel','channel_key','analyzed_at','source_fingerprint','index','detector','duration_seconds')};value.update(original_range=[0.,2000.],range=bounds,best=bounds,preview_windows=s.versions.previews(bounds),version_label=label);return value
   context={'a':side(rangea,'Version A'),'b':side(rangeb,'Version B'),'target':'preferred_version_if_keep_one','reserved_fine_holdout':False,'fine_data_role':'training','blind_version_comparison':True,'acceptability_target':None,'cut_target':None}
   self.manifest['rows'].append({'kind':'version-versus','batch':batch,'position':0,'video_id':100,'start_seconds':rangea[0],'end_seconds':rangea[1],'channel':'creator','stratum':'blind-version','context':context})
   self.manifest['private_assignments'].append({'batch':batch,'position':0,'pilot_role':role,'source':copy.deepcopy(self.source),'assignments':dict(zip(('a','b'),('frozen_primary_best','current_human_approved') if role=='model_vs_human' else ('frozen_primary_location','fixed_endpoint_control'))),'predictions':{k:{'a':1.,'b':2.} for k in ('numeric','predecessor','primary')},'frame_checkpoint':copy.deepcopy(frame_receipt),'numeric_identity':copy.deepcopy(identity)})
  dependencies=[]
  for name,role in [('generator.py','generator'),('head.json','head'),('cohort.json','feature_cohort'),('source.py','source')]:
   path=self.root/name;path.write_text('{}');dependencies.append({'path':str(path),'sha256':s.base.digest(path),'role':role})
  dependencies.append({'path':str(frame),'sha256':s.base.digest(frame),'role':'frame_checkpoint'});self.manifest.update(dependencies=dependencies,generator_source_path=str(self.root/'generator.py'),source_sha256=s.base.digest(self.root/'generator.py'),consumer_sources={str(Path(s.__file__).resolve()):s.base.digest(s.__file__),str(Path(a.__file__).resolve()):s.base.digest(a.__file__)})
  self.tasks=[dict(copy.deepcopy(r),id=500+i,answer=('a','neither')[i],reasons=[],detail=None,answered_at=datetime.datetime(2026,10,10,16)) for i,r in enumerate(self.manifest['rows'])]
 def tearDown(self):self.temp.cleanup()
 def freeze(self):
  p=self.root/'private_manifest.json';p.write_text(json.dumps(self.manifest));return s.base.digest(p)
 def test_two_same_source_same_start_different_batches_are_legal(self):
  s.validate_manifest(self.manifest,set(),self.receipt);self.assertEqual(self.manifest['rows'][0]['start_seconds'],self.manifest['rows'][1]['start_seconds'])
  sha=self.freeze()
  with patch.object(s.safe.previous,'holdout_contract',return_value=(set(),self.receipt)):
   loaded,reserved,holdout=s.load_contract(self.root,sha);self.assertEqual(loaded,self.manifest);self.assertEqual(holdout,self.receipt);self.assertNotEqual(holdout,self.manifest['private_assignments'][0]['frame_checkpoint'])
   class Cursor:
    def fetchall(self):return []
    def fetchone(self):return ['same']
   class PG:
    def __init__(self):self.sql=[]
    def execute(self,q,args=()):self.sql.append(q);return Cursor()
   pg=PG()
   with patch.object(s.safe,'load_history',return_value=[]),patch.object(s.safe.previous,'load_rows',return_value={10:{}}),patch.object(s.safe.previous,'side',return_value=self.source):result=a.execute(pg,loaded,reserved,holdout,sha,False)
   self.assertEqual(result['status'],'preflight_ready_no_queue_writes');self.assertFalse(any(q.startswith(('INSERT','UPDATE','DELETE')) for q in pg.sql))
 def test_collision_duplicate_pair_and_reserved_failclosed(self):
  for change in ('slot','pair','reserved','public_score','preview','identity','prediction','control_distinct','reference'):
   value=copy.deepcopy(self.manifest)
   if change=='slot':value['rows'].append(copy.deepcopy(value['rows'][0]));value['private_assignments'].append(copy.deepcopy(value['private_assignments'][0]))
   elif change=='pair':value['rows'][1]['context']=copy.deepcopy(value['rows'][0]['context']);value['rows'][1]['end_seconds']=2000.
   elif change=='reserved':value['rows'][0]['context']['reserved_fine_holdout']=True
   elif change=='public_score':value['rows'][0]['context']['a']['score']=.8
   elif change=='preview':value['rows'][0]['context']['a']['preview_windows'][0][0]+=1
   elif change=='identity':value['private_assignments'][0]['numeric_identity']['analyzed_at']='changed'
   elif change=='prediction':value['private_assignments'][0]['predictions']['primary']['a']=float('nan')
   elif change=='reference':value['private_assignments'][0]['source']['best']=[310.,910.]
   else:
    v=value['rows'][1]['context']['b'];v.update(range=[10.,610.],best=[10.,610.],preview_windows=s.versions.previews([10.,610.]))
   with self.subTest(change=change),self.assertRaises(ValueError):s.validate_manifest(value,set(),self.receipt)
 def test_wrong_sha_changed_dependency_and_changed_consumer(self):
  sha=self.freeze()
  with self.assertRaises(ValueError):s.load_contract(self.root,'0'*64)
  with patch.object(s.safe.previous,'holdout_contract',return_value=(set(),self.receipt)):
   (self.root/'head.json').write_text('changed')
   with self.assertRaises(ValueError):s.load_contract(self.root,sha)
   (self.root/'head.json').write_text('{}');self.manifest['consumer_sources'][str(Path(a.__file__).resolve())]='0'*64;sha=self.freeze()
   with self.assertRaises(ValueError):s.load_contract(self.root,sha)
 def test_corrupted_numeric_identity_rejects_before_media(self):
  receipt=self.manifest['private_assignments'][0]['frame_checkpoint'];path=Path(receipt['path']);np.savez(path,t=np.arange(401)*5.,v=np.ones((401,1152)),identity_sha256='bad')
  newsha=s.base.digest(path)
  for p in self.manifest['private_assignments']:p['frame_checkpoint']['sha256']=newsha
  self.manifest['dependencies'][-1]['sha256']=newsha;sha=self.freeze()
  with patch.object(s.safe.previous,'holdout_contract',return_value=(set(),self.receipt)),self.assertRaises(ValueError):s.load_contract(self.root,sha)
 def test_intake_pure_preferences_and_no_cuts(self):
  out=s.checked_answers(self.tasks,self.manifest);self.assertEqual(out['strict_pairs'],1);self.assertEqual(out['abstained'],1)
  for row in out['preference_rows']:self.assertIsNone(row['absolute_y']);self.assertIsNone(row['cut_gold']);self.assertEqual(row['permanent_storage_worth'],'unknown')
  bad=copy.deepcopy(self.tasks);bad[0]['detail']={'best':{}}
  with self.assertRaises(ValueError):s.checked_answers(bad,self.manifest)
 def test_waiting_suppresses_snapshot_and_labels(self):
  self.tasks[1].update(answer=None,answered_at=None)
  with patch.object(s,'load_contract',return_value=(self.manifest,set(),self.receipt)),patch.object(s,'write_snapshot') as write:
   out=s.intake(self.root,'x',lambda _:self.tasks);write.assert_not_called();self.assertNotIn('preference_rows',out);self.assertEqual(out['pending'],1)
 def test_snapshots_immutable_reanswer_private(self):
  payload=s.checked_answers(self.tasks,self.manifest);path,sha,_=s.write_snapshot(self.root,payload,'x');before=path.read_bytes();self.tasks[0]['answered_at']+=datetime.timedelta(seconds=1);new=s.write_snapshot(self.root,s.checked_answers(self.tasks,self.manifest),'x')
  self.assertNotEqual(new[1],sha);self.assertEqual(path.read_bytes(),before);self.assertEqual(path.stat().st_mode&0o777,0o600)
 def test_viewing_context_does_not_invent_completion(self):
  seen={'a':{'preview_started':[0,1],'preview_completed':[0],'full_opened':True,'full_completed':False}}
  self.tasks[0]['detail']={'viewing':seen};self.assertEqual(s.checked_answers(self.tasks,self.manifest)['preference_rows'][0]['viewing'],seen)
  for bad in [{'a':dict(seen['a'],preview_completed=[2])},{'a':dict(seen['a'],full_opened=False,full_completed=True)}]:
   with self.assertRaises(ValueError):s.viewing_context({'viewing':bad})
 def test_metadata_drift_blocks_outcome_query(self):
  class Cursor:
   def fetchall(self):return []
  class PG:
   def __init__(self):self.sql=[]
   def execute(self,q,args=()):self.sql.append(q);return Cursor()
  pg=PG()
  with self.assertRaises(ValueError):s.fetch_tasks(pg,self.manifest)
  self.assertFalse(any('answer,reasons' in q for q in pg.sql))
 def test_live_source_drift_or_duplicate_blocks_insert(self):
  class Cursor:
   def fetchall(self):return []
   def fetchone(self):return ['same']
  class PG:
   def __init__(self):self.sql=[]
   def execute(self,q,args=()):self.sql.append(q);return Cursor()
  pg=PG()
  with patch.object(s.safe,'load_history',return_value=[]),patch.object(s.safe.previous,'load_rows',return_value={10:{}}),patch.object(s.safe.previous,'side',return_value=dict(self.source,analyzed_at='drift')),self.assertRaises(ValueError):a.execute(pg,self.manifest,set(),self.receipt,'x',True)
  self.assertFalse(any(q.startswith(('INSERT','UPDATE','DELETE')) for q in pg.sql))
  old=[dict(kind='version-versus',batch='old',context=self.manifest['rows'][0]['context'])]
  with patch.object(s.safe.previous,'side',return_value=self.source),self.assertRaises(ValueError):a.validate_live(self.manifest,{10:{}},old,set(),self.receipt)
 def test_idempotent_existing_and_atomic_count_protections(self):
  existing=copy.deepcopy(self.tasks);before=copy.deepcopy(existing);a.existing_match(existing,self.manifest['rows']);self.assertEqual(before,existing)
  with self.assertRaises(ValueError):a.existing_match(existing[:1],self.manifest['rows'])
  class Cursor:
   rowcount=1
   def __init__(self,rows=None,hash='same'):self.rows=rows or [];self.hash=hash
   def fetchall(self):return self.rows
   def fetchone(self):return [self.hash]
  class PG:
   def __init__(self,existing=(),change=False):self.sql=[];self.existing=existing;self.hashes=0;self.change=change
   def execute(self,q,args=()):
    self.sql.append(q)
    if q.startswith('SELECT md5'):self.hashes+=1;return Cursor(hash='changed' if self.change and self.hashes==2 else 'same')
    if q.startswith('SELECT kind'):return Cursor([[r[k] for k in s.FIELDS] for r in self.existing])
    return Cursor()
  for existing in ((),self.tasks):
   pg=PG(existing)
   with patch.object(s.safe,'load_history',return_value=[]),patch.object(s.safe.previous,'load_rows',return_value={10:{}}),patch.object(s.safe.previous,'side',return_value=self.source):out=a.execute(pg,self.manifest,set(),self.receipt,'x',True)
   self.assertEqual(out['inserted'],0 if existing else 2);self.assertFalse(any(q.startswith(('UPDATE','DELETE')) for q in pg.sql));self.assertIn('LOCK TABLE recording_label_tasks IN SHARE ROW EXCLUSIVE MODE',pg.sql)
  pg=PG(change=True)
  with patch.object(s.safe,'load_history',return_value=[]),patch.object(s.safe.previous,'load_rows',return_value={10:{}}),patch.object(s.safe.previous,'side',return_value=self.source),self.assertRaises(ValueError):a.execute(pg,self.manifest,set(),self.receipt,'x',True)

if __name__=='__main__':unittest.main()
