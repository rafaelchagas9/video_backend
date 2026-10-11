"""Disposable synthetic contracts only; no real images/model/DB/outcomes."""
import copy,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import temporal_face_requests_v2 as f

class Tests(unittest.TestCase):
 def request(self):
  times=np.arange(101)*5.;identity={'video_id':1,'duration':500.,'analyzed_at':'generation','source_fingerprint':{},'index':{'frame_count':101,'model_revision':f.base.VISUAL_PIN,'interval_seconds':5},'proposals':[{'id':'original-1','start':0.,'end':500.,'score':2.27}]};key=f.face.digest(identity);indices=sorted(set(f.uniform(times,[0,500],72))|set(f.uniform(times,[100,300],24)));source={'identity':identity,'group':'creator','frame_checkpoint':{'path':'/unused','sha256':'unused','identity_sha256':key},'full_timestamps':times.tolist(),'feedback_ids':[1],'rows':[{'feedback_id':1,'original_range':[0.,500.],'control_range':[100.,300.],'point_indices':indices}],'planned_indices':indices};return {'schema_version':1,'fits':0,'queue_writes':0,'labels_used_for_scoring':False,'sources':{key:source},'requested_face_points':len(indices)},key,source
 def point(self,index=0):
  meta={'index':index,'timestamp':index*5.,'cue_end':index*5.+5,'page':0,'extension':'webp','xywh':[0,0,256,342]};return meta,dict(meta,**f.face.normalize_detections([],256,342))
 def test_v1_frozen_and_sampling_recipe_unchanged(self):
  import hashlib,temporal_face_requests as v1
  self.assertEqual(hashlib.sha256(Path(v1.__file__).read_bytes()).hexdigest(),'57c93e9958c10c5e8fdc9a7f72b4614489332a76d7c793f4c8a7c2445baff5eb')
  self.assertEqual(f.MAX_READS,1280*1024**2);self.assertEqual(f.MAX_SECONDS,v1.MAX_SECONDS);self.assertEqual(f.POLICY['recipe'],v1.POLICY['recipe']);self.assertEqual(f.POLICY['model_sha256'],v1.POLICY['model_sha256']);self.assertEqual(f.POLICY['input_size'],v1.POLICY['input_size']);self.assertFalse(f.POLICY['GPU'])
 def test_uniform_exact72_24_inside_no_copy(self):
  r,k,s=self.request();self.assertEqual(len(f.uniform(s['full_timestamps'],[0,500],72)),72);self.assertEqual(len(f.uniform(s['full_timestamps'],[100,300],24)),24);self.assertEqual(f.validate_request(r,[]),r['sources']);self.assertEqual(f.uniform([0,5,10],[2,8],72),[1])
 def test_reserved_rejected_before_timeline(self):
  r,_,_=self.request()
  with patch.object(f,'timeline',side_effect=AssertionError('not read')):
   with self.assertRaises(ValueError):f.validate_request(r,['creator'])
 def test_request_sampling_feedback_geometry_generation_failclosed(self):
  r,k,s=self.request()
  for mutate in ('point','range','duplicate','time','proposal','unknown'):
   value=copy.deepcopy(r);item=value['sources'][k]
   if mutate=='point':item['planned_indices']=item['planned_indices'][1:]
   elif mutate=='range':item['rows'][0]['control_range']=[-1,300]
   elif mutate=='duplicate':item['rows'].append(copy.deepcopy(item['rows'][0]))
   elif mutate=='time':item['full_timestamps'][1]=6
   elif mutate=='proposal':item['identity']['proposals'][0]['score']=float('nan')
   else:value['labels_used_for_scoring']=True
   with self.assertRaises(ValueError):f.validate_request(value,[])
 def test_numeric_header_timeline_without_loading_embeddings(self):
  _,k,s=self.request()
  def payload(width=1152):
   b=io.BytesIO();np.savez(b,t=np.asarray(s['full_timestamps']),v=np.zeros((101,width),np.float32),identity_sha256=np.asarray(k));return b.getvalue()
  class Reads:
   def __init__(self,raw):self.raw=raw
   def read(self,*_,**__):return self.raw
  self.assertEqual(len(f.timeline(s,Reads(payload()))),101)
  with self.assertRaises(ValueError):f.timeline(s,Reads(payload(12)))
 def test_checkpoint_missing_falsecomplete_and_conflicts(self):
  meta,point=self.point();s={'identity':{'id':1},'frames':[meta]};v=f.checkpoint('key',s,[point],'request','receipt');self.assertEqual(f.checked_frames(v,'key',s,'request','receipt'),[point]);partial=f.checkpoint('key',s,[],'request','receipt');self.assertFalse(partial['complete']);partial['complete']=True
  with self.assertRaises(ValueError):f.checked_frames(partial,'key',s,'request','receipt')
  points={};f.merge(points,[point]);different=dict(point,detected=True)
  with self.assertRaises(ValueError):f.merge(points,[different])
 def test_portrait_and_short_last_page_geometry(self):
  self.assertEqual(f.old.validate_page_geometry(1280,1710,256,342,0,25),(1280,1710));self.assertEqual(f.old.validate_page_geometry(1824,256,456,256,15,379),(1824,256))
  with self.assertRaises(ValueError):f.old.validate_page_geometry(2280,256,456,256,15,379)
 def test_ssd_byte_cap_fingerprint_and_timeout(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'private';p.write_bytes(b'abc');reads=f.Reads(d);self.assertEqual(reads.read(p,3),b'abc')
   with self.assertRaises(ValueError):reads.read(p,2)
   with self.assertRaises(ValueError):reads.read(p,3,checksum='wrong')
   reads.total=f.MAX_READS
   with self.assertRaises(ValueError):reads.charge(1)
   with patch.object(f,'STARTED',0):
    with self.assertRaises(TimeoutError):f.check()
 def test_lock_no_duplicate_prepare_run(self):
  with tempfile.TemporaryDirectory() as d,patch.object(f,'LOCK',Path(d)/'worker.lock'):
   lock=f.acquire()
   try:
    self.assertIsNone(f.acquire());self.assertEqual(f.prepare('/unused','unused')['status'],'busy_lock_no_execution');self.assertEqual(f.run('/unused')['status'],'busy_lock_no_execution')
   finally:lock.close()
 def test_projection_includes_double_page_and_model_pass(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'file';p.write_bytes(b'abc');s={'frame_checkpoint':{'path':str(p)},'vtt':{'path':str(p)},'pages':{'0':{'fingerprint':{'size_bytes':100}}}};self.assertEqual(f.projected_reads(17,{'k':s},11),11+34+6+200+32*1024**2)
 def test_reuse_only_same_pinned_page_bytes(self):
  meta,point=self.point();identity={'video_id':1};k=f.face.digest(identity);s={'identity':identity,'group':'g','frames':[meta],'pages':{'0':{'path':'/same','fingerprint':{},'sha256':'same','size':[1280,1710]}}};r={'policy':f.old.POLICY,'source_sha256':f.face.digest(Path(f.old.__file__).read_bytes()),'pilot_helper_sha256':f.face.digest(Path(f.face.__file__).read_bytes()),'model':{'sha256':f.face.MODEL_SHA},'sources':{k:s}}
  class Reads:
   def read(self,p,*_,**__):return Path(p).read_bytes()
  with tempfile.TemporaryDirectory() as d:
   raw=json.dumps(r).encode();sha=f.face.digest(raw);p=Path(d)/f'inputs.{sha}.json';p.write_bytes(raw);cp={'input_receipt_sha256':sha,'source_key':k,'identity':identity,'policy':f.old.POLICY,'frames':[point],'complete':True};f.face.save_version(Path(d)/'sources'/k,'checkpoint',cp);self.assertEqual(f.reusable(p,{k:s},Reads())[0],{k:[point]});bad=copy.deepcopy(s);bad['pages']['0']['sha256']='changed'
   with self.assertRaises(ValueError):f.reusable(p,{k:bad},Reads())
 def test_numeric_consumer_complete_identity_recipe_no_media(self):
  meta,point=self.point();identity={'video_id':1};key=f.face.digest(identity);s={'identity':identity,'group':'creator','frames':[meta]};receipt={'policy':f.POLICY,'request_sha256':'request','model':{'sha256':f.face.MODEL_SHA},'sources':{key:s},'excluded_holdout_creators':['reserved'],'source_pins':[]}
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);rp=f.face.save_version(root,'inputs',receipt);rs=f.face.digest(rp.read_bytes());value=f.checkpoint(key,s,[point],'request',rs);f.publish_complete(root,key,value);self.assertEqual(f.load_numeric_source(root,key,'request',identity,f.Reads(root))[0],[point]);self.assertEqual((root/f'{key}.json').stat().st_mode&0o777,0o600)
   with self.assertRaises(ValueError):f.load_numeric_source(root,key,'changed',identity,f.Reads(root))
   with self.assertRaises(ValueError):f.publish_complete(root,'partial',dict(value,complete=False))
 def test_busy_prepare_no_request_metadata_or_model_read(self):
  class Lock:
   def close(self):pass
  with patch.object(f,'acquire',return_value=Lock()),patch.object(f.face,'busy_workers',return_value=True),patch.object(f,'Reads',side_effect=AssertionError('not read')):
   self.assertEqual(f.prepare('/unused','unused')['status'],'busy_workers_no_execution')
if __name__=='__main__':unittest.main()
