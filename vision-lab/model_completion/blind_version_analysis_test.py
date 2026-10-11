"""Synthetic descriptive aggregation/provenance guards; no actual outcomes or models."""
import copy,unittest
import blind_version_counterbalanced_intake_test as fixtures
import blind_version_counterbalanced_intake as intake
import blind_version_analysis as s

class Analysis(unittest.TestCase):
 def setUp(self):self.f=fixtures.Intake();self.f.setUp();self.manifest=self.f.manifest
 def tearDown(self):self.f.tearDown()
 def test_role_reconciliation_and_nonlabels(self):
  private={x['position']:x for x in self.manifest['private_assignments']}
  for row in self.f.tasks:row['answer']=next(k for k,v in private[row['position']]['assignments'].items() if v=='human_compact')
  report=s.analyze_payload(self.manifest,intake.checked_answers(self.f.tasks,self.manifest));self.assertEqual(report['summary']['long_vs_compact']['human_compact_preferred'],4);self.assertEqual(report['summary']['equal_duration_control']['human_compact_preferred'],2);self.assertEqual(report['model_fits'],0);self.assertNotIn('absolute_y',report);self.assertNotIn('current_candidate_rows',report)
 def test_ties_abstentions_and_missing_viewing_honest(self):
  self.f.tasks[0]['answer']='both';self.f.tasks[1]['answer']='neither';report=s.analyze_payload(self.manifest,intake.checked_answers(self.f.tasks,self.manifest));self.assertEqual(sum(x['no_strict_preference'] for x in report['summary'].values()),2);self.assertEqual(sum(x['abstained'] for x in report['summary'].values()),2);self.assertEqual(sum(x['sides_without_viewing_metadata'] for x in report['viewing_event_summary'].values()),12);self.assertEqual(sum(x['full_completed_events'] for x in report['viewing_event_summary'].values()),0)
 def test_partial_and_identity_or_label_mutation_rejected(self):
  payload=intake.checked_answers(self.f.tasks,self.manifest)
  for change in ('partial','source','label'):
   bad=copy.deepcopy(payload)
   if change=='partial':bad['preference_rows'].pop()
   elif change=='source':bad['preference_rows'][0]['a']['source_fingerprint']['mtime_ns']='changed'
   else:bad['preference_rows'][0]['absolute_y']=1
   with self.subTest(change=change),self.assertRaises(ValueError):s.analyze_payload(self.manifest,bad)

if __name__=='__main__':unittest.main()
