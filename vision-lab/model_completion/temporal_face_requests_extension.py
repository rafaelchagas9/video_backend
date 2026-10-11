"""Extension: extra frozen proposals, same CPU detector, bounded2GiB SSD reads.
Preserves version1/version2; no raw media, recognition, fits or queue writes.
"""
from __future__ import annotations
import argparse,copy,fcntl,io,json,math,os,re,signal,time,zipfile
STARTED=time.monotonic()
from pathlib import Path
import numpy as np
from PIL import Image
import face_offered_features_v3 as old
import temporal_face_requests_v2 as prior
import face_visibility_pilot as face
import targeted_label_round as base
ROOT=face.ROOT;OUT=ROOT/'temporal-validation50-face-extension-v1'
LOCK=face.BACKEND/'data/models/recording-audio-jobs/.worker.lock'
MAX_SECONDS=1200;MAX_READS=2*1024**3;MAX_PAGE=32*1024**2;MAX_POINTS=3200;MAX_SOURCES=32;MAX_ROWS=32
POLICY={'schema_version':3,'recipe':'frozen_uniform72_original_union24_old_control_detection_v1','model_sha256':face.MODEL_SHA,'provider':'CPUExecutionProvider','threads':2,'input_size':[640,640],'confidence':.5,'nms':.4,'sampling':'Exactly72 uniform existing point indices within each original union24 within frozen oldC; shared by full recording generation. No label/face-driven points.','max_seconds':MAX_SECONDS,'max_read_bytes':MAX_READS,'max_page_bytes':MAX_PAGE,'max_points':MAX_POINTS,'max_sources':MAX_SOURCES,'one_sprite_at_a_time':True,'identity_embeddings':False,'GPU':False,'raw_media_reads':0,'fits':0,'queue_writes':0,'cloud':False,'missing':'Partial points remain unavailable; never face-zero imputation.','reuse':'Only complete pinned baseV2 source points with exact model/recipe, full numeric source identity and index/timestamp/crop/page bytes.'}

def check():
 if time.monotonic()-STARTED>=MAX_SECONDS:raise TimeoutError('Twenty-minute CPU face request budget expired')

class Reads:
 def __init__(self,root=ROOT):self.device=Path(root).stat().st_dev;self.total=0
 def charge(self,size):
  check()
  if type(size) is not int or size<0 or self.total+size>MAX_READS:raise ValueError('TwoGiB request read budget exceeded')
  self.total+=size
 def read(self,path,limit,expected=None,checksum=None):
  path=Path(path)
  if not path.is_absolute() or path.resolve()!=path or not path.is_file():raise ValueError('Exact absolute SSD input path required')
  before=face.fingerprint(path)
  if before['device']!=self.device or before['size_bytes']>limit or (expected is not None and before!=expected):raise ValueError('Frozen SSD fingerprint/device/size differs')
  self.charge(before['size_bytes']);raw=path.read_bytes()
  if len(raw)!=before['size_bytes'] or face.fingerprint(path)!=before or (checksum is not None and face.digest(raw)!=checksum):raise ValueError('Pinned bytes changed')
  return raw

def uniform(times,bounds,count):
 t=np.asarray(times,float)
 if not isinstance(bounds,list) or len(bounds)!=2 or any(isinstance(z,bool) or not isinstance(z,(int,float)) or not math.isfinite(z) for z in bounds) or not 0<=bounds[0]<bounds[1]:raise ValueError('Finite original/control range required')
 ids=np.flatnonzero((t>=bounds[0])&(t<=bounds[1]))
 if not len(ids):raise ValueError('Range has no existing point indices')
 return ids[np.unique(np.linspace(0,len(ids)-1,min(count,len(ids))).astype(int))].tolist()

def validate_request(value,reserved):
 sources=value.get('sources')
 if value.get('schema_version')!=1 or value.get('fits')!=0 or value.get('queue_writes')!=0 or value.get('labels_used_for_scoring') is not False or not isinstance(sources,dict) or not 1<=len(sources)<=MAX_SOURCES:raise ValueError('Bounded outcome-free controls request required')
 rows=points=0;feedback=set()
 for key,s in sources.items():
  i=s['identity'];index=i['index'];group=s['group'];t=np.asarray(s['full_timestamps'],float)
  if not isinstance(group,str) or not group or group in reserved or base.canon(group)!=group or key!=face.digest(i) or s['frame_checkpoint']['identity_sha256']!=key:raise ValueError('Nonreserved canonical exact numeric source required')
  if type(i['video_id']) is not int or i['video_id']<=0 or type(index['frame_count']) is not int or not 1<=index['frame_count']<=8000 or index['model_revision']!=base.VISUAL_PIN or index['interval_seconds']!=5 or t.shape!=(index['frame_count'],) or not np.isfinite(t).all() or t[0]<0 or t[-1]>i['duration'] or t[0]>5.001 or t[-1]+10<i['duration'] or not np.allclose(np.diff(t),5,rtol=0,atol=.001):raise ValueError('Full exact frozen5s numeric index required')
  if isinstance(i['duration'],bool) or not isinstance(i['duration'],(int,float)) or not math.isfinite(i['duration']) or i['duration']<=0 or not isinstance(i['proposals'],list) or not 1<=len(i['proposals'])<=60:raise ValueError('Bounded finite original proposal universe required')
  ids=set()
  for proposal in i['proposals']:
   if not isinstance(proposal['id'],(str,int)) or isinstance(proposal['id'],bool) or str(proposal['id'])=='' or str(proposal['id']) in ids or any(isinstance(proposal[k],bool) or not isinstance(proposal[k],(int,float)) or not math.isfinite(proposal[k]) for k in ('start','end','score')) or not 0<=proposal['start']<proposal['end']<=i['duration']:raise ValueError('Exact finite original detector proposals required')
   ids.add(str(proposal['id']))
  planned=set();fids=[]
  for r in s['rows']:
   a,b=r['original_range'];c,d=r['control_range']
   if not 0<=a<=c<d<=b<=i['duration'] or len([p for p in i['proposals'] if [p['start'],p['end']]==[a,b]])!=1:raise ValueError('Exact original/control proposal geometry differs')
   expected=sorted(set(uniform(t,[a,b],72))|set(uniform(t,[c,d],24)))
   if r['point_indices']!=expected or type(r['feedback_id']) is not int or r['feedback_id']<=0 or r['feedback_id'] in feedback:raise ValueError('Exact fixed face sampling/feedback differs')
   feedback.add(r['feedback_id']);fids.append(r['feedback_id']);planned.update(expected);rows+=1
  if not fids or sorted(s['feedback_ids'])!=sorted(fids) or len(set(s['feedback_ids']))!=len(fids) or s['planned_indices']!=sorted(planned):raise ValueError('Whole source point/feedback inventory differs')
  points+=len(planned)
 if rows>MAX_ROWS or points>MAX_POINTS or value.get('requested_face_points')!=points:raise ValueError('Bounded total point/row inventory differs')
 return sources

def timeline(s,reads):
 r=s['frame_checkpoint'];raw=reads.read(r['path'],64*1024**2,checksum=r['sha256'])
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  if len(z.infolist())!=3 or set(z.namelist())!={'t.npy','v.npy','identity_sha256.npy'} or sum(f.file_size for f in z.infolist())>64*1024**2:raise ValueError('Bounded exact numeric checkpoint members required')
  # Validate matrix shape using only its header, without materializing embeddings.
  with z.open('v.npy') as member:
   version=np.lib.format.read_magic(member)
   if version==(1,0):shape,fortran,dtype=np.lib.format.read_array_header_1_0(member)
   elif version==(2,0):shape,fortran,dtype=np.lib.format.read_array_header_2_0(member)
   else:raise ValueError('Unsupported numeric NPY header version')
   if z.getinfo('v.npy').file_size!=member.tell()+int(np.prod(shape))*dtype.itemsize:raise ValueError('Frozen numeric matrix byte extent differs')
   if shape!=(s['identity']['index']['frame_count'],1152) or fortran or dtype!=np.dtype('float32'):raise ValueError('Frozen numeric frame header differs')
 with np.load(io.BytesIO(raw),allow_pickle=False) as z:
  if z['identity_sha256'].shape!=() or str(z['identity_sha256'])!=face.digest(s['identity']) or not np.array_equal(z['t'],np.asarray(s['full_timestamps'],float)):raise ValueError('Frozen full timeline identity differs')
 return np.asarray(s['full_timestamps'],float)

def live_metadata(sources):
 # Metadata only, no fine tasks/answers, no source-media reads and no image fallback.
 import psycopg
 ids=sorted({s['identity']['video_id'] for s in sources.values()});query='''SELECT v.id,v.file_path,v.is_available,r.analyzed_at,i.model_revision,i.frame_count,i.interval_seconds,i.storyboard_generated_at,i.indexed_at,s.sprite_path,s.vtt_path,s.tile_width,s.tile_height,s.tile_count,s.interval_seconds,s.generated_at FROM videos v JOIN recording_reviews r ON r.video_id=v.id JOIN video_visual_index i ON i.video_id=v.id JOIN storyboards s ON s.video_id=v.id WHERE v.id=ANY(%s)'''
 with psycopg.connect(base.pg_config(),connect_timeout=4) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='10s'");rows={r[0]:r for r in pg.execute(query,(ids,)).fetchall()}
 if set(rows)!=set(ids):raise ValueError('Exact cached source/storyboard metadata absent')
 out={}
 for key,s in sources.items():
  i=s['identity'];r=rows[i['video_id']];index={'model_revision':r[4],'frame_count':r[5],'interval_seconds':r[6],'storyboard_generated_at':base.stamp(r[7]),'indexed_at':base.stamp(r[8])}
  if r[2] is not True or base.stamp(r[3])!=i['analyzed_at'] or index!=i['index'] or base.source_fingerprint(r[1])!=i['source_fingerprint'] or r[13]!=index['frame_count'] or float(r[14])!=5 or base.stamp(r[15])!=index['storyboard_generated_at']:raise ValueError('Current source/index/storyboard generation drift')
  old.validate_tile_geometry(r[11],r[12]);out[key]={'source_path':str(Path(r[1]).resolve()),'sprite_path':str((base.BACKEND/r[9]).resolve()),'vtt_path':str((base.BACKEND/r[10]).resolve()),'tile_width':r[11],'tile_height':r[12],'tile_count':r[13],'interval_seconds':float(r[14]),'generated_at':base.stamp(r[15])}
 return out

def plan(s,metadata,reads):
 t=timeline(s,reads);vtt=Path(metadata['vtt_path']);raw=reads.read(vtt,2*1024**2);cues=face.vtt_tiles(raw.decode(),s['identity']['video_id'],t,vtt.name,width=metadata['tile_width'],height=metadata['tile_height']);frames=[cues[i] for i in s['planned_indices']];pattern=re.fullmatch(r'(.*)\.p0\.(webp|jpg)',metadata['sprite_path'])
 if not pattern:raise ValueError('Exact existing paged storyboard required')
 pages={}
 for f in frames:
  page=str(f['page'])
  if f['extension']!=pattern[2]:raise ValueError('VTT/sprite page extension differs')
  if page in pages:continue
  path=Path(pattern[1]+'.p'+page+'.'+pattern[2]);content=reads.read(path,MAX_PAGE)
  with Image.open(io.BytesIO(content)) as encoded:shape=encoded.size
  old.validate_page_geometry(*shape,metadata['tile_width'],metadata['tile_height'],int(page),len(t));pages[page]={'path':str(path),'fingerprint':face.fingerprint(path),'sha256':face.digest(content),'size':list(shape)}
 return dict(copy.deepcopy(s),storyboard=metadata,vtt={'path':str(vtt),'fingerprint':face.fingerprint(vtt),'sha256':face.digest(raw)},frames=frames,pages=pages)

def checked_frames(value,key,s,request_sha,receipt_sha):
 if value.get('request_sha256')!=request_sha or value.get('input_receipt_sha256')!=receipt_sha or value.get('source_key')!=key or value.get('identity')!=s['identity'] or value.get('policy')!=POLICY or value.get('model_sha256')!=face.MODEL_SHA or value.get('provider')!='CPUExecutionProvider' or value.get('identity_embeddings') is not False:raise ValueError('Face checkpoint request/model/source recipe differs')
 frames=value.get('frames');expected={f['index']:f for f in s['frames']}
 if not isinstance(frames,list) or len({f.get('index') for f in frames})!=len(frames) or any(f.get('index') not in expected for f in frames) or [f['index'] for f in frames]!=sorted(f['index'] for f in frames):raise ValueError('Face checkpoint planned point inventory differs')
 for f in frames:old.checked_result(f,expected[f['index']])
 if value.get('complete') is not (len(frames)==len(expected)):raise ValueError('Incomplete face sources remain unavailable')
 return frames

def checkpoint(key,s,frames,request_sha,receipt_sha):
 return {'schema_version':1,'request_sha256':request_sha,'input_receipt_sha256':receipt_sha,'source_key':key,'identity':s['identity'],'policy':POLICY,'model_sha256':face.MODEL_SHA,'provider':'CPUExecutionProvider','identity_embeddings':False,'frames':sorted(frames,key=lambda f:f['index']),'complete':len(frames)==len(s['frames'])}

def merge(points,frames):
 for f in frames:
  if f['index'] in points and points[f['index']]!=f:raise ValueError('Conflicting immutable face point checkpoints')
  points[f['index']]=f

# Base V2 points are immutable and remain in their original policy/receipt.
# Only validated point records are rebound to this extra request's own receipt.
def reusable(path,sources,reads):
 if path is None:raise ValueError('Extension requires a complete reviewed baseV2 input receipt')
 path=Path(path);raw=reads.read(path,16*1024**2);r=json.loads(raw);sha=face.digest(raw)
 if path.name!=f'inputs.{sha}.json' or r.get('policy')!=prior.POLICY or r.get('model',{}).get('sha256')!=face.MODEL_SHA:raise ValueError('Reusable baseV2 recipe/model receipt differs')
 for pin in r['source_pins']:reads.read(pin['path'],2*1024**2,checksum=pin['sha256'])
 if face.digest(reads.read(Path(prior.__file__).resolve(),2*1024**2))!=next((p['sha256'] for p in r['source_pins'] if p['path']==str(Path(prior.__file__).resolve())),None):raise ValueError('Exact frozen baseV2 extractor source pin absent')
 results={};pins=[]
 for key,s in sources.items():
  previous=r['sources'].get(key)
  if previous is None or previous['identity']!=s['identity'] or previous['group']!=s['group'] or previous['frame_checkpoint']!=s['frame_checkpoint'] or previous['full_timestamps']!=s['full_timestamps']:raise ValueError('Extension must reuse an exact baseV2 numeric source generation')
  cp=path.parent/f'{key}.json';payload=reads.read(cp,16*1024**2);value=json.loads(payload)
  frames=prior.checked_frames(value,key,previous,r['request_sha256'],sha)
  if value['complete'] is not True:raise ValueError('Partial baseV2 points unavailable for extension reuse')
  pins.append({'path':str(cp.resolve()),'sha256':face.digest(payload)})
  expected={f['index']:f for f in s['frames']};values={}
  for frame in frames:
   if frame['index'] not in expected:continue
   page=str(frame['page']);a=previous['pages'][page];b=s['pages'][page]
   if any(a[k]!=b[k] for k in ('path','fingerprint','sha256','size')):raise ValueError('Reusable exact baseV2 page bytes/geometry differ')
   old.checked_result(frame,expected[frame['index']]);merge(values,[frame])
  if values:results[key]=sorted(values.values(),key=lambda f:f['index'])
 return results,{'input_path':str(path.resolve()),'input_sha256':sha,'request_sha256':r['request_sha256'],'source_pins':r['source_pins'],'checkpoints':pins}

def projected_reads(model_size,sources,prepare_bytes):
 # One checksum pass and at most one decode pass over each page. Preparation
 # bytes also conservatively cover source/request/reuse receipt reads again.
 return prepare_bytes+2*model_size+sum(Path(s['frame_checkpoint']['path']).stat().st_size+Path(s['vtt']['path']).stat().st_size+2*sum(p['fingerprint']['size_bytes'] for p in s['pages'].values()) for s in sources.values())+32*1024**2

def load_numeric_source(root,key,request_sha,identity,reads=None):
 """Read-only consumer API: complete numeric points and their frozen provenance.
 Does not read images, source media, DB, model weights or any outcomes.
 """
 root=Path(root).resolve();reads=reads or Reads();raw=reads.read(root/f'{key}.json',16*1024**2);value=json.loads(raw);receipt_sha=value.get('input_receipt_sha256')
 if not isinstance(receipt_sha,str) or re.fullmatch('[a-f0-9]{64}',receipt_sha) is None:raise ValueError('Exact numeric input receipt digest required')
 receipt_path=root/f'inputs.{receipt_sha}.json';payload=reads.read(receipt_path,16*1024**2,checksum=receipt_sha);receipt=json.loads(payload)
 if receipt.get('policy')!=POLICY or receipt.get('request_sha256')!=request_sha or receipt.get('model',{}).get('sha256')!=face.MODEL_SHA or key not in receipt.get('sources',{}):raise ValueError('Numeric face receipt/request/model differs')
 for pin in receipt['source_pins']:reads.read(pin['path'],2*1024**2,checksum=pin['sha256'])
 source=receipt['sources'][key]
 if key!=face.digest(identity) or source['identity']!=identity or source['group'] in receipt['excluded_holdout_creators']:raise ValueError('Exact nonreserved numeric source differs')
 frames=checked_frames(value,key,source,request_sha,receipt_sha)
 if value['complete'] is not True:raise ValueError('Missing detector points unavailable to scoring')
 return frames,{'input_receipt_path':str(receipt_path),'input_receipt_sha256':receipt_sha,'checkpoint_path':str(root/f'{key}.json'),'checkpoint_sha256':face.digest(raw),'source_pins':receipt['source_pins'],'request_sha256':request_sha,'policy':POLICY,'source':source,'model':receipt['model']}

def source_pins(reads):
 return [{'path':str(p.resolve()),'sha256':face.digest(reads.read(p.resolve(),2*1024**2))} for p in [Path(__file__),Path(__file__).with_name('temporal_face_requests_extension_test.py'),Path(old.__file__),Path(face.__file__),Path(base.__file__),Path(prior.__file__),Path(prior.__file__).with_name('temporal_face_requests_v2_test.py')]]

def acquire():
 lock=LOCK.open('a+')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:lock.close();return None
 return lock

def prepare(request_path,request_sha,out=OUT,reuse_receipt=None):
 lock=acquire()
 if lock is None:return {'status':'busy_lock_no_execution'}
 try:
  if face.busy_workers():return {'status':'busy_workers_no_execution'}
  reads=Reads();raw=reads.read(Path(request_path),16*1024**2,checksum=request_sha);request=json.loads(raw)
  import connected_label_round as connected
  reserved,holdout=connected.holdout_contract();sources=validate_request(request,reserved);live=live_metadata(sources);model_raw=reads.read(face.MODEL.resolve(),32*1024**2,checksum=face.MODEL_SHA);planned={k:plan(s,live[k],reads) for k,s in sorted(sources.items())};reuse,reuse_pin=reusable(reuse_receipt,planned,reads);pins=source_pins(reads)
  projected=projected_reads(len(model_raw),planned,reads.total)
  if projected>MAX_READS:raise ValueError('Frozen complete run projection exceedsTwoGiB')
  value={'schema_version':1,'policy':POLICY,'source_pins':pins,'request_path':str(Path(request_path).resolve()),'request_sha256':request_sha,'holdout_dependency':holdout,'excluded_holdout_creators':sorted(reserved),'model':{'path':str(face.MODEL.resolve()),'fingerprint':face.fingerprint(face.MODEL),'sha256':face.MODEL_SHA},'sources':planned,'reuse_frames':reuse,'reuse_receipt':reuse_pin,'unique_points':sum(len(s['frames']) for s in planned.values()),'projected_run_read_bytes':projected,'preparation_read_bytes':reads.total,'source_contents_read':False,'fine_outcomes_read':False,'fits':0,'queue_writes':0};check();path=face.save_version(Path(out),'inputs',value)
  return {'status':'prepared_only','receipt_path':str(path),'request_sha256':request_sha,'sources':len(planned),'points':value['unique_points'],'reused_points':sum(len(v) for v in reuse.values()),'reads':reads.total}
 finally:lock.close()

def publish_complete(out,key,value):
 # A stable per-source file is created only on completeness; immutable version checkpoints preserve all progress.
 if value['complete'] is not True:raise ValueError('Cannot publish missing points as complete')
 from channel_partial_order import immutable_write
 immutable_write(Path(out)/f'{key}.json',value)

def run(receipt_path,out=OUT):
 lock=acquire()
 if lock is None:return {'status':'busy_lock_no_execution'}
 try:
  if face.busy_workers():return {'status':'busy_workers_no_execution'}
  os.nice(10);reads=Reads();raw=reads.read(Path(receipt_path),16*1024**2);r=json.loads(raw);receipt_sha=face.digest(raw)
  if Path(receipt_path).name!=f'inputs.{receipt_sha}.json' or r.get('policy')!=POLICY:raise ValueError('Frozen request extraction receipt differs')
  for pin in r['source_pins']:reads.read(pin['path'],2*1024**2,checksum=pin['sha256'])
  req=json.loads(reads.read(r['request_path'],16*1024**2,checksum=r['request_sha256']))
  import connected_label_round as connected
  reserved,holdout=connected.holdout_contract()
  if holdout!=r['holdout_dependency'] or sorted(reserved)!=r['excluded_holdout_creators']:raise ValueError('Global reserved source contract changed')
  sources=validate_request(req,reserved);live=live_metadata(sources)
  if set(sources)!=set(r['sources']):raise ValueError('Frozen source inventory differs')
  # Revalidate every source/timeline and all pages BEFORE model allocation/reusing even cached detections.
  for key,s in r['sources'].items():
   if s['storyboard']!=live[key] or any(s[k]!=sources[key][k] for k in sources[key]):raise ValueError('Current source/index/request drift')
   t=timeline(s,reads);vtt=reads.read(s['vtt']['path'],2*1024**2,s['vtt']['fingerprint'],s['vtt']['sha256']);cues=face.vtt_tiles(vtt.decode(),s['identity']['video_id'],t,Path(s['vtt']['path']).name,width=s['storyboard']['tile_width'],height=s['storyboard']['tile_height'])
   if s['frames']!=[cues[i] for i in s['planned_indices']] or set(s['pages'])!={str(f['page']) for f in s['frames']}:raise ValueError('Frozen exact frame/page plan differs')
   for page in s['pages'].values():
    reads.read(page['path'],MAX_PAGE,page['fingerprint'],page['sha256'])
  reuse,reuse_pin=reusable(None if r['reuse_receipt'] is None else r['reuse_receipt']['input_path'],r['sources'],reads)
  if reuse!=r['reuse_frames'] or reuse_pin!=r['reuse_receipt']:raise ValueError('Frozen reusable point set changed')
  if r['model']['path']!=str(face.MODEL.resolve()) or r['model']['sha256']!=face.MODEL_SHA:raise ValueError('Pinned detection model path differs')
  reads.read(face.MODEL.resolve(),32*1024**2,r['model']['fingerprint'],face.MODEL_SHA);model=None;available=[];status='complete';error=None;current=None;points={}
  try:
   for key,s in sorted(r['sources'].items()):
    check();current=(key,s);points={};merge(points,reuse.get(key,[]));directory=Path(out)/'sources'/key;prior=sorted(directory.glob('checkpoint.*.json')) if directory.exists() else []
    if len(prior)>256:raise ValueError('Bounded resume checkpoint count exceeded')
    for path in prior:
     payload=reads.read(path,4*1024**2)
     if path.name!=f'checkpoint.{face.digest(payload)}.json':raise ValueError('Resume checkpoint checksum differs')
     merge(points,checked_frames(json.loads(payload),key,s,r['request_sha256'],receipt_sha))
    for page in sorted(s['pages'],key=int):
     pending=[f for f in s['frames'] if str(f['page'])==page and f['index'] not in points]
     if not pending:continue
     check()
     if face.busy_workers():raise RuntimeError('Competing media worker appeared')
     if model is None:reads.charge(r['model']['fingerprint']['size_bytes']);model=face.detector()
     p=s['pages'][page];content=reads.read(p['path'],MAX_PAGE,p['fingerprint'],p['sha256'])
     with Image.open(io.BytesIO(content)) as encoded:
      old.validate_page_geometry(*encoded.size,s['storyboard']['tile_width'],s['storyboard']['tile_height'],int(page),len(s['full_timestamps']))
      if list(encoded.size)!=p['size']:raise ValueError('Frozen sprite header dimensions changed')
      sheet=encoded.convert('RGB')
     try:
      for f in pending:
       check();x,y,w,h=f['xywh']
       if x+w>sheet.width or y+h>sheet.height:raise ValueError('Exact crop exceeds sprite')
       tile=np.asarray(sheet.crop((x,y,x+w,y+h)))[:,:,::-1].copy();boxes,_=model.detect(tile,input_size=(640,640));merge(points,[dict(f,**face.normalize_detections(boxes,w,h))])
     finally:sheet.close()
     value=checkpoint(key,s,list(points.values()),r['request_sha256'],receipt_sha);checked_frames(value,key,s,r['request_sha256'],receipt_sha);face.save_version(directory,'checkpoint',value)
    value=checkpoint(key,s,list(points.values()),r['request_sha256'],receipt_sha);checked_frames(value,key,s,r['request_sha256'],receipt_sha)
    if not value['complete']:raise ValueError('Incomplete source remains unavailable')
    face.save_version(directory,'checkpoint',value);publish_complete(out,key,value);available.append(key);current=None
  except (TimeoutError,ValueError,OSError,RuntimeError) as e:
   status='partial_failed';error=type(e).__name__+': '+str(e)
   if current is not None and points:
    key,s=current;value=checkpoint(key,s,list(points.values()),r['request_sha256'],receipt_sha);checked_frames(value,key,s,r['request_sha256'],receipt_sha);face.save_version(Path(out)/'sources'/key,'checkpoint',value)
  report={'schema_version':1,'status':status,'error':error,'request_sha256':r['request_sha256'],'input_receipt_sha256':receipt_sha,'policy':POLICY,'available_sources':available,'planned_sources':len(r['sources']),'planned_points':r['unique_points'],'reused_points':sum(len(v) for v in reuse.values()),'read_bytes':reads.total,'seconds':time.monotonic()-STARTED,'raw_media_reads':0,'GPU':False,'identity_embeddings':False,'fits':0,'queue_writes':0};path=face.save_version(Path(out),'report',report)
  return {'status':status,'report_path':str(path),'available_sources':len(available),'planned_sources':len(r['sources']),'reads':reads.total,'seconds':report['seconds']}
 finally:lock.close()

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','run']);p.add_argument('--request',type=Path);p.add_argument('--request-sha256');p.add_argument('--receipt',type=Path);p.add_argument('--out',type=Path,default=OUT);p.add_argument('--reuse-receipt',type=Path);a=p.parse_args()
 def expired(*_):raise TimeoutError('Twenty-minute CPU extraction process deadline')
 signal.signal(signal.SIGALRM,expired);signal.alarm(max(1,math.ceil(MAX_SECONDS-(time.monotonic()-STARTED))))
 if a.mode=='prepare' and (a.request is None or a.request_sha256 is None):p.error('prepare requires exact --request and --request-sha256')
 if a.mode=='run' and a.receipt is None:p.error('run requires frozen --receipt')
 print(json.dumps(prepare(a.request,a.request_sha256,a.out,a.reuse_receipt) if a.mode=='prepare' else run(a.receipt,a.out)))
