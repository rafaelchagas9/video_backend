"""Bounded private worker: original proposal audio -> pinned numeric cache only.

The backend owns job creation and scheduling. HTTP never imports this module.
Completed generation caches contain no source paths or media metadata strings.
"""
from __future__ import annotations
import argparse, contextlib, fcntl, hashlib, json, math, os, resource, signal, subprocess, sys, time
from pathlib import Path
for _threads in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[_threads]='2'

MODEL='google/embeddinggemma-2'
REVISION='914f7f89142e33e77833254d9c9b90c3cef7303b'
PIN=MODEL+'@'+REVISION
RATE=16000;SECONDS=20;SAMPLES=RATE*SECONDS
MAX_BYTES=1024*1024;MAX_PROPOSALS=60
KEYS=('video_id','analyzed_at','index_model_revision','storyboard_generated_at','frame_count','audio_model_revision')

class Deferred(Exception): pass

def cache_name(identity):
 return hashlib.sha256(json.dumps([identity[k] for k in KEYS],separators=(',',':'),ensure_ascii=False).encode()).hexdigest()+'.json'

def windows(row):
 a,b=row['start_seconds'],row['end_seconds']
 if b-a<SECONDS:return None
 return [[math.floor(max(a,min(a+(b-a)*f-10,b-20))*1000+.5)/1000,0] for f in (1/3,2/3)]

def expected_windows(row):
 value=windows(row)
 if value is not None:
  for pair in value:pair[1]=pair[0]+SECONDS
 return value

def fingerprint(path):
 info=path.stat()
 if not path.is_file():raise ValueError('source must be a regular file')
 return {'size_bytes':info.st_size,'mtime_ns':str(info.st_mtime_ns)}

def load_job(path):
 if path.stat().st_size>65536:raise ValueError('job too large')
 job=json.loads(path.read_text());identity=job['identity'];rows=job['proposals']
 if identity.get('schema_version')!=1 or identity.get('audio_model_revision')!=PIN:raise ValueError('wrong cache schema or model')
 if not isinstance(identity['video_id'],int) or identity['video_id']<=0 or not isinstance(identity['frame_count'],int) or not 0<=identity['frame_count']<=8000:raise ValueError('invalid index identity')
 for key in ('analyzed_at','storyboard_generated_at'):
  from datetime import datetime
  if not isinstance(identity[key],str) or len(identity[key])!=24 or not identity[key].endswith('Z'):raise ValueError('timestamps must match JS milliseconds UTC')
  datetime.fromisoformat(identity[key])
 if not isinstance(identity['index_model_revision'],str) or len(identity['index_model_revision'])>200:raise ValueError('invalid index model')
 fp=identity['source_fingerprint']
 if not isinstance(fp['size_bytes'],int) or not 0<=fp['size_bytes']<=2**53-1 or not isinstance(fp['mtime_ns'],str) or not fp['mtime_ns'].isdigit():raise ValueError('invalid source fingerprint')
 if not isinstance(rows,list) or not 0<len(rows)<=MAX_PROPOSALS:raise ValueError('invalid proposal count')
 seen=set()
 for row in rows:
  rid=row['id'];a,b=row['start_seconds'],row['end_seconds']
  if not isinstance(rid,str) or not 0<len(rid)<=100 or rid.startswith('added-') or rid in seen:raise ValueError('invalid original proposal identity')
  if not isinstance(a,(int,float)) or not isinstance(b,(int,float)) or not math.isfinite(a) or not math.isfinite(b) or a<0 or b<=a:raise ValueError('invalid original interval')
  seen.add(rid)
 if path.name!=cache_name(identity):raise ValueError('job generation filename mismatch')
 source=Path(job['source_path'])
 if not source.is_absolute() or fingerprint(source)!=fp:raise ValueError('source changed before job')
 return job,source

def atomic(path,value):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700)
 payload=json.dumps(value,allow_nan=False,separators=(',',':')).encode()
 if len(payload)>MAX_BYTES:raise ValueError('cache exceeds numeric size limit')
 temporary=path.with_suffix('.partial')
 with temporary.open('wb') as file:file.write(payload);file.flush();os.fsync(file.fileno())
 temporary.chmod(0o600);temporary.replace(path)

def busy():
 for entry in Path('/proc').iterdir():
  if not entry.name.isdigit() or int(entry.name)==os.getpid():continue
  try:comm=(entry/'comm').read_text().strip();cmd=(entry/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
  except OSError:continue
  names=('audio_features.py','dense_boundary_audio.py','audio_complete.py','fine_audio_match.py')
  if os.environ.get('KURA_AUDIO_DENSE_CPU_ONLY')=='1':names=tuple(n for n in names if n!='dense_boundary_audio.py')
  if comm=='ffmpeg' or (comm.startswith('python') and any(name in cmd for name in names)):return True
 return False

def gpu_idle():
 for path in Path('/sys/class/drm').glob('card[0-9]*/device/gpu_busy_percent'):
  try:
   if int(path.read_text())>10:return False
  except (OSError,ValueError):pass
 return True

def await_idle(deadline,gpu=False):
 while busy() or (gpu and not gpu_idle()):
  if time.monotonic()+2>=deadline:raise Deferred()
  time.sleep(2)

def limited():
 os.nice(10);resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))

def decode(source,offset,deadline):
 remaining=deadline-time.monotonic()
 if remaining<3:raise Deferred()
 command=['ionice','-c','3','ffmpeg','-nostdin','-v','error','-threads','1','-filter_threads','1','-filter_complex_threads','1','-ss',str(offset),'-vn','-i',str(source),'-map','0:a:0','-threads','1','-af','aresample=16000:async=1:first_pts=0','-t',str(SECONDS),'-ac','1','-ar',str(RATE),'-f','s16le','-']
 child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=limited)
 try:audio,_=child.communicate(timeout=min(45,remaining))
 except BaseException:
  child.kill();child.communicate();raise
 if child.returncode or len(audio)!=SAMPLES*2:raise ValueError('incomplete bounded audio')
 import numpy as np
 return np.frombuffer(audio,dtype='<i2').astype(np.float32)/32768

def valid_cached(row,previous):
 import numpy as np
 if previous.get('id')!=row['id'] or previous.get('start_seconds')!=row['start_seconds'] or previous.get('end_seconds')!=row['end_seconds'] or previous.get('status')!='ready':return False
 if previous.get('windows_seconds')!=expected_windows(row) or previous.get('decoded_samples')!=[SAMPLES,SAMPLES]:return False
 vector=np.asarray(previous.get('embedding'),dtype=float)
 return vector.shape==(768,) and np.isfinite(vector).all() and abs(float(np.linalg.norm(vector))-1)<.01

@contextlib.contextmanager
def watchdog(deadline):
 def expired(*_):raise Deferred()
 previous=signal.getsignal(signal.SIGALRM);signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
 try:yield
 finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

class Processor:
 def __init__(self,deadline,root):self.deadline=deadline;self.root=root;self.model=None;self.changed_ids=set()
 def model_ready(self):
  if self.model is not None:return
  await_idle(self.deadline,gpu=True)
  for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[key]='2'
  os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
  import torch
  from sentence_transformers import SentenceTransformer
  torch.set_num_threads(2)
  if not torch.cuda.is_available():raise ValueError('local GPU unavailable')
  dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
  with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
   self.model=SentenceTransformer(MODEL,revision=REVISION,device='cuda',config_kwargs={'vision_config':None},model_kwargs={'torch_dtype':dtype},local_files_only=True)
 def process(self,path):
  job,source=load_job(path);identity=job['identity'];target=self.root/cache_name(identity);previous={}
  if target.exists() and target.stat().st_size<=MAX_BYTES:
   try:
    cache=json.loads(target.read_text())
    if all(cache.get(k)==v for k,v in identity.items()):previous={r['id']:r for r in cache['proposals']}
   except (ValueError,KeyError,OSError):pass
  cache=dict(identity,proposals=[])
  for row in job['proposals']:
   if time.monotonic()>=self.deadline:raise Deferred()
   cached=previous.get(row['id'],{})
   if valid_cached(row,cached):cache['proposals'].append(cached);continue
   record={k:row[k] for k in ('id','start_seconds','end_seconds')};intervals=expected_windows(row)
   if intervals is None:record['status']='failed';cache['proposals'].append(record);atomic(target,cache);continue
   try:
    self.model_ready();waves=[]
    for start,_ in intervals:await_idle(self.deadline);waves.append(decode(source,start,self.deadline))
    if fingerprint(source)!=identity['source_fingerprint']:raise Deferred()
    import numpy as np
    import torch
    with torch.inference_mode():vectors=self.model.encode([{'audio':wave} for wave in waves],batch_size=2,normalize_embeddings=True,show_progress_bar=False)
    if vectors.shape!=(2,768) or not np.isfinite(vectors).all() or not np.allclose(np.linalg.norm(vectors,axis=1),1,atol=.01):raise ValueError('invalid pinned output')
    vector=vectors.mean(0);norm=float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm<=0:raise ValueError('invalid embedding norm')
    record.update(status='ready',embedding=(vector/norm).tolist(),windows_seconds=intervals,decoded_samples=[len(w) for w in waves])
   except (OSError,ValueError,subprocess.TimeoutExpired):record['status']='failed'
   cache['proposals'].append(record)
   if fingerprint(source)!=identity['source_fingerprint']:raise Deferred()
   atomic(target,cache)
   if record['status']=='ready':self.changed_ids.add(identity['video_id'])
  # Do not delete a concurrently replaced generation job, even when this source stayed stable.
  if fingerprint(source)!=identity['source_fingerprint']:raise Deferred()
  current=json.loads(path.read_text())
  if current==job:path.unlink()
  print(json.dumps({'video_id':identity['video_id'],'ready':sum(r['status']=='ready' for r in cache['proposals']),'failed':sum(r['status']=='failed' for r in cache['proposals'])}),flush=True)
 def completion(self):
  if self.changed_ids:print(json.dumps({'event':'recordings:model-ready','video_ids':sorted(self.changed_ids)}),flush=True)
 def close(self):
  if self.model is not None:
   import torch
   del self.model;torch.cuda.empty_cache()

def main():
 parser=argparse.ArgumentParser();parser.add_argument('job',type=Path);parser.add_argument('--cache-root',type=Path,required=True);parser.add_argument('--seconds',type=int,default=300);args=parser.parse_args()
 if not 10<=args.seconds<=1200:raise ValueError('worker budget outside allowed bound')
 if not args.job.exists():return
 jobs=args.job.resolve().parent;jobs.mkdir(parents=True,exist_ok=True,mode=0o700);lockpath=jobs/'.worker.lock'
 with lockpath.open('a') as lock:
  lockpath.chmod(0o600)
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return
  deadline=time.monotonic()+args.seconds;worker=Processor(deadline,args.cache_root.resolve())
  try:
   with watchdog(deadline):
    await_idle(deadline,gpu=True)
    seen=set();first=args.job.resolve()
    while time.monotonic()<deadline:
     queue=([first] if first not in seen and first.exists() else [])+[p for p in sorted(jobs.glob('*.json')) if p not in seen and p!=first]
     if not queue:break
     for job in queue:
      seen.add(job)
      if not job.exists():continue
      try:worker.process(job)
      except (OSError,ValueError,KeyError):print(json.dumps({'status':'invalid-private-job'}),flush=True)
  except Deferred:print(json.dumps({'status':'deferred-numeric-fallback'}),flush=True)
  except Exception as error:print(json.dumps({'status':'worker-unavailable','error_type':type(error).__name__}),flush=True)
  finally:
   try:worker.close()
   finally:worker.completion()
if __name__=='__main__':main()
