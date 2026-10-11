"""Timestamped Whisper->Gemma text semantics on immutable original SSD stages.

Strict twenty-minute process budget. No original media reads, uploads, stored
transcripts or stored token sequences. Status: -1 unsupported/pending, 0 validated
no text/silence, 1 unit text embedding, 2 rejected generation. Missing text remains
explicit uncertainty; it is never a human negative label.
"""
import contextlib,copy,fcntl,gc,hashlib,json,os,sys,time
from pathlib import Path
for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[k]='2'
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
LAB=Path(__file__).resolve().parents[1];sys.path.insert(0,str(LAB/'model_completion'));sys.path.insert(0,str(LAB/'colab_audio_pilot'))
import numpy as np
import soundfile as sf
import audio_cache_worker as aw
import models_v2 as mv
from prepare import ROOT,save
BASE=ROOT/'joint-gemma';OUT=BASE/'dense-original-speech';RECIPE='whisper-turbo-timestamped20s-gemma2-classification-text-original-dense20s-v1'

def fp(p):
 s=p.stat();return [s.st_size,s.st_mtime_ns]

def checkpoint(target,data,r,audiohash):
 tmp=target.with_suffix('.partial')
 with tmp.open('wb') as f:
  np.savez_compressed(f,**data,offsets=np.asarray(r['dense_offsets']),revision=aw.REVISION,asr_revision=mv.MODEL_PINS['whisper'][1],recipe=RECIPE,absolute_start=r['original_start'],duration=r['original_end']-r['original_start'],decoded_samples=np.full(len(r['dense_offsets']),320000),alignment=r['alignment'],audio_checkpoint_sha256=audiohash,staged_audio_sha256=r['cache_sha256'])
 tmp.chmod(0o600);tmp.replace(target)

def main():
 os.nice(10);began=time.monotonic();deadline=began+1200;OUT.mkdir(exist_ok=True);OUT.chmod(0o700);folder=OUT/'embeddings';folder.mkdir(exist_ok=True);folder.chmod(0o700)
 rows=[r for r in json.loads((BASE/'audio_reuse_manifest.json').read_text())['rows'] if r['complete_original_coverage']];base={r['row']:r for r in json.loads((BASE/'dense-original-joint/numeric_manifest.json').read_text())['rows']};assert len(rows)==21 and sum(len(r['dense_offsets']) for r in rows)==1149
 report={'status':'running','planned_targets':21,'planned_windows':1149,'recipe':RECIPE,'asr_model':mv.MODEL_PINS['whisper'][0]+'@'+mv.MODEL_PINS['whisper'][1],'text_model':aw.PIN,'text_prompt':'Classification','silence_criteria':{'raw_initial_no_speech_probability_gt':.6,'average_generated_log_probability_lt':-1.},'compression_ratio_rejection_gt':2.4,'original_media_reads':0,'uploads':0,'transcripts_saved':False,'token_sequences_saved':False,'complete_targets':0,'completed_windows':0,'asr_seconds':0.,'text_embedding_seconds':0.,'raw_no_speech_seconds':0.}
 save(OUT/'run_summary.json',report);lock=(LAB.parent/'data/models/recording-audio-jobs/.worker.lock').open('a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);numeric=[];status_counts={str(x):0 for x in (-1,0,1,2)}
 try:
  with aw.watchdog(deadline):
   aw.await_idle(deadline,gpu=True)
   import torch
   from transformers import AutoProcessor,AutoModelForSpeechSeq2Seq,StoppingCriteria,StoppingCriteriaList
   from transformers.utils import logging as hf_logging
   from sentence_transformers import SentenceTransformer
   hf_logging.set_verbosity_error();torch.set_num_threads(2);dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32;repo,rev=mv.MODEL_PINS['whisper']
   with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
    processor=AutoProcessor.from_pretrained(repo,revision=rev,local_files_only=True);asr=AutoModelForSpeechSeq2Seq.from_pretrained(repo,revision=rev,dtype=dtype,attn_implementation='sdpa',local_files_only=True).to('cuda').eval();textmodel=SentenceTransformer(aw.MODEL,revision=aw.REVISION,device='cuda',config_kwargs={'vision_config':None,'audio_config':None},model_kwargs={'torch_dtype':dtype},local_files_only=True)
   textmodel.eval();tokenizer=processor.tokenizer;timestamp_begin=tokenizer.convert_tokens_to_ids('<|0.00|>');nospeech=tokenizer.convert_tokens_to_ids('<|nospeech|>');eos=asr.generation_config.eos_token_id;config=copy.deepcopy(asr.generation_config);config.output_scores=True;config.max_new_tokens=440;config.do_sample=False;config.max_length=448;config.logprob_threshold=None;config.no_speech_threshold=None;config.compression_ratio_threshold=None
   class Deadline(StoppingCriteria):
    def __call__(self,input_ids,scores,**kwargs):
     if time.monotonic()>=deadline:raise TimeoutError('speech twenty-minute wall bound')
     return False
   try:
    with torch.inference_mode():
     for r in rows:
      aw.await_idle(deadline);cache=Path(r['cache_path']);assert fp(cache)==r['cache_fingerprint'] and cache.stat().st_dev==BASE.stat().st_dev;h=hashlib.sha256()
      with cache.open('rb') as f:
       for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
      assert h.hexdigest()==r['cache_sha256'];offsets=np.asarray(r['dense_offsets']);n=len(offsets);audiofile=BASE/'dense-original-audio/embeddings'/(r['row']+'.npz');audiohash=hashlib.sha256(audiofile.read_bytes()).hexdigest()
      with np.load(audiofile) as z:assert np.array_equal(z['offsets'],offsets) and str(z['revision'])==aw.REVISION and np.all(z['decoded_samples']==320000)
      data={'text':np.zeros((n,768),np.float32),'asr_status':np.full(n,-1,np.int8),'token_count':np.zeros(n,np.int16),'mean_logprob':np.zeros(n,np.float32),'mean_text_logprob':np.zeros(n,np.float32),'no_speech_probability':np.zeros(n,np.float32),'timestamp_valid':np.zeros(n,bool),'coverage_seconds':np.zeros(n,np.float32),'truncated':np.zeros(n,bool),'repetition_suspect':np.zeros(n,bool),'low_confidence':np.zeros(n,bool),'timestamp_count':np.zeros(n,np.int16),'no_speech_flag':np.zeros(n,bool)};target=folder/(r['row']+'.npz')
      with sf.SoundFile(cache) as f:
       for start in range(0,n,4):
        aw.await_idle(deadline);waves=[]
        for offset in offsets[start:start+4]:f.seek(round((offset-r['audio_start'])*16000));wave=f.read(320000,dtype='float32');assert len(wave)==320000 and np.isfinite(wave).all();waves.append(wave)
        inputs=processor(waves,sampling_rate=16000,return_tensors='pt',return_attention_mask=True).to('cuda',dtype);started=time.monotonic();sot=torch.full((len(waves),1),asr.generation_config.decoder_start_token_id,device='cuda',dtype=torch.long);raw=asr(**inputs,decoder_input_ids=sot,use_cache=False).logits[:,0,:].float();ns=raw.softmax(-1)[:,nospeech].cpu().numpy();torch.cuda.synchronize();report['raw_no_speech_seconds']+=time.monotonic()-started;del raw,sot
        started=time.monotonic()
        with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):result=asr.generate(**inputs,generation_config=config,task='transcribe',return_timestamps=True,return_dict_in_generate=True,force_unique_generate_call=True,stopping_criteria=StoppingCriteriaList([Deadline()]))
        torch.cuda.synchronize();report['asr_seconds']+=time.monotonic()-started;seq=result.sequences;prefix=seq.shape[1]-len(result.scores);texts=processor.batch_decode(seq,skip_special_tokens=True,clean_up_tokenization_spaces=False);to_embed=[];positions=[]
        for j,text in enumerate(texts):
         ix=start+j;tokens=seq[j,prefix:];ids=tokens.tolist();ended=eos in ids;limit=ids.index(eos)+1 if ended else len(ids);tokens=tokens[:limit];ids=ids[:limit];stamp=[(t-timestamp_begin)*.02 for t in ids if t>=timestamp_begin];lp=[];tlp=[]
         for step,score in enumerate(result.scores[:limit]):
          logs=torch.log_softmax(score[j].float(),dim=-1);value=float(logs[ids[step]].item());lp.append(value)
          if ids[step]<timestamp_begin and ids[step] not in tokenizer.all_special_ids:tlp.append(value)
         avg=float(np.mean(lp)) if lp else 0.;textavg=float(np.mean(tlp)) if tlp else 0.;compression=asr._retrieve_compression_ratio(tokens,asr.config.vocab_size) if len(tokens) else 0.;truncated=not ended;repetition=compression>2.4;valid=bool(len(stamp)>=2 and len(stamp)%2==0 and all(x<=y for x,y in zip(stamp,stamp[1:])) and all(0<=t<=20.1 for t in stamp));coverage=sum(max(0,min(20.,y)-max(0.,x)) for x,y in zip(stamp[::2],stamp[1::2]));silence=bool(ns[j]>.6 and avg<-1.);empty=mv._text_status(text)==0
         status=0 if silence else (2 if truncated or repetition or not valid or mv._text_status(text)==2 else (0 if empty else 1))
         data['asr_status'][ix]=status;data['token_count'][ix]=len(tlp);data['mean_logprob'][ix]=avg;data['mean_text_logprob'][ix]=textavg;data['no_speech_probability'][ix]=ns[j];data['timestamp_valid'][ix]=valid;data['coverage_seconds'][ix]=min(20.,coverage);data['truncated'][ix]=truncated;data['repetition_suspect'][ix]=repetition;data['low_confidence'][ix]=avg<-1.;data['timestamp_count'][ix]=len(stamp);data['no_speech_flag'][ix]=silence
         if status==1:positions.append(ix);to_embed.append(text)
        if to_embed:
         started=time.monotonic();vectors=textmodel.encode(to_embed,prompt_name='Classification',batch_size=4,normalize_embeddings=True,show_progress_bar=False);report['text_embedding_seconds']+=time.monotonic()-started;assert vectors.shape==(len(to_embed),768) and np.isfinite(vectors).all() and np.allclose(np.linalg.norm(vectors,axis=1),1,atol=.01)
         for ix,v in zip(positions,vectors):data['text'][ix]=v
         del vectors,v
        del result,seq,tokens,ids,text,texts,to_embed,inputs,waves;gc.collect();assert torch.cuda.max_memory_allocated()<=8*1024**3;checkpoint(target,data,r,audiohash)
      assert fp(cache)==r['cache_fingerprint'];report['complete_targets']+=1;report['completed_windows']+=n
      for key in status_counts:status_counts[key]+=int(np.sum(data['asr_status']==int(key)))
      numeric.append(dict(base[r['row']],speech_complete=True));save(OUT/'numeric_manifest.json',{'recipe':RECIPE,'revision':aw.PIN,'asr_revision':repo+'@'+rev,'text_prompt':'Classification','window_seconds':20,'offset_unit':'absolute media seconds','rows':numeric});report.update(seconds=time.monotonic()-began,status_counts=status_counts,peak_gpu_gib=torch.cuda.max_memory_allocated()/1024**3);save(OUT/'run_summary.json',report);print(json.dumps({'clip':r['row'],'windows_complete':report['completed_windows'],'total_windows':1149,'status_counts':status_counts,'seconds':report['seconds']}),flush=True)
   finally:
    report.update(seconds=time.monotonic()-began,peak_gpu_gib=torch.cuda.max_memory_allocated()/1024**3);save(OUT/'run_summary.json',report);del asr,processor,textmodel;gc.collect();torch.cuda.empty_cache()
   report['status']='complete';save(OUT/'run_summary.json',report)
 finally:lock.close()
if __name__=='__main__':
 try:main()
 except Exception as e:
  import traceback
  save(OUT/'failure.json',{'status':'failed','type':type(e).__name__,'frames':[{'file':Path(x.filename).name,'line':x.lineno} for x in traceback.extract_tb(e.__traceback__)],'transcripts_saved':False,'uploads':0});raise SystemExit(1)
