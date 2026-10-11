"""Numeric/metadata-only answer intake fixtures; no live database or fitting."""
import copy,datetime,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import connected_answer_intake as s
import connected_label_round_test as fixtures

class Intake(unittest.TestCase):
 def setUp(self):
  self.fixture=fixtures.Connected();self.fixture.setUp();self.root=self.fixture.root;self.manifest=self.fixture.manifest();self.tasks=[]
  for i,row in enumerate(self.manifest['rows']):
   answer=('a','b','both','neither')[i%4];chosen=('a','b') if answer=='both' else () if answer=='neither' else (answer,);cuts={key:{'start_seconds':row['context'][key]['best'][0],'end_seconds':row['context'][key]['best'][1],'accepted':False} for key in chosen}
   self.tasks.append(dict(copy.deepcopy(row),id=i+1000,answer=answer,detail={'best':cuts},reasons=[],answered_at=datetime.datetime(2026,10,10,12)))
 def tearDown(self):self.fixture.tearDown()
 def test_complete_current_labels_cuts_and_exact_cross_creator_groups(self):
  result=s.checked_answers(self.tasks,self.manifest);self.assertEqual(result['status'],'complete');rows=result['current_candidate_rows'];self.assertEqual(len(rows),40);self.assertEqual(sum(r['y'] for r in rows),30);self.assertEqual(len(result['confirmed_cut_gold']),20);self.assertEqual(len(result['training_pairs']),20);self.assertEqual(result['label_summary']['ranking_pairs'],10)
  self.assertTrue(all(r['future_replacement_y'] is None and r['permanent_storage_y'] is None for r in rows))
  for pair in result['training_pairs']:
   if pair['comparison_scope']=='cross_channel':self.assertEqual(len({r['group'] for r in pair['rows']}),2);self.assertEqual(len(pair['creators']),2)
  loser=next(r for r in rows if r['ranking_y']==0);self.assertEqual(loser['y'],1);self.assertIsNone(loser['cut_gold'])
 def test_pair_folds_exclude_if_either_creator_held_before_transform(self):
  rows=s.checked_answers(self.tasks,self.manifest)['current_candidate_rows'];cross=next(pair for pair in s.pair_records(rows) if pair['comparison_scope']=='cross_channel')
  for creator in cross['creators']:
   kept=s.training_pairs_excluding_creators(rows,{creator});self.assertNotIn(cross['task_id'],{p['task_id'] for p in kept});self.assertTrue(all(creator not in p['creators'] for p in kept));self.assertTrue(all(len(p['rows'])==2 for p in kept))
  reserved=copy.deepcopy(rows);reserved[0]['reserved_fine_holdout']=True
  with self.assertRaises(s.fl.ReservedFineHoldoutError):s.training_pairs_excluding_creators(reserved,set())
  partial=rows[:-1]
  with self.assertRaisesRegex(ValueError,'Complete two-sided'):s.pair_records(partial)
 def test_strict_pair_metrics_keep_cross_creators_and_never_evaluate_half_pairs(self):
  rows=s.checked_answers(self.tasks,self.manifest)['current_candidate_rows'];scores=[float(r['ranking_y']) if r['ranking_y'] is not None else .5 for r in rows]
  report=s.strict_pair_metrics(rows,scores);self.assertEqual(report['strict_pairs'],10);self.assertEqual(report['correct_pairs'],10);self.assertEqual(report['cross_creator_strict_pairs']+report['same_creator_strict_pairs'],10)
  self.assertGreater(report['cross_creator_strict_pairs'],0);self.assertGreater(report['same_creator_strict_pairs'],0)
  self.assertEqual(s.strict_pair_metrics(rows,[.5]*len(rows))['tied_pairs'],10)
  held=next(r['group'] for r in rows if r['comparison_scope']=='cross_channel');kept=[r for p in s.training_pairs_excluding_creators(rows,{held}) for r in p['rows']]
  self.assertLess(s.strict_pair_metrics(kept,[float(r['ranking_y']) if r['ranking_y'] is not None else .5 for r in kept])['strict_pairs'],10)
  with self.assertRaisesRegex(ValueError,'Complete two-sided'):s.strict_pair_metrics(rows[:-1],scores[:-1])
  with self.assertRaisesRegex(ValueError,'alignment'):s.strict_pair_metrics(rows,scores[:-1])
  bad=scores.copy();bad[0]=float('nan')
  with self.assertRaises(ValueError):s.strict_pair_metrics(rows,bad)
  changed=copy.deepcopy(rows);changed[0]['group']='fake-shared-creator'
  with self.assertRaisesRegex(ValueError,'Exact per-side'):s.strict_pair_metrics(changed,scores)
 def test_partial_wait_counts_only_no_snapshot_directory(self):
  self.tasks[-1].update(answer=None,detail=None,answered_at=None)
  with patch.object(s,'load_contract',return_value=self.manifest),patch.object(s,'write_snapshot') as write:
   result=s.intake(self.root,lambda:self.tasks);write.assert_not_called()
  self.assertEqual(result['status'],'waiting');self.assertEqual(result['answered'],19);self.assertNotIn('current_candidate_rows',result);self.assertNotIn('tasks',result);self.assertFalse((self.root/'answer-snapshots').exists())
 def test_context_role_channel_generation_and_missing_task_rejected(self):
  for field,value in [('reserved_fine_holdout',True),('fine_data_role','holdout'),('comparison_scope','same_channel')]:
   tasks=copy.deepcopy(self.tasks);tasks[0]['context'][field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
  for field,value in [('analyzed_at','older'),('channel_key','other'),('index',{})]:
   tasks=copy.deepcopy(self.tasks);tasks[0]['context']['a'][field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
  with self.assertRaises(ValueError):s.checked_answers(self.tasks[:-1],self.manifest)
 def test_selected_cut_exact_keys_bounds_bools_and_timestamp(self):
  for change in [{'accepted':'false'},{'start_seconds':float('nan')},{'end_seconds':10000},{'start_seconds':True},{'unexpected':1}]:
   tasks=copy.deepcopy(self.tasks);tasks[0]['detail']['best']['a'].update(change)
   with self.subTest(change=change),self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
  tasks=copy.deepcopy(self.tasks);tasks[0]['detail']['best']={}
  with self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
  tasks=copy.deepcopy(self.tasks);tasks[3]['detail']['best']['a']=copy.deepcopy(self.tasks[0]['detail']['best']['a'])
  with self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
  tasks=copy.deepcopy(self.tasks);tasks[0]['answered_at']='bad'
  with self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
 def test_immutable_snapshots_and_reanswered_version_retained(self):
  result=s.checked_answers(self.tasks,self.manifest);path,sha,created=s.write_snapshot(self.root,result);before=path.read_bytes();self.assertTrue(created);self.assertEqual(path.stat().st_mode&511,384)
  self.assertEqual(s.write_snapshot(self.root,result),(path,sha,False));self.tasks[0]['detail']['best']['a']['start_seconds']+=1;self.tasks[0]['answered_at']+=datetime.timedelta(seconds=1)
  other,newsha,new=s.write_snapshot(self.root,s.checked_answers(self.tasks,self.manifest));self.assertTrue(new);self.assertNotEqual(sha,newsha);self.assertEqual(path.read_bytes(),before);self.assertEqual(len(list(path.parent.glob('answers.*.json'))),2)
 def test_existing_contract_file_is_pinned_with_reserved_scope_receipt(self):
  path=self.root/'private_manifest.json';s.batch.base.save_frozen(path,self.manifest)
  with patch.object(s,'FINAL_MANIFEST_SHA256',s.batch.base.digest(path)),patch.object(s.batch,'holdout_contract',return_value=(self.fixture.reserved,self.fixture.receipt)):
   self.assertEqual(s.load_contract(self.root),self.manifest)
   changed=copy.deepcopy(self.manifest);changed['rows'][0]['context']['reserved_fine_holdout']=True;path.write_text(json.dumps(changed))
   with self.assertRaisesRegex(ValueError,'checksum'):s.load_contract(self.root)

if __name__=='__main__':unittest.main()
