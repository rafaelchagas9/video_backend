"""Isolated pure preferences, failure-before-write, partial suppression and revisions."""
import copy,datetime,unittest
from unittest.mock import patch
import blind_version_counterbalanced_test as fixtures
import blind_version_counterbalanced_intake as s
import blind_version_counterbalanced_apply as a

class Intake(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.Counterbalance();self.f.setUp();self.manifest=self.f.value();self.root=self.f.f.f.fixture.root
  self.tasks=[dict(copy.deepcopy(row),id=6000+i,answer=('a','b','both','neither')[i%4],reasons=[],detail=None,answered_at=datetime.datetime(2026,10,10,16)) for i,row in enumerate(self.manifest['rows'])]
 def tearDown(self):self.f.tearDown()
 def test_preferences_never_acceptability_or_cut_gold(self):
  out=s.checked_answers(self.tasks,self.manifest);self.assertEqual(len(out['preference_rows']),6);self.assertEqual(out['strict_pairs'],4);self.assertFalse(out['fine_legacy_compatibility'])
  for row in out['preference_rows']:self.assertIsNone(row['absolute_y']);self.assertIsNone(row['cut_gold']);self.assertEqual(row['outside_quality'],'unknown')
  self.assertNotIn('current_candidate_rows',out)
 def test_partial_suppresses_labels_and_write(self):
  self.tasks[-1].update(answer=None,answered_at=None)
  with patch.object(s,'load_contract',return_value=(self.manifest,set(),{})),patch.object(s,'write_snapshot') as write:
   out=s.intake(self.root,lambda:self.tasks);write.assert_not_called();self.assertEqual(out['pending'],1);self.assertNotIn('preference_rows',out)
 def test_changed_source_generation_range_or_cut_details_reject(self):
  for kind in ('source','generation','range','detail'):
   tasks=copy.deepcopy(self.tasks)
   if kind=='source':tasks[0]['context']['a']['source_fingerprint']['mtime_ns']='changed'
   elif kind=='generation':tasks[0]['context']['b']['analyzed_at']='changed'
   elif kind=='range':tasks[0]['context']['a']['range'][0]+=1
   else:tasks[0]['detail']={'best':{}}
   with self.subTest(kind=kind),self.assertRaises(ValueError):s.checked_answers(tasks,self.manifest)
 def test_immutable_reanswer_and_existing_replay(self):
  payload=s.checked_answers(self.tasks,self.manifest);path,sha,_=s.write_snapshot(self.root,payload);before=path.read_bytes();self.tasks[0]['answered_at']+=datetime.timedelta(seconds=1);new=s.write_snapshot(self.root,s.checked_answers(self.tasks,self.manifest));self.assertNotEqual(new[1],sha);self.assertEqual(path.read_bytes(),before)
  before=copy.deepcopy(self.tasks);a.existing_match(self.tasks,self.manifest['rows']);self.assertEqual(self.tasks,before)
 def test_optional_viewing_coverage_is_recorded_without_quality_claim(self):
  viewing={'a':{'preview_started':[0,1,2],'preview_completed':[0,1],'full_opened':True,'full_completed':False},'b':{'preview_started':[],'preview_completed':[],'full_opened':False,'full_completed':False}}
  self.tasks[0]['detail']={'viewing':viewing};out=s.checked_answers(self.tasks,self.manifest);row=out['preference_rows'][0];self.assertEqual(row['viewing'],viewing);self.assertIsNone(row['absolute_y']);self.assertIsNone(row['cut_gold'])
  for change in ('bool_index','unfinished','duplicate','full','extra'):
   bad=copy.deepcopy(viewing)
   if change=='bool_index':bad['a']['preview_started']=[True]
   elif change=='unfinished':bad['b']['preview_completed']=[0]
   elif change=='duplicate':bad['a']['preview_started']=[0,0]
   elif change=='full':bad['b']['full_completed']=True
   else:bad['a']['quality']='good'
   with self.subTest(change=change),self.assertRaises(ValueError):s.viewing_context({'viewing':bad})
 def test_source_drift_prevents_insert_and_wrongsha_prevents_read(self):
  with self.assertRaises(ValueError):s.load_contract(self.root,'wrong')
  class Cursor:
   def fetchall(self):return []
  class PG:
   def __init__(self):self.sql=[]
   def execute(self,q,args=()):self.sql.append(q);return Cursor()
  pg=PG()
  with patch.object(a.batch.safe,'load_history',return_value=[]),patch.object(a.batch.safe.previous,'load_rows',return_value={}),patch.object(a.batch,'validate_live',side_effect=ValueError('source drift')),self.assertRaises(ValueError):a.execute(pg,self.manifest,set(),{},True)
  self.assertFalse(any('INSERT' in q or 'UPDATE' in q or 'DELETE' in q for q in pg.sql))

if __name__=='__main__':unittest.main()
