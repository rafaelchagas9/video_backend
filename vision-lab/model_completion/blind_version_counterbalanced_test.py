"""Pinned source wrapper balance/mapping/window identity tests; no real media/queue."""
import copy,unittest
from unittest.mock import patch
import blind_version_round_test as fixtures
import blind_version_counterbalanced as s

class Counterbalance(unittest.TestCase):
 def setUp(self):self.f=fixtures.Blind();self.f.setUp();self.old=self.f.manifest
 def tearDown(self):self.f.tearDown()
 def value(self):
  with patch.object(s,'prior_contract',return_value=(self.old,{'manifest_sha256':'fixture','source_sha256':self.old['source_sha256']})):return s.make_manifest(self.f.sources,set(),{'fixture':True})
 def test_only_one_control_swapped_and_both_roles_balanced(self):
  oldbytes=s.canonical(self.old);value=self.value();self.assertEqual(s.canonical(self.old),oldbytes);self.assertEqual(s.previous.BATCH,'blind-version-20261010-1')
  for before,after,private in zip(self.old['rows'],value['rows'],value['private_assignments']):
   self.assertEqual(before['position'],after['position']);self.assertEqual(after['kind'],'version-versus');self.assertEqual(after['context']['batch_policy'],s.BATCH)
   for key in ('a','b'):
    expected=copy.deepcopy(before['context']['b' if key=='a' else 'a'] if private['feedback_id']==331 else before['context'][key]);expected['version_label']=f'Version {key.upper()}';self.assertEqual(after['context'][key],expected)
  for role,wanted in (('long_vs_compact',[2,2]),('equal_duration_control',[1,1])):
   subset=[x for x in value['private_assignments'] if x['pilot_role']==role];self.assertEqual([sum(x['assignments'][k]=='human_compact' for x in subset) for k in ('a','b')],wanted)
 def test_wrong_generation_range_or_source_never_transforms(self):
  for field in ('analyzed_at','best','source_fingerprint'):
   sources=copy.deepcopy(self.f.sources)
   if field=='best':sources[331]['best'][0]+=1
   elif field=='source_fingerprint':sources[331][field]['mtime_ns']='changed'
   else:sources[331][field]='changed'
   with patch.object(s,'prior_contract',return_value=(self.old,{})),self.subTest(field=field),self.assertRaisesRegex(ValueError,'generations'):s.make_manifest(sources,set(),{'fixture':True})
 def test_no_public_roles_scores_or_source_names(self):
  for row in self.value()['rows']:
   self.assertEqual(row['stratum'],'blind-version');self.assertNotIn('assignments',row['context'])
   for key in ('a','b'):
    self.assertNotIn('score',row['context'][key]);self.assertNotIn('initial_best_source',row['context'][key]);self.assertNotIn('file_name',row['context'][key]);self.assertEqual(len(row['context'][key]['preview_windows']),3)

if __name__=='__main__':unittest.main()
