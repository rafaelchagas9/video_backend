"""Synthetic caller checks with model and media work explicitly mocked out."""
import sys,unittest
import numpy as np
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'colab_audio_pilot'))
import preference_audio as pref
import fine_labels as fl
from fine_labels_test import pair

class FineLabelCallersTest(unittest.TestCase):
 def annotated(self,answers):
  tasks=[];meta=[]
  for i,answer in enumerate(answers):
   t,m=pair(i,answer);tasks.append(t)
   for r in m:r.update(base=[float(r['y']),.5],audio=None,windows=[])
   meta.extend(m)
  return fl.annotate_rows(meta,meta,tasks)
 def test_one_class_training_returns_before_features_or_fit(self):
  rows=self.annotated(['neither','both','both'])
  with patch.object(pref.ev,'features',side_effect=AssertionError('feature/model work forbidden')):
   result=pref.heldout(rows,'baseline')
  self.assertEqual(result['status'],'insufficient_explicit_labels_or_provenance');self.assertIn('outer training fold',result['error'])
 def test_current_acceptability_metrics_still_measure_strict_winner_separately(self):
  import analyze_label_round as analysis
  rows=self.annotated(['a','both','neither'])
  rows=[dict(r,pair=r['recording']) for r in rows]
  result=analysis.metrics(rows,np.array([3.,2.,3.,3.,0.,0.]))
  self.assertEqual((result['strict_pairs'],result['correct_pairs']),(1,1));self.assertEqual(result['target'],fl.CURRENT_TARGET)
  self.assertEqual(sum(r['y'] for r in rows),4)
 def test_all_metric_callers_keep_eight_ranking_pairs_and_current_36_of40(self):
  import analyze_label_round as analysis
  import fine_audio_match as matched
  import fine_transfer as transfer
  import final_worth_match as final
  rows=self.annotated(['a','b']*4+['both']*10+['neither']*2)
  values=np.array([2. if r['ranking_y']==1 else 1. if r['ranking_y']==0 else 3. if r['absolute_y'] else 0. for r in rows])
  self.assertEqual((len(rows),sum(r['y'] for r in rows)),(40,36))
  for metric in (analysis.metrics,matched.current_metrics,transfer.current_metrics,final.domain_metrics):
   with self.subTest(metric=metric.__module__):
    result=metric(rows,values);self.assertEqual((result['strict_pairs'],result['correct_pairs']),(8,8));self.assertEqual(result['auroc'],1.)
 def test_public_v2_labels_roundtrip_and_legacy_failure(self):
  t,meta=pair(1,'a');rows=fl.annotate_rows(meta,meta,[t])
  self.assertEqual([r['y'] for r in rows],[1,1]);self.assertEqual([r['legacy_y'] for r in rows],[1,0])
  self.assertEqual(len(fl.annotate_rows(rows,meta,[t])),2)
 def test_ranking_survives_single_class_current_coverage(self):
  rows=self.annotated(['a','b']*4)
  def relative(selected,kind,allow=False):
   self.assertEqual(len(fl.absolute_rows(selected)),16)
   self.assertEqual(len(fl.ranking_rows(selected)),16)
   return {'strict_pairs':8}
  with patch.object(pref.ev,'validate_rows',side_effect=lambda x:x['rows']),patch.object(pref.ev,'complete',return_value=True),patch.object(pref,'heldout',side_effect=AssertionError('absolute fitting forbidden')),patch.object(pref,'pairwise_heldout',side_effect=relative):
   report=pref.compare_cohort({'rows':rows,'target':'synthetic'},'synthetic')
  self.assertTrue(report['comparisons'])
  for result in report['comparisons'].values():
   self.assertEqual(result['absolute_sides'],16);self.assertFalse(result['models']);self.assertTrue(result['relative_heads'])
if __name__=='__main__':unittest.main()
