"""Full-recording numeric contract tests; all inputs synthetic, no DB/media/fits."""
import copy,json,math,unittest
from pathlib import Path
import numpy as np
import whole_review_inputs as model


def vector(a,b=0.):
    v=np.zeros(1152);v[0]=a;v[1]=b;return v

def head():
    return {'schema_version':1,'kind':'current_whole_recording_linear','target':model.TARGET,'feature_recipe':model.RECIPE,'feature_names':model.FEATURES.copy(),'visual_recipe':model.VISUAL_RECIPE,'weights':[0.]*8,'visual_weights':[0.]*1152,'bias':0.,'enabled':False,'probability_calibrated':False,'automatic_action':False}


class WholeRecordingInputTest(unittest.TestCase):
    def test_no_proposals_still_uses_entire_visual_sequence(self):
        x,v=model.features([],20,[0,5,10,15],[vector(2)]*4)
        self.assertEqual(x[1:5],[0.,0.,0.,0.]);self.assertEqual(x[5:],[0.,0.,1.]);self.assertEqual(v[0],1.);self.assertEqual(sum(v[1:]),0.)

    def test_union_coverage_does_not_count_overlaps_twice(self):
        proposals=[{'id':'a','start':0.,'end':10.,'score':.2},{'id':'b','start':5.,'end':20.,'score':.6},{'id':'c','start':20.,'end':25.,'score':.8}]
        x,_=model.features(proposals,25,[0,5,10,15,20],[vector(1)]*5)
        self.assertAlmostEqual(x[1],math.log1p(3));self.assertAlmostEqual(x[2],1.6/3);self.assertEqual(x[3],.8);self.assertEqual(x[4],1.)

    def test_mean_normalizes_each_frame_and_transitions_use_full_sequence(self):
        x,v=model.features([],10,[0,5],[vector(2),vector(0,3)])
        self.assertAlmostEqual(v[0],1/math.sqrt(2));self.assertAlmostEqual(v[1],1/math.sqrt(2))
        self.assertAlmostEqual(x[5],1-1/math.sqrt(2));self.assertAlmostEqual(x[6],1.)

    def test_annotations_kept_cuts_and_added_proposals_are_not_features(self):
        source=[{'id':'a','start':0.,'end':20.,'score':.4}];annotated=copy.deepcopy(source)
        annotated[0].update(verdict='skip',keep=False,kept_cut=[4,7],best=[4,7],whole_review='keep')
        annotated.append({'id':'added-manual','start':200.,'end':300.,'score':.99})
        args=(20,[0,5,10,15],[vector(1)]*4);before=copy.deepcopy(annotated)
        self.assertEqual(model.features(source,*args),model.features(annotated,*args));self.assertEqual(annotated,before)

    def test_missing_zero_cancelling_wrong_width_and_gaps_fail(self):
        malformed=[(10,[0,5],[vector(0),vector(1)]),(10,[0,5],[vector(1),vector(-1)]),(10,[0],[np.zeros(1151)]),(20,[6,11,16],[vector(1)]*3),(30,[0,15,20],[vector(1)]*3),(20,[0,5],[vector(1),vector(1)]),(10,[5,0],[vector(1),vector(1)]),(20,[0,21],[vector(1),vector(1)]),(10,[0,5],[vector(1e200),vector(1)])]
        for duration,t,v in malformed:
            with self.assertRaises(ValueError):model.features([],duration,t,v)

    def test_actual_duration_original_bounds_and_proposal_identity_are_strict(self):
        for duration in (True,0.,-1.,math.inf):
            with self.assertRaises(ValueError):model.features([],duration,[],[])
        for proposals in ([{'id':'a','start':0.,'end':20.1,'score':.5}],[{'id':'a','start':0.,'end':20.,'score':True}],[{'id':'a','start':0.,'end':20.,'score':float('inf')}],[{'id':True,'start':0.,'end':20.,'score':.5}],[{'id':'a','start':0.,'end':10.,'score':.5}]*2):
            with self.assertRaises(ValueError):model.features(proposals,20,[],[])

    def test_original_z_scores_are_raw_finite_inputs_not_probabilities(self):
        x,_=model.features([{'id':'a','start':0.,'end':10.,'score':2.27},{'id':'b','start':10.,'end':20.,'score':-.3}],20,[],[])
        self.assertAlmostEqual(x[2],.985);self.assertEqual(x[3],2.27)
        with self.assertRaises(ValueError):model.features([{'id':'a','start':0.,'end':10.,'score':1.7e308},{'id':'b','start':10.,'end':20.,'score':1.7e308}],20,[],[])

    def test_numeric_only_missing_frames_cannot_score_visual_head(self):
        x,v=model.features([],20,[],[]);self.assertIsNone(v);self.assertEqual(x[-1],0.)
        h=head();h['weights'][0]=2;h['bias']=.3;self.assertAlmostEqual(model.score(h,x,v),2*math.log(20)+.3)
        h['visual_weights'][0]=1.
        with self.assertRaises(ValueError):model.score(h,x,v)

    def test_portable_schema_rejects_wrong_target_recipe_dimensions_and_booleans(self):
        x,v=model.features([],20,[0,5,10,15],[vector(1)]*4)
        mutations=[{'schema_version':True},{'schema_version':2},{'enabled':1},{'target':'clip_acceptance'},{'feature_recipe':'recording-v1'},{'feature_names':list(reversed(model.FEATURES))},{'visual_recipe':'proposal_mean'},{'weights':[0.]*7},{'weights':[True]+[0.]*7},{'visual_weights':[False]+[0.]*1151},{'bias':math.inf},{'probability_calibrated':True},{'automatic_action':True},{'unexpected':0}]
        for change in mutations:
            with self.assertRaises(ValueError):model.score(dict(head(),**change),x,v)
        h=head();h.pop('enabled')
        with self.assertRaises(ValueError):model.score(h,x,v)
        for changed_x in ([True]+x[1:],np.zeros(7)):
            with self.assertRaises(ValueError):model.score(head(),changed_x,v)
        h=head();h['enabled']=True;self.assertEqual(model.score(h,x,v),0.)

    def test_two_frozen_synthetic_parity_fixtures(self):
        fixture=json.loads(Path(__file__).with_name('fixtures').joinpath('whole_review_parity.json').read_text());self.assertTrue(fixture['synthetic_only'])
        self.assertEqual(len(fixture['cases']),2)
        for case in fixture['cases']:
            i=case['inputs'];x,v=model.features(i['proposals'],i['duration_seconds'],i['timestamps'],i['vectors']);np.testing.assert_allclose(x,case['expected']['features'],rtol=0,atol=1e-13);np.testing.assert_allclose(v,case['expected']['visual_mean'],rtol=0,atol=1e-13);self.assertAlmostEqual(model.score(fixture['head'],x,v),case['expected']['score'],13)


if __name__=='__main__':unittest.main()
