"""Finite18 intake tests: preserved semantics/immutable revisions/no partial export."""
import copy,datetime,unittest
from unittest.mock import patch
import creator_expansion_v2_test as fixtures
import creator_expansion_intake as s

class Intake(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.MixedRound();self.f.setUp();self.manifest=self.f.value;self.root=self.f.f.fixture.root;self.tasks=[]
  for i,row in enumerate(self.manifest['rows']):
   answer=('a','b','both','neither')[i%4];chosen=('a','b') if answer=='both' else () if answer=='neither' else (answer,)
   cuts={k:{'start_seconds':row['context'][k]['best'][0],'end_seconds':row['context'][k]['best'][1],'accepted':True} for k in chosen}
   self.tasks.append(dict(copy.deepcopy(row),id=3000+i,answer=answer,reasons=[],detail={'best':cuts},answered_at=datetime.datetime(2026,10,10,15)))
 def tearDown(self):self.f.tearDown()
 def test_complete_only36_versus_sides_order_and_acceptance_separate(self):
  out=s.checked_answers(self.tasks,self.manifest);self.assertEqual(len(out['current_candidate_rows']),36);self.assertEqual(out['label_summary']['absolute_positive'],28);self.assertEqual(out['label_summary']['ranking_pairs'],10);self.assertEqual(out['cut_counts']['confirmed_cuts'],18);self.assertEqual(out['cut_counts']['changed_boundaries'],0)
  self.tasks[0]['detail']['best']['a']['start_seconds']+=1;self.tasks[0]['detail']['best']['a']['accepted']=False;self.assertEqual(s.checked_answers(self.tasks,self.manifest)['cut_counts']['changed_boundaries'],1)
 def test_partial_and_empty_output_on_waiting(self):
  self.tasks[-1].update(answer=None,detail=None,answered_at=None)
  with patch.object(s,'load_contract',return_value=self.manifest),patch.object(s,'write_snapshot') as write:
   result=s.intake(self.root,lambda:self.tasks);self.assertEqual(result['answered'],17);write.assert_not_called();self.assertNotIn('current_candidate_rows',result)
 def test_mutated_reserved_missingcuts_and_stalegeneration_fail(self):
  for kind in ('reserved','missing','generation'):
   tasks=copy.deepcopy(self.tasks)
   if kind=='reserved':tasks[0]['context']['fine_data_role']='holdout'
   elif kind=='missing':tasks[0]['detail']['best']={}
   else:tasks[0]['context']['b']['analyzed_at']='changed'
   with self.subTest(kind=kind),self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
 def test_reanswer_revision_and_either_creator_exclusion(self):
  value=s.checked_answers(self.tasks,self.manifest);path,sha,_=s.write_snapshot(self.root,value);before=path.read_bytes();self.tasks[0]['answered_at']+=datetime.timedelta(seconds=1);new=s.write_snapshot(self.root,s.checked_answers(self.tasks,self.manifest));self.assertNotEqual(new[1],sha);self.assertEqual(path.read_bytes(),before)
  held=value['current_candidate_rows'][1]['group'];self.assertTrue(all(held not in pair['creators'] for pair in s.training_pairs_excluding_creators(value['current_candidate_rows'],{held})))

if __name__=='__main__':unittest.main()
