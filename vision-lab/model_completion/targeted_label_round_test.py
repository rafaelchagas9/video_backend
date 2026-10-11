"""Disposable task-round tests: no actual database/recordings or queue writes."""
import copy,datetime,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import targeted_label_round as s


class Round(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.source=self.root/'neutral.mp4';self.source.write_bytes(b'disposable');self.vtt=self.root/'neutral.vtt';self.vtt.write_text('fixture')
  at=datetime.datetime(2026,10,10,10);self.rows={}
  for i,pair in enumerate(s.PAIRS):
   for j,fid in enumerate(pair):self.rows[fid]={'feedback_id':fid,'video_id':i*2+j+1,'clip_id':str(fid),'channel':f'channel{i}','analyzed_at':at,'start':20.,'end':400.,'original_start':0.,'original_end':500.,'score':.8,'file_path':str(self.source),'file_name':'neutral.mp4','duration':600.,'saved_at':at,'review_generation':at,'model_revision':s.VISUAL_PIN,'frame_count':120,'actual_frame_count':120,'interval_seconds':5.,'storyboard_generated_at':at,'storyboard_at':at,'indexed_at':at,'vtt_path':str(self.vtt),'last_frame_timestamp':595.,'detector':'fixture','verdict':'keep','added':False,'merged_into':None,'label_type':'triage'}
 def tearDown(self):self.tmp.cleanup()
 def test_fixed_pairs_order_randomization_original_bounds_and_no_cap(self):
  manifest=s.make_manifest(self.rows,[]);self.assertEqual(manifest,s.make_manifest(self.rows,[]));self.assertEqual(len(manifest['rows']),8);self.assertEqual(len(set(manifest['holdout_channels'])),4)
  self.assertEqual([r['position'] for r in manifest['rows']],list(range(8)))
  for row,pair in zip(manifest['rows'],s.PAIRS):
   self.assertEqual({row['context'][k]['feedback_id'] for k in ('a','b')},set(pair))
   for k in ('a','b'):
    side=row['context'][k];self.assertEqual(side['clip'],[0.,500.]);self.assertEqual(side['best'],[20.,400.]);self.assertEqual(side['snippet'],[202.5,217.5]);self.assertEqual(row['context']['reserved_fine_holdout'],row['position']>=4);self.assertIsInstance(side['source_fingerprint']['mtime_ns'],str)
  self.assertEqual(json.loads(json.dumps(manifest)),manifest);self.assertEqual(len(manifest['training_channels']),4);self.assertFalse(set(manifest['training_channels'])&set(manifest['holdout_channels']))
 def test_invalid_source_generation_bounds_index_storyboard_failclosed(self):
  r=self.rows[284]
  for key,value in [('review_generation',datetime.datetime(2026,10,9)),('duration',300.),('end',501.),('model_revision','other'),('actual_frame_count',119),('storyboard_at',datetime.datetime(2026,10,9)),('verdict','skip'),('label_type','other'),('added',True),('merged_into','x')]:
   with self.subTest(key=key),self.assertRaises(ValueError):s.side(dict(r,**{key:value}))
  self.source.unlink()
  with self.assertRaisesRegex(ValueError,'playable'):s.side(r)
 def test_storyboard_identity_matches_existing_js_millisecond_precision(self):
  r=self.rows[284];r['storyboard_at']=r['storyboard_generated_at']+datetime.timedelta(microseconds=932);self.assertEqual(s.side(r)['index']['storyboard_generated_at'],s.stamp(r['storyboard_at']))
  with self.assertRaisesRegex(ValueError,'generation'):s.side(dict(r,storyboard_at=r['storyboard_generated_at']+datetime.timedelta(milliseconds=1)))
 def test_existing_pairs_sides_and_channels_cannot_be_redrawn(self):
  context={'a':{'feedback_id':284},'b':{'feedback_id':999}}
  with self.assertRaisesRegex(ValueError,'already asked'):s.make_manifest(self.rows,[{'answer':None,'channel':'other','context':context}])
  with self.assertRaisesRegex(ValueError,'new fine'):s.make_manifest(self.rows,[{'answer':'both','channel':'@CHANNEL0','context':{}}])
  rows=copy.deepcopy(self.rows);rows[696]['channel']=rows[697]['channel']='channel0'
  with self.assertRaisesRegex(ValueError,'new fine'):s.make_manifest(rows,[])
 def test_frozen_manifest_is_immutable(self):
  path=self.root/'private.json';manifest=s.make_manifest(self.rows,[]);s.save_frozen(path,manifest);before=path.read_bytes();s.save_frozen(path,manifest);self.assertEqual(before,path.read_bytes());self.assertEqual(path.stat().st_mode&511,384)
  with self.assertRaisesRegex(ValueError,'Frozen'):s.save_frozen(path,dict(manifest,rows=[]))
 def test_idempotent_existing_match_preserves_answer_and_rejects_partial(self):
  planned=s.make_manifest(self.rows,[])['rows'];existing=[dict(row,id=i,answer='a' if i%2 else None) for i,row in enumerate(planned)];before=copy.deepcopy(existing);self.assertTrue(s.existing_match(existing,planned));self.assertEqual(existing,before)
  with self.assertRaisesRegex(ValueError,'incomplete'):s.existing_match(existing[:7],planned)
  changed=copy.deepcopy(existing);changed[0]['context']['a']['best'][0]+=1
  with self.assertRaisesRegex(ValueError,'differs'):s.existing_match(changed,planned)
 def test_existing_replay_rejects_valid_changed_source_and_index(self):
  planned=s.make_manifest(self.rows,[])['rows'];s.validate_replay(self.rows,planned)
  changed=copy.deepcopy(self.rows);changed[284]['indexed_at']+=datetime.timedelta(seconds=1)
  with self.assertRaisesRegex(ValueError,'live source'):s.validate_replay(changed,planned)
  self.source.write_bytes(b'still playable but overwritten')
  with self.assertRaisesRegex(ValueError,'live source'):s.validate_replay(self.rows,planned)
 def test_source_overwrite_between_prepare_and_insert_rolls_back_before_writes(self):
  manifest=s.make_manifest(self.rows,[]);path=self.root/'private_manifest.json';s.save_frozen(path,manifest);reviewed=s.digest(path);self.source.write_bytes(b'disposable overwritten')
  class Cursor:
   def fetchall(self):return []
  class Connection:
   def __init__(self):self.inserts=[]
   def __enter__(self):return self
   def __exit__(self,*args):return False
   def execute(self,sql,params=None):
    if sql.startswith('INSERT'):self.inserts.append((sql,params))
    return Cursor()
  connection=Connection()
  with patch('psycopg.connect',return_value=connection),patch.object(s,'pg_config',return_value='unused'),patch.object(s,'load_rows',return_value=self.rows),patch.object(s,'tasks',return_value=[]):
   with self.assertRaisesRegex(ValueError,'changed since review'):s.insert(self.root,reviewed)
  self.assertEqual(connection.inserts,[])
 def test_hash_guard_precedes_any_database_connection(self):
  path=self.root/'private_manifest.json';s.save_frozen(path,s.make_manifest(self.rows,[]))
  with patch('psycopg.connect') as connect:
   with self.assertRaisesRegex(ValueError,'hash differs'):s.insert(self.root,'0'*64)
   connect.assert_not_called()

if __name__=='__main__':unittest.main()
