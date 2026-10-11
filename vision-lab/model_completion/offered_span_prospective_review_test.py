"""Independent synthetic-only optimizer contract checks; no live generation or fitting."""
import contextlib
import io
import math
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import offered_span_prospective as subject


class ProspectiveOptimizerReview(unittest.TestCase):
    def test_grid_is_bounded_unique_and_inside_original(self):
        for width in (180.,181.,305.,799.,951.,1855.,5405.):
            original=[41.25,41.25+width]
            reference=[41.25,41.25+min(width,520.)]
            candidates=subject.grid(original,reference)
            self.assertLessEqual(len(candidates),128)
            self.assertEqual(len(candidates),len({tuple(r) for r in candidates}))
            self.assertIn(original,candidates)
            self.assertIn(reference,candidates)
            for a,b in candidates:
                self.assertTrue(original[0]<=a<b<=original[1])
                self.assertGreaterEqual(b-a,180.)
            self.assertEqual(candidates,subject.grid(original,reference))

    def test_grid_keeps_long_original_and_exact_human_edges(self):
        original=[50.25,2450.5]
        reference=[470.75,990.25]
        candidates=subject.grid(original,reference)
        self.assertIn(original,candidates)
        self.assertIn(reference,candidates)
        self.assertTrue(any(b-a>900 for a,b in candidates))

    def test_bad_or_too_short_reference_fails(self):
        for original,reference in (([0,120],[0,120]),([0,600],[0,179]),([0,600],[-1,180]),([0,600],[100,601]),([0,600],[300,200])):
            with self.assertRaises(ValueError):subject.grid(original,reference)

    def test_control_locations_obey_original_and_fixed_length(self):
        # Production control formula ensures >=60 seconds of location room.
        for original,reference_length in (([5.25,310.25],196.),([100.5,1880.5],1600.),([0,5000],720.)):
            length=min(reference_length,900.,original[1]-original[0]-60.)
            candidates=subject.locations(original,length)
            self.assertLessEqual(len(candidates),17)
            self.assertIn([original[0],original[0]+length],candidates)
            self.assertIn([original[1]-length,original[1]],candidates)
            for a,b in candidates:
                self.assertTrue(original[0]<=a<b<=original[1])
                self.assertAlmostEqual(b-a,length)

    def test_best_uses_primary_then_shorter_then_earlier(self):
        ranges=[[0,1200],[40,340],[10,310],[0,180]]
        values=[{'primary':4,'numeric':1000},{'primary':4,'numeric':1000},{'primary':4,'numeric':-1000},{'primary':3,'numeric':10000}]
        self.assertEqual(subject.best(ranges,values),2)
        # If reference wins, the generator cannot force the second-best challenger.
        values[0]['primary']=5
        self.assertEqual(subject.best(ranges,values),0)
        self.assertEqual(subject.iou(ranges[0],ranges[0]),1.)

    def test_same_pair_suppresses_duplicate_control_regardless_of_side_order(self):
        # Reference is an endpoint and optimized best has that exact same length.
        candidate=[[300.,600.],[0.,300.]]
        control=[[300.,600.],[0.,300.]]
        self.assertTrue(subject.same_pair(candidate,control))
        self.assertTrue(subject.same_pair(candidate,list(reversed(control))))
        self.assertFalse(subject.same_pair(candidate,[[300.,600.],[1.,301.]]))

    def test_iou_is_about_overlap_not_absolute_quality(self):
        self.assertEqual(subject.iou([0,180],[180,360]),0.)
        self.assertAlmostEqual(subject.iou([0,240],[60,300]),.6)
        self.assertAlmostEqual(subject.iou([0,300],[0,180]),.6)

    def test_scores_all_frozen_heads_with_exact_offered_range(self):
        numeric=np.arange(13,dtype=float)
        visual=np.zeros(1152);visual[0]=1.
        heads={kind:{'bias':i,'numeric_weights':[1.]*13,'visual_weights':[1.]*1152,'duration_weights':[2.,3.]} for i,kind in enumerate(('primary','predecessor','numeric'))}
        inputs=(object(),object(),[],{},Path('/not-read.npz'))
        source={'channel_key':'synthetic'};raw={};bounds=[30.,1230.]
        with patch.object(subject.frames.numeric,'domain_features',return_value=(numeric,visual)) as recipe:
            scores=subject.scores(heads,raw,source,inputs,bounds)
        recipe.assert_called_once_with({'group':'synthetic'},source,raw,inputs[0],inputs[1],inputs[2],*bounds)
        expected=float(numeric.sum()+1+3*math.log(1200/900))
        self.assertEqual(set(scores),set(heads))
        self.assertAlmostEqual(scores['primary'],expected)
        self.assertAlmostEqual(scores['predecessor'],expected+1)
        self.assertAlmostEqual(scores['numeric'],expected+2)

    def test_scores_reject_unsupported_means_and_nonfinite_head_outputs(self):
        valid_x=np.zeros(13);valid_v=np.zeros(1152);valid_v[0]=1.
        heads={kind:{'bias':0.,'numeric_weights':[0.]*13,'visual_weights':[0.]*1152,'duration_weights':[0.,0.]} for kind in ('primary','predecessor','numeric')}
        inputs=(None,None,[],{},Path('/not-read.npz'))
        invalid=[(valid_x,None),(valid_x,np.zeros(1152)),(valid_x,valid_v*2),(valid_x,np.ones(1151)),(np.zeros(12),valid_v),(np.full(13,np.nan),valid_v),(valid_x,np.full(1152,np.inf))]
        for features in invalid:
            with patch.object(subject.frames.numeric,'domain_features',return_value=features),self.assertRaises(ValueError):
                subject.scores(heads,{}, {'channel_key':'synthetic'},inputs,[0.,180.])
        heads['primary']['bias']=math.inf
        with patch.object(subject.frames.numeric,'domain_features',return_value=(valid_x,valid_v)),self.assertRaises(ValueError):
            subject.scores(heads,{}, {'channel_key':'synthetic'},inputs,[0.,180.])
        heads.pop('primary')
        with patch.object(subject.frames.numeric,'domain_features',return_value=(valid_x,valid_v)),self.assertRaises(ValueError):
            subject.scores(heads,{}, {'channel_key':'synthetic'},inputs,[0.,180.])

    def test_prepare_pins_runtime_recipe_before_scores_without_writes(self):
        original_digest=subject.base.digest
        captured={}
        def digest(path):
            return '0'*64 if str(path).startswith('/not-written/') else original_digest(path)
        def capture(path,value):captured[str(path)]=value
        with patch.object(subject.base,'digest',side_effect=digest),patch.object(subject.base,'save_frozen',side_effect=capture),contextlib.redirect_stdout(io.StringIO()):
            spec=subject.prepare(Path('/not-written'))
        self.assertIn('/not-written/before-generation-v2.json',captured)
        expected=[subject.frames.numeric,subject.frames.numeric.recipe,subject.frames,subject.view,subject.safe.previous,subject.safe,subject.rank,subject.rank.old]
        for module in expected:
            path=str(Path(module.__file__).resolve())
            self.assertEqual(spec['helper_sources'][path],original_digest(path))
        self.assertIn(str(Path(subject.__file__).with_name('offered_span_apply.py').resolve()),spec['helper_sources'])
        self.assertIn(str(Path(subject.__file__).with_name('offered_span_intake.py').resolve()),spec['helper_sources'])
        self.assertFalse(spec['production_model_activation'])


if __name__=='__main__':unittest.main()
