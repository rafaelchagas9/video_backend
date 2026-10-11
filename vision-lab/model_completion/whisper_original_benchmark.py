"""Bounded cached-only Whisper timing on eight label-independent SSD windows.

No transcript or token sequence is persisted. Confidence is model output confidence,
not transcription accuracy. No originals, uploads, downloads or database writes.
"""
import contextlib,copy,fcntl,gc,hashlib,json,os,sys,time,zlib
from pathlib import Path
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[k]='2'
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
LAB=Path(__file__).resolve().parents[1];sys.path.insert(0,str(LAB/'model_completion'));sys.path.insert(0,str(LAB/'colab_audio_pilot'))
import numpy as np
import soundfile as sf
import audio_cache_worker as aw
import models_v2 as mv
from prepare import ROOT,save
OUT=ROOT/'joint-gemma'/'whisper-original-benchmark'

def main():
 os.nice(10);began=time.monotonic();deadline=began+90;OUT.mkdir(exist_ok=True);OUT.chmod(0o700)
 rows=[r for r in json.loads((ROOT/'joint-gemma/audio_reuse_manifest.json').read_text())['rows'] if r['complete_original_coverage']]
 # Evenly spaced rows in stable numeric order; middle window in each selected original.
 rows=sorted(rows,key=lambda r:r['row']);indices=np.linspace(0,len(rows)-1,8).round().astype(int);selected=[rows[i] for i in indices]
 lock=(LAB.parent/'data/models/recording-audio-jobs/.worker.lock').open('a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 report={'status':'started','window_seconds':20,'planned_windows':8,'batch_size':4,'checkpoint':mv.MODEL_PINS['whisper'][0]+'@'+mv.MODEL_PINS['whisper'][1],'selection':'eight evenly spaced neutral rows, middle original window; no chosen-cut labels used','original_media_reads':0,'uploads':0,'transcripts_saved':False,'token_sequences_saved':False,'quality_is_reference_free':True,'windows':[]}
 try:
  with aw.watchdog(deadline):
   aw.await_idle(deadline,gpu=True);waves=[]
   for r in selected:
    path=Path(r['cache_path']);s=path.stat();assert [s.st_size,s.st_mtime_ns]==r['cache_fingerprint'];assert path.stat().st_dev==(ROOT/'joint-gemma').stat().st_dev
    h=hashlib.sha256()
    with path.open('rb') as f:
     for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    assert h.hexdigest()==r['cache_sha256'];offset=r['dense_offsets'][len(r['dense_offsets'])//2]
    with sf.SoundFile(path) as f:f.seek(round((offset-r['audio_start'])*16000));wave=f.read(320000,dtype='float32')
    assert len(wave)==320000 and np.isfinite(wave).all();waves.append(wave);report['windows'].append({'row':r['row'],'offset':offset,'decoded_samples':len(wave),'rms':float(np.sqrt(np.mean(wave.astype(float)**2)))})
   import torch
   from transformers import AutoProcessor,AutoModelForSpeechSeq2Seq,StoppingCriteria,StoppingCriteriaList
   torch.set_num_threads(2);dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32;repo,rev=mv.MODEL_PINS['whisper'];started=time.monotonic()
   with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
    processor=AutoProcessor.from_pretrained(repo,revision=rev,local_files_only=True);model=AutoModelForSpeechSeq2Seq.from_pretrained(repo,revision=rev,dtype=dtype,attn_implementation='sdpa',local_files_only=True).to('cuda').eval()
   report['load_seconds']=time.monotonic()-started;report['batches']=[];tokenizer=processor.tokenizer;timestamp_begin=tokenizer.convert_tokens_to_ids('<|0.00|>');no_speech=tokenizer.convert_tokens_to_ids('<|nospeech|>');config=copy.deepcopy(model.generation_config);config.output_scores=True;config.max_length=None
   class Deadline(StoppingCriteria):
    def __call__(self,input_ids,scores,**kwargs):
     if time.monotonic()>=deadline:raise TimeoutError('Whisper benchmark wall bound')
     return False
   try:
    with torch.inference_mode():
     for start in range(0,len(waves),4):
      aw.await_idle(deadline);started=time.monotonic();inputs=processor(waves[start:start+4],sampling_rate=16000,return_tensors='pt',return_attention_mask=True).to('cuda',dtype);prep=time.monotonic()-started;torch.cuda.synchronize();started=time.monotonic()
      with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
       result=model.generate(**inputs,generation_config=config,max_new_tokens=440,do_sample=False,task='transcribe',return_timestamps=True,return_dict_in_generate=True,force_unique_generate_call=True,stopping_criteria=StoppingCriteriaList([Deadline()]))
      torch.cuda.synchronize();elapsed=time.monotonic()-started;seq=result.sequences;prefix=seq.shape[1]-len(result.scores);texts=processor.batch_decode(seq,skip_special_tokens=True);report['batches'].append({'windows':len(texts),'preprocess_seconds':prep,'inference_seconds':elapsed})
      for j,text in enumerate(texts):
       tokens=seq[j,prefix:].tolist();stamp=[(t-timestamp_begin)*.02 for t in tokens if t>=timestamp_begin];probs=[];no_speech_probability=None
       for step,score in enumerate(result.scores):
        scores=score[j].float();free=int(torch.isfinite(scores).sum())>1
        if not free:continue
        lp=torch.log_softmax(scores,dim=-1)
        if no_speech_probability is None and 0<=no_speech<len(lp):no_speech_probability=float(lp[no_speech].exp().item())
        token=tokens[step]
        if token<timestamp_begin and token not in tokenizer.all_special_ids:probs.append(float(lp[token].item()))
       status=mv._text_status(text,len(tokens)>=440 and tokens[-1]!=model.generation_config.eos_token_id)
       report['windows'][start+j].update(text_status=status,text_token_count=len(probs),mean_text_log_probability=float(np.mean(probs)) if probs else None,no_speech_token_probability=no_speech_probability,timestamp_count=len(stamp),timestamp_monotonic=all(a<=b for a,b in zip(stamp,stamp[1:])),timestamp_within_input=all(0<=t<=20.1 for t in stamp))
      del texts,seq,result,inputs,text,tokens;gc.collect()
      if torch.cuda.max_memory_allocated()>8*1024**3:raise MemoryError('Whisper benchmark memory bound')
      save(OUT/'report.json',dict(report,status='partial',seconds=time.monotonic()-began))
   finally:
    report['peak_gpu_gib']=torch.cuda.max_memory_allocated()/1024**3;del model,processor;gc.collect();torch.cuda.empty_cache()
   report.update(status='complete',seconds=time.monotonic()-began,asr_seconds_per_window=sum(b['inference_seconds'] for b in report['batches'])/len(report['windows']))
   save(OUT/'report.json',report);print(json.dumps({k:v for k,v in report.items() if k not in ('windows','batches')}),flush=True)
 finally:lock.close()
if __name__=='__main__':
 try:main()
 except Exception as e:
  import traceback
  OUT.mkdir(exist_ok=True);save(OUT/'failure.json',{'status':'failed','type':type(e).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno} for f in traceback.extract_tb(e.__traceback__)],'transcripts_saved':False,'uploads':0});raise SystemExit(1)
