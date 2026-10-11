"""New reserved channel roles survive exports and cannot enter fitting paths."""
import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import fine_labels as fl
from fine_labels_test import pair
import raw_original_boundaries as raw
import cut_and_whole as cuts
import frame_cuts as frames
import channel_partial_order as graph


class Holdout(unittest.TestCase):
 def annotated(self):
  task,meta=pair(12,'a');task['context']['reserved_fine_holdout']=True;task['context']['fine_data_role']='holdout';return task,meta,fl.annotate_rows(meta,meta,[task])
 def test_reserved_labels_retained_for_explicit_evaluation_not_fit(self):
  task,meta,rows=self.annotated();self.assertEqual(len(rows),2);self.assertTrue(all(r['reserved_fine_holdout'] for r in rows));self.assertEqual([r['absolute_y'] for r in rows],[1,1]);self.assertEqual([r['ranking_y'] for r in rows],[1,0])
  for helper in (fl.absolute_rows,fl.ranking_rows):
   with self.assertRaises(fl.ReservedFineHoldoutError):helper(rows)
   self.assertEqual(len(helper(rows,for_fit=False)),2)
  summary=fl.summary(rows);self.assertEqual(summary['reserved_holdout_sides'],2);self.assertEqual(summary['fit_eligible_sides'],0);self.assertEqual(summary['valid_final_cuts'],1)
  self.assertEqual(fl.strict_pair_metrics(rows,[.8,.2])['correct_pairs'],1)
 def test_public_false_cannot_override_task_reserved_role(self):
  task,meta,rows=self.annotated();public=copy.deepcopy(meta)
  for row in public:row['reserved_fine_holdout']=False;row['fine_data_role']='training'
  verified=fl.annotate_rows(public,meta,[task]);self.assertTrue(all(r['reserved_fine_holdout'] for r in verified))
  with self.assertRaises(fl.ReservedFineHoldoutError):fl.require_fit_scope(verified)
 def test_training_and_legacy_rows_remain_eligible(self):
  task,meta=pair(13,'both');task['context']['reserved_fine_holdout']=False;rows=fl.annotate_rows(meta,meta,[task]);fl.require_fit_scope(rows);self.assertEqual(len(fl.absolute_rows(rows)),2)
  task['context'].pop('reserved_fine_holdout');rows=fl.annotate_rows(meta,meta,[task]);self.assertFalse(any(r['reserved_fine_holdout'] for r in rows));self.assertEqual(fl.summary(rows)['fit_eligible_sides'],2)
 def test_cut_target_exports_fail_before_numeric_or_media_loading(self):
  task,meta,rows=self.annotated()
  for key in ('a','b'):task['context'][key]['feedback_id']=100
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'cohort.json').write_text(json.dumps({'recordings':[]}));(root/'private_snapshot.json').write_text(json.dumps({'tasks':[task],'records':[]}))
   with self.assertRaises(fl.ReservedFineHoldoutError):raw.targets(root/'cohort.json')
   with self.assertRaises(fl.ReservedFineHoldoutError):cuts.fine_boundaries({'recordings':[]},root)
   # Explicit evaluation-only access remains possible and does not manufacture missing source coverage.
   self.assertEqual(raw.targets(root/'cohort.json',for_fit=False)[0],[]);self.assertEqual(cuts.fine_boundaries({'recordings':[]},root,for_fit=False),[])
 def test_model_and_partial_order_guards_precede_any_fit(self):
  task,meta,rows=self.annotated()
  with patch.object(frames,'StandardScaler') as scale:
   with self.assertRaises(fl.ReservedFineHoldoutError):frames.fit(rows,1.)
   scale.assert_not_called()
  with patch.object(cuts,'make_pipeline') as fitting:
   with self.assertRaises(fl.ReservedFineHoldoutError):cuts.fit_cut(rows,1.)
   fitting.assert_not_called()
  with self.assertRaises(fl.ReservedFineHoldoutError):graph.build(meta,meta,{'tasks':[task]}, {})
 def test_nonboolean_role_marker_rejected_before_label_export(self):
  task,meta=pair(14,'both');task['context']['reserved_fine_holdout']='true'
  with self.assertRaises(fl.FineLabelContractError):fl.annotate_rows(meta,meta,[task])

if __name__=='__main__':unittest.main()
