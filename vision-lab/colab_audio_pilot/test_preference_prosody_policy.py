"""Synthetic labels/features only; never invokes extraction or a real fitted model."""
import unittest
import builtins, contextlib, io, json, tempfile
from pathlib import Path
from unittest.mock import patch
import numpy as np
import preference_prosody as prosody


def fixture(answers=('both','both','neither','neither','a','b','a','b')):
    rows=[];private=[];tasks=[]
    for task_id,answer in enumerate(answers,1):
        context={side:dict(video_id=task_id*10+i,clip=[10,100],best=[20,80]) for i,side in enumerate(('a','b'))}
        tasks.append(dict(id=task_id,kind='versus',answer=answer,context=context,detail={}))
        for side in ('a','b'):
            index=len(rows)
            row=dict(row=f'p{task_id:02d}{side}',task_id=task_id,video_id=context[side]['video_id'],start=20,end=80,
                     y=int(answer in (side,'both')),group=f'g{task_id}',recording=f'pair{task_id}',base=[index,1],fixed_baseline=float(index))
            rows.append(dict(row));private.append(dict(row,side=side,answer=answer))
    return dict(rows=rows),dict(rows=private),dict(tasks=tasks)


class PolicyTests(unittest.TestCase):
    def test_absolute_and_relative_feature_and_score_slices_keep_exact_rows(self):
        payload,private,snapshot=fixture()
        rows=prosody.annotate_cohort(payload,private,snapshot)
        X=np.array([row['base'] for row in rows])
        absolute,AX=prosody.labeled_cohort(rows,X)
        ranking,RX=prosody.labeled_cohort(rows,X,True)
        self.assertEqual([row['y'] for row in absolute],[1,1,1,1,0,0,0,0]+[1]*8)
        np.testing.assert_array_equal(AX[:,0],np.arange(16))
        np.testing.assert_array_equal(RX[:,0],np.arange(8,16))
        self.assertEqual(len(ranking),8)
        self.assertTrue(all(row['absolute_y']==1 and row['future_replacement_y'] is None and row['permanent_storage_y'] is None for row in rows[8:]))
        scores=np.array([row['fixed_baseline'] for row in rows])
        self.assertEqual(prosody.metrics(rows,scores)['rows'],16)
        self.assertEqual(prosody.metrics(rows,scores)['auroc'],.6667)
        relative=prosody.metrics(rows,scores,True)
        self.assertEqual((relative['strict_pairs'],relative['correct_pairs']),(4,2))

    def test_current_single_class_training_fails_before_model_fit(self):
        for answers in [('a','b','a','b'),('both','both')]:
            payload,private,snapshot=fixture(answers)
            rows=prosody.annotate_cohort(payload,private,snapshot)
            with patch.object(prosody,'LogisticRegression',side_effect=AssertionError('No model may fit these labels')):
                result=prosody.fit(rows,np.array([row['base'] for row in rows]))
            self.assertEqual(result['status'],'insufficient_absolute_labels')
        payload,private,snapshot=fixture(('both','neither'))
        rows=prosody.annotate_cohort(payload,private,snapshot)
        with patch.object(prosody,'LogisticRegression',side_effect=AssertionError('One-class fold must fail closed')):
            result=prosody.fit(rows,np.array([row['base'] for row in rows]))
        self.assertEqual(result['status'],'insufficient_training_classes')

    def test_late_sorted_single_negative_channel_is_rejected_before_any_scaler_or_model(self):
        payload,private,snapshot=fixture(('both','both','neither'))
        rows=prosody.annotate_cohort(payload,private,snapshot)
        with patch.object(prosody,'StandardScaler') as scaler,patch.object(prosody,'LogisticRegression') as model:
            result=prosody.fit(rows,np.array([row['base'] for row in rows]))
        self.assertEqual(result['status'],'insufficient_training_classes')
        self.assertEqual(result['held_out_group'],'g3')
        scaler.assert_not_called();model.assert_not_called()

    def test_relative_eligibility_survives_single_class_current_acceptability(self):
        payload,private,snapshot=fixture(('a','b','a','b'))
        allowed=prosody.eligibility(prosody.annotate_cohort(payload,private,snapshot))
        self.assertEqual(allowed['absolute']['status'],'insufficient_absolute_labels')
        self.assertEqual(allowed['relative']['status'],'ready')
        self.assertEqual(allowed['relative']['strict_pairs'],4)

    def test_synthetic_main_one_class_no_ranking_writes_status_without_audio_import_or_read(self):
        payload,private,snapshot=fixture(('both','both','both'))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);frozen=root/'frozen.json'
            (root/'features_with_embeddings.json').write_text(json.dumps(payload))
            (root/'private_manifest.json').write_text(json.dumps(private));frozen.write_text(json.dumps(snapshot))
            original_import=builtins.__import__
            def guarded_import(name,*args,**kwargs):
                if name in ('opensmile','soundfile'):raise AssertionError('Unsupported labels must not import audio extractors')
                return original_import(name,*args,**kwargs)
            with patch.object(prosody,'ROOT',root),patch.object(prosody,'SNAPSHOT',frozen),patch('builtins.__import__',side_effect=guarded_import),patch.object(Path,'read_bytes',side_effect=AssertionError('No source media reads')),patch.object(prosody,'LogisticRegression',side_effect=AssertionError('No fitting')),contextlib.redirect_stdout(io.StringIO()):
                prosody.main()
            status=json.loads((root/'prosody'/f'status.{prosody.fl.POLICY}.json').read_text())
            self.assertEqual(status['status'],'insufficient_labels')
            self.assertEqual(status['eligibility']['absolute']['status'],'insufficient_absolute_labels')
            self.assertEqual(status['eligibility']['relative']['status'],'insufficient_training_pairs')
            self.assertEqual(sorted(path.name for path in (root/'prosody').iterdir()),[f'status.{prosody.fl.POLICY}.json'])

    def test_mock_fits_use_current_labels_and_ranking_stays_independent(self):
        payload,private,snapshot=fixture()
        rows=prosody.annotate_cohort(payload,private,snapshot);X=np.array([row['base'] for row in rows])
        calls=[]
        class Scaler:
            def fit(self,values):return self
            def transform(self,values):return values
        class Model:
            def __init__(self,**kwargs):self.relative=kwargs.get('fit_intercept') is False
            def fit(self,values,labels):calls.append((self.relative,values.copy(),labels.copy()));return self
            def decision_function(self,values):return values[:,0]
        with patch.object(prosody,'StandardScaler',Scaler),patch.object(prosody,'LogisticRegression',Model):
            absolute=prosody.fit(rows,X);ranking=prosody.fit(rows,X,True)
        self.assertEqual(absolute['rows'],16);self.assertEqual(ranking['strict_pairs'],4)
        for relative,values,labels in calls:
            if relative:
                self.assertEqual(set(labels),{0,1});self.assertEqual(len(labels),6)
            else:
                self.assertTrue(np.all(values[:,0]<16))
                np.testing.assert_array_equal(labels,((values[:,0]<4)|(values[:,0]>=8)).astype(int))

    def test_exact_private_frozen_provenance_is_required_before_any_fit(self):
        payload,private,snapshot=fixture()
        private['rows'][0]['start']=21
        with self.assertRaises(prosody.fl.FineLabelContractError):prosody.annotate_cohort(payload,private,snapshot)
        with self.assertRaises(prosody.fl.FineLabelContractError):prosody.labeled_cohort([dict(row='p1a',y=0)],np.zeros((1,2)))
        with self.assertRaises(ValueError):prosody.labeled_cohort([],np.zeros((1,2)))

if __name__=='__main__':unittest.main()
