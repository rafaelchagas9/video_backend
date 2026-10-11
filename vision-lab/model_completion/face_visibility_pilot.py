"""One local detection-only diagnostic. No identity, training, DB writes or changed offers."""
from __future__ import annotations
import argparse,datetime,hashlib,io,json,math,os,re,signal,tempfile,time
PROCESS_STARTED=time.monotonic()
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
import numpy as np
from PIL import Image
LAB=Path(__file__).resolve().parents[1];BACKEND=LAB.parent
ROOT=LAB/'data/model-completion-20261010'
MANIFEST=ROOT/'offered-span-prospective-v2/private_manifest.json'
MANIFEST_SHA='eec780157b221c592462e3224974c0e8b0e8f30a4f62311a16f81121c1f6be72'
MODEL=BACKEND/'vision-service/models/models/buffalo_l/det_10g.onnx'
MODEL_SHA='5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91'
OUT=ROOT/'face-presence-pilot-v1'
MAX_FRAMES=128;MAX_PAGE=32*1024**2;MAX_READS=64*1024**2;MAX_DECODED=512*1024**2
POLICY={'schema_version':1,'target':'sampled_face_visibility_only_not_identity_or_cut_gold','provider':'CPUExecutionProvider','threads':2,'input_size':[640,640],'confidence':.5,'nms':.4,'uniform_original_points':64,'sampling':'64 uniform original point indices union ALL observed points inside frozen primary candidate; fail if over128','seconds':300,'max_frames':128,'max_page_bytes':MAX_PAGE,'max_read_bytes':MAX_READS,'max_decoded_bytes':MAX_DECODED,'one_sprite_at_a_time':True,'model_sha256':MODEL_SHA,'manifest_sha256':MANIFEST_SHA,'media':'only existing SSD storyboard tiles; no video/audio decode or FFmpeg','limitations':'5s sampled absence is unknown; small/occluded faces can be missed; scores not calibrated face truth','frozen_comparisons_changed':False,'training':False,'production_writes':False,'cloud':False}

def digest(value):
 raw=value if isinstance(value,bytes) else json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
 return hashlib.sha256(raw).hexdigest()
def fingerprint(path):
 s=Path(path).stat();return {'size_bytes':s.st_size,'mtime_ns':s.st_mtime_ns,'device':s.st_dev}
def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Five-minute local diagnostic expired')
class Reads:
 def __init__(self):self.total=0
 def charge(self,n):
  self.total+=n
  if self.total>MAX_READS:raise ValueError('Bounded64MiB total disk read budget exceeded')
 def read(self,path,limit,expected=None):
  before=fingerprint(path)
  if before['size_bytes']>limit or (expected is not None and before!=expected):raise ValueError('File size/fingerprint differs')
  self.charge(before['size_bytes']);raw=Path(path).read_bytes()
  if len(raw)!=before['size_bytes'] or fingerprint(path)!=before:raise ValueError('File changed while reading')
  return raw

def busy_workers():
 found=[]
 for p in Path('/proc').iterdir():
  if not p.name.isdigit() or int(p.name)==os.getpid():continue
  try:comm=(p/'comm').read_text().strip();cmd=(p/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
  except OSError:continue
  if comm in ('ffmpeg','ffprobe') or (comm.startswith('python') and any(x in cmd for x in ('audio_features.py','audio_complete.py','dense_original_audio.py','dense_original_joint.py','dense_original_speech.py'))):found.append(int(p.name))
 return found

def load_offer(reads):
 raw=reads.read(MANIFEST,2*1024**2)
 if digest(raw)!=MANIFEST_SHA:raise ValueError('Authoritative frozen16 manifest differs')
 m=json.loads(raw);private=[p for p in m['private_assignments'] if p['source']['feedback_id']==350 and p['source']['video_id']==6209 and p['pilot_role']=='model_vs_human']
 if len(private)!=1:raise ValueError('Exactly one frozen comparison7 source required')
 p=private[0];rows=[r for r in m['rows'] if (r['batch'],r['position'])==(p['batch'],p['position'])]
 if len(rows)!=1 or p['source']['channel_key'] in m['excluded_holdout_creators']:raise ValueError('Reserved or ambiguous source')
 row=rows[0];source=p['source'];roles=p['assignments']
 if set(roles.values())!={'current_human_approved','frozen_primary_best'}:raise ValueError('Frozen primary/reference assignment differs')
 ranges={roles[k]:row['context'][k]['range'] for k in ('a','b')}
 for k in ('a','b'):
  side=row['context'][k]
  if any(side[z]!=source[z] for z in ('feedback_id','video_id','analyzed_at','source_fingerprint','index')) or side['original_range']!=source['clip']:raise ValueError('Frozen side source/index differs')
  a,b=side['range']
  if not source['clip'][0]<=a<b<=source['clip'][1]:raise ValueError('Offer outside immutable original')
 return p,ranges

def selected_points(times,original,candidate):
 t=np.asarray(times,float)
 if t.ndim!=1 or not len(t) or not np.isfinite(t).all() or np.any(np.diff(t)<=0):raise ValueError('Invalid original timestamp index')
 idx=np.flatnonzero((t>=original[0]-1e-6)&(t<=original[1]+1e-6))
 if not len(idx):raise ValueError('Original lacks point coverage')
 uniform=idx[np.unique(np.linspace(0,len(idx)-1,min(64,len(idx))).astype(int))]
 inside=np.flatnonzero((t>=candidate[0]-1e-6)&(t<=candidate[1]+1e-6))
 chosen=np.union1d(uniform,inside).astype(int)
 if not len(inside) or len(chosen)>MAX_FRAMES:raise ValueError('Candidate coverage absent or128-point budget exceeded')
 return chosen

def seconds(text):
 match=re.fullmatch(r'(\d+):(\d{2}):(\d{2})\.(\d{3})',text)
 if not match:raise ValueError('Unsupported VTT timestamp')
 h,m,s,ms=map(int,match.groups())
 if m>=60 or s>=60:raise ValueError('Invalid VTT time')
 return h*3600+m*60+s+ms/1000

def vtt_tiles(text,video_id,times,generated_vtt,width=456,height=256):
 if not text.startswith('WEBVTT'):raise ValueError('VTT header absent')
 blocks=re.split(r'\n\s*\n',text.strip());cues=[]
 for block in blocks[1:]:
  lines=block.strip().splitlines()
  if len(lines)!=2 or ' --> ' not in lines[0]:raise ValueError('Unsupported VTT cue')
  left,right=lines[0].split(' --> ');start,end=seconds(left),seconds(right);uri=urlsplit(lines[1])
  match=re.fullmatch(r'/api/videos/'+str(video_id)+r'/storyboard/pages/(\d+)\.(webp|jpg)',uri.path)
  box=re.fullmatch(r'xywh=(\d+),(\d+),(\d+),(\d+)',uri.fragment)
  if not match or not box or uri.scheme or uri.netloc or parse_qs(uri.query)!={'v':[generated_vtt]}:raise ValueError('VTT page identity/version differs')
  page=int(match[1]);x,y,w,h=map(int,box.groups());index=len(cues)
  if not end>start or page!=index//25 or (x,y,w,h)!=((index%5)*width,((index%25)//5)*height,width,height):raise ValueError('VTT placement differs')
  cues.append({'index':index,'timestamp':start,'cue_end':end,'page':page,'extension':match[2],'xywh':[x,y,w,h]})
 if len(cues)!=len(times) or any(abs(c['timestamp']-float(t))>.001 for c,t in zip(cues,times)):raise ValueError('VTT/index timestamps differ')
 return cues

def save_version(directory,stem,value):
 directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700);raw=json.dumps(value,allow_nan=False,sort_keys=True,indent=2).encode();target=directory/f'{stem}.{digest(raw)}.json'
 fd,tmp=tempfile.mkstemp(prefix='.receipt-',dir=directory)
 try:
  with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
  os.chmod(tmp,0o600)
  try:os.link(tmp,target)
  except FileExistsError:
   if target.read_bytes()!=raw:raise ValueError('Immutable version collision')
 finally:os.unlink(tmp)
 return target

def stamp(v):
 if not isinstance(v,datetime.datetime):return v
 if v.tzinfo is None:v=v.replace(tzinfo=datetime.timezone.utc)
 return v.astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def metadata(source):
 import new_round_features as n,psycopg
 with psycopg.connect(n.base.pg_config(),connect_timeout=4) as c:
  c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');c.execute("SET statement_timeout='5s'")
  live=n.connected.load_rows(c,[350])
  if set(live)!={350}:raise ValueError('Frozen source unavailable')
  n.validate_live({'group':source['channel_key']},source,live[350])
  row=c.execute('SELECT sprite_path,vtt_path,tile_width,tile_height,tile_count,interval_seconds,generated_at FROM storyboards WHERE video_id=%s',(6209,)).fetchone()
 if not row or (row[2],row[3])!=(456,256) or row[4]!=source['index']['frame_count'] or float(row[5])!=5. or stamp(row[6])!=source['index']['storyboard_generated_at']:raise ValueError('Storyboard generation/geometry differs')
 return {'sprite_path':str((BACKEND/row[0]).resolve()),'vtt_path':str((BACKEND/row[1]).resolve()),'tile_width':row[2],'tile_height':row[3],'tile_count':row[4],'interval_seconds':float(row[5]),'generated_at':stamp(row[6])}

def prepare(out=OUT):
 deadline=PROCESS_STARTED+300;reads=Reads()
 if busy_workers():return {'status':'busy_no_execution'}
 p,ranges=load_offer(reads);source=p['source'];model_fp=fingerprint(MODEL)
 if model_fp['device']!=fingerprint(ROOT)['device'] or digest(reads.read(MODEL,32*1024**2))!=MODEL_SHA:raise ValueError('Cached detection model pin/device differs')
 meta=metadata(source);frame_path=Path(p['frame_checkpoint']['path']);raw=reads.read(frame_path,64*1024**2)
 if digest(raw)!=p['frame_checkpoint']['sha256']:raise ValueError('Frozen numeric checkpoint differs')
 with np.load(io.BytesIO(raw),allow_pickle=False) as z:
  times=z['t'].copy()
  if str(z['identity_sha256'])!=p['frame_checkpoint']['identity_sha256']:raise ValueError('Frame generation identity differs')
 if len(times)!=source['index']['frame_count'] or not np.allclose(np.diff(times),5.,atol=.001):raise ValueError('Frame5s cadence/count differs')
 chosen=selected_points(times,source['clip'],ranges['frozen_primary_best']);vtt=Path(meta['vtt_path']);vtt_fp=fingerprint(vtt)
 if vtt_fp['device']!=model_fp['device']:raise ValueError('VTT is not cached on NVMe device')
 vtt_raw=reads.read(vtt,2*1024**2);cues=vtt_tiles(vtt_raw.decode(),6209,times,vtt.name);pattern=re.fullmatch(r'(.*)\.p0\.(webp|jpg)',meta['sprite_path'])
 if not pattern:raise ValueError('Unsupported paged sprite source')
 pages={};tasks=[]
 for i in chosen:
  check(deadline);cue=cues[int(i)];key=str(cue['page']);path=Path(pattern[1]+'.p'+key+'.'+pattern[2]);fp=fingerprint(path)
  if fp['device']!=model_fp['device'] or fp['size_bytes']>MAX_PAGE or cue['extension']!=pattern[2]:raise ValueError('Sprite page size/device/extension differs')
  if key not in pages:
   payload=reads.read(path,MAX_PAGE,fp);pages[key]={'path':str(path),'fingerprint':fp,'sha256':digest(payload)}
  tasks.append(cue)
 # Account for one ONNX loader read in addition to the pinned hash read during run.
 projected=2*model_fp['size_bytes']+len(vtt_raw)+len(raw)+sum(x['fingerprint']['size_bytes'] for x in pages.values())+256*1024
 if projected>MAX_READS:raise ValueError('Projected complete run exceeds64MiB disk read budget')
 receipt={'schema_version':1,'policy':POLICY,'source_sha256':digest(Path(__file__).read_bytes()),'manifest_sha256':MANIFEST_SHA,'source':source,'ranges':ranges,'numeric_identity':p['numeric_identity'],'frame_checkpoint':p['frame_checkpoint'],'storyboard':meta,'vtt':{'path':str(vtt),'fingerprint':vtt_fp,'sha256':digest(vtt_raw)},'model':{'path':str(MODEL.resolve()),'fingerprint':model_fp,'sha256':MODEL_SHA},'frames':tasks,'full_timestamps':times.tolist(),'pages':pages,'projected_run_read_bytes':projected,'preparation_read_bytes':reads.total,'source_contents_read':False,'DB_writes':0}
 path=save_version(out,'inputs',receipt);return {'status':'prepared_no_inference','receipt_name':path.name,'sampled_frames':len(tasks),'candidate_point_samples':sum(ranges['frozen_primary_best'][0]<=f['timestamp']<=ranges['frozen_primary_best'][1] for f in tasks),'pages':len(pages),'preparation_read_bytes':reads.total}

def normalize_detections(bboxes,width,height):
 a=np.asarray(bboxes,float)
 if a.size==0:return {'max_confidence':0.,'max_box_area_fraction':0.,'boxes':[],'detected':False}
 if a.ndim!=2 or a.shape[1]!=5 or not np.isfinite(a).all():raise ValueError('Invalid numeric face detector output')
 result=[]
 for x1,y1,x2,y2,confidence in a:
  if not .5<=confidence<=1 or x2<=x1 or y2<=y1:raise ValueError('Invalid confidence/box')
  x1,x2=np.clip([x1,x2],0,width);y1,y2=np.clip([y1,y2],0,height)
  if x2<=x1 or y2<=y1:raise ValueError('Face box outside source tile')
  area=float((x2-x1)*(y2-y1)/(width*height));result.append({'bbox':[float(x1/width),float(y1/height),float(x2/width),float(y2/height)],'confidence':float(confidence),'area_fraction':area})
 return {'max_confidence':max(b['confidence'] for b in result),'max_box_area_fraction':max(b['area_fraction'] for b in result),'boxes':result,'detected':True}

def range_summary(results,bounds,planned):
 frames=[r for r in results if bounds[0]<=r['timestamp']<=bounds[1]];total=sum(bounds[0]<=f['timestamp']<=bounds[1] for f in planned)
 return {'planned_point_samples':total,'processed_point_samples':len(frames),'face_positive_samples':sum(f['detected'] for f in frames),'positive_sample_fraction':sum(f['detected'] for f in frames)/len(frames) if frames else None,'maximum_confidence':max((f['max_confidence'] for f in frames),default=None),'maximum_box_area_fraction':max((f['max_box_area_fraction'] for f in frames),default=None),'absence_is_ground_truth':False,'duration_coverage_estimated':False}

def detector():
 import onnxruntime as ort
 from insightface.model_zoo import get_model
 options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1;options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
 model=get_model(str(MODEL),providers=['CPUExecutionProvider'],sess_options=options)
 if model.taskname!='detection' or model.session.get_providers()!=['CPUExecutionProvider']:raise ValueError('Non-CPU/non-detection session refused')
 model.prepare(ctx_id=-1,input_size=(640,640),det_thresh=.5,nms_thresh=.4)
 return model

def run(receipt_path,out=OUT):
 import fcntl
 deadline=PROCESS_STARTED+300
 if busy_workers():return {'status':'busy_no_execution'}
 lock_path=BACKEND/'data/models/recording-audio-jobs/.worker.lock';lock=lock_path.open('a+')
 try:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return {'status':'busy_lock_no_execution'}
  reads=Reads();raw=reads.read(receipt_path,2*1024**2);r=json.loads(raw)
  if Path(receipt_path).name!='inputs.'+digest(raw)+'.json' or r['policy']!=POLICY or r['source_sha256']!=digest(Path(__file__).read_bytes()) or r['manifest_sha256']!=MANIFEST_SHA:raise ValueError('Frozen private receipt/source differs')
  p,ranges=load_offer(reads)
  if r['source']!=p['source'] or r['ranges']!=ranges or r['numeric_identity']!=p['numeric_identity'] or r['frame_checkpoint']!=p['frame_checkpoint']:raise ValueError('Frozen source/range receipts differ')
  if metadata(r['source'])!=r['storyboard']:raise ValueError('Live generation changed after preparation')
  full=np.asarray(r['full_timestamps'],float);cues=None
  for item,limit in ((r['model'],32*1024**2),(r['vtt'],2*1024**2)):
   content=reads.read(item['path'],limit,item['fingerprint'])
   if digest(content)!=item['sha256']:raise ValueError('Pinned model/VTT contents differ')
   if item is r['vtt']:cues=vtt_tiles(content.decode(),6209,full,Path(item['path']).name)
  if r['model']['path']!=str(MODEL.resolve()) or r['model']['sha256']!=MODEL_SHA:raise ValueError('Model path/pin differs')
  frame_raw=reads.read(r['frame_checkpoint']['path'],8*1024**2)
  if digest(frame_raw)!=r['frame_checkpoint']['sha256']:raise ValueError('Numeric generation changed')
  with np.load(io.BytesIO(frame_raw),allow_pickle=False) as stored:
   if not np.array_equal(stored['t'],full) or str(stored['identity_sha256'])!=r['frame_checkpoint']['identity_sha256']:raise ValueError('Full sampled timeline identity differs')
  selected=selected_points(full,r['source']['clip'],ranges['frozen_primary_best'])
  if r['frames']!=[cues[int(i)] for i in selected] or set(r['pages'])!={str(f['page']) for f in r['frames']}:raise ValueError('Frozen sampling/tile inventory differs')
  if any(x['fingerprint']['device']!=r['model']['fingerprint']['device'] for x in r['pages'].values()):raise ValueError('Sprite pages are not on frozen NVMe device')
  if len(r['frames'])>128 or not len(r['frames']) or sum(x['fingerprint']['size_bytes'] for x in r['pages'].values())>MAX_READS:raise ValueError('Invalid bounded frame inventory')
  check(deadline);reads.charge(r['model']['fingerprint']['size_bytes']);model=detector();results=[];status='complete';error=None
  try:
   for page_id in sorted(r['pages'],key=int):
    check(deadline)
    if busy_workers():raise RuntimeError('A competing media worker appeared; stopping without continuation')
    item=r['pages'][page_id];payload=reads.read(item['path'],MAX_PAGE,item['fingerprint'])
    if digest(payload)!=item['sha256']:raise ValueError('Frozen sprite hash differs')
    with Image.open(io.BytesIO(payload)) as encoded:
     w,h=encoded.size
     if w!=456*5 or h%256 or not 256<=h<=256*5 or w*h*3>MAX_DECODED:raise ValueError('Sprite geometry/decoded memory bound differs')
     sheet=encoded.convert('RGB')
    try:
     for f in [f for f in r['frames'] if str(f['page'])==page_id]:
      check(deadline);x,y,w,h=f['xywh']
      if (w,h)!=(456,256) or x+w>sheet.width or y+h>sheet.height:raise ValueError('Frozen tile exceeds sprite')
      tile=np.asarray(sheet.crop((x,y,x+w,y+h)))[:,:,::-1].copy();boxes,_=model.detect(tile,input_size=(640,640))
      results.append(dict(f,**normalize_detections(boxes,w,h)))
      save_version(out,'partial',{'input_receipt_sha256':digest(raw),'frames':results,'read_bytes':reads.total,'status':'partial','automatic_action':False})
    finally:sheet.close()
   if len(results)!=len(r['frames']):raise ValueError('Planned numeric results incomplete')
  except (TimeoutError,RuntimeError,ValueError,OSError) as e:status='partial_failed';error=type(e).__name__+': '+str(e)
  report={'schema_version':1,'input_receipt_sha256':digest(raw),'manifest_sha256':MANIFEST_SHA,'model_sha256':MODEL_SHA,'policy':POLICY,'status':status,'error':error,'frames':results,'read_bytes':reads.total,'seconds':time.monotonic()-PROCESS_STARTED,'ranges':{k:range_summary(results,span,r['frames']) for k,span in ranges.items()},'cut_gold':None,'current_acceptability_labels':None,'fits':0,'GPU':False,'identity_embeddings':False,'source_video_audio_reads':0,'frozen_tasks_changed':False,'automatic_action':False}
  path=save_version(out,'result',report)
  return {'status':status,'result_name':path.name,'processed_frames':len(results),'planned_frames':len(r['frames']),'read_bytes':reads.total,'seconds':report['seconds'],'ranges':report['ranges']}
 finally:lock.close()

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','run']);parser.add_argument('--receipt',type=Path);parser.add_argument('--out',type=Path,default=OUT);args=parser.parse_args();signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError('Five-minute process deadline')));signal.alarm(max(1,math.ceil(300-(time.monotonic()-PROCESS_STARTED))))
 if args.mode=='run' and args.receipt is None:parser.error('--receipt required')
 print(json.dumps(prepare(args.out) if args.mode=='prepare' else run(args.receipt,args.out)))
