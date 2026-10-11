import copy,unittest
import whole_verdict_labels as w
class Labels(unittest.TestCase):
 def task(self,answer='keep_entire'):
  return {'id':1,'batch':'whole-fixture','position':0,'kind':'whole-verdict','video_id':3,'start_seconds':0.,'end_seconds':120.,'context':{'target':w.TARGET,'reserved_fine_holdout':False,'fine_data_role':'training','original_range':[0.,120.],'candidate':{'video_id':3,'channel_key':'private-fixture','duration_seconds':120.,'analyzed_at':'2026-10-10T00:00:00Z','index':{'model_revision':'fixture'},'source_fingerprint':{'size_bytes':1}}},'answer':answer,'answered_at':'2026-10-10T12:00:00Z' if answer else None,'detail':None,'reasons':[]}
 def test_four_choices_separate_targets(self):
  for answer,y in w.ANSWERS.items():
   got=w.contract(self.task(answer),set());self.assertEqual(got['y'],y)
   for k in ('clip_current_acceptability_y','cut_gold','future_replacement_y','permanent_storage_y'):self.assertIsNone(got[k])
 def test_unsure_unknown_pending_none(self):
  self.assertIsNone(w.contract(self.task('unsure'),set())['y']);self.assertIsNone(w.contract(self.task(None),set()))
 def test_reserved_scope_rejected_before_outcome(self):
  with self.assertRaises(ValueError):w.contract(self.task(),{'private-fixture'})
  for flag,value in [('fine_data_role','holdout'),('reserved_fine_holdout',True)]:
   t=self.task();t['context'][flag]=value
   with self.assertRaises(ValueError):w.contract(t,set())
 def test_partialrecording_and_clipdetail_rejected(self):
  for change in ('start','end','range','detail','kind'):
   t=self.task()
   if change=='start':t['start_seconds']=20.
   elif change=='end':t['end_seconds']=119.
   elif change=='range':t['context']['original_range']=[0.,119.]
   elif change=='detail':t['detail']={'best':{'a':[1,3]}}
   else:t['kind']='version-versus'
   with self.assertRaises(ValueError):w.contract(t,set())
 def test_receipts_missing_or_generation_invalid(self):
  for field in ('index','source_fingerprint','analyzed_at'):
   t=self.task();del t['context']['candidate'][field]
   with self.assertRaises(ValueError):w.contract(t,set())
 def test_reopen_stale_outcome_rejected(self):
  t=self.task(None);t['answered_at']='2026-10-10T12:00:00Z'
  with self.assertRaises(ValueError):w.contract(t,set())
if __name__=='__main__':unittest.main()
