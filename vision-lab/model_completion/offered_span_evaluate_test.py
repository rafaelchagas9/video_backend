"""Synthetic answer evaluation only; no live answers, DB, frames, media or model fits."""
import contextlib,copy,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import offered_span_evaluate as subject


def frozen_metadata():
    return json.loads((subject.ROOT/'private_manifest.json').read_text())


def synthetic_snapshot(manifest,answer_for=None):
    assignments={subject.intake.key(p):p for p in manifest['private_assignments']}
    tasks=[]
    for i,plan in enumerate(manifest['rows']):
        p=assignments[subject.intake.key(plan)]
        answer=answer_for(i,p) if answer_for else ('a','b','both','neither')[plan['position']%4]
        tasks.append(dict(copy.deepcopy(plan),id=10000+i,answer=answer,reasons=[],detail=None,answered_at='2026-10-10T15:00:00.000Z' if answer else None))
    payload=subject.intake.checked_answers(tasks,manifest)
    return {'schema_version':1,'manifest_sha256':subject.MANIFEST_SHA,'intake_source_sha256':subject.base.digest(Path(subject.intake.__file__)),'answers':payload}


def role_row(creator,answer='a',winning='a'):
    scores={'a':1.,'b':0.} if winning=='a' else {'a':0.,'b':1.} if winning=='b' else {'a':0.,'b':0.}
    return {'creator':creator,'answer':answer,'predictions':{kind:dict(scores) for kind in subject.HEADS}}


class OfferedSpanEvaluationTest(unittest.TestCase):
    def test_complete_synthetic_snapshot_reconstructs_exact_contract(self):
        manifest=frozen_metadata();value=synthetic_snapshot(manifest)
        self.assertEqual(subject.checked_snapshot(value,manifest),value['answers'])
        report=subject.analysis(manifest,value['answers'])
        self.assertEqual(report['shared_creators_between_roles'],8)
        self.assertEqual(report['historically_fine_unseen_creators'],1)
        for role in subject.ROLES:
            counts=report['roles'][role]['outcomes']
            self.assertEqual(counts['answered'],8)
            self.assertEqual(counts['strict'],4)
            self.assertEqual(counts['human_ties'],2)
            self.assertEqual(counts['abstentions'],2)
        self.assertEqual(report['future_training_role'],'pure_version_preference_only')
        self.assertEqual(report['current_acceptability'],'not_observed')
        self.assertEqual(report['cut_gold'],'not_observed')
        self.assertFalse(report['reserved_opened'])

    def test_no_strict_results_are_null_not_false_binary_labels(self):
        metrics=subject.role_metrics([role_row('g1','both'),role_row('g2','neither')])
        self.assertEqual(metrics['outcomes']['answered'],2)
        self.assertEqual(metrics['outcomes']['strict'],0)
        for head in metrics['heads'].values():
            self.assertIsNone(head['strict_accuracy'])
            self.assertIsNone(head['creator_macro_strict_accuracy'])
            self.assertEqual(head['strict_correct_over_all_answered'],0.)
        for comparison in metrics['paired'].values():
            self.assertIsNone(comparison['creator_macro_gain'])
            self.assertIsNone(comparison['creator_bootstrap_95'])
            self.assertEqual(comparison['creator_count'],0)

    def test_model_tie_gets_no_half_credit_on_strict_preference(self):
        metrics=subject.role_metrics([role_row('g1','a',None),role_row('g2','b',None)])
        self.assertEqual(metrics['heads']['primary']['strict_accuracy'],0.)
        self.assertEqual(metrics['heads']['primary']['model_ties_strict'],2)

    def test_creator_macro_and_bootstrap_do_not_treat_rows_as_creators(self):
        rows=[role_row('g1') for _ in range(3)]+[role_row('g2','b')]
        metrics=subject.role_metrics(rows)
        self.assertEqual(metrics['outcomes']['creators_with_strict'],2)
        self.assertEqual(metrics['heads']['primary']['strict_accuracy'],.75)
        self.assertEqual(metrics['heads']['primary']['creator_macro_strict_accuracy'],.5)
        self.assertEqual(metrics['paired']['primary_vs_numeric']['creator_count'],2)
        self.assertEqual(metrics['paired']['primary_vs_numeric']['creator_bootstrap_95'],[0.,0.])

    def test_pairs_use_identical_cohort_and_all_answered_denominator(self):
        rows=[role_row('g1'),role_row('g2','b'),role_row('g3','both'),role_row('g4','neither')]
        rows[1]['predictions']['primary']={'a':0.,'b':1.}
        metrics=subject.role_metrics(rows)
        self.assertEqual(metrics['heads']['primary']['strict_accuracy'],1.)
        self.assertEqual(metrics['heads']['primary']['strict_correct_over_all_answered'],.5)
        self.assertEqual(metrics['heads']['numeric']['strict_accuracy'],.5)
        paired=metrics['paired']['primary_vs_numeric']
        self.assertEqual(paired['creator_macro_gain'],.5)
        self.assertEqual(paired['strict_comparisons'],2)
        self.assertTrue(paired['identical_head_cohort'])
        self.assertEqual(metrics,subject.role_metrics(rows))

    def test_pending_null_and_partial_snapshot_rejected(self):
        manifest=frozen_metadata();value=synthetic_snapshot(manifest,lambda i,p:None if i==0 else 'a')
        with self.assertRaises(ValueError):subject.checked_snapshot(value,manifest)
        with self.assertRaises(ValueError):subject.role_metrics([role_row('g',None)])

    def test_outcome_or_source_drift_rejected(self):
        manifest=frozen_metadata();original=synthetic_snapshot(manifest)
        mutations=[lambda v:v['answers']['preference_rows'][0].update(preferred_side='b'),lambda v:v['answers']['preference_rows'][0].update(absolute_y=1),lambda v:v['answers']['preference_rows'][0]['a']['range'].__setitem__(0,v['answers']['preference_rows'][0]['a']['range'][0]+1.),lambda v:v['answers'].update(strict_pairs=999),lambda v:v.update(manifest_sha256='0'*64)]
        for mutation in mutations:
            value=copy.deepcopy(original);mutation(value)
            with self.assertRaises(ValueError):subject.checked_snapshot(value,manifest)

    def test_mixed_role_reserved_and_missing_head_rejected(self):
        manifest=frozen_metadata();payload=synthetic_snapshot(manifest)['answers']
        for mutation in (lambda m:m['private_assignments'][0].update(pilot_role='fine_acceptability'),lambda m:m['excluded_holdout_creators'].append(m['private_assignments'][0]['source']['channel_key']),lambda m:m['private_assignments'][0]['predictions'].pop('numeric')):
            value=copy.deepcopy(manifest);mutation(value)
            with self.assertRaises(ValueError):subject.analysis(value,payload)

    def test_nonfinite_or_boolean_scores_fail_closed(self):
        for value in ({'a':True,'b':0.},{'a':float('nan'),'b':0.},{'a':0.}, {'a':1.,'b':0.,'c':2.}):
            with self.assertRaises(ValueError):subject.predict(value)

    def test_immutable_policy_and_answer_revision_reports_stay_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'policy.json'
            self.assertTrue(subject.immutable(path,{'policy':1}))
            self.assertFalse(subject.immutable(path,{'policy':1}))
            with self.assertRaises(ValueError):subject.immutable(path,{'policy':2})
            self.assertEqual(json.loads(path.read_text()),{'policy':1})
            a=Path(directory)/'report.answerA.json';b=Path(directory)/'report.answerB.json'
            subject.immutable(a,{'answer':'a'});subject.immutable(b,{'answer':'b'})
            self.assertEqual(json.loads(a.read_text()),{'answer':'a'})
            self.assertEqual(json.loads(b.read_text()),{'answer':'b'})

    def test_metrics_policy_timing_discloses_observed_preference(self):
        self.assertTrue(subject.POLICY['user_preference_or_rationale_seen_before_metrics_policy'])
        self.assertFalse(subject.POLICY['outcome_blind_preregistration'])
        self.assertIn('after at least one user preference/rationale observed',subject.POLICY['timing'])
        self.assertIn('before first complete-snapshot analysis',subject.POLICY['timing'])
        self.assertIn('frozen head scores/ranges generated before all new answers',subject.POLICY['timing'])
        self.assertIn('Not outcome-blind preregistration',subject.POLICY['timing'])

    def test_policy_verification_rejects_changed_head_source_or_timing(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);pins={'source_sha':'fake','head_sha':'head'};spec=dict(subject.POLICY,**pins)
            subject.immutable(root/'evaluation-policy/before-evaluation.json',spec)
            self.assertEqual(subject.verify_policy(root,pins)[0],spec)
            with self.assertRaises(ValueError):subject.verify_policy(root,dict(pins,head_sha='changed'))
            with self.assertRaises(ValueError):subject.verify_policy(root,dict(pins,source_sha='changed'))


if __name__=='__main__':unittest.main()
