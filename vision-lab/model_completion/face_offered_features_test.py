"""Synthetic only: no images, actual extraction, DB, model loading or outcomes."""
import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import face_offered_features as f
class Tests(unittest.TestCase):
 def frame(self,index=0):
  metadata={'index':index,'timestamp':index*5.,'cue_end':index*5.+5,'page':index//25,'extension':'webp','xywh':[0,0,456,256]}
  return metadata,dict(metadata,**f.face.normalize_detections([[100,50,120,70,.6]],456,256))
 def test_sampling_inside_uniform_and_unchanged_by_outcomes(self):
  t=np.arange(400)*5.;a=f.sample_indices(t,[1378.02,1558.02]);self.assertEqual(len(a),24);self.assertTrue(all(1378.02<=t[i]<=1558.02 for i in a));self.assertEqual(a,f.sample_indices(t,[1378.02,1558.02]));self.assertEqual(a[0],276);self.assertEqual(a[-1],311)
 def test_short_range_no_duplication_or_outside_fill(self):
  self.assertEqual(f.sample_indices(np.arange(20)*5.,[2,12]),[1,2])
  with self.assertRaises(ValueError):f.sample_indices(np.arange(20)*5.,[2,4])
 def test_shared_points_own_denominator(self):
  _,a=self.frame(0);_,b=self.frame(1);b.update(f.face.normalize_detections([],456,256))
  out=f.aggregate([{'row':'long','offered_range':[0,10],'point_indices':[0,1]},{'row':'short','offered_range':[0,5],'point_indices':[0]}],[a,b]);self.assertEqual(out[0]['features'][0],.5);self.assertEqual(out[1]['features'][0],1.);self.assertFalse(out[0]['continuous_coverage_estimated'])
 def test_missing_not_face_zero(self):
  _,a=self.frame()
  with self.assertRaises(ValueError):f.aggregate([{'row':'x','offered_range':[0,10],'point_indices':[0,1]}],[a])
 def test_checkpoint_rejects_empty_false_complete_and_changed_generation(self):
  meta,frame=self.frame();source={'identity':{'video_id':1},'frames':[meta]};value={'input_receipt_sha256':'h','source_key':'k','identity':source['identity'],'policy':f.POLICY,'frames':[frame],'complete':True}
  self.assertEqual(f.validate_checkpoint(value,'k',source,'h'),[frame])
  for changes in ({'frames':[]},{'identity':{'video_id':2}},{'input_receipt_sha256':'other'},{'complete':False}):
   altered=copy.deepcopy(value);altered.update(changes)
   with self.assertRaises(ValueError):f.validate_checkpoint(altered,'k',source,'h')
 def test_duplicate_or_wrong_timestamp_and_corrupt_area_rejected(self):
  meta,a=self.frame();source={'identity':{'video_id':1},'frames':[meta]};base={'input_receipt_sha256':'h','source_key':'k','identity':source['identity'],'policy':f.POLICY,'frames':[a],'complete':True}
  for mut in ('duplicate','timestamp','area','nan'):
   x=copy.deepcopy(base)
   if mut=='duplicate':x['frames'].append(copy.deepcopy(a))
   elif mut=='timestamp':x['frames'][0]['timestamp']=5
   elif mut=='area':x['frames'][0]['boxes'][0]['area_fraction']=.9
   else:x['frames'][0]['max_confidence']=float('nan')
   with self.assertRaises(ValueError):f.validate_checkpoint(x,'k',source,'h')
 def test_reserve_and_original_range_contract(self):
  identity={'video_id':1,'analyzed_at':'gen','source_fingerprint':{},'index':{},'duration':100.,'proposals':[{'start':0,'end':100}]};row=dict(identity,row='r',feedback_id=1,original_range=[0,100],reserved_fine_holdout=False,fine_data_role='training');frame={'identity_sha256':f.source_key(identity)}
  item=f.label_free_row(row,identity,frame,'g',[10,50]);self.assertNotIn('answer',item);self.assertNotIn('score',item)
  for value in ({'reserved_fine_holdout':True},{'analyzed_at':'wrong'},{'fine_data_role':'reserved_fine_holdout'}):
   x=dict(row,**value)
   with self.assertRaises(ValueError):f.label_free_row(x,identity,frame,'g',[10,50])
  with self.assertRaises(ValueError):f.label_free_row(row,identity,frame,'g',[0,110])
 def test_read_cap_and_atomic_private_immutability(self):
  reads=f.Reads();reads.charge(f.MAX_READS)
  with self.assertRaises(ValueError):reads.charge(1)
  with tempfile.TemporaryDirectory() as d:
   p=f.face.save_version(Path(d),'checkpoint',{'complete':False});q=f.face.save_version(Path(d),'checkpoint',{'complete':True});self.assertNotEqual(p,q);self.assertEqual(p.stat().st_mode&0o777,0o600);self.assertFalse(json.loads(p.read_text())['complete'])
 def test_numeric_detection_only_no_identity_empty_valid(self):
  meta,_=self.frame();a=dict(meta,**f.face.normalize_detections([],456,256));self.assertEqual(f.checked_result(a,meta),a);self.assertFalse(a['detected']);self.assertFalse(f.POLICY['identity_embeddings']);self.assertEqual(f.POLICY['provider'],'CPUExecutionProvider')
 def test_inputs_strip_outcomes_and_preserve92_bound_versions(self):
  identity={'video_id':1,'analyzed_at':'gen','source_fingerprint':{},'index':{},'duration':100.,'proposals':[{'start':0,'end':100}]};frame={'identity_sha256':f.source_key(identity),'sha256':'x','path':'/mock'}
  def row(i):return dict(identity,row=f'r{i}',feedback_id=1,group='g',original_range=[0,100],offered_range=[0,100],numeric_identity=identity,frame_checkpoint=frame,frame_cache='/mock',reserved_fine_holdout=False,fine_data_role='training',answer='secret',score=.9)
  cohort={'old_rows':[row(i) for i in range(48)],'version_rows':[row(i) for i in range(48,60)],'reserved_creators_excluded':['reserved']};manifest={'rows':[],'private_assignments':[],'excluded_holdout_creators':['reserved']}
  for i in range(16):
   item=dict(row(100+i),channel_key='g',range=[0,100]);context={'a':item,'b':item,'reserved_fine_holdout':False,'fine_data_role':'training'};manifest['rows'].append({'batch':'b','position':i,'context':context});manifest['private_assignments'].append({'batch':'b','position':i,'numeric_identity':identity,'frame_checkpoint':frame,'predictions':{'ignored':'secret'},'assignments':{'ignored':'secret'}})
  ca=json.dumps(cohort).encode();ma=json.dumps(manifest).encode()
  class Reads:
   def read(self,path,_):return ca if path==f.COHORT else ma
  with patch.object(f,'COHORT_SHA',f.face.digest(ca)),patch.object(f,'MANIFEST_SHA',f.face.digest(ma)):
   got=f.inputs(Reads());self.assertEqual(len(got['rows']),92);self.assertEqual(len(got['sources']),1);encoded=json.dumps(got);self.assertNotIn('secret',encoded);self.assertNotIn('predictions',encoded);self.assertNotIn('assignments',encoded)
if __name__=='__main__':unittest.main()
