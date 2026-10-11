"""Full available-cohort Gemma audio ablation, local bounded reads and atomic numeric checkpoints."""
from __future__ import annotations
import argparse,contextlib,gc,hashlib,json,math,os,subprocess,sys,time,warnings
from collections import defaultdict
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','2');os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('MKL_NUM_THREADS','2')
LAB=Path(__file__).resolve().parents[1];sys.path.insert(0,str(LAB));sys.path.insert(0,str(LAB/'colab_audio_pilot'))
import numpy as np
import pipeline as p
import models_v2 as mv
ROOT=LAB/'data'/'model-completion-20261010';OUT=ROOT/'audio';PIN=mv.MODEL_PINS['eg'];RATE=16000;SECONDS=20

def save(name,value):
 OUT.mkdir(parents=True,exist_ok=True);OUT.chmod(0o700);p.save_json(OUT/name,value)

def offsets(row):
 a,b=row['detected_start'],row['detected_end'];return [round(max(a,min(a+(b-a)*f-SECONDS/2,b-SECONDS)),3) for f in (1/3,2/3)]

def reusable(row,old):
 sys.path.insert(0,str(Path(__file__).parent))
 from archived_audio import embedding
 archived=embedding(row)
 if archived is not None:return archived
 for item in old:
  if item['feedback_id']!=row['feedback_id'] or abs(item['start']-row['detected_start'])>.001 or abs(item['end']-row['detected_end'])>.001 or item['generation']!=row['analyzed_at']:continue
  path=LAB/'data'/'colab-audio-pilot-20261009'/'embeddings'/f"{item['row']}.npz"
  if not path.exists():continue
  try:
   with np.load(path,allow_pickle=False) as z:
    if str(z['revision'])!=PIN[1] or abs(float(z['duration'])-SECONDS)>.001 or z['v'].ndim!=2 or z['v'].shape[1]!=768 or not np.isfinite(z['v']).all():continue
    exp=np.array(sorted(set(offsets(row))));actual=z['offsets']
    if exp.shape!=actual.shape or not np.allclose(exp,actual,atol=.001):continue
    if 'decoded_samples' in z:
     counts=z['decoded_samples']
     if len(counts)!=len(z['v']) or min(counts)<int((SECONDS-.25)*RATE) or max(counts)>(SECONDS+1)*RATE:continue
    else:
     audit=json.loads((LAB/'data'/'colab-audio-pilot-20261009'/'checkpoint_audit.json').read_text())
     if item['row'] not in audit['accepted'] or hashlib.sha256(path.read_bytes()).hexdigest()!=audit['checkpoint_sha256'].get(item['row']):continue
    norms=np.linalg.norm(z['v'],axis=1)
    if not np.all((norms>.99)&(norms<1.01)):continue
    v=z['v'].mean(0);v/=np.linalg.norm(v);return v
  except (KeyError,OSError,ValueError):continue
 return None

def rowpath(row):return OUT/'embeddings'/f"{row['row']}.npz"

def checkpoint(row,v,source_kind):
 v=np.asarray(v,np.float32);assert v.shape==(768,) and np.isfinite(v).all() and .99<float(np.linalg.norm(v))<1.01
 target=rowpath(row);target.parent.mkdir(exist_ok=True);target.parent.chmod(0o700);tmp=target.with_suffix('.partial.npz')
 np.savez_compressed(tmp,embedding=v,revision=PIN[1],feedback_id=row['feedback_id'],start=row['detected_start'],end=row['detected_end'],source_kind=source_kind);tmp.chmod(0o600);tmp.replace(target)

def validate_checkpoint(row):
 path=rowpath(row)
 if not path.exists():return None
 with np.load(path,allow_pickle=False) as z:
  if str(z['revision'])!=PIN[1] or int(z['feedback_id'])!=row['feedback_id'] or abs(float(z['start'])-row['detected_start'])>.001 or abs(float(z['end'])-row['detected_end'])>.001:raise ValueError('checkpoint identity mismatch')
  v=z['embedding'];assert v.shape==(768,) and np.isfinite(v).all() and .99<float(np.linalg.norm(v))<1.01;return v.copy()

def snapshot():
 OUT.mkdir(parents=True,exist_ok=True);OUT.chmod(0o700)
 path=OUT/'private_manifest.json'
 if path.exists():
  manifest=json.loads(path.read_text())
  # Deleted source/catalog rows can still supply exact frozen numeric training inputs.
  sys.path.insert(0,str(Path(__file__).parent))
  from archived_audio import embedding
  for row in manifest['rows']:
   if validate_checkpoint(row) is None:
    archived=embedding(row)
    if archived is not None:checkpoint(row,archived,'validated_frozen_audio_snapshot')
  return manifest
 import psycopg
 from label_server import PG
 payload=json.loads((ROOT/'cohort.json').read_text());rows=[r for r in payload['rows'] if r['has_original_edges'] and r['detected_end']-r['detected_start']>=SECONDS]
 with psycopg.connect(PG) as conn:
  conn.execute('SET TRANSACTION READ ONLY');sources={v:p for v,p in conn.execute('select id,file_path from videos where id=any(%s)',(sorted({r['video_id'] for r in rows}),)).fetchall()}
 old=json.loads((LAB/'data'/'colab-audio-pilot-20261009'/'private_manifest.json').read_text())['rows'];reused=0
 for row in rows:
  existing=validate_checkpoint(row)
  if existing is None:
   v=reusable(row,old)
   if v is not None:checkpoint(row,v,'validated_original_range_checkpoint');reused+=1
  row['source']=sources.get(row['video_id']);row['has_ssd_cache']=(LAB/'data'/'audio_src'/f"{row['video_id']}.opus").is_file();row['has_original']=bool(row['source'] and Path(row['source']).is_file())
 manifest={'cohort_sha256':hashlib.sha256((ROOT/'cohort.json').read_bytes()).hexdigest(),'rows':rows,'reused':reused,'model':PIN[0],'revision':PIN[1],'window_seconds':SECONDS,'sample_rate':RATE,'sampling':'centres1/3and2/3originaldetectedrange','aggregation':'unitnormalizedmeanofunit768vectors'};save('private_manifest.json',manifest)
 save('availability.json',{'original_edges_rows':len(rows),'validated_reused_rows':reused,'available_original_rows':sum(r['has_original'] for r in rows),'ssd_cache_rows':sum(r['has_ssd_cache'] for r in rows),'pending_available_rows':sum(validate_checkpoint(r) is None and (r['has_original'] or r['has_ssd_cache']) for r in rows),'media_workers':len(p.busy_media_workers()),'model':PIN[0],'revision':PIN[1],'raw_uploaded':False})
 return manifest

def gpu_idle():
 vals=[]
 for f in Path('/sys/class/drm').glob('card[0-9]*/device/gpu_busy_percent'):
  try:vals.append(int(f.read_text().strip()))
  except (OSError,ValueError):pass
 return not vals or max(vals)<=10

def choose_source(row):
 cache=LAB/'data'/'audio_src'/f"{row['video_id']}.opus"
 candidates=([cache] if cache.is_file() else [])+([Path(row['source'])] if row['has_original'] else [])
 for source in candidates:
  probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type,duration','-of','json',str(source)],capture_output=True,text=True,timeout=15)
  if probe.returncode:continue
  try:
   m=json.loads(probe.stdout);audio=[s for s in m['streams'] if s['codec_type']=='audio'];duration=float(audio[0].get('duration') or m['format']['duration']) if audio else 0
   if duration>=row['detected_end']-.25:return source,source==cache
  except (ValueError,KeyError,TypeError):continue
 raise ValueError('source audio does not cover detected range')

def decode(source,start):
 cmd=['ionice','-c','3','ffmpeg','-nostdin','-v','error','-threads','1','-filter_threads','1','-filter_complex_threads','1','-ss',str(start),'-vn','-i',str(source),'-map','0:a:0','-threads','1','-af','aresample=16000:async=1:first_pts=0','-t',str(SECONDS),'-ac','1','-ar',str(RATE),'-f','s16le','-']
 result=subprocess.run(cmd,capture_output=True,timeout=45,preexec_fn=p.restricted_child)
 if result.returncode or len(result.stdout)!=SECONDS*RATE*2:raise ValueError('bounded decode did not return exact expected samples')
 return np.frombuffer(result.stdout,dtype='<i2').astype(np.float32)/32768

def run(minutes):
 began=time.monotonic();deadline=began+minutes*60;manifest=snapshot();rows=manifest['rows'];pending=[r for r in rows if validate_checkpoint(r) is None and (r['has_original'] or r['has_ssd_cache'])]
 print(json.dumps(json.loads((OUT/'availability.json').read_text())),flush=True)
 if not pending:return
 p.await_idle(deadline,settle=0)
 quiet=time.monotonic()
 while not gpu_idle():
  if time.monotonic()>deadline:raise TimeoutError('GPU idle budget expired')
  print(json.dumps({'status':'waiting_for_gpu'}),flush=True);time.sleep(5)
 os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';os.environ['HF_HUB_DISABLE_PROGRESS_BARS']='1'
 import torch
 from sentence_transformers import SentenceTransformer
 torch.set_num_threads(2)
 if not torch.cuda.is_available():raise RuntimeError('Expected local AMD torch device unavailable')
 dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
 with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
  model=SentenceTransformer(PIN[0],revision=PIN[1],device='cuda',config_kwargs={'vision_config':None},model_kwargs={'torch_dtype':dtype},local_files_only=True)
 print(json.dumps({'status':'model_ready','pending':len(pending),'elapsed_seconds':round(time.monotonic()-began,1)}),flush=True)
 errors=[];completed=0;decode_seconds=0;infer_seconds=0
 try:
  with mv._watchdog(deadline),torch.inference_mode():
   for row in pending:
    mv._check(deadline);p.await_idle(deadline,settle=0)
    try:
     started=time.monotonic();source,ssd=choose_source(row);before=source.stat();waves=[]
     for offset in offsets(row):
      mv._check(deadline);p.await_idle(deadline,settle=0);waves.append(decode(source,offset))
     after=source.stat()
     if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('source changed during read')
     decode_seconds+=time.monotonic()-started;started=time.monotonic()
     vectors=model.encode([{'audio':wave} for wave in waves],batch_size=2,normalize_embeddings=True,show_progress_bar=False)
     if vectors.shape!=(2,768) or not np.isfinite(vectors).all():raise ValueError('model vector invalid')
     v=vectors.mean(0);v/=np.linalg.norm(v);checkpoint(row,v,'ssd_audio_cache' if ssd else 'original_audio_only');infer_seconds+=time.monotonic()-started;completed+=1
     print(json.dumps({'new_rows_completed':completed,'new_rows_pending':len(pending),'elapsed_seconds':round(time.monotonic()-began,1),'decode_seconds':round(decode_seconds,1),'infer_seconds':round(infer_seconds,1)}),flush=True)
    except (OSError,ValueError,subprocess.TimeoutExpired) as e:
     errors.append({'row':row['row'],'error':type(e).__name__});save('errors.json',errors)
 finally:
  del model;gc.collect();torch.cuda.empty_cache();save('run_summary.json',{'new_completed':completed,'pending_initial':len(pending),'reused':manifest['reused'],'excluded_attempts':len(errors),'elapsed_seconds':round(time.monotonic()-began,2),'decode_seconds':decode_seconds,'infer_seconds':infer_seconds,'gpu_peak_gib':torch.cuda.max_memory_allocated()/1024**3,'raw_uploaded':False,'cloud_compute_units':0})

def evaluate():
 from sklearn.decomposition import PCA
 from sklearn.preprocessing import StandardScaler
 from sklearn.linear_model import LogisticRegression
 from sklearn.model_selection import GroupKFold
 from sklearn.exceptions import ConvergenceWarning
 sys.path.insert(0,str(Path(__file__).parent));import rank
 manifest=snapshot();assert manifest['cohort_sha256']==hashlib.sha256((ROOT/'cohort.json').read_bytes()).hexdigest()
 rows=[];emb=[]
 for row in manifest['rows']:
  v=validate_checkpoint(row)
  if v is not None:rows.append(row);emb.append(v)
 X=np.array([r['features'] for r in rows]);E=np.asarray(emb,dtype=np.float64);assert X.shape==(len(rows),13) and E.shape==(len(rows),768)
 # Strong regularization and low-dimensional audio prevent 768 dimensions swamping small labels.
 specs=[('length','point',1,0),('base_point','point',2,0),('base_pair','pair',2,0),('context_point','point',13,0),('context_pair','pair',13,0),('context_list','list',13,0),('audio_point','point',13,16),('audio_pair','pair',13,16),('audio_pair32','pair',13,32)]
 numeric_specs=[s for s in specs if not s[3]];audio_specs=[s for s in specs if s[3]]
 Cs=(.1,1.,10.);groups=np.array([r['group'] for r in rows])
 class Fit:
  def __init__(self,spec,C):self.spec=spec;self.C=C
  def fit(self,rr,x,e):
   _,kind,numeric,components=self.spec;self.scaler=StandardScaler().fit(x[:,:numeric]);z=self.scaler.transform(x[:,:numeric]);self.pca=None;self.latent=None
   if components:
    self.pca=PCA(n_components=min(components,len(rr)-1),svd_solver='full').fit(e);latent=self.pca.transform(e);self.latent=StandardScaler().fit(latent);z=np.c_[z,self.latent.transform(latent)]
   if kind=='point':
    vids=np.array([r['video_id'] for r in rr]);counts={v:sum(vids==v) for v in set(vids)};weight=np.array([1/counts[v] for v in vids])*len(rr)/len(counts)
    self.model=LogisticRegression(C=self.C,solver='liblinear',max_iter=5000,tol=1e-6).fit(z,[r['y'] for r in rr],sample_weight=weight)
   elif kind=='list':
    from lightgbm import LGBMRanker
    vids=np.array([r['video_id'] for r in rr]);order=np.argsort(vids,kind='stable');q=[sum(vids==v) for v in sorted(set(vids))]
    self.model=LGBMRanker(objective='rank_xendcg',n_estimators=60,num_leaves=7,max_depth=3,min_child_samples=15,reg_lambda=10.,reg_alpha=1.,learning_rate=.05,random_state=420,num_threads=2,verbosity=-1).fit(z[order],np.array([r['y'] for r in rr])[order],group=q)
   else:
    pp=rank.pairs(rr);d=np.array([z[k]-z[s] for k,s,w in pp]);w=np.array([w for k,s,w in pp]);w*=len(w)/w.sum();self.model=LogisticRegression(C=self.C,fit_intercept=False,solver='liblinear',max_iter=5000,tol=1e-6).fit(np.r_[d,-d],np.r_[np.ones(len(d)),np.zeros(len(d))],sample_weight=np.r_[w,w])
   return self
  def predict(self,x,e):
   z=self.scaler.transform(x[:,:self.spec[2]])
   if self.pca is not None:z=np.c_[z,self.latent.transform(self.pca.transform(e))]
   return self.model.predict(z) if self.spec[1]=='list' else self.model.decision_function(z)
  def export(self):
   numeric=self.spec[2];coef=self.model.coef_[0];w=np.zeros(13);w[:numeric]=coef[:numeric]/self.scaler.scale_;bias=float(self.model.intercept_[0])-float(w[:numeric]@self.scaler.mean_);audio=np.zeros(768)
   if self.pca is not None:
    latent_weights=coef[numeric:]/self.latent.scale_;audio=latent_weights@self.pca.components_;bias-=float(latent_weights@self.latent.mean_)+float(audio@self.pca.mean_)
   return {'spec':self.spec[0],'kind':self.spec[1],'features':json.loads((ROOT/'cohort.json').read_text())['features'],'weights':w.tolist(),'audio_weights':audio.tolist(),'bias':bias,'model':PIN[0],'revision':PIN[1],'model_revision':PIN[0]+'@'+PIN[1],'window_policy':'two uniform20s windows centered at1/3 and2/3 of original detected range; mean then unit normalization','audio_input':'unit768 mean vector','C':self.C}
 def folds(rr,n):
  g=np.array([r['group'] for r in rr]);return list(GroupKFold(n_splits=min(n,len(set(g)))).split(np.zeros(len(rr)),[r['y'] for r in rr],g))
 def choose(rr,x,e,choices):
  trials=[]
  for spec in choices:
   for C in ((1.,) if spec[1]=='list' else Cs):
    out=np.full(len(rr),np.nan)
    for tr,te in folds(rr,3):out[te]=Fit(spec,C).fit([rr[i] for i in tr],x[tr],e[tr]).predict(x[te],e[te])
    m=rank.metrics(rr,out);trials.append((m['recording_macro_pair_accuracy'],m['top1'],-spec[3],spec,C))
  best=max(trials,key=lambda t:t[:3]);return best[3],best[4]
 save('evaluation_spec.json',{'target':'coarse triage keep/skip only; versus preference not pooled','cohort':'identical validated audio-available original-range rows across all comparators','outer_folds':5,'inner_folds':3,'PCA':'fit inside each training fold only;16/32components','C':list(Cs),'specs':specs,'gate':'nested audio >=nested numerical macro+0.02; top1 and recall@2 no worse; channel-bootstrap lower95 bound >-0.02','cohort_sha256':manifest['cohort_sha256']})
 scores={s[0]:np.full(len(rows),np.nan) for s in specs};nested_numeric=np.full(len(rows),np.nan);nested_audio=np.full(len(rows),np.nan);decisions=[];began=time.monotonic()
 with warnings.catch_warnings():
  warnings.simplefilter('error',ConvergenceWarning)
  for f,(tr,te) in enumerate(folds(rows,5)):
   rr=[rows[i] for i in tr];assert set(groups[tr]).isdisjoint(set(groups[te]));ns,nc=choose(rr,X[tr],E[tr],numeric_specs);aus,ac=choose(rr,X[tr],E[tr],audio_specs);nested_numeric[te]=Fit(ns,nc).fit(rr,X[tr],E[tr]).predict(X[te],E[te]);nested_audio[te]=Fit(aus,ac).fit(rr,X[tr],E[tr]).predict(X[te],E[te])
   for s in specs:scores[s[0]][te]=Fit(s,1.).fit(rr,X[tr],E[tr]).predict(X[te],E[te])
   decisions.append({'fold':f,'numeric_selected':ns[0],'numeric_C':nc,'audio_selected':aus[0],'audio_C':ac});print(json.dumps({'audio_outer_fold_done':f+1,'elapsed_seconds':round(time.monotonic()-began,1)}),flush=True)
  from scipy.special import expit
  from sklearn.metrics import roc_auc_score,brier_score_loss
  y=np.array([r['y'] for r in rows]);acceptance={name:{'auroc':float(roc_auc_score(y,scores[name])),'brier':float(brier_score_loss(y,expit(scores[name]))),'mean_predicted_keep':float(expit(scores[name]).mean())} for name in ('base_point','context_point','audio_point')}
  acceptance_gate=bool(acceptance['audio_point']['auroc']>=acceptance['context_point']['auroc']+.02 and acceptance['audio_point']['brier']<=acceptance['context_point']['brier'])
  acceptance_fit=Fit(next(s for s in specs if s[0]=='audio_point'),1.).fit(rows,X,E);acceptance_artifact=acceptance_fit.export();acceptance_artifact['gate_passed']=acceptance_gate;acceptance_artifact['target']='coarse triage acceptance; sigmoid(logit), not storage preference';save('audio_acceptance_fixed_c1.json',acceptance_artifact)
  from datetime import datetime
  latest_review={v:max(datetime.fromisoformat(r['updated_at']).timestamp() for r in rows if r['video_id']==v) for v in {r['video_id'] for r in rows}}
  chronology=sorted((latest_review[v],v) for v in latest_review);n=max(1,int(.75*len(chronology)));training_vids={v for _,v in chronology[:n]};ct=np.array([i for i,r in enumerate(rows) if r['video_id'] in training_vids]);ce=np.array([i for i,r in enumerate(rows) if r['video_id'] not in training_vids]);cr=[rows[i] for i in ct];later=[rows[i] for i in ce];chronology_report={'status':'insufficient'}
  if len(set(y[ct]))==2 and len(rank.pairs(later)) and len({r['group'] for r in cr})>=3:
   ns,nc=choose(cr,X[ct],E[ct],numeric_specs);aus,ac=choose(cr,X[ct],E[ct],audio_specs);nm=rank.metrics(later,Fit(ns,nc).fit(cr,X[ct],E[ct]).predict(X[ce],E[ce]));am=rank.metrics(later,Fit(aus,ac).fit(cr,X[ct],E[ct]).predict(X[ce],E[ce]));chronology_report={'status':'ok','validation':'earliest75%recordings bylastreview(updated_at) train,latest25%test; recipe selection only onearliertraining channels','numeric':nm,'audio':am,'numeric_selected':ns[0],'audio_selected':aus[0]}
  from sklearn.metrics import brier_score_loss,roc_auc_score
  def cls(scored,yy):
   pp=expit(scored);bins=[]
   for low,high in zip(np.arange(0,1,.2),np.arange(.2,1.01,.2)):
    mask=(pp>=low)&(pp<high if high<1 else pp<=high)
    if mask.any():bins.append({'lower':float(low),'upper':float(high),'n':int(mask.sum()),'mean_probability':float(pp[mask].mean()),'observed_keep':float(yy[mask].mean())})
   return {'auroc':float(roc_auc_score(yy,scored)),'brier':float(brier_score_loss(yy,pp)),'keep_prevalence':float(yy.mean()),'mean_predicted_keep':float(pp.mean()),'ECE5':float(sum(b['n']*abs(b['mean_probability']-b['observed_keep']) for b in bins)/len(yy)),'calibration':bins}
  acceptance={name:cls(scores[name],y) for name in ('base_point','context_point','audio_point')}
  rng=np.random.default_rng(420);units=sorted(set(groups));boot=[]
  for _ in range(1000):
   picked=np.concatenate([np.flatnonzero(groups==g) for g in rng.choice(units,len(units),replace=True)])
   if len(set(y[picked]))<2:continue
   ap=cls(scores['audio_point'][picked],y[picked]);bp=cls(scores['context_point'][picked],y[picked]);boot.append([ap['auroc']-bp['auroc'],ap['brier']-bp['brier']])
  acceptance_uncertainty={'unit':'wholechannelclusterbootstrap; conditionsonobservedclassratioineachsample','auroc_delta':acceptance['audio_point']['auroc']-acceptance['context_point']['auroc'],'auroc_delta_95':np.quantile(np.array(boot)[:,0],[.025,.975]).tolist(),'brier_delta':acceptance['audio_point']['brier']-acceptance['context_point']['brier'],'brier_delta_95':np.quantile(np.array(boot)[:,1],[.025,.975]).tolist()}
  def choose_class(rr,x,e,spec):
   yy=np.array([r['y'] for r in rr]);trials=[]
   for C in Cs:
    out=np.full(len(rr),np.nan)
    for tr,te in folds(rr,3):out[te]=Fit(spec,C).fit([rr[i] for i in tr],x[tr],e[tr]).predict(x[te],e[te])
    mm=cls(out,yy);trials.append((mm['auroc'],-mm['brier'],C))
   return max(trials) [2]
  audio_spec=next(s for s in specs if s[0]=='audio_point');context_spec=next(s for s in specs if s[0]=='context_point');ncscore=np.full(len(rows),np.nan);nnumscore=np.full(len(rows),np.nan);nchoices=[]
  classification_numeric_specs=[s for s in numeric_specs if s[1]=='point']
  def choose_classifier(rr,x,e,choices):
   yy=np.array([r['y'] for r in rr]);trials=[]
   for spec in choices:
    C=choose_class(rr,x,e,spec);out=np.full(len(rr),np.nan)
    for tr,te in folds(rr,3):out[te]=Fit(spec,C).fit([rr[i] for i in tr],x[tr],e[tr]).predict(x[te],e[te])
    mm=cls(out,yy);trials.append((mm['auroc'],-mm['brier'],-spec[2],spec,C))
   best=max(trials,key=lambda a:a[:3]);return best[3],best[4]
  for f,(tr,te) in enumerate(folds(rows,5)):
   rr=[rows[i] for i in tr];C=choose_class(rr,X[tr],E[tr],audio_spec);ns,nc=choose_classifier(rr,X[tr],E[tr],classification_numeric_specs);ncscore[te]=Fit(audio_spec,C).fit(rr,X[tr],E[tr]).predict(X[te],E[te]);nnumscore[te]=Fit(ns,nc).fit(rr,X[tr],E[tr]).predict(X[te],E[te]);nchoices.append({'fold':f,'C':C,'numeric_spec':ns[0],'numeric_C':nc})
  acceptance_nested={'metrics':cls(ncscore,y),'numeric_metrics':cls(nnumscore,y),'fold_C':nchoices,'purpose':'NestedclassificationobjectiveAUROCthenBrier; fixedC1separatelyreported'}
  rng=np.random.default_rng(420);boot=[]
  for _ in range(1000):
   picked=np.concatenate([np.flatnonzero(groups==g) for g in rng.choice(units,len(units),replace=True)])
   if len(set(y[picked]))<2:continue
   ap=cls(ncscore[picked],y[picked]);bp=cls(nnumscore[picked],y[picked]);boot.append([ap['auroc']-bp['auroc'],ap['brier']-bp['brier']])
  nested_acceptance_uncertainty={'unit':'wholechannelclusterbootstrap','auroc_delta':acceptance_nested['metrics']['auroc']-acceptance_nested['numeric_metrics']['auroc'],'auroc_delta_95':np.quantile(np.array(boot)[:,0],[.025,.975]).tolist(),'brier_delta':acceptance_nested['metrics']['brier']-acceptance_nested['numeric_metrics']['brier'],'brier_delta_95':np.quantile(np.array(boot)[:,1],[.025,.975]).tolist()}
  nested_chronology={}
  if len(set(y[ce]))==2:
   C=choose_class(cr,X[ct],E[ct],audio_spec);ns,nc=choose_classifier(cr,X[ct],E[ct],classification_numeric_specs);nested_chronology={'audio_C':C,'numeric_spec':ns[0],'numeric_C':nc,'audio':cls(Fit(audio_spec,C).fit(cr,X[ct],E[ct]).predict(X[ce],E[ce]),y[ce]),'numeric':cls(Fit(ns,nc).fit(cr,X[ct],E[ct]).predict(X[ce],E[ce]),y[ce])}
  nested_acceptance_gate=bool(nested_acceptance_uncertainty['auroc_delta']>=.02 and nested_acceptance_uncertainty['brier_delta']<=0 and nested_acceptance_uncertainty['auroc_delta_95'][0]>-.02 and (not nested_chronology or (nested_chronology['audio']['auroc']>=nested_chronology['numeric']['auroc'] and nested_chronology['audio']['brier']<=nested_chronology['numeric']['brier'])))
  chosen_C=choose_class(rows,X,E,audio_spec);accepted=Fit(audio_spec,chosen_C).fit(rows,X,E);accepted_artifact=accepted.export();accepted_artifact['gate_passed']=nested_acceptance_gate;accepted_artifact['target']='coarse triage acceptance, not final storage worth';accepted_artifact['validated_spec']={'PCA':16,'C':chosen_C,'selection':'nestedwholechannelclassificationAUROCthenBrier','chronology':'lastreviewupdated_at'};assert np.allclose(X@np.array(accepted_artifact['weights'])+E@np.array(accepted_artifact['audio_weights'])+accepted_artifact['bias'],accepted.predict(X,E),atol=1e-8);save('audio_acceptance.json',accepted_artifact)
  chronology_acceptance={}
  if len(set(y[ce]))==2:
   chronology_acceptance={name:cls(Fit(next(s for s in specs if s[0]==name),1.).fit(cr,X[ct],E[ct]).predict(X[ce],E[ce]),y[ce]) for name in ('base_point','context_point','audio_point')}
  acceptance_gate=bool(acceptance['audio_point']['auroc']>=acceptance['context_point']['auroc']+.02 and acceptance['audio_point']['brier']<=acceptance['context_point']['brier'] and acceptance_uncertainty['auroc_delta_95'][0]>-.02 and (not chronology_acceptance or (chronology_acceptance['audio_point']['auroc']>=chronology_acceptance['context_point']['auroc'] and chronology_acceptance['audio_point']['brier']<=chronology_acceptance['context_point']['brier'])))
  acceptance_artifact['gate_passed']=acceptance_gate;acceptance_artifact['validated_spec']={'PCA':16,'C':1.,'outer':'5wholechannelfolds','chronology':'lastreviewupdated_at'};save('audio_acceptance_fixed_c1.json',acceptance_artifact)
  save('oof_scores.json',{'rows':[{'row':r['row'],'group':r['group'],'video_id':r['video_id'],'y':r['y'],'base_point':float(scores['base_point'][i]),'context_point':float(scores['context_point'][i]),'audio_point':float(scores['audio_point'][i])} for i,r in enumerate(rows)]})
  reports={name:rank.metrics(rows,v) for name,v in scores.items()};reports['nested_numeric']=rank.metrics(rows,nested_numeric);reports['nested_audio']=rank.metrics(rows,nested_audio);shipped=np.array([-6.654+.8134*r['features'][0]+1.7894*r['score'] for r in rows]);reports['shipped']=rank.metrics(rows,shipped);diff=rank.cluster_difference(reports['nested_audio'],reports['nested_numeric']);a,b=reports['nested_audio'],reports['nested_numeric'];gate=bool(a['recording_macro_pair_accuracy']>=b['recording_macro_pair_accuracy']+.02 and a['top1']>=b['top1'] and a['keeper_recall_at_k'][1]>=b['keeper_recall_at_k'][1] and diff['channel_bootstrap_95'][0]>-.02)
  spec,C=choose(rows,X,E,audio_specs);final=Fit(spec,C).fit(rows,X,E);artifact=final.export();portable=X@np.array(artifact['weights'])+E@np.array(artifact['audio_weights'])+artifact['bias'];assert np.allclose(portable,final.predict(X,E),atol=1e-8);artifact['gate_passed']=gate;save('audio_candidate.json',artifact)
  cached=[{'row':r['row'],'feedback_id':r['feedback_id'],'video_id':r['video_id'],'start':r['detected_start'],'end':r['detected_end'],'score':float(s),'embedding':e.tolist()} for r,s,e in zip(rows,portable,E)];save('range_scores.json',{'revision':PIN[1],'rows':cached})
  report={'target':'coarse triage only','rows':len(rows),'channels':len(set(groups)),'keeps':sum(r['y'] for r in rows),'reports':reports,'difference':diff,'gate_passed':gate,'acceptance':acceptance,'acceptance_gate_passed':acceptance_gate,'acceptance_uncertainty':acceptance_uncertainty,'acceptance_nested':acceptance_nested,'nested_acceptance_uncertainty':nested_acceptance_uncertainty,'nested_acceptance_gate_passed':nested_acceptance_gate,'nested_chronology_acceptance':nested_chronology,'chosen_acceptance_C':chosen_C,'chronology_acceptance':chronology_acceptance,'chronological':chronology_report,'selected_full_fit':spec[0],'C':C,'fold_selection':decisions,'portable_prediction_max_error':float(abs(portable-final.predict(X,E)).max()),'production_changed':False,'cloud_compute_units':0,'raw_uploaded':False,'elapsed_seconds':round(time.monotonic()-began,2)};save('report.json',report);print(json.dumps({k:report[k] for k in ('rows','channels','keeps','difference','gate_passed','acceptance','acceptance_gate_passed','selected_full_fit','elapsed_seconds')},indent=2))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('action',choices=['run','evaluate']);parser.add_argument('--minutes',type=float,default=20);args=parser.parse_args()
 if args.action=='run':run(args.minutes)
 else:evaluate()
