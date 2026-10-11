"""Synthetic blind assignment/window/source guards; no media/live writes."""
import copy,unittest
import blind_version_round as s
import creator_expansion_round_test as fixtures

class Blind(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.Expansion();self.f.setUp();prototype=s.safe.previous.side(self.f.rows[100],self.f.history);self.sources={}
  for i,fid in enumerate(s.LONG_IDS+s.CONTROL_IDS):
   value=copy.deepcopy(prototype);value.update(feedback_id=fid,video_id=6000+i,channel=f'blind{i}',channel_key=f'blind{i}',clip=[0.,2000.],best=[300.,900.],duration_seconds=2000.);self.sources[fid]=value
  self.manifest=s.make_manifest(self.sources,set(),{'fixture':True})
 def tearDown(self):self.f.tearDown()
 def test_fixed_six_randomization_public_assignment_blind(self):
  self.assertEqual(self.manifest,s.make_manifest(self.sources,set(),{'fixture':True}));self.assertEqual(len(self.manifest['rows']),6)
  for row in self.manifest['rows']:
   self.assertEqual(row['kind'],'version-versus');self.assertEqual(row['stratum'],'blind-version');self.assertEqual(row['context']['target'],'preferred_version_if_keep_one')
   for side in (row['context']['a'],row['context']['b']):
    for secret in ('score','file_name','initial_best_source','final_cut_receipt','pilot_role','assignments'):self.assertNotIn(secret,side)
    self.assertEqual(len(side['preview_windows']),3)
    for a,b in side['preview_windows']:self.assertEqual(b-a,15);self.assertTrue(side['range'][0]<=a<b<=side['range'][1])
 def test_control_equal_length_minimum_overlap_no_duplicate(self):
  self.assertEqual(s.endpoint_control([0,2000],[300,900]),[1400.,2000.]);self.assertEqual(s.endpoint_control([0,2000],[0,600]),[1400.,2000.])
  for private in self.manifest['private_assignments']:
   if private['pilot_role']=='equal_duration_control':
    row=self.manifest['rows'][private['position']];self.assertEqual(row['context']['a']['range'][1]-row['context']['a']['range'][0],row['context']['b']['range'][1]-row['context']['b']['range'][0])
 def test_exact_version_identity_differs_for_same_feedback(self):
  row=self.manifest['rows'][0];a,b=(row['context'][k] for k in ('a','b'));self.assertEqual(a['feedback_id'],b['feedback_id']);self.assertNotEqual(s.version_key(a),s.version_key(b));self.assertEqual(len(s.history_pairs([row])),1)
  changed=copy.deepcopy(a);changed['source_fingerprint']['mtime_ns']='new';self.assertNotEqual(s.version_key(a),s.version_key(changed))
 def test_bounds_creator_and_original_small_failclosed(self):
  for change in ('reserved','duration','compact'):
   values=copy.deepcopy(self.sources);reserved=set()
   if change=='reserved':reserved.add(values[s.LONG_IDS[0]]['channel_key'])
   elif change=='duration':values[s.LONG_IDS[0]]['clip']=[0,900]
   else:values[s.LONG_IDS[0]]['best']=[0,100]
   with self.subTest(change=change),self.assertRaises(ValueError):s.make_manifest(values,reserved,{'fixture':True})

if __name__=='__main__':unittest.main()
