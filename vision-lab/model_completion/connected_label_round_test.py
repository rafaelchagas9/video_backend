"""Disposable metadata fixtures only: no library, database, media or queue writes."""
import collections,copy,datetime,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import connected_label_round as s

class Connected(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);source=self.root/'neutral.mp4';source.write_bytes(b'disposable');vtt=self.root/'neutral.vtt';vtt.write_text('fixture');at=datetime.datetime(2026,10,10,10)
  self.rows={}
  for channel in range(10):
   for j in range(2):
    fid=100+channel*2+j;span=40+channel*20+j*10
    self.rows[fid]={'feedback_id':fid,'video_id':fid,'clip_id':str(fid),'channel':f'channel{channel}','analyzed_at':at,'start':20.,'end':20.+span,'original_start':0.,'original_end':500.,'score':.4+channel*.04,'file_path':str(source),'file_name':'neutral.mp4','duration':600.,'saved_at':at,'review_generation':at,'model_revision':s.base.VISUAL_PIN,'frame_count':120,'actual_frame_count':120,'interval_seconds':5.,'storyboard_generated_at':at,'storyboard_at':at,'indexed_at':at,'vtt_path':str(vtt),'last_frame_timestamp':595.,'detector':'fixture','verdict':'keep','added':False,'merged_into':None,'label_type':'triage','is_available':True}
  self.reserved={'channel8','channel9'};self.receipt={'synthetic':True}
 def tearDown(self):self.tmp.cleanup()
 def manifest(self,tasks=()):return s.make_manifest(self.rows,list(tasks),self.reserved,self.receipt)
 def test_graph_scope_roles_connected_cap_unique_deterministic(self):
  manifest=self.manifest();self.assertEqual(manifest,self.manifest());rows=manifest['rows'];self.assertEqual(len(rows),20)
  scopes=collections.Counter(r['context']['comparison_scope'] for r in rows);self.assertEqual(scopes,{'cross_channel':12,'same_channel':8})
  seen=set();exposure=collections.Counter();edges=collections.defaultdict(set)
  for row in rows:
   a,b=(row['context'][k] for k in ('a','b'));pair=tuple(sorted((a['feedback_id'],b['feedback_id'])));self.assertNotIn(pair,seen);seen.add(pair);exposure.update(pair)
   self.assertFalse(row['context']['reserved_fine_holdout']);self.assertEqual(row['context']['fine_data_role'],'training')
   self.assertFalse({a['channel_key'],b['channel_key']}&self.reserved)
   for value in (a,b):self.assertEqual(value['clip'],[0.,500.]);self.assertEqual(value['snippet'][1]-value['snippet'][0],15)
   if row['context']['comparison_scope']=='cross_channel':
    self.assertIsNone(row['channel']);self.assertNotEqual(a['channel_key'],b['channel_key']);edges[a['channel_key']].add(b['channel_key']);edges[b['channel_key']].add(a['channel_key'])
   else:self.assertEqual(a['channel_key'],b['channel_key']);self.assertNotEqual(a['video_id'],b['video_id'])
  self.assertEqual(len(seen),20);self.assertEqual(max(exposure.values()),4);self.assertEqual(len(exposure),16)
  reached=set();todo=[next(iter(edges))]
  while todo:
   key=todo.pop()
   if key not in reached:reached.add(key);todo.extend(edges[key]-reached)
  self.assertEqual(len(reached),8);self.assertTrue(all(len(v)==3 for v in edges.values()))
 def test_exact_refinement_reused_but_stale_provenance_not_substituted(self):
  row=self.rows[100];side=s.base.side(row);task={'id':7,'batch':'old','answer':'a','channel':row['channel'],'context':{'a':side,'b':{'feedback_id':999}},'detail':{'best':{'a':{'start_seconds':25.,'end_seconds':55.,'accepted':False}}},'answered_at':datetime.datetime(2026,10,10,11)}
  got=s.side(row,[task]);self.assertEqual(got['best'],[25.,55.]);self.assertEqual(got['initial_best_source'],'existing_confirmed_final_cut');self.assertFalse(got['final_cut_receipt']['accepted_offered_edges'])
  for key,value in [('analyzed_at','older'),('index',{}),('source_fingerprint',{}),('clip',[1.,500.])]:
   stale=copy.deepcopy(task);stale['context']['a'][key]=value;self.assertEqual(s.side(row,[stale])['initial_best_source'],'existing_saved_coarse_range')
  other=copy.deepcopy(task);other['answer']='b';self.assertEqual(s.side(row,[other])['best'],[20.,60.])
 def test_exposed_anchor_excluded_and_pairs_never_repeated(self):
  # Ten channels allow one earlier-exposed creator to be excluded without losing feasibility.
  self.reserved={'channel9'};tasks=[{'id':1,'batch':'old','answer':None,'channel':'channel0','context':{'a':{'feedback_id':100},'b':{'feedback_id':101}}}]
  manifest=self.manifest(tasks);newpairs={tuple(sorted(row['context'][k]['feedback_id'] for k in ('a','b'))) for row in manifest['rows']};self.assertNotIn((100,101),newpairs)
  self.assertNotIn('channel0',{row['context'][k]['channel_key'] for row in manifest['rows'] for k in ('a','b')})
 def test_source_catalog_generation_and_reserved_eligibility_failclosed(self):
  for key,value in [('is_available',False),('review_generation',datetime.datetime(2026,10,9)),('model_revision','other'),('duration',10.)]:
   with self.subTest(key=key),self.assertRaises(ValueError):s.side(dict(self.rows[100],**{key:value}),[])
  rows=copy.deepcopy(self.rows);rows[100]['is_available']=False
  with self.assertRaisesRegex(ValueError,'Fewer than eight'):s.make_manifest(rows,[],self.reserved,self.receipt)
 def test_live_replay_validates_generation_index_source_and_final_cut(self):
  manifest=self.manifest();s.validate_live(manifest,self.rows,[],self.reserved,self.receipt)
  fid=manifest['rows'][0]['context']['a']['feedback_id'];changed=copy.deepcopy(self.rows);changed[fid]['indexed_at']+=datetime.timedelta(seconds=1)
  with self.assertRaisesRegex(ValueError,'live source'):s.validate_live(manifest,changed,[],self.reserved,self.receipt)
  Path(self.rows[fid]['file_path']).write_bytes(b'changed source')
  with self.assertRaisesRegex(ValueError,'live source'):s.validate_live(manifest,self.rows,[],self.reserved,self.receipt)
 def test_prior_pair_and_exposure_detected_before_insert(self):
  manifest=self.manifest();row=manifest['rows'][0];task={'batch':'other','context':row['context']}
  with self.assertRaisesRegex(ValueError,'duplicate'):s.validate_live(manifest,self.rows,[task],self.reserved,self.receipt)
 def test_frozen_manifest_and_reviewed_hash_guard_before_connection(self):
  manifest=self.manifest();path=self.root/'private_manifest.json';s.base.save_frozen(path,manifest);before=path.read_bytes();s.base.save_frozen(path,manifest);self.assertEqual(before,path.read_bytes())
  with self.assertRaises(ValueError):s.base.save_frozen(path,dict(manifest,graph={}))
  with patch('psycopg.connect') as connect:
   with self.assertRaisesRegex(ValueError,'hash differs'):s.insert(self.root,'0'*64)
   connect.assert_not_called()
 def test_earlier_frozen_holdout_manifest_dependency_required(self):
  with patch.object(s.base,'OUT',self.root):
   path=self.root/'private_manifest.json';path.write_text('{}')
   with self.assertRaisesRegex(ValueError,'checksum'):s.holdout_contract()

if __name__=='__main__':unittest.main()
