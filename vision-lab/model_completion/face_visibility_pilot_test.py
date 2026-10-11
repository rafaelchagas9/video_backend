"""Disposable synthetic contracts; no real offers, media, DB or model execution."""
import copy,datetime,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import numpy as np
import face_visibility_pilot as s

class FaceVisibility(unittest.TestCase):
 def vtt(self):
  return 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n/api/videos/6209/storyboard/pages/0.webp?v=test.vtt#xywh=0,0,456,256\n\n00:00:05.000 --> 00:00:10.000\n/api/videos/6209/storyboard/pages/0.webp?v=test.vtt#xywh=456,0,456,256\n\n'
 def test_fixed_sampling_preserves_all_candidate_points_and_original_coverage(self):
  t=np.arange(0,1560,5.);a=s.selected_points(t,[0,1558.02],[1378.02,1558.02]);self.assertLessEqual(len(a),128);self.assertEqual(a[0],0);self.assertEqual(a[-1],len(t)-1)
  self.assertTrue(set(np.flatnonzero(t>=1378.02))<=set(a));np.testing.assert_array_equal(a,s.selected_points(t,[0,1558.02],[1378.02,1558.02]))
 def test_sampling_rejects_overbudget_or_missing_candidate_without_adapting(self):
  with self.assertRaises(ValueError):s.selected_points(np.arange(0,1000,5.),[0,995],[0,995])
  with self.assertRaises(ValueError):s.selected_points(np.arange(0,100,5.),[0,95],[101,105])
 def test_vtt_exact_source_version_geometry_and_timestamp_binding(self):
  parsed=s.vtt_tiles(self.vtt(),6209,[0,5],'test.vtt');self.assertEqual(parsed[1]['xywh'],[456,0,456,256])
  for text in [self.vtt().replace('/6209/','/6208/'),self.vtt().replace('test.vtt','old.vtt'),self.vtt().replace('456,0,456','0,0,456'),self.vtt().replace('00:00:05.000 -->','00:00:06.000 -->'),self.vtt().replace('pages/0.webp','pages/1.webp')]:
   with self.subTest(text=text[:20]),self.assertRaises(ValueError):s.vtt_tiles(text,6209,[0,5],'test.vtt')
 def test_tiny_face_is_numeric_evidence_without_identity_or_size_cutoff(self):
  r=s.normalize_detections([[1,2,2,3,.51]],456,256);self.assertTrue(r['detected']);self.assertAlmostEqual(r['max_box_area_fraction'],1/(456*256));self.assertNotIn('embedding',r)
  absent=s.normalize_detections(np.empty((0,5)),456,256);self.assertFalse(absent['detected']);self.assertEqual(absent['max_confidence'],0)
 def test_invalid_confidence_boxes_and_nonfinite_fail_closed(self):
  for b in [[[1,2,3,4,.49]],[[1,2,3,4,1.1]],[[1,2,0,4,.9]],[[500,2,600,4,.9]],[[1,2,3,4,float('nan')]],[[1,2,3,4]]]:
   with self.subTest(b=b),self.assertRaises(ValueError):s.normalize_detections(b,456,256)
 def test_sampled_absence_and_partial_coverage_never_become_cut_or_whole_truth(self):
  planned=[{'timestamp':0},{'timestamp':5},{'timestamp':10}];r=s.range_summary([{'timestamp':5,**s.normalize_detections([],456,256)}],[0,10],planned)
  self.assertEqual(r['planned_point_samples'],3);self.assertEqual(r['processed_point_samples'],1);self.assertFalse(r['absence_is_ground_truth']);self.assertFalse(r['duration_coverage_estimated'])
 def test_total_read_and_fingerprint_bounds_precede_file_contents(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'numeric';p.write_bytes(b'abc');reads=s.Reads();self.assertEqual(reads.read(p,3),b'abc')
   with self.assertRaises(ValueError):reads.read(p,2)
   fp=s.fingerprint(p);p.write_bytes(b'abcd')
   with self.assertRaises(ValueError):reads.read(p,5,fp)
   with self.assertRaises(ValueError):reads.charge(s.MAX_READS)
 def test_content_addressed_private_versions_do_not_overwrite(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);a=s.save_version(root,'result',{'frames':[1]});b=s.save_version(root,'result',{'frames':[2]});self.assertNotEqual(a,b);self.assertEqual(s.save_version(root,'result',{'frames':[1]}),a);self.assertEqual(a.stat().st_mode&0o777,0o600)
 def test_detector_constructs_only_cpu_detection_with_two_threads(self):
  ort=types.ModuleType('onnxruntime');options=types.SimpleNamespace();ort.SessionOptions=lambda:options;ort.ExecutionMode=types.SimpleNamespace(ORT_SEQUENTIAL='sequential')
  zoo=types.ModuleType('insightface.model_zoo');model=Mock();model.taskname='detection';model.session.get_providers.return_value=['CPUExecutionProvider'];zoo.get_model=Mock(return_value=model)
  parent=types.ModuleType('insightface');parent.__path__=[]
  with patch.dict('sys.modules',{'onnxruntime':ort,'insightface':parent,'insightface.model_zoo':zoo}):self.assertIs(s.detector(),model)
  self.assertEqual(options.intra_op_num_threads,2);self.assertEqual(options.inter_op_num_threads,1);self.assertEqual(zoo.get_model.call_args.kwargs['providers'],['CPUExecutionProvider']);model.prepare.assert_called_once_with(ctx_id=-1,input_size=(640,640),det_thresh=.5,nms_thresh=.4)
  model.session.get_providers.return_value=['CUDAExecutionProvider']
  with patch.dict('sys.modules',{'onnxruntime':ort,'insightface':parent,'insightface.model_zoo':zoo}),self.assertRaises(ValueError):s.detector()
 def test_generation_timestamp_uses_the_existing_utc_millisecond_contract(self):
  self.assertEqual(s.stamp(datetime.datetime(2026,10,10,1,2,3,123456)),'2026-10-10T01:02:03.123Z')
  self.assertEqual(s.stamp(datetime.datetime(2026,10,9,22,2,3,123456,tzinfo=datetime.timezone(datetime.timedelta(hours=-3)))),'2026-10-10T01:02:03.123Z')
 def test_manifest_pin_fails_without_reading_any_outcomes(self):
  reader=Mock();reader.read.return_value=b'{}'
  with self.assertRaisesRegex(ValueError,'manifest'):s.load_offer(reader)

if __name__=='__main__':unittest.main()
