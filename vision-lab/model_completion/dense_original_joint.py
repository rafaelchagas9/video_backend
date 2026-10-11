"""Distinct bounded dense joint Gemma pass; validated SSD stages and cached storyboard tiles only."""
import contextlib,fcntl,hashlib,json,os,sys,time
from functools import lru_cache
from pathlib import Path
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[k]='2'
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
LAB=Path(__file__).resolve().parents[1];sys.path.insert(0,str(LAB/'model_completion'));sys.path.insert(0,str(LAB/'colab_audio_pilot'))
import numpy as np
import soundfile as sf
import audio_cache_worker as aw
from prepare import ROOT,save
BASE=ROOT/'joint-gemma';OUT=BASE/'dense-original-joint';RECIPE='gemma2-full740m-joint2alignedstoryboardimages20saudio-original-dense20s-v1'

def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('bounded dense joint deadline')
def fp(path):
 s=path.stat();return [s.st_size,s.st_mtime_ns]

def main():
 os.nice(10);began=time.monotonic();deadline=began+1200;OUT.mkdir(exist_ok=True);OUT.chmod(0o700);folder=OUT/'embeddings';folder.mkdir(exist_ok=True);folder.chmod(0o700)
 receipt=json.loads((BASE/'audio_reuse_manifest.json').read_text());private={r['row']:r for r in json.loads((BASE/'private_manifest.json').read_text())['rows']};rows=[r for r in receipt['rows'] if r['complete_original_coverage']];numeric=[]
 lock=(LAB.parent/'data'/'models'/'recording-audio-jobs'/'.worker.lock').open('a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 try:
  with aw.watchdog(deadline):
   aw.await_idle(deadline,gpu=True)
   from PIL import Image
   import torch
   from sentence_transformers import SentenceTransformer
   from sentence_transformers.util import batch_to_device
   torch.set_num_threads(2)
   with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):model=SentenceTransformer(aw.MODEL,revision=aw.REVISION,device='cuda',model_kwargs={'torch_dtype':torch.bfloat16},local_files_only=True)
   model.eval();completed=0;gpu_seconds=cpu_seconds=0.
   @lru_cache(maxsize=8)
   def page(path):return Image.open(path).convert('RGB')
   try:
    with torch.inference_mode():
     for r in rows:
      check(deadline);meta=private[r['row']];cache=Path(r['cache_path']);assert fp(cache)==r['cache_fingerprint'];digest=hashlib.sha256()
      with cache.open('rb') as f:
       for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
      assert digest.hexdigest()==r['cache_sha256']
      framepath=Path(meta['visual_frame_cache']);assert hashlib.sha256(framepath.read_bytes()).hexdigest()==r['visual_cache_sha256']
      with np.load(framepath) as z:times=z['t'].copy()
      for w in meta['windows']:
       for t,ix in zip(w['times'],w['indices']):assert len(np.flatnonzero(abs(times-t)<.001))==1 and np.flatnonzero(abs(times-t)<.001)[0]==ix
      offsets=np.asarray(r['dense_offsets']);frame_indices=[];frame_times=[]
      for offset in offsets:
       span=np.flatnonzero((times>=offset)&(times<offset+20));assert len(span)>=2
       idx=[int(span[np.argmin(abs(times[span]-(offset+d)))]) for d in (5,15)];assert idx[0]!=idx[1];frame_indices.append(idx);frame_times.append(times[idx].tolist())
      audiofile=BASE/'dense-original-audio'/'embeddings'/(r['row']+'.npz')
      with np.load(audiofile) as z:
       assert str(z['revision'])==aw.REVISION and np.array_equal(z['offsets'],offsets) and z['v'].shape==(len(offsets),768) and np.all(z['decoded_samples']==320000);audio_vectors=z['v'].copy()
      target=folder/(r['row']+'.npz');vectors=[]
      if target.exists():
       with np.load(target) as z:
        if str(z['recipe'])==RECIPE and str(z['revision'])==aw.REVISION and np.array_equal(z['offsets'],offsets):vectors=list(z['joint'])
      with sf.SoundFile(cache) as audio:
       for start in range(len(vectors),len(offsets),2):
        check(deadline);aw.await_idle(deadline);inputs=[]
        for j in range(start,min(start+2,len(offsets))):
         audio.seek(round((offsets[j]-r['audio_start'])*16000));wave=audio.read(320000,dtype='float32');assert len(wave)==320000;images=[]
         for ix in frame_indices[j]:
          key=str(ix//25);path=Path(meta['pages'][key]);assert path.stat().st_dev==cache.stat().st_dev and fp(path)==meta['page_fingerprints'][key]
          image=page(str(path));slot=ix%25;tw,th=meta['sprite_width'],meta['sprite_height'];x,y=slot%5*tw,slot//5*th;assert x+tw<=image.width and y+th<=image.height;images.append(image.crop((x,y,x+tw,y+th)))
         inputs.append({'image':images,'audio':wave})
        started=time.monotonic();features=model.preprocess(inputs);cpu_seconds+=time.monotonic()-started;torch.cuda.synchronize();started=time.monotonic();features=batch_to_device(features,'cuda');value=model(features)['sentence_embedding'];value=torch.nn.functional.normalize(value,p=2,dim=1).detach().float().cpu().numpy();torch.cuda.synchronize();gpu_seconds+=time.monotonic()-started;assert value.shape==(len(inputs),768) and np.isfinite(value).all() and np.allclose(np.linalg.norm(value,axis=1),1,atol=.01);vectors.extend(value)
        if torch.cuda.max_memory_allocated()>8*1024**3:raise MemoryError('joint memory bound8GiB exceeded')
        tmp=target.with_suffix('.partial')
        with tmp.open('wb') as f:np.savez_compressed(f,joint=np.array(vectors,np.float32),audio=audio_vectors,offsets=offsets,frame_times=frame_times,frame_indices=frame_indices,revision=aw.REVISION,recipe=RECIPE,absolute_start=r['original_start'],duration=r['original_end']-r['original_start'],decoded_samples=np.full(len(vectors),320000),alignment=r['alignment'],audio_checkpoint_sha256=hashlib.sha256(audiofile.read_bytes()).hexdigest())
        tmp.chmod(0o600);tmp.replace(target)
      assert fp(cache)==r['cache_fingerprint'];completed+=len(offsets);numeric.append({k:v for k,v in meta.items() if k not in ('source_path','audio_cache','pages','covering_audio_cache','visual_frame_cache','windows')});numeric[-1].update(offsets=offsets.tolist(),frame_times=frame_times,frame_indices=frame_indices,complete_original_coverage=True)
      save(OUT/'numeric_manifest.json',{'recipe':RECIPE,'model_revision':aw.PIN,'window_seconds':20,'offset_unit':'absolute media seconds','rows':numeric});print(json.dumps({'clip':r['row'],'windows_complete':completed,'total_windows':sum(len(x['dense_offsets']) for x in rows),'gpu_peak_gib':torch.cuda.max_memory_allocated()/1024**3}),flush=True)
   finally:
    save(OUT/'inference_summary.json',{'completed_windows':completed,'peak_gpu_gib':torch.cuda.max_memory_allocated()/1024**3,'cpu_preprocess_seconds':cpu_seconds,'gpu_forward_seconds':gpu_seconds,'seconds':time.monotonic()-began,'model_revision':aw.PIN,'recipe':RECIPE,'original_media_reads':0,'raw_video_decodes':0,'audio_vectors_reused':True,'uploads':0});del model;torch.cuda.empty_cache();page.cache_clear()
   save(OUT/'run_summary.json',{'status':'complete','rows':len(rows),'windows':completed,'seconds':time.monotonic()-began,'uploads':0,'original_media_reads':0})
 finally:lock.close()
if __name__=='__main__':
 try:main()
 except Exception as e:
  import traceback
  save(OUT/'run_summary.json',{'status':'failed','type':type(e).__name__,'lines':[{'file':Path(x.filename).name,'line':x.lineno} for x in traceback.extract_tb(e.__traceback__)]});raise SystemExit(1)
