"""Disposable diversity intake fixtures; no model, live library or queue writes."""
import copy,datetime,json,unittest
from unittest.mock import patch
import diversity_answer_intake as s
import creator_expansion_round_test as fixtures

class Intake(unittest.TestCase):
 def setUp(self):
  self.fixture=fixtures.Expansion();self.fixture.setUp();self.root=self.fixture.fixture.root;self.manifest=self.fixture.value();self.tasks=[]
  for i,row in enumerate(self.manifest['rows']):
   answer=('a','b','both','neither')[i%4];chosen=('a','b') if answer=='both' else () if answer=='neither' else (answer,);cuts={key:{'start_seconds':row['context'][key]['best'][0],'end_seconds':row['context'][key]['best'][1],'accepted':True} for key in chosen}
   self.tasks.append(dict(copy.deepcopy(row),id=2000+i,answer=answer,detail={'best':cuts},reasons=[],answered_at=datetime.datetime(2026,10,10,14)))
 def tearDown(self):self.fixture.tearDown()
 def test_complete_neutral_audit_semantics_and_unchanged_edits_separate(self):
  value=s.checked_answers(self.tasks,self.manifest);self.assertEqual(value['status'],'complete');self.assertEqual(len(value['current_candidate_rows']),48);self.assertEqual(value['label_summary']['absolute_positive'],36);self.assertEqual(value['label_summary']['ranking_pairs'],12);self.assertEqual(value['cut_and_audit_counts']['audit_current_rejects'],12);self.assertEqual(value['cut_and_audit_counts']['confirmed_unchanged'],24);self.assertEqual(value['cut_and_audit_counts']['changed_boundaries'],0)
  self.tasks[0]['detail']['best']['a']['start_seconds']+=1;self.tasks[0]['detail']['best']['a']['accepted']=False;new=s.checked_answers(self.tasks,self.manifest);self.assertEqual(new['cut_and_audit_counts']['changed_boundaries'],1);self.assertEqual(new['cut_and_audit_counts']['confirmed_unchanged'],23)
 def test_recovery_is_human_answer_not_initial_skip_target(self):
  row=self.tasks[3];self.assertEqual(row['context']['selection_role'],'two_skip_audit');row['answer']='both';row['detail']['best']={key:{'start_seconds':v['best'][0],'end_seconds':v['best'][1],'accepted':True} for key,v in ((k,row['context'][k]) for k in ('a','b'))}
  result=s.checked_answers(self.tasks,self.manifest);self.assertEqual(result['cut_and_audit_counts']['audit_current_recoveries'],2);self.assertEqual(result['cut_and_audit_counts']['audit_current_rejects'],10)
 def test_partial_no_labels_or_snapshot_and_mutated_context_fails(self):
  self.tasks[-1].update(answer=None,detail=None,answered_at=None)
  with patch.object(s,'load_contract',return_value=self.manifest),patch.object(s,'write_snapshot') as write:
   result=s.intake(self.root,lambda:self.tasks);write.assert_not_called();self.assertEqual(result['answered'],23);self.assertNotIn('current_candidate_rows',result)
  self.tasks[0]['context']['a']['analyzed_at']='changed'
  with self.assertRaises(ValueError):s.checked_answers(self.tasks,self.manifest)
 def test_missing_cuts_wrong_bool_and_reserved_criteria_rejected(self):
  for change in ('missing_cut','bad_bool','reserved'):
   tasks=copy.deepcopy(self.tasks)
   if change=='missing_cut':tasks[0]['detail']['best']={}
   elif change=='bad_bool':tasks[0]['detail']['best']['a']['accepted']='true'
   else:tasks[0]['context']['reserved_fine_holdout']=True
   with self.subTest(change=change),self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
 def test_versioned_snapshot_and_pair_safe_fold(self):
  value=s.checked_answers(self.tasks,self.manifest);path,sha,created=s.write_snapshot(self.root,value);self.assertTrue(created);self.assertEqual(s.write_snapshot(self.root,value),(path,sha,False));before=path.read_bytes();self.tasks[0]['answered_at']+=datetime.timedelta(seconds=1);new=s.write_snapshot(self.root,s.checked_answers(self.tasks,self.manifest));self.assertNotEqual(new[1],sha);self.assertEqual(path.read_bytes(),before)
  rows=value['current_candidate_rows'];held=rows[0]['group'];pairs=s.training_pairs_excluding_creators(rows,{held});self.assertTrue(all(held not in p['creators'] for p in pairs));self.assertTrue(all(len(p['rows'])==2 for p in pairs))

if __name__=='__main__':unittest.main()
