"""Timestamped speech semantics, full-original denominator and explicit uncertainty."""
import hashlib,json,sys,time
from collections import Counter
from pathlib import Path
import numpy as np
import dense_original_window_boundaries as da
import joint_window_boundaries as jw
import frame_cuts as fc
from cut_and_whole import save
ASR_PIN='41f01f3fe87f28c78e2fbf8b568835947dd65ed9'
LOADED=[]
GUARD_MODE='whole_target'

def load(cohort_file,cache):
 audio_cache=cohort_file.parent/'joint-gemma/dense-original-audio';rows,excluded=da.load(cohort_file,audio_cache);receipt={r['row']:r for r in json.loads((cohort_file.parent/'joint-gemma/audio_reuse_manifest.json').read_text())['rows']}
 for r in rows:
  n=len(r['offsets']);path=cache/'embeddings'/f"{r['row']}.npz";values=None
  if path.exists():
   with np.load(path) as z:values={k:z[k].copy() for k in z.files}
   assert str(values['revision'])==jw.PIN and str(values['asr_revision'])==ASR_PIN and str(values['alignment'])=='aresample_async_first_pts_0'
   assert abs(float(values['absolute_start'])-r['detected_start'])<.001 and abs(float(values['duration'])-(r['detected_end']-r['detected_start']))<.001 and np.array_equal(values['offsets'],r['offsets']) and np.all(values['decoded_samples']==320000)
   assert str(values['audio_checkpoint_sha256'])==hashlib.sha256((audio_cache/'embeddings'/f"{r['row']}.npz").read_bytes()).hexdigest() and str(values['staged_audio_sha256'])==receipt[r['row']]['cache_sha256']
   text=values['text'];status=np.asarray(values['asr_status'],int);assert text.shape==(n,768) and status.shape==(n,) and np.isfinite(text).all() and np.all(np.isin(status,[-1,0,1,2]))
   usable=status==1;assert np.allclose(np.linalg.norm(text[usable],axis=1),1,atol=.015) and np.all(text[~usable]==0)
   assert np.all(values['timestamp_valid'][usable]) and not np.any(values['truncated'][usable]) and not np.any(values['repetition_suspect'][usable]) and np.all(values['token_count'][usable]>0) and np.all(values['coverage_seconds'][usable]>=0) and np.all(values['coverage_seconds'][usable]<=20.1)
   recipe=str(values['recipe'])
  else:text=np.zeros((n,768),np.float32);status=np.full(n,-1);recipe='missing_timestamped_speech_checkpoint'
  supported=np.isin(status,[0,1]);r['force_original']=bool(np.any(~supported));r['context_mask']=supported;r['asr_status']=status;r['sample']=r['sample'][supported[r['sample']]];numeric=np.concatenate([r['numeric'],(status==1).astype(np.float32)[:,None]],1);statusonly=np.zeros_like(numeric);statusonly[:,-1]=numeric[:,-1];r['numeric']=numeric;r['numeric_by_family']={'audio_status':statusonly};r['arrays']={'audio_pure':r['arrays']['audio_pure'],'audio_status':r['arrays']['audio_pure'],'text_pure':text,'text_numeric':text,'audio_text_pure':np.concatenate([r['arrays']['audio_pure'],text],1),'audio_text_numeric':np.concatenate([r['arrays']['audio_pure'],text],1)};r['recipe']=recipe;r['asr_quality']={k:int(np.sum(values[k])) if values is not None else None for k in ('low_confidence','truncated','repetition_suspect','no_speech_flag')};r['usable_text_windows']=int(np.sum(status==1));r['supported_windows']=int(supported.sum());r['asr_quality_quantiles']={}
  if values is not None:
   for key in ('mean_logprob','mean_text_logprob','no_speech_probability'):
    vals=np.asarray(values[key],float);valid=vals[(status==1)&np.isfinite(vals)];r['asr_quality_quantiles'][key]={'count':len(valid),'p10_median_p90':np.quantile(valid,[.1,.5,.9]).tolist() if len(valid) else None}
 LOADED.clear();LOADED.extend(rows);return rows,excluded

BASE_INTERVALS=fc.intervals

def guarded_intervals(rows,probs,threshold,mode='global'):
 pred=BASE_INTERVALS(rows,probs,threshold,mode)
 result=[]
 for r,value in zip(rows,pred):
  if r.get('force_original'):
   if GUARD_MODE=='whole_target':value=[r['detected_start'],r['detected_end']]
   else:
    unsupported=r['offsets'][~np.isin(r['asr_status'],[0,1])];value=[min(value[0],float(unsupported.min())),max(value[1],float(unsupported.max()+20))]
  result.append(value)
 return result

def argument(name):return Path(sys.argv[sys.argv.index(name)+1])

def run_once():
 jw.load=load;jw.FAMILIES=['audio_pure','audio_status','text_pure','text_numeric','audio_text_pure','audio_text_numeric'];jw.CONTROL_FAMILIES=('audio_pure','audio_status');jw.JOINT_FAMILIES=('text_pure','text_numeric','audio_text_pure','audio_text_numeric');jw.RECIPES=[(family,'basic',C) for family in jw.FAMILIES for C in (.1,1.,10.)]+[(family,'relative',1.) for family in ('text_pure','text_numeric','audio_text_pure','audio_text_numeric')];jw.NUMERIC_NAMES=list(fc.NAMES)+['has_validated_asr_text'];jw.REPORT_PREFIX='dense_original_speech' if GUARD_MODE=='whole_target' else 'dense_original_speech_retain_uncertain';jw.ARTIFACT_KIND='matched_dense_speech_window_boundary';jw.SAMPLING_DESCRIPTION='All21 fully audio-covered immutable originals remain primary denominator; valid empty text is zero; rejected/pending ASR windows are not training samples; uncertainty handling='+GUARD_MODE+'; no transcript persistence';fc.intervals=guarded_intervals
 output=argument('--output')
 try:jw.main()
 except (ValueError,AssertionError) as error:
  if isinstance(error,AssertionError):raise
  counts={'primary_targets':len(LOADED),'supported_training_windows':sum(len(r['sample']) for r in LOADED),'fully_supported_targets':sum(not r['force_original'] for r in LOADED),'usable_text_windows':sum(r['usable_text_windows'] for r in LOADED)};save(output/(jw.REPORT_PREFIX+'_boundary_report.json'),{'enabled':False,'status':'insufficient validated speech training cohort','error_type':type(error).__name__,'error':str(error),'coverage':counts,'uncertainty_policy':'original-range fallback; no labels inferred from rejected/empty ASR'});save(output/(jw.REPORT_PREFIX+'_boundary_envelope.json'),{'enabled':False,'fallback':'original_range'});print(json.dumps(counts));return
 report_path=output/(jw.REPORT_PREFIX+'_boundary_report.json');report=json.loads(report_path.read_text());predictions=json.loads((output/(jw.REPORT_PREFIX+'_boundary_predictions.json')).read_text());byrow={r['row']:r for r in predictions['rows']};supported=[r for r in LOADED if not r['force_original']];status_counts=Counter(str(x) for r in LOADED for x in r['asr_status']);secondary={}
 for family in report['comparisons']:
  if supported:secondary[family]=fc.metrics(supported,[byrow[r['row']]['predictions'][family] for r in supported])
 report['uncertainty_policy']='Any unsupported window forces entire original range' if GUARD_MODE=='whole_target' else 'Clamp bounds outward to fully retain every unsupported20s window; matched audio controls receive identical clamp'
 report['speech_coverage']={'primary_targets':len(LOADED),'primary_windows':sum(len(r['times']) for r in LOADED),'status_counts':dict(status_counts),'fully_supported_targets':len(supported),'fully_supported_channels':len({r['group'] for r in supported}),'targets_with_unsupported_windows':len(LOADED)-len(supported),'whole_original_fallbacks':len(LOADED)-len(supported) if GUARD_MODE=='whole_target' else 0,'supported_training_windows':sum(len(r['sample']) for r in LOADED),'usable_text_windows':sum(r['usable_text_windows'] for r in LOADED),'per_target':[{'row':r['row'],'windows':len(r['times']),'supported_windows':r['supported_windows'],'usable_text_windows':r['usable_text_windows'],'original_fallback':r['force_original'],'quality_flags':r['asr_quality'],'usable_text_quality':r['asr_quality_quantiles']} for r in LOADED]};report['fully_supported_subset']={'status':'adequate diagnostic coverage' if len(supported)>=10 and len({r['group'] for r in supported})>=5 else 'insufficient fully supported speech targets for general precision claim','identity':fc.metrics(supported,[[r['detected_start'],r['detected_end']] for r in supported]),'comparisons':secondary,'quality_selection':'Audio and text share the same support/fallback mask. This selected subset is not evidence of general speech precision.'};report['semantic_limits']='Transcripts are unverified model outputs; no new quality labels derive from ASR. Empty speech means absent text representation, not unwanted media. Low-confidence flags are reported without an added threshold.';save(report_path,report)
 artifact_path=output/(jw.REPORT_PREFIX+'_boundary_envelope.json');artifact=json.loads(artifact_path.read_text());artifact.update(unsupported_asr_policy=report['uncertainty_policy'],valid_asr_statuses=[0,1],empty_asr_vector='zero',asr_model_revision=ASR_PIN,transcripts_saved=False);save(artifact_path,artifact)
 print(json.dumps({'coverage':report['speech_coverage'],'fully_supported_status':report['fully_supported_subset']['status'],'enabled':report['enabled']},indent=2))
def main():
 global GUARD_MODE
 start=time.monotonic();seconds=int(sys.argv[sys.argv.index('--seconds')+1]) if '--seconds' in sys.argv else 170;run_once();GUARD_MODE='retain_unsupported_windows';remaining=max(1,int(seconds-(time.monotonic()-start)))
 if '--seconds' in sys.argv:sys.argv[sys.argv.index('--seconds')+1]=str(remaining)
 else:sys.argv.extend(['--seconds',str(remaining)])
 run_once()

if __name__=='__main__':main()
