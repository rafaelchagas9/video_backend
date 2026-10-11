"""Fixed coarse-prior audit on verified current-acceptability saved ranges. No final-label fitting or promotion.

prepare: numeric/source-stat preflight and immutable preregistration; no media/GPU.
run: one offline, SSD-only, shared-lock attempt capped at 240s, including evaluation.
"""
from __future__ import annotations
import argparse, contextlib, fcntl, hashlib, json, math, os, sys, time
from pathlib import Path
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[key]='2'
LAB=Path(__file__).resolve().parents[1];sys.path[:0]=[str(LAB/'model_completion'),str(LAB),str(LAB/'colab_audio_pilot')]
import numpy as np
import fine_labels as fl
import audio_cache_worker as aw
ROOT=LAB/'data/model-completion-20261010';FINE=LAB/'data/preference-audio-20261010'
OUT=ROOT/'final-worth-matched'/fl.POLICY
LOCK=LAB.parent/'data/models/recording-audio-jobs/.worker.lock'
RECIPE='current-acceptability-final-runtime-audio570m-uniform2x20-v2'
COMPARATORS=(('coarse_audio13_C01',13,.1,True),('coarse_numeric13_C01',13,.1,False),('coarse_numeric2_C1',2,1.,False))

def read(path):return json.loads(path.read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def atomic(path,value):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700)
 temporary=path.with_suffix('.partial');payload=json.dumps(value,allow_nan=False,indent=2)
 with temporary.open('w') as file:file.write(payload);file.flush();os.fsync(file.fileno())
 temporary.chmod(0o600);temporary.replace(path)
def frozen(path,value):
 if path.exists():
  if read(path)!=value:raise ValueError('immutable preregistration differs')
 else:atomic(path,value)
def intervals(a,b):
 value=aw.expected_windows({'start_seconds':a,'end_seconds':b})
 if value is None:raise ValueError('final span shorter than20s')
 return [pair[0] for pair in value]
def unitmean(v):
 vector=np.asarray(v,dtype=np.float64).mean(0);norm=float(np.linalg.norm(vector))
 if not math.isfinite(norm) or norm<1e-12:raise ValueError('zero mean vector')
 return vector/norm

def offered_vectors(path,offsets):
 with np.load(path,allow_pickle=False) as z:
  v=np.asarray(z['v'],dtype=np.float64);off=np.asarray(z['offsets'],dtype=np.float64)
  if str(z['revision'])!=aw.REVISION or v.shape!=(2,768) or off.shape!=(2,) or not np.allclose(off,offsets,rtol=0,atol=.0001) or not np.array_equal(z['decoded_samples'],[aw.SAMPLES,aw.SAMPLES]) or not np.isfinite(v).all() or not np.allclose(np.linalg.norm(v,axis=1),1,rtol=0,atol=.01):raise ValueError('offered checkpoint provenance/vector mismatch')
  return v.copy()
def exact_reuse(wanted,old_offsets,vectors):
 result=[]
 for offset in wanted:
  hits=[i for i,old in enumerate(old_offsets) if abs(old-offset)<.0001]
  result.append(vectors[hits[0]].copy() if hits else None)
 return result

def require_same_device(source,root):
 if source.stat().st_dev!=root.stat().st_dev:raise ValueError('staged source is outside numeric SSD filesystem')

def cache_receipt(row,root=ROOT):
 cache=Path(row['cache_path']).resolve();allowed=[(root/'joint-gemma/audio').resolve(),(root/'boundary_audio/audio').resolve()]
 if cache.suffix!='.flac' or not any(cache.is_relative_to(base) for base in allowed):raise ValueError('cache outside explicitly staged SSD roots')
 require_same_device(cache,root)
 if row.get('alignment')!='aresample_async_first_pts_0' or row.get('rate')!=aw.RATE or row.get('channels')!=1:raise ValueError('staged cache alignment/rate mismatch')
 fp=aw.fingerprint(cache);expected=row['cache_fingerprint']
 if [fp['size_bytes'],int(fp['mtime_ns'])]!=expected:raise ValueError('staged cache changed')
 if not row['complete_selected_coverage']:raise ValueError('staged cache incomplete final coverage')
 return {'path':str(cache),'fingerprint':fp,'absolute_start':float(row['audio_start']),'absolute_end':float(row['audio_end']),'sha256_at_staging':row['cache_sha256'],'source_fingerprint':row['source_fingerprint'],'alignment':row['alignment']}

def prepare(root=ROOT,fine=FINE,out=OUT):
 import prepare as p
 fl.freeze_semantics(root/'label-semantics'/f'{fl.POLICY}.json')
 cohort=read(root/'cohort.json');snapshot=read(root/'private_snapshot.json');private=read(fine/'private_manifest.json');public=read(fine/'features_with_embeddings.json')
 import task_generation_inputs as task_inputs
 sidecar=task_inputs.load_sidecar(root)
 annotated=fl.annotate_rows(public['rows'],private['rows'],snapshot['tasks']);explicit=fl.absolute_rows(annotated);fl.require_binary([r['y'] for r in explicit],'explicit final audit')
 if len(explicit)!=40 or sum(r['y'] for r in explicit)!=36:raise ValueError('frozen current-acceptability40 contract changed')
 meta={r['row']:r for r in private['rows']};tasks={r['id']:r for r in snapshot['tasks']};records=task_inputs.feedback_map(snapshot,sidecar);recs={r['video_id']:r for r in cohort['recordings']}
 if sidecar is not None:
  for label in explicit:
   task=tasks[label['task_id']];feedback=records.get(task['context'][label['side']]['feedback_id'])
   if feedback is None or task_inputs.sidecar_features(sidecar,task,label['side'],feedback) is None:raise fl.FineLabelContractError('Missing exact task-generation numeric coverage')
  # Old pilot NPZs have no source/index-generation receipt; never substitute them for a new corpus.
  task_inputs.require_offered_audio_identity({'generation_input':True})
 matched={r['row']:r for r in read(root/'fine-audio-matched/numeric_manifest.json')['rows']};staged={r['row']:r for r in read(root/'joint-gemma/audio_reuse_manifest.json')['rows']}
 identities={};rows=[];coarse=[]
 # Consume only existing numeric coarse checkpoints, never call snapshot()/DB/archival writes.
 coarse_manifest=read(root/'audio/private_manifest.json')
 if coarse_manifest['cohort_sha256']!=sha(root/'cohort.json'):raise ValueError('coarse manifest references different frozen cohort')
 for row in coarse_manifest['rows']:
  path=root/'audio/embeddings'/f"{row['row']}.npz"
  if not path.is_file():continue
  with np.load(path,allow_pickle=False) as z:
   vector=np.asarray(z['embedding'],dtype=np.float64)
   if str(z['revision'])!=aw.REVISION or int(z['feedback_id'])!=row['feedback_id'] or abs(float(z['start'])-row['detected_start'])>.001 or abs(float(z['end'])-row['detected_end'])>.001 or vector.shape!=(768,) or not np.isfinite(vector).all() or abs(np.linalg.norm(vector)-1)>.01:raise ValueError('coarse checkpoint mismatch')
  fx=np.asarray(row['features'],dtype=float)
  if fx.shape!=(13,) or not np.isfinite(fx).all():raise ValueError('coarse numeric features invalid')
  coarse.append({'row':row['row'],'group':row['group'],'video_id':row['video_id'],'y':row['y'],'features':fx.tolist(),'embedding':vector.tolist(),'checkpoint_sha256':sha(path)})
 for label in explicit:
  old=meta[label['row']];task=tasks[old['task_id']];side=label['side'];context=task['context'][side];feedback=records[context['feedback_id']];record=recs[old['video_id']];proposals=[dict(r) for r in record['original_proposals']]
  matches=[i for i,r in enumerate(proposals) if r['id']==feedback['clip_id']]
  if len(matches)!=1 or feedback['video_id']!=old['video_id'] or feedback['analyzed_at']!=record['analyzed_at']:raise ValueError('frozen original proposal generation mismatch')
  index=matches[0];gold=label['cut_gold'];a,b=(gold['start_seconds'],gold['end_seconds']) if gold else (old['start'],old['end'])
  wanted=intervals(a,b);old_offsets=intervals(old['start'],old['end']);cp=root/'fine-audio-matched/embeddings'/f"{old['row']}.npz";v=offered_vectors(cp,old_offsets);reused=exact_reuse(wanted,old_offsets,v)
  frame=root/'frames'/f"{old['video_id']}.npz";t=frames=None
  if frame.is_file():
   with np.load(frame,allow_pickle=False) as z:t=z['t'].copy();frames=z['v'].copy()
   if frames.ndim!=2 or frames.shape[1]!=1152 or len(t)!=len(frames) or not np.isfinite(frames).all() or not np.isfinite(t).all() or np.any(np.diff(t)<=0):raise ValueError('frozen indexed frames invalid')
  proposals[index].update(start=old['start'],end=old['end'],score=old['base'][1]);offered_fx=p.features(proposals,record['duration'],t,frames)[index]
  if not np.allclose(offered_fx,matched[old['row']]['features'],atol=1e-9,rtol=1e-9):raise ValueError('offered13 parity mismatch')
  proposals[index].update(start=a,end=b);fx=p.features(proposals,record['duration'],t,frames)[index];key=f"fine{old['task_id']}{side}";cache=None
  if any(vec is None for vec in reused):
   receipt=staged[key]
   if receipt['video_id']!=old['video_id'] or receipt['feedback_id']!=feedback['id'] or receipt['clip_id']!=feedback['clip_id'] or abs(receipt['selected_start']-a)>.001 or abs(receipt['selected_end']-b)>.001:raise ValueError('staged final-range identity mismatch')
   cache=cache_receipt(receipt,root)
   if a<cache['absolute_start']-.001 or b>cache['absolute_end']+.001:raise ValueError('final range outside staged audio')
  cg=matched[old['row']]['coarse_group']
  if cg!=record['group']:raise ValueError('fine/coarse channel identity mismatch')
  if identities.setdefault(label['group'],cg)!=cg:raise ValueError('fine channel maps to inconsistent coarse channels')
  row={'row':old['row'],'task_id':old['task_id'],'side':side,'video_id':old['video_id'],'feedback_id':feedback['id'],'clip_id':feedback['clip_id'],'generation':feedback['analyzed_at'],'group':label['group'],'coarse_group':cg,'y':label['y'],'absolute_y':label['absolute_y'],'current_acceptability_y':label['current_acceptability_y'],'ranking_y':label['ranking_y'],'fine_label_policy':fl.POLICY,'label_target':fl.CURRENT_TARGET,'future_replacement_y':None,'permanent_storage_y':None,'label_policy':fl.POLICY,'offered_start':old['start'],'offered_end':old['end'],'final_start':a,'final_end':b,'cut_gold':gold,'features':fx,'offered_features':offered_fx,'window_offsets':wanted,'offered_offsets':old_offsets,'offered_checkpoint':str(cp),'offered_checkpoint_sha256':sha(cp),'frame_sha256':sha(frame) if frame.is_file() else None,'visual_index_identity':snapshot['indices'].get(str(old['video_id'])),'cache':cache,'reused_windows':sum(vec is not None for vec in reused)}
  row['identity_sha256']=digest(row);rows.append(row)
 for g,cg in identities.items():
  train=[r['y'] for r in coarse if r['group']!=cg];fl.require_binary(train,'coarse prior held-fine-channel training')
  if len(train)<=16:raise ValueError('coarse PCA training cohort too small')
 sources=[root/'cohort.json',root/'private_snapshot.json',root/'audio/private_manifest.json',fine/'private_manifest.json',fine/'features_with_embeddings.json',root/'fine-audio-matched/numeric_manifest.json',root/'joint-gemma/audio_reuse_manifest.json']
 manifest={'recipe':RECIPE,'policy':fl.POLICY,'pin':aw.PIN,'rows':rows,'coarse_rows':coarse,'input_sha256':{str(path.relative_to(LAB)):sha(path) for path in sources},'coarse_cohort_sha256':digest(coarse)}
 spec={'recipe':RECIPE,'policy':fl.POLICY,'manifest_sha256':digest(manifest),'total_seconds':240,'rows':len(rows),'positives':sum(r['y'] for r in rows),'negative_channels':len({r['group'] for r in rows if not r['y']}),'reused_windows':sum(r['reused_windows'] for r in rows),'new_windows':sum(2-r['reused_windows'] for r in rows),'model':aw.PIN,'features':p.FEATURES,'comparators':COMPARATORS,'training':'coarse triage only, fixed C and PCA16, whole test channel excluded from all scaling/PCA/fitting, recording-balanced weights shared by all models','paired_domains':'same fitted models score offered and final ranges; no fine fitting/tuning','stop':'one attempt; shared nonblocking GPU/media lock; busy/deadline/first error stops; no automatic retry','source':'only verified preexisting staged local SSD FLAC; no originals/HDD fallback; no network/cloud','label_limit':'A/B/both current candidates and neither current rejects; two negative channels; future replacement/permanent storage unknown','deploy':False}
 # Roundtrip tuples before immutable comparison.
 spec=json.loads(json.dumps(spec));frozen(out/'private_manifest.json',manifest);frozen(out/'preregistration.json',spec)
 return manifest,spec

def final_checkpoint(row,path):
 if not path.is_file():return None
 with np.load(path,allow_pickle=False) as z:
  v=np.asarray(z['v'],dtype=np.float64)
  if str(z['identity_sha256'])!=row['identity_sha256'] or str(z['revision'])!=aw.REVISION or str(z['recipe'])!=RECIPE or not np.allclose(z['offsets'],row['window_offsets'],atol=.0001,rtol=0) or not np.array_equal(z['decoded_samples'],[aw.SAMPLES]*2) or v.shape!=(2,768) or not np.isfinite(v).all() or not np.allclose(np.linalg.norm(v,axis=1),1,rtol=0,atol=.01):raise ValueError('final checkpoint identity mismatch')
  return v.copy()
def checkpoint(row,v,path):
 path.parent.mkdir(exist_ok=True,mode=0o700);temporary=path.with_suffix('.partial')
 with temporary.open('wb') as file:np.savez_compressed(file,v=np.asarray(v,dtype=np.float32),offsets=row['window_offsets'],decoded_samples=[aw.SAMPLES]*2,identity_sha256=row['identity_sha256'],revision=aw.REVISION,recipe=RECIPE);file.flush();os.fsync(file.fileno())
 temporary.chmod(0o600);temporary.replace(path)
def ensure_time(deadline):
 if time.monotonic()>=deadline:raise aw.Deferred()
def ensure_idle(deadline,gpu=False):
 ensure_time(deadline)
 if aw.busy() or (gpu and not aw.gpu_idle()):raise aw.Deferred()

def domain_metrics(rows,scores):
 from sklearn.metrics import roc_auc_score,brier_score_loss
 from scipy.special import expit
 labels=np.asarray([r['absolute_y'] for r in rows]);fl.require_binary(labels,'saved-range current-acceptability metrics')
 return {'auroc':float(roc_auc_score(labels,scores)),'brier_of_uncalibrated_coarse_prior':float(brier_score_loss(labels,expit(scores))),**fl.strict_pair_metrics(rows,scores)}

def evaluate(manifest,out,deadline):
 from sklearn.preprocessing import StandardScaler
 from sklearn.decomposition import PCA
 from sklearn.linear_model import LogisticRegression
 from sklearn.metrics import roc_auc_score,brier_score_loss
 from scipy.special import expit
 rows=manifest['rows'];coarse=manifest['coarse_rows'];y=np.array([r['y'] for r in rows]);groups=np.array([r['group'] for r in rows]);cx=np.array([r['features'] for r in coarse]);ce=np.array([r['embedding'] for r in coarse]);cy=np.array([r['y'] for r in coarse]);cg=np.array([r['group'] for r in coarse]);vid=np.array([r['video_id'] for r in coarse]);fx=np.array([r['features'] for r in rows]);ox=np.array([r['offered_features'] for r in rows]);fe=[];oe=[]
 for row in rows:
  ensure_time(deadline);fe.append(unitmean(final_checkpoint(row,out/'embeddings'/f"{row['row']}.npz")));oe.append(unitmean(offered_vectors(Path(row['offered_checkpoint']),row['offered_offsets'])))
 fe=np.asarray(fe);oe=np.asarray(oe);scores={domain:{name:np.full(len(rows),np.nan) for name,*_ in COMPARATORS} for domain in ('offered','final')};folds=[]
 for group in sorted(set(groups)):
  ensure_time(deadline);test=np.flatnonzero(groups==group);excluded={rows[i]['coarse_group'] for i in test};train=np.flatnonzero(~np.isin(cg,list(excluded)));fl.require_binary(cy[train],'coarse-only audit train fold')
  if set(cg[train])&excluded:raise ValueError('held-out coarse channel leaked')
  ids=vid[train];counts={v:sum(ids==v) for v in set(ids)};weight=np.array([1/counts[v] for v in ids])*len(ids)/len(counts)
  pc=PCA(16,svd_solver='full').fit(ce[train]);sc_audio=StandardScaler().fit(pc.transform(ce[train]));latent=sc_audio.transform(pc.transform(ce[train]));latent_final=sc_audio.transform(pc.transform(fe[test]));latent_offered=sc_audio.transform(pc.transform(oe[test]))
  for name,n,C,audio in COMPARATORS:
   ensure_time(deadline);sc=StandardScaler().fit(cx[train,:n]);x=sc.transform(cx[train,:n]);final=sc.transform(fx[test,:n]);offered=sc.transform(ox[test,:n])
   if audio:x=np.c_[x,latent];final=np.c_[final,latent_final];offered=np.c_[offered,latent_offered]
   model=LogisticRegression(C=C,solver='liblinear',max_iter=5000,tol=1e-6).fit(x,cy[train],sample_weight=weight)
   scores['final'][name][test]=model.decision_function(final);scores['offered'][name][test]=model.decision_function(offered)
  folds.append({'fine_group':group,'excluded_coarse_groups':sorted(excluded),'training_rows':len(train),'test_rows':len(test)})
 metrics={domain:{name:domain_metrics(rows,s) for name,s in predictions.items()} for domain,predictions in scores.items()}
 report={'status':'complete','recipe':RECIPE,'policy':fl.POLICY,'label_target':fl.CURRENT_TARGET,'future_replacement':'unknown','permanent_storage_worth':'unknown','rows':len(rows),'positives':int(y.sum()),'channels':len(set(groups)),'negative_channels':len({r['group'] for r in rows if not r['y']}),'comparisons':metrics,'folds':folds,'production_changed':False,'final_classifier_trained':False,'limits':['Only2negativechannels; exploratory reused corpus, not independent final validation.','Coarse-trained scores and their Brier values are not calibrated current-acceptability or permanent-storage probabilities.','Verified saved detail.best ranges remain valid, including accepted=false manual adjustments. One-sided losers remain current candidates without invented saved cuts; future replacement and permanent storage worth are unknown.'],'raw_uploads':0,'cloud_units':0}
 atomic(out/'predictions.json',{'rows':[{'row':r['row'],'y':r['y'],'final_start':r['final_start'],'final_end':r['final_end'],**{domain:{name:float(s[i]) for name,s in predictions.items()} for domain,predictions in scores.items()}} for i,r in enumerate(rows)]});return report

def run():
 began=time.monotonic();deadline=began+240;model=None;completed=0;new_windows=0;report={'status':'not_started'}
 OUT.mkdir(parents=True,exist_ok=True,mode=0o700)
 # Marker rejects a second automatic/manual invocation of this immutable preregistered attempt.
 marker=OUT/'attempt.json'
 with marker.open('x') as file:json.dump({'started_unix':time.time(),'total_seconds':240},file)
 marker.chmod(0o600)
 lock=LOCK.open('a')
 try:
  with aw.watchdog(deadline):
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:raise aw.Deferred()
   ensure_idle(deadline,gpu=True);manifest,spec=prepare()
   if digest(manifest)!=spec['manifest_sha256']:raise ValueError('preregistered manifest mismatch')
   for row in manifest['rows']:
    ensure_idle(deadline);target=OUT/'embeddings'/f"{row['row']}.npz";cached=final_checkpoint(row,target)
    if cached is not None:completed+=1;continue
    if sha(Path(row['offered_checkpoint']))!=row['offered_checkpoint_sha256']:raise ValueError('offered checkpoint changed after freeze')
    vectors=exact_reuse(row['window_offsets'],row['offered_offsets'],offered_vectors(Path(row['offered_checkpoint']),row['offered_offsets']))
    if any(v is None for v in vectors):
     cache=row['cache'];source=Path(cache['path'])
     if aw.fingerprint(source)!=cache['fingerprint']:raise ValueError('SSD cache changed after freeze')
     if model is None:
      ensure_idle(deadline,gpu=True)
      os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
      import torch
      from sentence_transformers import SentenceTransformer
      torch.set_num_threads(2)
      if not torch.cuda.is_available():raise ValueError('local AMD runtime unavailable')
      with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):model=SentenceTransformer(aw.MODEL,revision=aw.REVISION,device='cuda',config_kwargs={'vision_config':None},model_kwargs={'torch_dtype':torch.bfloat16},local_files_only=True)
     for i,v in enumerate(vectors):
      if v is not None:continue
      ensure_idle(deadline);offset=row['window_offsets'][i]-cache['absolute_start']
      if offset<-.001 or offset+20>cache['absolute_end']-cache['absolute_start']+.001:raise ValueError('uniform final window outside cache')
      wave=aw.decode(source,max(0.,offset),deadline)
      if aw.fingerprint(source)!=cache['fingerprint']:raise ValueError('SSD cache changed during decode')
      with torch.inference_mode():encoded=model.encode([{'audio':wave}],batch_size=1,normalize_embeddings=True,show_progress_bar=False)
      if encoded.shape!=(1,768) or not np.isfinite(encoded).all() or abs(np.linalg.norm(encoded[0])-1)>.01:raise ValueError('invalid local output')
      vectors[i]=encoded[0];new_windows+=1
    checkpoint(row,vectors,target);completed+=1
    print(json.dumps({'rows_completed':completed,'new_windows':new_windows,'elapsed_seconds':round(time.monotonic()-began,1)}),flush=True)
   if model is not None:
    del model;model=None;torch.cuda.empty_cache()
   ensure_time(deadline);report=evaluate(manifest,OUT,deadline)
 except aw.Deferred:report={'status':'busy_or_deadline_stopped','automatic_retry':False}
 except Exception as error:report={'status':'error_stopped','error_type':type(error).__name__,'automatic_retry':False}
 finally:
  if model is not None:
   del model
   import torch
   torch.cuda.empty_cache()
  lock.close();report.update(completed_rows=completed,new_windows=new_windows,elapsed_seconds=round(time.monotonic()-began,2),production_changed=False,raw_uploads=0,cloud_units=0);atomic(OUT/'report.json',report)
 print(json.dumps(report),flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','run']);args=parser.parse_args()
 if args.mode=='prepare':
  manifest,spec=prepare();print(json.dumps({k:v for k,v in spec.items() if k in ('rows','positives','negative_channels','reused_windows','new_windows','manifest_sha256','total_seconds')},allow_nan=False))
 else:run()
