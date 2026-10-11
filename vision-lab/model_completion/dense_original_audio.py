"""Dense immutable-original Gemma audio from validated neutral SSD stages only."""
import contextlib,fcntl,hashlib,json,os,sys,time
from pathlib import Path
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[k]='2'
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
LAB=Path(__file__).resolve().parents[1];sys.path.insert(0,str(LAB/'model_completion'));sys.path.insert(0,str(LAB/'colab_audio_pilot'))
import numpy as np
import soundfile as sf
import audio_cache_worker as aw
from prepare import ROOT,save
OUT=ROOT/'joint-gemma'/'dense-original-audio';RECIPE='gemma2-audio570m-original-uniform20s-v1'

def main():
 os.nice(10);began=time.monotonic();deadline=began+300;OUT.mkdir(exist_ok=True);OUT.chmod(0o700);folder=OUT/'embeddings';folder.mkdir(exist_ok=True);folder.chmod(0o700)
 manifest=json.loads((ROOT/'joint-gemma'/'audio_reuse_manifest.json').read_text());base={r['row']:r for r in json.loads((ROOT/'actual_fine_cohort.json').read_text())['rows']};rows=[]
 lock=(LAB.parent/'data'/'models'/'recording-audio-jobs'/'.worker.lock').open('a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 try:
  with aw.watchdog(deadline):
   aw.await_idle(deadline,gpu=True)
   for r in manifest['rows']:
    path=Path(r['cache_path']);s=path.stat()
    if [s.st_size,s.st_mtime_ns]!=r['cache_fingerprint']:raise ValueError('neutral SSD stage fingerprint changed')
    digest=hashlib.sha256()
    with path.open('rb') as f:
     for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
    if digest.hexdigest()!=r['cache_sha256']:raise ValueError('neutral stage checksum mismatch')
    info=sf.info(path)
    if info.samplerate!=16000 or info.channels!=1 or r['audio_start']+info.duration<r['audio_end']-.001:raise ValueError('stage timeline mismatch')
    rows.append(r)
   import torch
   from sentence_transformers import SentenceTransformer
   torch.set_num_threads(2)
   with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):model=SentenceTransformer(aw.MODEL,revision=aw.REVISION,device='cuda',config_kwargs={'vision_config':None},model_kwargs={'torch_dtype':torch.bfloat16},local_files_only=True)
   model.eval();completed=0;infer_time=0.
   try:
    with torch.inference_mode():
     for r in rows:
      offsets=np.array(r['dense_offsets']);target=folder/(r['row']+'.npz');values=[]
      if target.exists():
       with np.load(target) as z:
        if str(z['recipe'])==RECIPE and str(z['revision'])==aw.REVISION and np.array_equal(z['offsets'],offsets):values=list(z['v'])
      with sf.SoundFile(r['cache_path']) as f:
       for j in range(len(values),len(offsets),4):
        if time.monotonic()>=deadline:raise TimeoutError('dense original audio deadline')
        waves=[]
        for offset in offsets[j:j+4]:
         f.seek(round((offset-r['audio_start'])*16000));wave=f.read(320000,dtype='float32');assert len(wave)==320000;waves.append(wave)
        started=time.monotonic();v=model.encode([{'audio':w} for w in waves],batch_size=4,normalize_embeddings=True,show_progress_bar=False);infer_time+=time.monotonic()-started;assert v.shape==(len(waves),768) and np.isfinite(v).all() and np.allclose(np.linalg.norm(v,axis=1),1,atol=.01);values.extend(v)
        tmp=target.with_suffix('.partial')
        with tmp.open('wb') as out:np.savez_compressed(out,v=np.array(values,np.float32),offsets=offsets,revision=aw.REVISION,recipe=RECIPE,absolute_start=r['original_start'],duration=r['original_end']-r['original_start'],decoded_samples=np.full(len(values),320000),alignment=r['alignment'])
        tmp.chmod(0o600);tmp.replace(target)
      completed+=len(offsets);print(json.dumps({'clip':r['row'],'windows_complete':completed,'total_windows':sum(len(x['dense_offsets']) for x in rows)}),flush=True)
   finally:
    save(OUT/'inference_summary.json',{'completed_windows':completed,'peak_gpu_gib':torch.cuda.max_memory_allocated()/1024**3,'inference_seconds':infer_time,'seconds':time.monotonic()-began,'model_revision':aw.PIN,'recipe':RECIPE,'raw_video_decodes':0,'original_media_reads':0,'uploads':0});del model;torch.cuda.empty_cache()
   save(OUT/'numeric_manifest.json',{'recipe':RECIPE,'window_seconds':20,'offset_unit':'absolute media seconds','model_revision':aw.PIN,'rows':[dict(base[r['row']],offsets=r['dense_offsets'],complete_original_coverage=r['complete_original_coverage'],complete_selected_coverage=r['complete_selected_coverage'],audio_start=r['audio_start'],audio_end=r['audio_end']) for r in rows]})
   save(OUT/'run_summary.json',{'status':'complete','rows':len(rows),'windows':completed,'full_original_rows':sum(r['complete_original_coverage'] for r in rows),'full_original_windows':sum(len(r['dense_offsets']) for r in rows if r['complete_original_coverage']),'seconds':time.monotonic()-began,'uploads':0,'original_media_reads':0})
 finally:lock.close()
if __name__=='__main__':
 try:main()
 except Exception as e:
  import traceback
  save(OUT/'run_summary.json',{'status':'failed','type':type(e).__name__,'lines':[{'file':Path(x.filename).name,'line':x.lineno} for x in traceback.extract_tb(e.__traceback__)]});raise SystemExit(1)
