"""Bounded SSD storyboard-only detector features; no outcomes, identity, fits or raw media.

prepare freezes label-free inputs; run may reuse exact atomic per-source numeric
checkpoints. Partial sources are unavailable until all planned points are present.
"""
from __future__ import annotations
import argparse,io,json,math,os,signal,time,zipfile
PROCESS_STARTED=time.monotonic()
from pathlib import Path
import numpy as np
from PIL import Image
import face_visibility_pilot as face
LAB=face.LAB;ROOT=face.ROOT;BACKEND=face.BACKEND
COHORT=ROOT/'blind-preference-features/feature_cohort.json'
COHORT_SHA='5a0b86cdb813702524ed22fe476908a7598d69289e005f0cbc7acec56861cbd3'
MANIFEST=ROOT/'offered-span-prospective-v2/private_manifest.json'
MANIFEST_SHA=face.MANIFEST_SHA
OUT=ROOT/'offered-face-features-v3'
MAX_SECONDS=600;MAX_POINTS=1500;MAX_READS=256*1024**2;MAX_PAGE=32*1024**2;MAX_DECODED=512*1024**2
FEATURES=['sampled_face_positive_fraction','sampled_mean_max_confidence','sampled_mean_max_box_area_fraction','sampled_max_box_area_fraction']
POLICY={'schema_version':3,'recipe':'offered_uniform24_detection_only_exact_geometry_finalpage_v3','page_geometry':'exact storyboardPageSize: min(5,remaining)*tilewidth by ceil(remaining/5)*tileheight','tile_geometry':'exact frozen per-source DB width/height; both positive integers<=1024; full VTT/grid match','points_per_range':24,'max_unique_points':MAX_POINTS,'provider':'CPUExecutionProvider','threads':2,'confidence':.5,'nms':.4,'input_size':[640,640],'model_sha256':face.MODEL_SHA,'cohort_sha256':COHORT_SHA,'manifest_sha256':MANIFEST_SHA,'max_seconds':MAX_SECONDS,'max_read_bytes':MAX_READS,'max_page_bytes':MAX_PAGE,'max_decoded_bytes':MAX_DECODED,'one_sprite_at_a_time':True,'features':FEATURES,'sampling':'24 evenly spaced available point indices inside exact offered bounds; no outside points','missing':'unavailable, never imputed zero','absence_is_ground_truth':False,'continuous_coverage_estimated':False,'identity_embeddings':False,'raw_media_decode':False,'answers_used':False,'predictions_used':False,'GPU':False,'fits':0,'DB_writes':0,'cloud':False}

def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Ten-minute offered face extraction expired')
class Reads(face.Reads):
 def charge(self,n):
  self.total+=n
  if self.total>MAX_READS:raise ValueError('256MiB disk-read budget exceeded')
 def read(self,path,limit,expected=None):
  if face.fingerprint(path)['device']!=face.fingerprint(ROOT)['device']:raise ValueError('Input is not on frozen SSD device')
  return super().read(path,limit,expected)


def validate_tile_geometry(width,height):
 if any(isinstance(v,bool) or not isinstance(v,int) or not 1<=v<=1024 for v in (width,height)):raise ValueError('Exact storyboard tile dimensions invalid/bounded')
 return width,height

def validate_page_geometry(width,height,tile_width,tile_height,page,total_frames):
 validate_tile_geometry(tile_width,tile_height)
 if any(isinstance(v,bool) or not isinstance(v,int) for v in (page,total_frames)) or not total_frames>0 or not 0<=page<math.ceil(total_frames/25):raise ValueError('Invalid exact page/frame inventory')
 remaining=min(25,total_frames-page*25);expected=(min(5,remaining)*tile_width,math.ceil(remaining/5)*tile_height)
 if (width,height)!=expected or width*height*6>MAX_DECODED:raise ValueError('Exact producer sprite size/decoded memory differs')
 return width,height

def validate_page_fingerprints(pages):
 for item in pages.values():
  if face.fingerprint(item['path'])!=item['fingerprint']:raise ValueError('Frozen sprite stat changed before cached detections reused')
 return True

def source_key(identity):return face.digest(identity)
def sample_indices(times,bounds):
 t=np.asarray(times,float)
 if t.ndim!=1 or not len(t) or not np.isfinite(t).all() or np.any(np.diff(t)<=0):raise ValueError('Invalid point timeline')
 if not isinstance(bounds,list) or len(bounds)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in bounds) or not 0<=bounds[0]<bounds[1]:raise ValueError('Invalid offered bounds')
 ii=np.flatnonzero((t>=bounds[0])&(t<=bounds[1]))
 if not len(ii):raise ValueError('Offered version has no observed frames')
 return ii[np.unique(np.linspace(0,len(ii)-1,min(24,len(ii))).astype(int))].tolist()

def label_free_row(row,identity,frame,group,span):
 if row.get('reserved_fine_holdout') is not False or row.get('fine_data_role')!='training':raise ValueError('Nontraining or reserved offered row')
 for k in ('video_id','analyzed_at','source_fingerprint','index'):
  if row[k]!=identity[k]:raise ValueError('Exact row generation identity differs')
 if frame['identity_sha256']!=source_key(identity):raise ValueError('Numeric frame identity checksum differs')
 original=row['original_range']
 if not 0<=original[0]<=span[0]<span[1]<=original[1]<=identity['duration']:raise ValueError('Offered range exceeds immutable original')
 if len([p for p in identity['proposals'] if [p['start'],p['end']]==original])!=1:raise ValueError('Exact original proposal missing/ambiguous')
 return {'row':row['row'],'feedback_id':row['feedback_id'],'video_id':row['video_id'],'group':group,'original_range':original,'offered_range':span,'source_key':source_key(identity),'numeric_identity':identity,'frame_checkpoint':frame}

def inputs(reads):
 a=reads.read(COHORT,8*1024**2);b=reads.read(MANIFEST,8*1024**2)
 if face.digest(a)!=COHORT_SHA or face.digest(b)!=MANIFEST_SHA:raise ValueError('Frozen cohort/manifest changed')
 cohort=json.loads(a);manifest=json.loads(b);reserved=cohort['reserved_creators_excluded']
 if reserved!=manifest['excluded_holdout_creators']:raise ValueError('Authoritative reserved creators differ')
 rows=[]
 for row in cohort['old_rows']+cohort['version_rows']:
  frame=dict(row['frame_checkpoint'],path=row['frame_cache'])
  rows.append(label_free_row(row,row['numeric_identity'],frame,row['group'],row['offered_range']))
 private={(p['batch'],p['position']):p for p in manifest['private_assignments']}
 for task in manifest['rows']:
  p=private[(task['batch'],task['position'])]
  for side in ('a','b'):
   item=task['context'][side];row=dict(item,row=f"prospective:{task['batch']}:{task['position']}:{side}",fine_data_role=task['context']['fine_data_role'],reserved_fine_holdout=task['context']['reserved_fine_holdout'])
   rows.append(label_free_row(row,p['numeric_identity'],p['frame_checkpoint'],item['channel_key'],item['range']))
 if len(rows)!=92 or len({r['row'] for r in rows})!=92 or any(r['group'] in reserved for r in rows):raise ValueError('Exactly92 nonreserved offered versions required')
 sources={}
 for row in rows:
  key=row['source_key'];record=sources.setdefault(key,{'identity':row['numeric_identity'],'group':row['group'],'frame_checkpoint':row['frame_checkpoint'],'feedback_ids':[],'rows':[]})
  if record['identity']!=row['numeric_identity'] or record['group']!=row['group'] or record['frame_checkpoint']['sha256']!=row['frame_checkpoint']['sha256']:raise ValueError('Shared source provenance differs')
  record['feedback_ids'].append(row['feedback_id']);record['rows'].append({k:row[k] for k in ('row','feedback_id','original_range','offered_range')})
 for s in sources.values():s['feedback_ids']=sorted(set(s['feedback_ids']))
 return {'rows':rows,'sources':sources,'reserved_creators_excluded':reserved,'cohort_sha256':COHORT_SHA,'manifest_sha256':MANIFEST_SHA}

def live_storyboards(sources):
 import new_round_features as numeric,psycopg
 result={};ids=sorted({fid for s in sources.values() for fid in s['feedback_ids']})
 with psycopg.connect(numeric.base.pg_config(),connect_timeout=4) as pg:
  pg.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');pg.execute("SET statement_timeout='8s'")
  live=numeric.connected.load_rows(pg,ids)
  if set(live)!=set(ids):raise ValueError('Exact saved source feedback unavailable')
  for key,s in sources.items():
   identity=s['identity']
   for fid in s['feedback_ids']:
    got=numeric.base.side(live[fid])
    if any(got[k]!=identity[k] for k in ('video_id','analyzed_at','source_fingerprint','index')) or numeric.base.canon(live[fid]['channel'])!=s['group']:raise ValueError('Live exact generation/source/creator differs')
    matching=[r for r in s['rows'] if r['feedback_id']==fid]
    if any(got['clip']!=r['original_range'] for r in matching):raise ValueError('Live original proposal bounds differ')
   value=pg.execute('SELECT sprite_path,vtt_path,tile_width,tile_height,tile_count,interval_seconds,generated_at FROM storyboards WHERE video_id=%s',(identity['video_id'],)).fetchone()
   if not value or value[4]!=identity['index']['frame_count'] or float(value[5])!=5 or face.stamp(value[6])!=identity['index']['storyboard_generated_at']:raise ValueError('Exact storyboard generation/geometry unavailable')
   validate_tile_geometry(value[2],value[3])
   result[key]={'tile_width':value[2],'tile_height':value[3],'sprite_path':str((BACKEND/value[0]).resolve()),'vtt_path':str((BACKEND/value[1]).resolve()),'generated_at':face.stamp(value[6]),'tile_count':value[4]}
 return result

def numeric_times(source,reads):
 frame=source['frame_checkpoint'];raw=reads.read(frame['path'],64*1024**2)
 if face.digest(raw)!=frame['sha256']:raise ValueError('Pinned numeric frame bytes changed')
 with zipfile.ZipFile(io.BytesIO(raw)) as archive:
  if sum(i.file_size for i in archive.infolist())>64*1024**2:raise ValueError('Numeric decompression bound exceeded')
 with np.load(io.BytesIO(raw),allow_pickle=False) as z:
  if str(z['identity_sha256'])!=source_key(source['identity']):raise ValueError('Numeric generation checksum differs')
  t=z['t'].copy()
 i=source['identity']
 if t.shape!=(i['index']['frame_count'],) or not len(t) or not np.isfinite(t).all() or t[0]<0 or t[-1]>i['duration'] or t[0]>5.001 or t[-1]+10<i['duration'] or not np.allclose(np.diff(t),5,atol=.001):raise ValueError('Full exact5s timeline invalid')
 return t

def plan_source(source,storyboard,reads,deadline):
 import re
 t=numeric_times(source,reads);vtt=Path(storyboard['vtt_path']);raw=reads.read(vtt,2*1024**2);cues=face.vtt_tiles(raw.decode(),source['identity']['video_id'],t,vtt.name,width=storyboard['tile_width'],height=storyboard['tile_height']);points=set();rows=[]
 for row in source['rows']:
  ii=sample_indices(t,row['offered_range']);points.update(ii);rows.append(dict(row,point_indices=ii))
 pattern=re.fullmatch(r'(.*)\.p0\.(webp|jpg)',storyboard['sprite_path'])
 if not pattern:raise ValueError('Storyboard page pattern unsupported')
 pages={}
 for index in sorted(points):
  check(deadline);cue=cues[index];page=str(cue['page'])
  if page not in pages:
   path=Path(pattern[1]+'.p'+page+'.'+pattern[2]);fp=face.fingerprint(path)
   if cue['extension']!=pattern[2]:raise ValueError('Storyboard page extension differs')
   content=reads.read(path,MAX_PAGE,fp)
   with Image.open(io.BytesIO(content)) as encoded:shape=encoded.size
   validate_page_geometry(*shape,storyboard['tile_width'],storyboard['tile_height'],int(page),len(t))
   pages[page]={'path':str(path),'fingerprint':fp,'sha256':face.digest(content),'size':list(shape)}
 return {'identity':source['identity'],'group':source['group'],'feedback_ids':source['feedback_ids'],'frame_checkpoint':source['frame_checkpoint'],'storyboard':storyboard,'vtt':{'path':str(vtt),'fingerprint':face.fingerprint(vtt),'sha256':face.digest(raw)},'rows':rows,'frames':[cues[i] for i in sorted(points)],'pages':pages,'full_timestamps':t.tolist()}

def prepare(out=OUT,migration_receipt=None):
 deadline=PROCESS_STARTED+MAX_SECONDS;reads=Reads()
 if face.busy_workers():return {'status':'busy_no_execution'}
 data=inputs(reads);storyboards=live_storyboards(data['sources']);model_fp=face.fingerprint(face.MODEL)
 if face.digest(reads.read(face.MODEL,32*1024**2))!=face.MODEL_SHA:raise ValueError('Cached detector pin changed')
 sources={key:plan_source(s,storyboards[key],reads,deadline) for key,s in sorted(data['sources'].items())};count=sum(len(s['frames']) for s in sources.values())
 if count>MAX_POINTS:raise ValueError('1,500-point shared budget exceeded')
 projected=2*model_fp['size_bytes']+sum(s['frame_checkpoint'].get('bytes',Path(s['frame_checkpoint']['path']).stat().st_size)+s['vtt']['fingerprint']['size_bytes']+sum(v['fingerprint']['size_bytes'] for v in s['pages'].values()) for s in sources.values())+16*1024**2
 if projected>MAX_READS:raise ValueError('Projected run exceeds256MiB read cap')
 receipt={'schema_version':1,'policy':POLICY,'source_sha256':face.digest(Path(__file__).read_bytes()),'pilot_helper_sha256':face.digest(Path(face.__file__).read_bytes()),'cohort_sha256':COHORT_SHA,'manifest_sha256':MANIFEST_SHA,'reserved_creators_excluded':data['reserved_creators_excluded'],'model':{'path':str(face.MODEL.resolve()),'fingerprint':model_fp,'sha256':face.MODEL_SHA},'sources':sources,'projected_run_read_bytes':projected,'preparation_read_bytes':reads.total,'unique_points':count,'version_count':92,'source_contents_read':False,'DB_writes':0,'answers_used':False,'predictions_used':False}
 if migration_receipt is not None:
  migration=load_migration(migration_receipt,receipt,reads)
  receipt['migration']={'receipt_path':str(Path(migration_receipt).resolve()),'receipt_sha256':migration['sha256'],'v2_source_sha256':migration['source_sha256'],'complete_source_keys':sorted(migration['complete']),'partial_point_counts':{k:len(v) for k,v in sorted(migration['partial'].items())}}
 check(deadline);path=face.save_version(out,'inputs',receipt)
 return {'status':'prepared_no_detection','receipt_name':path.name,'unique_points':count,'sources':len(sources),'versions':92,'preparation_read_bytes':reads.total}

def checked_result(frame,expected):
 if any(frame.get(k)!=v for k,v in expected.items()):raise ValueError('Per-point metadata differs')
 boxes=frame.get('boxes')
 if not isinstance(boxes,list):raise ValueError('Detection boxes unavailable')
 raw=[]
 for box in boxes:
  xy=box['bbox']
  if len(xy)!=4 or not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) for v in xy) or not all(0<=v<=1 for v in xy):raise ValueError('Invalid normalized checkpoint box')
  w,h=expected['xywh'][2:];validate_tile_geometry(w,h)
  raw.append([xy[0]*w,xy[1]*h,xy[2]*w,xy[3]*h,box['confidence']])
 w,h=expected['xywh'][2:];validate_tile_geometry(w,h)
 derived=face.normalize_detections(raw,w,h)
 if frame.get('detected') is not derived['detected'] or any(not isinstance(frame.get(k),(int,float)) or not math.isclose(frame[k],derived[k],rel_tol=1e-10,abs_tol=1e-12) for k in ('max_confidence','max_box_area_fraction')):raise ValueError('Per-point aggregates inconsistent with numeric boxes')
 if len(boxes)!=len(derived['boxes']) or any(not math.isclose(a['area_fraction'],b['area_fraction'],abs_tol=1e-12) for a,b in zip(boxes,derived['boxes'])):raise ValueError('Box area receipt inconsistent')
 return frame

def validate_checkpoint(value,key,source,receipt_sha):
 if value.get('input_receipt_sha256')!=receipt_sha or value.get('source_key')!=key or value.get('identity')!=source['identity'] or value.get('policy')!=POLICY:raise ValueError('Per-source checkpoint provenance differs')
 expected={f['index']:f for f in source['frames']};frames=value.get('frames')
 if not isinstance(frames,list) or len({f.get('index') for f in frames})!=len(frames) or any(f.get('index') not in expected for f in frames):raise ValueError('Per-source point inventory differs')
 for frame in frames:checked_result(frame,expected[frame['index']])
 if value.get('complete') is not (len(frames)==len(expected)):raise ValueError('Per-source completion marker differs')
 return frames

def aggregate(rows,frames):
 by={f['index']:f for f in frames};result=[]
 for row in rows:
  ids=row['point_indices']
  if not ids or any(i not in by for i in ids):raise ValueError('Incomplete offered points; features unavailable')
  values=[by[i] for i in ids];result.append({'row':row['row'],'offered_range':row['offered_range'],'point_indices':ids,'sampled_timestamps':[f['timestamp'] for f in values],'features':[sum(f['detected'] for f in values)/len(values),sum(f['max_confidence'] for f in values)/len(values),sum(f['max_box_area_fraction'] for f in values)/len(values),max(f['max_box_area_fraction'] for f in values)],'sample_count':len(ids),'availability':True,'absence_is_ground_truth':False,'continuous_coverage_estimated':False})
 return result


def migration_source_view(source):
 # Only newly frozen header dimensions are absent from v2. All actual identities,
 # point plans, page bytes/path/stat and offered ranges must otherwise be equal.
 import copy
 value=copy.deepcopy(source)
 for page in value['pages'].values():page.pop('size',None)
 return value

def load_migration(path,receipt,reads):
 import face_offered_features_v2 as v2
 path=Path(path);raw=reads.read(path,16*1024**2);old=json.loads(raw);old_sha=face.digest(raw)
 if path.name!=f'inputs.{old_sha}.json' or old.get('policy')!=v2.POLICY or old.get('source_sha256')!=face.digest(Path(v2.__file__).read_bytes()) or old.get('pilot_helper_sha256')!=receipt['pilot_helper_sha256']:raise ValueError('Exact immutable v2 migration recipe/receipt changed')
 if any(old.get(k)!=receipt.get(k) for k in ('cohort_sha256','manifest_sha256','reserved_creators_excluded','model','unique_points','version_count')) or set(old['sources'])!=set(receipt['sources']):raise ValueError('Migration changed source/model/sampling inventory')
 complete={};partial={}
 for key,source in receipt['sources'].items():
  if migration_source_view(source)!=migration_source_view(old['sources'][key]):raise ValueError('Migration changed source/page hashes/point plan')
  directory=path.parent/'sources'/key;selected=[];known={}
  for checkpoint in sorted(directory.glob('checkpoint.*.json')) if directory.exists() else []:
   payload=reads.read(checkpoint,4*1024**2)
   if checkpoint.name!='checkpoint.'+face.digest(payload)+'.json':raise ValueError('Migration checkpoint checksum differs')
   value=json.loads(payload);frames=v2.validate_checkpoint(value,key,old['sources'][key],old_sha)
   for frame in frames:
    index=frame['index']
    if index in known and known[index]!=frame:raise ValueError('Conflicting per-point migration checkpoints')
    known[index]=frame
   if len(frames)>len(selected):selected=frames
  if selected:
   if len(selected)==len(source['frames']):complete[key]=selected
   else:partial[key]=selected
 return {'sha256':old_sha,'source_sha256':old['source_sha256'],'complete':complete,'partial':partial}

def apply_migration(receipt,receipt_sha,reads,out):
 if 'migration' not in receipt:return (0,0)
 binding=receipt['migration'];migration=load_migration(binding['receipt_path'],receipt,reads)
 if migration['sha256']!=binding['receipt_sha256'] or migration['source_sha256']!=binding['v2_source_sha256'] or sorted(migration['complete'])!=binding['complete_source_keys'] or {k:len(v) for k,v in sorted(migration['partial'].items())}!=binding['partial_point_counts']:raise ValueError('Frozen complete migration set changed')
 for key,frames in dict(migration['complete'],**migration['partial']).items():
  source=receipt['sources'][key];value={'input_receipt_sha256':receipt_sha,'source_key':key,'identity':source['identity'],'policy':POLICY,'frames':frames,'complete':len(frames)==len(source['frames']),'migrated_v2_input_sha256':migration['sha256']}
  validate_checkpoint(value,key,source,receipt_sha);face.save_version(out/'sources'/key,'checkpoint',value)
 return (len(migration['complete']),sum(len(v) for v in migration['partial'].values()))

def run(receipt_path,out=OUT):
 import fcntl
 deadline=PROCESS_STARTED+MAX_SECONDS
 if face.busy_workers():return {'status':'busy_no_execution'}
 lock=(BACKEND/'data/models/recording-audio-jobs/.worker.lock').open('a+')
 try:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return {'status':'busy_lock_no_execution'}
  reads=Reads();raw=reads.read(receipt_path,16*1024**2);r=json.loads(raw);receipt_sha=face.digest(raw)
  if Path(receipt_path).name!=f'inputs.{receipt_sha}.json' or r.get('policy')!=POLICY or r.get('source_sha256')!=face.digest(Path(__file__).read_bytes()) or r.get('pilot_helper_sha256')!=face.digest(Path(face.__file__).read_bytes()):raise ValueError('Frozen recipe/helper/receipt differs')
  data=inputs(reads)
  if set(data['sources'])!=set(r['sources']) or data['reserved_creators_excluded']!=r['reserved_creators_excluded']:raise ValueError('Frozen source inventory differs')
  live=live_storyboards(data['sources']);count=0
  for key,s in r['sources'].items():
   check(deadline)
   if s['identity']!=data['sources'][key]['identity'] or s['group']!=data['sources'][key]['group'] or s['storyboard']!=live[key]:raise ValueError('Frozen source/storyboard changed')
   t=numeric_times(s,reads);vtt=reads.read(s['vtt']['path'],2*1024**2,s['vtt']['fingerprint'])
   if face.digest(vtt)!=s['vtt']['sha256']:raise ValueError('Frozen VTT changed')
   cues=face.vtt_tiles(vtt.decode(),s['identity']['video_id'],t,Path(s['vtt']['path']).name,width=s['storyboard']['tile_width'],height=s['storyboard']['tile_height']);points=set();expected_rows=[]
   for row in data['sources'][key]['rows']:
    indices=sample_indices(t,row['offered_range']);points.update(indices);expected_rows.append(dict(row,point_indices=indices))
   if s['rows']!=expected_rows or s['frames']!=[cues[i] for i in sorted(points)] or s['full_timestamps']!=t.tolist() or set(s['pages'])!={str(f['page']) for f in s['frames']}:raise ValueError('Frozen sampling/full timeline differs')
   import re
   pattern=re.fullmatch(r'(.*)\.p0\.(webp|jpg)',s['storyboard']['sprite_path'])
   if not pattern or any(v['path']!=str(Path(pattern[1]+'.p'+k+'.'+pattern[2])) for k,v in s['pages'].items()):raise ValueError('Frozen page path substitution')
   validate_page_fingerprints(s['pages'])
   count+=len(points)
  if count!=r['unique_points'] or count>MAX_POINTS or sum(len(s['rows']) for s in r['sources'].values())!=92:raise ValueError('Frozen bounded inventory differs')
  if r['model']['path']!=str(face.MODEL.resolve()) or r['model']['sha256']!=face.MODEL_SHA or face.digest(reads.read(face.MODEL,32*1024**2,r['model']['fingerprint']))!=face.MODEL_SHA:raise ValueError('Detector model pin differs')
  migrated_sources,migrated_partial_points=apply_migration(r,receipt_sha,reads,out)
  reads.charge(r['model']['fingerprint']['size_bytes']);check(deadline);model=face.detector();completed={};status='complete';error=None
  try:
   for key,s in sorted(r['sources'].items()):
    check(deadline);directory=out/'sources'/key;prior=[]
    for path in sorted(directory.glob('checkpoint.*.json')) if directory.exists() else []:
     payload=reads.read(path,4*1024**2)
     if path.name!='checkpoint.'+face.digest(payload)+'.json':raise ValueError('Checkpoint filename checksum differs')
     candidate=validate_checkpoint(json.loads(payload),key,s,receipt_sha)
     if len(candidate)>len(prior):prior=candidate
    results=list(prior);done={f['index'] for f in results}
    for page in sorted(s['pages'],key=int):
     selected=[f for f in s['frames'] if str(f['page'])==page and f['index'] not in done]
     if not selected:continue
     check(deadline)
     if face.busy_workers():raise RuntimeError('Competing media worker appeared; stopping')
     entry=s['pages'][page];payload=reads.read(entry['path'],MAX_PAGE,entry['fingerprint'])
     if face.digest(payload)!=entry['sha256']:raise ValueError('Frozen sprite bytes changed')
     with Image.open(io.BytesIO(payload)) as encoded:
      w,h=encoded.size
      validate_page_geometry(w,h,s['storyboard']['tile_width'],s['storyboard']['tile_height'],int(page),len(s['full_timestamps']))
      if [w,h]!=entry['size']:raise ValueError('Frozen sprite header changed')
      sheet=encoded.convert('RGB')
     try:
      for f in selected:
       check(deadline);x,y,w,h=f['xywh']
       if x+w>sheet.width or y+h>sheet.height:raise ValueError('Tile exceeds sprite geometry')
       tile=np.asarray(sheet.crop((x,y,x+w,y+h)))[:,:,::-1].copy();boxes,_=model.detect(tile,input_size=(640,640));results.append(dict(f,**face.normalize_detections(boxes,w,h)));done.add(f['index'])
     finally:sheet.close()
     value={'input_receipt_sha256':receipt_sha,'source_key':key,'identity':s['identity'],'policy':POLICY,'frames':sorted(results,key=lambda f:f['index']),'complete':len(results)==len(s['frames'])};face.save_version(directory,'checkpoint',value)
    validate_checkpoint({'input_receipt_sha256':receipt_sha,'source_key':key,'identity':s['identity'],'policy':POLICY,'frames':results,'complete':len(results)==len(s['frames'])},key,s,receipt_sha)
    if len(results)!=len(s['frames']):raise ValueError('Incomplete source is unavailable')
    completed[key]={'source_key':key,'identity_sha256':source_key(s['identity']),'rows':aggregate(s['rows'],results)}
  except (TimeoutError,ValueError,OSError,RuntimeError) as e:status='partial_failed';error=type(e).__name__+': '+str(e)
  report={'schema_version':1,'status':status,'error':error,'input_receipt_sha256':receipt_sha,'policy':POLICY,'sources':completed,'available_version_count':sum(len(v['rows']) for v in completed.values()),'planned_version_count':92,'migrated_complete_sources':migrated_sources,'migrated_partial_points':migrated_partial_points,'planned_unique_points':count,'read_bytes':reads.total,'seconds':time.monotonic()-PROCESS_STARTED,'answers_used':False,'predictions_used':False,'fits':0,'raw_media_reads':0,'GPU':False,'DB_writes':0,'automatic_action':False}
  if status=='complete' and report['available_version_count']!=92:raise ValueError('Complete report missing offered versions')
  path=face.save_version(out,'features',report);return {'status':status,'report_name':path.name,'available_versions':report['available_version_count'],'sources':len(completed),'read_bytes':reads.total,'seconds':report['seconds']}
 finally:lock.close()

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','run']);p.add_argument('--receipt',type=Path);p.add_argument('--out',type=Path,default=OUT);p.add_argument('--migration-receipt',type=Path);a=p.parse_args();signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError('Ten-minute process deadline')));signal.alarm(max(1,math.ceil(MAX_SECONDS-(time.monotonic()-PROCESS_STARTED))))
 if a.mode=='run' and a.receipt is None:p.error('--receipt required')
 print(json.dumps(prepare(a.out,a.migration_receipt) if a.mode=='prepare' else run(a.receipt,a.out)))
