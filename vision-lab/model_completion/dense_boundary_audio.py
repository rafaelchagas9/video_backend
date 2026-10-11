"""Bounded local fine-cut localization. Neutral SSD audio; numeric checkpoints; no uploads."""
import argparse,hashlib,json,math,os,resource,subprocess,sys,time
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';os.environ['HF_HUB_DISABLE_PROGRESS_BARS']='1'
import numpy as np
import soundfile as sf
from cut_and_whole import fine_boundaries,splits,save,interval_metrics
import frame_cuts as fc
PIN=('google/embeddinggemma-2','914f7f89142e33e77833254d9c9b90c3cef7303b')
RATE=16000;SAMPLES=320000

def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Bounded localization deadline reached; durable checkpoints remain.')

def limited():resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))

def stage(fine,source_rows,out,deadline):
 sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'colab_audio_pilot'));import pipeline as p
 out.mkdir(parents=True,exist_ok=True);out.chmod(0o700);exclusions=json.loads((out/'coverage_exclusions.json').read_text()) if (out/'coverage_exclusions.json').exists() else {};audio=out/'audio';audio.mkdir(exist_ok=True);audio.chmod(0o700)
 mapping={f"fine{r['task_id']}{r['row'][-1]}":r for r in source_rows};records=[];audio_dir=Path(__file__).resolve().parents[1]/'data'/'audio_src'
 p.await_idle(deadline,settle=0)
 for i,row in enumerate(fine):
  check(deadline);p.await_idle(deadline,settle=0)
  if row['row'] in exclusions:continue
  source=Path(mapping[row['row']]['path']);a,b=row['detected_start'],row['detected_end'];duration=b-a
  neutral=audio/f'c{i:03d}.flac';cached=audio_dir/f"{row['video_id']}.opus"
  if cached.is_file():
   try:
    meta=json.loads(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(cached)],capture_output=True,text=True,timeout=10).stdout)
    if float(meta['format']['duration'])>=b-.25:source=cached
   except Exception:pass
  if not neutral.exists():
   if deadline-time.monotonic()<30:raise TimeoutError('Insufficient bounded decode budget.')
   signature=source.stat();tmp=neutral.with_suffix('.partial')
   command=['nice','-n','19','ionice','-c','3','ffmpeg','-nostdin','-v','error','-filter_threads','1','-filter_complex_threads','1','-threads','1','-ss',str(a),'-i',str(source),'-t',str(duration),'-map','0:a:0','-vn','-sn','-dn','-af','aresample=16000:async=1:first_pts=0','-ac','1','-ar','16000','-sample_fmt','s16','-threads','1','-c:a','flac','-map_metadata','-1','-map_chapters','-1','-f','flac','-y',str(tmp)]
   result=subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=min(120,deadline-time.monotonic()),preexec_fn=limited)
   if result.returncode:raise RuntimeError(f'Audio decode failed on neutral clip c{i:03d}; raw diagnostic withheld.')
   after=source.stat()
   if (signature.st_size,signature.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise RuntimeError('Source changed during extraction; checkpoint not published.')
   info=sf.info(tmp)
   if info.samplerate!=RATE or info.channels!=1:raise RuntimeError('Decoded audio has an unexpected format.')
   if info.duration<duration-.001:
    exclusions[row['row']]={'neutral_clip':f'c{i:03d}','requested_seconds':duration,'decoded_seconds':info.duration,'reason':'source_audio_does_not_cover_original_interval'};save(out/'coverage_exclusions.json',exclusions);continue
   tmp.chmod(0o600);tmp.replace(neutral)
  offsets=np.arange(0,max(0,duration-20),20).tolist();offsets.append(max(0,duration-20));offsets=sorted(set(round(x,3) for x in offsets))
  records.append({'row':row['row'],'cache':neutral.name,'offsets':offsets,'absolute_start':a,'duration':duration,'windows':len(offsets)})
  save(out/'staging_manifest.json',{'version':2,'alignment':'aresample_async_first_pts_0','model':PIN,'rows':records})
  print(json.dumps({'phase':'staging','clips_complete':i+1,'clips_total':len(fine),'windows':sum(r['windows'] for r in records)}),flush=True)
 return records

def infer(records,out,deadline):
 sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'colab_audio_pilot'));import pipeline as p;p.await_idle(deadline,settle=0)
 import torch
 from sentence_transformers import SentenceTransformer
 torch.set_num_threads(2);model=None;count=0;start=time.monotonic()
 for record in records:
  checkpoint=out/'embeddings'/f"{record['row']}.npz"
  if checkpoint.exists():
   with np.load(checkpoint) as z:
    if z['v'].shape==(record['windows'],768) and np.isfinite(z['v']).all() and str(z['revision'])==PIN[1] and np.array_equal(z['offsets'],record['offsets']) and 'absolute_start' in z.files and float(z['absolute_start'])==record['absolute_start'] and float(z['duration'])==record['duration'] and str(z['alignment'])=='aresample_async_first_pts_0':count+=record['windows'];continue
  check(deadline)
  if model is None:model=SentenceTransformer(PIN[0],revision=PIN[1],device='cuda',config_kwargs={'vision_config':None},model_kwargs={'torch_dtype':torch.bfloat16},local_files_only=True)
  waveform,rate=sf.read(out/'audio'/record['cache'],dtype='float32');assert rate==RATE and waveform.ndim==1
  vectors=[]
  for index in range(0,len(record['offsets']),4):
   check(deadline);waves=[]
   for offset in record['offsets'][index:index+4]:
    first=int(round(offset*RATE));wave=waveform[first:first+SAMPLES]
    if len(wave)<SAMPLES:raise RuntimeError('Requested window lacks decoded timeline coverage.')
    waves.append(wave)
   values=model.encode([{'audio':wave} for wave in waves],batch_size=4,normalize_embeddings=True,show_progress_bar=False)
   values=np.asarray(values,np.float32);assert values.shape==(len(waves),768) and np.isfinite(values).all() and np.allclose(np.linalg.norm(values,axis=1),1,atol=.01)
   vectors.extend(values)
  checkpoint.parent.mkdir(exist_ok=True);checkpoint.parent.chmod(0o700);tmp=checkpoint.with_suffix('.partial')
  with tmp.open('wb') as f:np.savez_compressed(f,v=np.asarray(vectors,np.float32),offsets=np.asarray(record['offsets']),revision=PIN[1],cache=record['cache'],absolute_start=record['absolute_start'],duration=record['duration'],alignment='aresample_async_first_pts_0')
  tmp.chmod(0o600);tmp.replace(checkpoint);count+=record['windows']
  print(json.dumps({'phase':'embedding','windows_complete':count,'clips_complete':record['row'],'peak_gpu_gib':round(torch.cuda.max_memory_allocated()/1024**3,3)}),flush=True)
 if model is not None:del model;torch.cuda.empty_cache()
 save(out/'inference_summary.json',{'windows':count,'seconds':time.monotonic()-start,'model':PIN,'cloud_credits':0,'uploads':0})

def numeric_rows(fine,records,out,cohort_folder,score_lookup):
 result=[];lookup={r['row']:r for r in fine}
 for record in records:
  row=lookup[record['row']];a,b=row['detected_start'],row['detected_end'];offsets=np.array(record['offsets']);times=a+offsets+10
  with np.load(out/'embeddings'/f"{row['row']}.npz") as z:audio=z['v']
  vectors=np.zeros((len(times),1152),np.float32);framepath=cohort_folder/'frames'/f"{row['video_id']}.npz"
  if framepath.exists():
   with np.load(framepath) as z:t,v=z['t'],z['v'].astype(np.float32)
   for i,offset in enumerate(offsets):
    span=v[(t>=a+offset)&(t<a+offset+20)]
    if len(span):mean=span.mean(0);vectors[i]=mean/max(np.linalg.norm(mean),1e-9)
  numeric=np.stack([(times-a)/(b-a),np.full(len(times),math.log(max(1,b-a))),np.full(len(times),score_lookup[row['row']]),np.zeros(len(times))],1)
  overlap=np.maximum(0,np.minimum(a+offsets+20,row['selected_end'])-np.maximum(a+offsets,row['selected_start']))/20
  sample=np.flatnonzero((overlap>=.8)|(overlap<=.2));y=(overlap>=.8).astype(int)
  result.append(dict(row,times=times,X=np.concatenate([vectors,audio,numeric],1).astype(np.float32),y=y,sample=sample))
 return result

def variant_rows(rows,kind):
 output=[]
 for r in rows:
  raw=r['X'];values={'position':raw[:,-4:],'visual':np.concatenate([raw[:,:1152],raw[:,-4:]],1),'audio':raw[:,1152:],'combined':raw}[kind]
  output.append(dict(r,X=values))
 return output

def choose(rows,kind):
 rows=variant_rows(rows,kind);options=[]
 for C in (.1,1.,10.):
  held=[None]*len(rows)
  for train,test in splits(rows,3):
   tr=[rows[i] for i in train];te=[rows[i] for i in test];m=fc.fit(tr,C)
   for i,p in zip(test,fc.probabilities(m,te)):held[i]=p
  policies=[('global',q) for q in (0.,.3,.4,.5,.6,.7)]+[('relative_quantile',q) for q in (.05,.1,.2,.3)]+[('contrast_mass',q) for q in (.001,.01,.03,.05)]+[('max_sum_relative',q) for q in (.1,.2,.3,.5)]
  for mode,level in policies:options.append((fc.objective(fc.metrics(rows,fc.intervals(rows,held,level,mode))),-level,-C,mode))
 best=max(options);return -best[2],-best[1],best[3],best[0]

def evaluate(rows,out,deadline):
 comparisons={};allprobs={};selected=[];kinds=['position','visual','audio','combined']
 for kind in kinds:
  predictions=[None]*len(rows);probs=[None]*len(rows);folds=[]
  for fold,(train,test) in enumerate(splits(rows)):
   check(deadline);tr=[rows[i] for i in train];te=[rows[i] for i in test];C,level,mode,inner_score=choose(tr,kind)
   model=fc.fit(variant_rows(tr,kind),C);p=fc.probabilities(model,variant_rows(te,kind))
   for i,value,pvalue in zip(test,fc.intervals(te,p,level,mode),p):predictions[i]=value;probs[i]=pvalue
   folds.append({'C':C,'level':level,'mode':mode,'inner_score':inner_score,'train':len(train),'test':len(test)})
  auc=[]
  from sklearn.metrics import roc_auc_score
  for r,p in zip(rows,probs):
   indices=r['sample']
   if len(set(r['y'][indices]))==2:auc.append(float(roc_auc_score(r['y'][indices],p[indices])))
  comparisons[kind]={'candidate':fc.metrics(rows,predictions),'frame_macro_auroc':float(np.mean(auc)) if auc else None,'folds':folds};allprobs[kind]=probs
  save(out/f'{kind}_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predicted':p,'times':r['times'].tolist(),'probabilities':v.tolist()} for r,p,v in zip(rows,predictions,probs)]})
  print(json.dumps({'phase':'evaluation','variant':kind,'metric':comparisons[kind]['candidate']}),flush=True)
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);nested=[None]*len(rows);foldselections=[]
 for fold,(_,test) in enumerate(splits(rows)):
  kind=max(kinds,key=lambda k:(comparisons[k]['folds'][fold]['inner_score'],-kinds.index(k)));setting=comparisons[kind]['folds'][fold]
  te=[rows[i] for i in test];p=[allprobs[kind][i] for i in test]
  for i,value in zip(test,fc.intervals(te,p,setting['level'],setting['mode'])):nested[i]=value
  foldselections.append(kind)
 candidate=fc.metrics(rows,nested);enabled=candidate['channel_macro_iou']>identity['channel_macro_iou']+.02 and candidate['channel_macro_retained']>=.97 and candidate['retention_p10']>=.9 and candidate['meaningfully_shortened']>=3
 selections={kind:choose(rows,kind) for kind in kinds};kind=max(kinds,key=lambda k:(selections[k][3],-kinds.index(k)));C,level,mode,_=selections[kind];scale,m=fc.fit(variant_rows(rows,kind),C)
 artifact={'schema_version':1,'kind':'dense_boundary_envelope','enabled':enabled,'variant':kind,'model':PIN,'window_seconds':20,'hop_seconds':20,
           'numeric_features':['position_fraction','log_original_seconds','detector_score','reserved_zero'],'numeric_mean':scale.mean_.tolist(),'numeric_scale':scale.scale_.tolist(),
           'weights':m.coef_[0].tolist(),'bias':float(m.intercept_[0]),'C':C,'level':level,'extraction_mode':mode,'smoothing_radius':1,
           'start_pad_seconds':10,'end_pad_seconds':15,'max_seconds':None,'constraints':{'min_seconds':5},'fallback':'original_range','automatic_action':False}
 report={'fine_clips':len(rows),'channels':len({r['group'] for r in rows}),'windows':sum(len(r['times']) for r in rows),
         'inside_windows':sum(int(sum(r['y'][r['sample']])) for r in rows),'outside_windows':sum(int(len(r['sample'])-sum(r['y'][r['sample']])) for r in rows),
         'target':'Fine explicit chosen intervals; no frame labels inferred from coarse triage','identity':identity,'comparisons':comparisons,
         'nested_selected_candidate':candidate,'nested_fold_variants':foldselections,'enabled':enabled,'final_variant':kind,
         'validation':'Whole-channel outer5 folds; variant, C and extraction policy selected only in inner3 training-channel folds; numeric scaling training-only',
         'limitations':['Only28 fine clip choices; earlier confirmation UX may influence these targets.','20-second audio windows give finite temporal resolution.'],
         'no_uploads':True,'cloud_credits':0}
 save(out/'dense_boundary_envelope.json',artifact);save(out/'dense_boundary_report.json',report);print(json.dumps(report,indent=2))

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--cohort',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--seconds',type=int,default=900);parser.add_argument('--wall-cutoff',type=float,default=None);a=parser.parse_args();deadline=time.monotonic()+min(a.seconds,max(0,a.wall_cutoff-time.time()) if a.wall_cutoff else a.seconds)
 cohort=json.loads(a.cohort.read_text());fine=fine_boundaries(cohort,a.cohort.parent);manifest=json.loads((a.cohort.parent.parent/'preference-audio-20261010'/'private_manifest.json').read_text())
 mappings={f"fine{r['task_id']}{r['row'][-1]}":r for r in manifest['rows']};score={r['row']:mappings[r['row']]['base'][1] for r in fine}
 records=stage(fine,manifest['rows'],a.output,deadline);assert sum(r['windows'] for r in records)<=1600
 infer(records,a.output,deadline);rows=numeric_rows(fine,records,a.output,a.cohort.parent,score);evaluate(rows,a.output,deadline)

if __name__=='__main__':
 try:main()
 except Exception as error:
  import traceback
  print(json.dumps({'status':'failed','type':type(error).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno} for f in traceback.extract_tb(error.__traceback__)]}),flush=True);raise SystemExit(1)
