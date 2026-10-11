"""Pure synthetic advisory ranking tests; no database, media or production writes."""
import copy,math,unittest
import preference_ratings as r

def side(i,channel='creator'):
 return {'feedback_id':i,'video_id':i,'analyzed_at':'2026-10-10T12:00:00.000Z','best':[10.,90.],'clip':[0.,100.],'channel':channel,'channel_key':channel,'source_fingerprint':{'size_bytes':100,'mtime_ns':'123','path_identity_sha256':'f'*64},'index':{'model_revision':'fixture','indexed_at':'2026-10-10T12:00:00.000Z'}}
def task(i,a,b,answer='a',ca='creator',cb='creator'):
 return {'id':i,'kind':'versus','channel':ca if ca==cb else None,'context':{'a':side(a,ca),'b':side(b,cb),'comparison_scope':'same_channel' if ca==cb else 'cross_channel','reserved_fine_holdout':False,'fine_data_role':'training'},'answer':answer}
def theta(report):return sorted(n['theta'] for n in report['nodes'] if n['theta'] is not None)

class Ratings(unittest.TestCase):
 def test_order_independent_and_fixed_elo_scale(self):
  tasks=[task(1,1,2),task(2,2,3),task(3,1,3)]
  a=r.ratings(tasks,set());b=r.ratings(tasks[::-1],set());self.assertEqual(a,b);self.assertEqual(a['strict_edges'],3)
  self.assertEqual(len(a['components']),1)
  for node in a['nodes']:self.assertAlmostEqual(node['elo_display'],1500+400/math.log(10)*node['theta'])
 def test_cycles_are_finite_soft_evidence(self):
  report=r.ratings([task(1,1,2),task(2,2,3),task(3,3,1)],set())
  self.assertEqual(theta(report),[0.,0.,0.]);self.assertEqual(len(report['components']),1)
 def test_components_not_global_and_unplayed_null(self):
  report=r.ratings([task(1,1,2),task(2,3,4),task(3,5,6,'both')],set())
  self.assertEqual(len(report['components']),2);self.assertIsNone(report['global_ranking']);self.assertEqual(report['unplayed_nodes'],2)
  for n in report['nodes']:
   if n['strict_comparisons']==0:self.assertIsNone(n['theta']);self.assertIsNone(n['elo_display']);self.assertIsNone(n['component'])
 def test_acceptance_not_losers_rejects_or_ties(self):
  report=r.ratings([task(1,1,2),task(2,3,4,'both'),task(3,5,6,'neither')],set())
  self.assertEqual(report['strict_edges'],1);self.assertEqual(report['no_order_tasks'],2)
  self.assertEqual(sum(n['accepted_observations'] for n in report['nodes']),4);self.assertEqual(sum(n['rejected_observations'] for n in report['nodes']),2)
  loser=next(n for n in report['nodes'] if n['strict_losses']);self.assertEqual(loser['accepted_observations'],1);self.assertEqual(loser['rejected_observations'],0)
  self.assertIsNone(report['permanent_worth']);self.assertIsNone(report['deletion']);self.assertIsNone(report['expiry'])
 def test_edited_cuts_ignored_offered_versions_distinct(self):
  t=task(1,1,2);first=r.ratings([t],set());t['detail']={'best':{'a':{'start_seconds':40,'end_seconds':50,'accepted':False}}}
  self.assertEqual(first,r.ratings([t],set()))
  revised=copy.deepcopy(t);revised['id']=2;revised['context']['a']['best']=[20.,80.]
  report=r.ratings([t,revised],set());self.assertEqual(len(report['nodes']),3)
 def test_reserved_answers_never_accessed_and_creators_excluded_everywhere(self):
  class Guard(dict):
   def get(self,key,default=None):
    if key=='answer':raise AssertionError('Reserved answer accessed')
    return super().get(key,default)
  held=Guard(task(1,1,2,ca='held',cb='held'));held['context']['reserved_fine_holdout']=True;held['context']['fine_data_role']='holdout'
  cross=Guard(task(2,3,4,ca='held',cb='other'));valid=task(3,5,6)
  report=r.ratings([held,cross,valid],set());self.assertEqual(report['excluded_reserved_creator_tasks'],2);self.assertEqual(report['strict_edges'],1);self.assertEqual(len(report['nodes']),2)
  explicit=r.ratings([Guard(task(4,7,8,ca='reserved',cb='other')),valid],{'@Reserved'})
  self.assertEqual(explicit['excluded_reserved_creator_tasks'],1)
 def test_exact_identity_and_range_fail_closed(self):
  t=task(1,1,2)
  for field,value in [('feedback_id',True),('best',[0,float('nan')]),('best',[10,101]),('channel_key','wrong')]:
   bad=copy.deepcopy(t);bad['context']['a'][field]=value
   with self.subTest(field=field),self.assertRaises(r.RatingContractError):r.ratings([bad],set())
  with self.assertRaises(r.RatingContractError):r.ratings([t,t],set())
  with self.assertRaises(r.RatingContractError):r.ratings([task(2,1,1)],set())
 def test_source_and_index_versions_do_not_silently_merge(self):
  original=task(1,1,2)
  for field in ('source_fingerprint','index'):
   changed=copy.deepcopy(original);changed['id']=2
   changed['context']['a'][field]['version']='changed'
   with self.subTest(field=field):self.assertEqual(len(r.ratings([original,changed],set())['nodes']),3)
 def test_missing_legacy_offer_receipt_reported_without_reading_answer(self):
  class Guard(dict):
   def get(self,key,default=None):
    if key=='answer':raise AssertionError('Unsupported answer accessed')
    return super().get(key,default)
  legacy=Guard(task(1,1,2));legacy['context']['a'].pop('analyzed_at')
  report=r.ratings([legacy],set());self.assertEqual(report['unsupported_version_tasks'],1);self.assertEqual(report['strict_edges'],0);self.assertEqual(report['nodes'],[])
 def test_pending_has_no_acceptance_or_score(self):
  report=r.ratings([task(1,1,2,None)],set());self.assertEqual(report['pending_tasks'],1);self.assertEqual(report['answered_tasks'],0);self.assertEqual(report['unplayed_nodes'],2)
  self.assertTrue(all(n['accepted_observations']==n['rejected_observations']==0 for n in report['nodes']))

if __name__=='__main__':unittest.main()
