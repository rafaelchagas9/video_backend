"""Bounded local Gemma joint image/audio representation on immutable-original fine targets."""
from __future__ import annotations
import contextlib,fcntl,hashlib,json,math,os,re,resource,subprocess,sys,time
from functools import lru_cache
from pathlib import Path
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[k]='2'
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
LAB=Path(__file__).resolve().parents[1];sys.path.insert(0,str(LAB));sys.path.insert(0,str(LAB/'colab_audio_pilot'))
import numpy as np
import soundfile as sf
import prepare as prep
import audio_cache_worker as aw
import pipeline
ROOT=prep.ROOT;OUT=ROOT/'joint-gemma';BACKEND=LAB.parent;SECONDS=20;RATE=16000
RECIPE='gemma2-full740m-joint2alignedstoryboardimages20saudio-original-uniform6-v1'

def save(name,data):prep.save(OUT/name,data)
def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('bounded joint pilot expired')
def stamp(value):
 from datetime import datetime
 value=value if hasattr(value,'isoformat') else datetime.fromisoformat(str(value))
 return value.replace(microsecond=value.microsecond//1000*1000).isoformat(timespec='microseconds')
def fp(path):
 s=path.stat();return [s.st_size,s.st_mtime_ns]
def limited():resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))

def meta(deadline):
 import psycopg
 from label_server import PG
 pack=json.loads((ROOT/'actual_fine_cohort.json').read_text());rows=pack['rows'];vids=sorted({r['video_id'] for r in rows});metadata={};exclude=[]
 with psycopg.connect(PG) as c:
  c.execute('SET TRANSACTION READ ONLY');c.execute("SET statement_timeout='30s'")
  for r in c.execute('SELECT v.id,v.file_path,s.sprite_path,s.tile_width,s.tile_height,s.tile_count,s.interval_seconds,s.generated_at,i.model_revision,i.frame_count,i.interval_seconds,i.storyboard_generated_at FROM videos v JOIN storyboards s ON s.video_id=v.id JOIN video_visual_index i ON i.video_id=v.id WHERE v.id=ANY(%s)',(vids,)).fetchall():metadata[r[0]]=r
  frame={vid:c.execute('SELECT frame_index,timestamp_seconds FROM video_frame_embeddings WHERE video_id=%s ORDER BY frame_index',(vid,)).fetchall() for vid in vids}
 result=[]
 for row in rows:
  check(deadline);m=metadata.get(row['video_id']);p=row['visual_index_provenance']
  if not m or m[8]!=p[0] or m[9]!=p[1] or abs(float(m[10])-p[2])>.001 or stamp(m[11])!=stamp(p[3]) or stamp(m[7])!=stamp(p[3]) or m[5]!=p[1]:exclude.append({'row':row['row'],'reason':'storyboard_or_index_generation_mismatch'});continue
  if hashlib.sha256(Path(row['visual_frame_cache']).read_bytes()).hexdigest()!=row['visual_cache_sha256']:raise ValueError('frozen visual cache changed')
  times=np.array([float(x[1]) for x in frame[row['video_id']]]);indices=np.array([x[0] for x in frame[row['video_id']]])
  with np.load(row['visual_frame_cache']) as z:
   if len(times)!=len(z['t']) or not np.allclose(times,z['t'],atol=.001):exclude.append({'row':row['row'],'reason':'numeric_frame_timestamp_mismatch'});continue
  a,b=row['detected_start'],row['detected_end'];offsets=sorted(set([round(x,3) for x in np.arange(a,max(a,b-20),20)]+[round(max(a,b-20),3)])) if b-a>=20 else []
  windows=[];sprite=BACKEND/m[2];pattern=re.fullmatch(r'(.*)\.p0\.(webp|jpg)',str(sprite))
  if not pattern:exclude.append({'row':row['row'],'reason':'nonpaged_storyboard_unsupported'});continue
  pages={}
  for start in offsets:
   valid=np.flatnonzero((times>=start)&(times<start+20))
   if len(valid)<2:continue
   chosen=[int(valid[np.argmin(abs(times[valid]-(start+5)))]),int(valid[np.argmin(abs(times[valid]-(start+15)))])]
   if chosen[0]==chosen[1]:continue
   idx=[int(indices[x]) for x in chosen];good=True
   for ix in idx:
    page=Path(pattern[1]+'.p'+str(ix//25)+'.'+pattern[2]);pages[str(ix//25)]=str(page)
    if not page.is_file():good=False
   if good:windows.append({'offset':start,'indices':idx,'times':[float(times[x]) for x in chosen]})
  if not windows:exclude.append({'row':row['row'],'reason':'no_joint_coverage'});continue
  source=Path(m[1]);signature=fp(source);row=dict(row,windows=windows,source_path=str(source),source_fingerprint=signature,sprite_width=m[3],sprite_height=m[4],pages=pages,page_fingerprints={k:fp(Path(v)) for k,v in pages.items()});result.append(row)
 if sum(len(r['windows']) for r in result)>1600:raise ValueError('window cap exceeded')
 save('private_manifest.json',{'recipe':RECIPE,'rows':result,'exclusions':exclude,'cohort_sha256':pack['cohort_sha256']});save('availability.json',{'original_targets':len(rows),'eligible_targets':len(result),'channels':len({r['group'] for r in result}),'windows':sum(len(r['windows']) for r in result),'exclusions':exclude,'raw_video_decodes':0,'uploads':0});print(json.dumps(json.loads((OUT/'availability.json').read_text())),flush=True)
 if not result:raise ValueError('no valid storyboard rows; pilot cannot run')
 return result

def stage(rows,deadline):
 folder=OUT/'audio';folder.mkdir(exist_ok=True);folder.chmod(0o700)
 for i,row in enumerate(rows):
  check(deadline);aw.await_idle(deadline);a,b=row['detected_start'],row['detected_end'];cover=row.get('covering_audio_cache');reused=False
  if cover:
   path=Path(cover['path'])
   if path.is_file() and cover['absolute_start']<=a+.001 and cover['absolute_start']+cover['duration']>=b-.001 and cover['alignment']=='aresample_async_first_pts_0':
    inf=sf.info(path)
    if inf.samplerate==RATE and inf.channels==1 and inf.duration>=cover['duration']-.001:row['audio_cache']=str(path);row['audio_absolute_start']=cover['absolute_start'];reused=True
  if not reused:
   neutral=folder/f'c{i:03d}.flac';source=Path(row['source_path']);cache=LAB/'data'/'audio_src'/f"{row['video_id']}.opus";source_kind='original_audio_only'
   if cache.is_file() and cache.stat().st_mtime_ns>=source.stat().st_mtime_ns:
    r=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(cache)],capture_output=True,text=True,timeout=min(10,max(1,deadline-time.monotonic())))
    try:
     if float(json.loads(r.stdout)['format']['duration'])>=b-.001:source=cache;source_kind='ssd_opus_cache'
    except (ValueError,KeyError):pass
   signature=fp(source);tmp=neutral.with_suffix('.partial');duration=b-a
   command=['ionice','-c','3','ffmpeg','-nostdin','-v','error','-threads','1','-filter_threads','1','-filter_complex_threads','1','-ss',str(a),'-i',str(source),'-t',str(duration),'-map','0:a:0','-vn','-sn','-dn','-af','aresample=16000:async=1:first_pts=0','-ac','1','-ar','16000','-sample_fmt','s16','-threads','1','-c:a','flac','-map_metadata','-1','-map_chapters','-1','-f','flac','-y',str(tmp)]
   r=subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=min(45,max(1,deadline-time.monotonic())),preexec_fn=limited)
   if r.returncode or fp(source)!=signature:raise ValueError('bounded audio stage failure')
   inf=sf.info(tmp)
   if inf.samplerate!=RATE or inf.channels!=1:raise ValueError('neutral audio shape mismatch')
   row['windows']=[w for w in row['windows'] if w['offset']+20<=a+inf.duration+.001]
   if not row['windows']:continue
   tmp.chmod(0o600);tmp.replace(neutral);row['audio_cache']=str(neutral);row['audio_absolute_start']=a;row['source_kind']=source_kind
  row['audio_fingerprint']=fp(Path(row['audio_cache']));save('private_manifest.json',{'recipe':RECIPE,'rows':rows});print(json.dumps({'phase':'audio_stage','clips_done':i+1,'clips_total':len(rows),'reused_covering_cache':reused}),flush=True)
 return [r for r in rows if r.get('audio_cache') and r['windows']]

def infer(rows,deadline):
 from PIL import Image
 import torch
 from sentence_transformers import SentenceTransformer
 from sentence_transformers.util import batch_to_device
 timings={k:{'cpu_preprocess':0.,'gpu_forward':0.,'windows':0} for k in ('joint','image','audio')};crop_seconds=0.
 aw.await_idle(deadline,gpu=True);torch.set_num_threads(2)
 with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):model=SentenceTransformer(aw.MODEL,revision=aw.REVISION,device='cuda',model_kwargs={'torch_dtype':torch.bfloat16},local_files_only=True)
 model.eval()
 @lru_cache(maxsize=8)
 def page(path):return Image.open(path).convert('RGB')
 def frames(row,w):
  output=[]
  for ix in w['indices']:
   key=str(ix//25);path=Path(row['pages'][key])
   if fp(path)!=row['page_fingerprints'][key]:raise ValueError('storyboard page changed')
   sheet=page(str(path));slot=ix%25;tw,th=row['sprite_width'],row['sprite_height'];x=slot%5*tw;y=slot//5*th
   if x+tw>sheet.width or y+th>sheet.height:raise ValueError('storyboard tile geometry mismatch')
   output.append(sheet.crop((x,y,x+tw,y+th)))
  return output
 folder=OUT/'embeddings';folder.mkdir(exist_ok=True);folder.chmod(0o700);completed=0
 try:
  with torch.inference_mode():
   for row in rows:
    check(deadline);waves=[];target=folder/(row['row']+'.npz');allvalues={k:[] for k in ('joint','image','audio')};done=0
    offsets=np.array([w['offset'] for w in row['windows']]);idx=np.array([w['indices'] for w in row['windows']]);tm=np.array([w['times'] for w in row['windows']])
    if target.exists():
     with np.load(target) as z:
      if str(z['recipe'])==RECIPE and str(z['revision'])==aw.REVISION and np.array_equal(z['offsets'],offsets):
       done=len(z['joint']);allvalues={k:list(z[k]) for k in allvalues}
    with sf.SoundFile(row['audio_cache']) as audio:
     for j in range(done,len(row['windows']),2):
      check(deadline);pipeline.await_idle(deadline,settle=0);items=[];ims=[];waves=[]
      for w in row['windows'][j:j+2]:
       audio.seek(round((w['offset']-row['audio_absolute_start'])*RATE));wave=audio.read(320000,dtype='float32');assert len(wave)==320000
       started=time.monotonic();im=frames(row,w);crop_seconds+=time.monotonic()-started;items.append({'image':im,'audio':wave});ims.append({'image':im});waves.append({'audio':wave})
      for kind,inputs in [('joint',items),('image',ims),('audio',waves)]:
       check(deadline);started=time.monotonic();features=model.preprocess(inputs);timings[kind]['cpu_preprocess']+=time.monotonic()-started;torch.cuda.synchronize();started=time.monotonic();features=batch_to_device(features,'cuda');vectors=model(features)['sentence_embedding'];vectors=torch.nn.functional.normalize(vectors,p=2,dim=1).detach().float().cpu().numpy();torch.cuda.synchronize();timings[kind]['gpu_forward']+=time.monotonic()-started;timings[kind]['windows']+=len(items);save('timing_report.json',{'variants':timings,'crop_seconds':crop_seconds,'frames_per_window':2,'batch_size':2,'policy':RECIPE});assert vectors.shape==(len(items),768) and np.isfinite(vectors).all() and np.allclose(np.linalg.norm(vectors,axis=1),1,atol=.01);allvalues[kind].extend(vectors)
       if torch.cuda.max_memory_allocated()>8*1024**3:raise MemoryError('bounded joint8GiB peak exceeded')
      tmp=target.with_suffix('.partial')
      with tmp.open('wb') as f:np.savez_compressed(f,**{k:np.asarray(v,np.float32) for k,v in allvalues.items()},offsets=offsets,frame_indices=idx,frame_times=tm,revision=aw.REVISION,recipe=RECIPE,absolute_start=row['detected_start'],duration=row['detected_end']-row['detected_start'])
      tmp.chmod(0o600);tmp.replace(target)
    if fp(Path(row['audio_cache']))!=row['audio_fingerprint'] or fp(Path(row['source_path']))!=row['source_fingerprint']:raise ValueError('source changed during inference')
    completed+=len(row['windows']);print(json.dumps({'phase':'joint_inference','clip':row['row'],'windows_complete':completed,'windows_total':sum(len(r['windows']) for r in rows),'peak_gpu_gib':torch.cuda.max_memory_allocated()/1024**3}),flush=True)
 finally:
  save('inference_summary.json',{'completed_windows':completed,'peak_gpu_gib':torch.cuda.max_memory_allocated()/1024**3,'model_revision':aw.PIN,'recipe':RECIPE,'uploads':0,'cloud_units':0});del model;torch.cuda.empty_cache();page.cache_clear()
 save('numeric_manifest.json',{'recipe':RECIPE,'model_revision':aw.PIN,'rows':[{k:v for k,v in r.items() if k not in ('source_path','audio_cache','pages','covering_audio_cache','visual_frame_cache')} for r in rows]})

if __name__=='__main__':
 began=time.monotonic();deadline=began+min(float(os.environ.get('KURA_JOINT_BUDGET_SECONDS','900')),max(0,(OUT/'synthetic_report.json').stat().st_mtime+900-time.time()));os.nice(10);OUT.mkdir(exist_ok=True);OUT.chmod(0o700);lock=(LAB.parent/'data'/'models'/'recording-audio-jobs'/'.worker.lock').open('a+')
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  with aw.watchdog(deadline):
   aw.await_idle(deadline,gpu=True)
   previous=json.loads((OUT/'private_manifest.json').read_text()) if os.environ.get('KURA_JOINT_RESUME')=='1' else None
   rows=meta(deadline)
   if previous is None:rows=stage(rows,deadline)
   else:
    prior={r['row']:r for r in previous['rows']};valid=[]
    for row in rows:
     old=prior[row['row']]
     if row['source_fingerprint']!=old['source_fingerprint'] or row['page_fingerprints']!=old['page_fingerprints'] or fp(Path(old['audio_cache']))!=old['audio_fingerprint']:raise ValueError('staged resume provenance changed')
     row.update({k:old[k] for k in ('audio_cache','audio_absolute_start','audio_fingerprint')});row['windows']=old['windows'];valid.append(row)
    rows=valid
   for row in rows:
    oldwindows=row['windows'];indices=np.unique(np.round(np.linspace(0,len(oldwindows)-1,min(6,len(oldwindows)))).astype(int));row['windows']=[oldwindows[i] for i in indices];row['sampling_policy']='uniform6 maximum over covered original range, label independent';row['dense_eligible_windows']=len(oldwindows)
    target=OUT/'embeddings'/(row['row']+'.npz')
    if target.exists():
     with np.load(target) as z:
      previous_v={k:z[k].copy() for k in ('joint','image','audio')};oldoffsets=z['offsets'].copy()
     if True:
      reuse=[]
      for w in row['windows']:
       matches=np.flatnonzero(abs(oldoffsets-w['offset'])<.001)
       if not len(matches) or matches[0]>=len(previous_v['joint']):break
       reuse.append(int(matches[0]));tmp=target.with_suffix('.partial')
      with tmp.open('wb') as f:np.savez_compressed(f,**{k:v[reuse] for k,v in previous_v.items()},offsets=np.array([w['offset'] for w in row['windows']]),frame_indices=np.array([w['indices'] for w in row['windows']]),frame_times=np.array([w['times'] for w in row['windows']]),recipe=RECIPE,revision=aw.REVISION,absolute_start=row['detected_start'],duration=row['detected_end']-row['detected_start'])
      tmp.chmod(0o600);tmp.replace(target)
   save('private_manifest.json',{'recipe':RECIPE,'rows':rows});save('sampling_report.json',{'policy':'label-independent uniform6 per covered immutable original range','targets':len(rows),'dense_windows_available':sum(r['dense_eligible_windows'] for r in rows),'sampled_windows':sum(len(r['windows']) for r in rows),'limit_reason':'measured joint image/audio throughput inside existing15min wall budget'})
   infer(rows,deadline)
  save('run_summary.json',{'status':'complete','seconds':time.monotonic()-began,'clips':len(rows),'windows':sum(len(r['windows']) for r in rows),'uploads':0,'production_writes':0})
 except Exception as e:
  import traceback
  save('run_summary.json',{'status':'failed','type':type(e).__name__,'message':str(e) if isinstance(e,(AssertionError,ValueError,TimeoutError,MemoryError)) else 'diagnostic withheld','lines':[{'file':Path(x.filename).name,'line':x.lineno} for x in traceback.extract_tb(e.__traceback__)],'seconds':time.monotonic()-began});print(json.dumps(json.loads((OUT/'run_summary.json').read_text())),flush=True);raise SystemExit(1)
 finally:lock.close()
