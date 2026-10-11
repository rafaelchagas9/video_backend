"""Matched-runtime20s fine current-acceptability validation. Neutral local numeric outputs only."""
from __future__ import annotations
import argparse,contextlib,hashlib,json,math,os,sys,time
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','2');os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
LAB=Path(__file__).resolve().parents[1];sys.path.insert(0,str(LAB));sys.path.insert(0,str(LAB/'colab_audio_pilot'))
import numpy as np
import prepare as p
import audio_complete as ac
import audio_cache_worker as aw
import fine_labels as fl
import task_generation_inputs as task_inputs
ROOT=p.ROOT;FINE=ROOT.parent/'preference-audio-20261010';OUT=ROOT/'fine-audio-matched'

def current_metrics(rows,scores,ids=None):
 from sklearn.metrics import roc_auc_score,brier_score_loss
 from scipy.special import expit
 ids=np.arange(len(rows)) if ids is None else np.asarray(ids);selected=[rows[i] for i in ids];values=np.asarray(scores)[ids];labels=np.asarray([r['absolute_y'] for r in selected]);fl.require_binary(labels,'matched current-acceptability metrics')
 return {'auroc':float(roc_auc_score(labels,values)),'brier':float(brier_score_loss(labels,expit(values))),'prevalence':float(labels.mean()),**fl.strict_pair_metrics(selected,values)}

def cohort():
 fl.freeze_semantics(ROOT/'label-semantics'/f'{fl.POLICY}.json')
 data=json.loads((ROOT/'cohort.json').read_text());snapshot=json.loads((ROOT/'private_snapshot.json').read_text());private=json.loads((FINE/'private_manifest.json').read_text());tasks={r['id']:r for r in snapshot['tasks']};sidecar=task_inputs.load_sidecar(ROOT);records=task_inputs.feedback_map(snapshot,sidecar);recs={r['video_id']:r for r in data['recordings']};cg={r['video_id']:r['group'] for r in data['rows']};channels={p.dd.channel_key(r['channel']):cg[r['video_id']] for r in snapshot['records'] if r['video_id'] in cg};rows=[]
 for meta in private['rows']:
  task=tasks[meta['task_id']];labels=fl.contract(meta,task);side=task['context'][labels['side']];channel=p.dd.channel_key(task['channel']);group=channels.get(channel,'fine-only-'+meta['group']);fid=side['feedback_id'];original=records.get(fid)
  if sidecar is not None:
   if original is None:raise fl.FineLabelContractError('Missing task feedback generation')
   features=task_inputs.sidecar_features(sidecar,task,labels['side'],original)
   if features is None:raise fl.FineLabelContractError('Missing exact task-generation numeric coverage')
   row={k:meta[k] for k in ('row','group','recording','y','video_id','task_id','start','end')};row.update(**labels);row.update(coarse_group=group,features=features,source_path=meta.get('path'),window_offsets=[w[0] for w in aw.expected_windows(dict(start_seconds=meta['start'],end_seconds=meta['end']))],generation_input=next(r for r in sidecar['sides'] if r['task_id']==task['id'] and r['side']==labels['side']))
   rows.append(row);continue
  rec=recs[meta['video_id']];proposals=[dict(r) for r in rec['original_proposals']];matched=[i for i,r in enumerate(proposals) if r['id']==original['clip_id']]
  if len(matched)!=1:raise ValueError('fine side original proposal cannot be mapped exactly')
  index=matched[0];proposals[index].update(start=meta['start'],end=meta['end'],score=meta['base'][1]);t=v=None;framepath=ROOT/'frames'/f"{meta['video_id']}.npz"
  if framepath.exists():
   with np.load(framepath) as z:t=z['t'];v=z['v']
  features=p.features(proposals,rec['duration'],t,v)[index]
  row={k:meta[k] for k in ('row','group','recording','y','video_id','task_id','start','end')};row.update(**labels);row.update(coarse_group=group,features=features,source_path=meta['path'],window_offsets=[w[0] for w in aw.expected_windows(dict(start_seconds=meta['start'],end_seconds=meta['end']))]);rows.append(row)
 return rows

def run(minutes,dense):
 import soundfile as sf
 began=time.monotonic();deadline=began+minutes*60;rows=cohort()
 for row in rows:task_inputs.require_offered_audio_identity(row)
 OUT.mkdir(parents=True,exist_ok=True);OUT.chmod(0o700);embedding=OUT/'embeddings';embedding.mkdir(exist_ok=True);embedding.chmod(0o700)
 sys.path.insert(0,str(LAB/'colab_audio_pilot'));import pipeline
 pipeline.await_idle(deadline,settle=0)
 while not ac.gpu_idle():
  if time.monotonic()>deadline:raise TimeoutError('GPU busy within bounded budget')
  time.sleep(2)
 records={r['row']:r for r in json.loads((dense/'staging_manifest.json').read_text())['rows']} if dense and (dense/'staging_manifest.json').exists() else {}
 os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_PROGRESS_BARS='1')
 import torch
 from sentence_transformers import SentenceTransformer
 torch.set_num_threads(2)
 with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):model=SentenceTransformer(aw.MODEL,revision=aw.REVISION,device='cuda',config_kwargs={'vision_config':None},model_kwargs={'torch_dtype':torch.bfloat16},local_files_only=True)
 reused=0;decoded=0;completed=0
 try:
  with aw.watchdog(deadline),torch.inference_mode():
   for row in rows:
    target=embedding/(row['row']+'.npz')
    if target.exists():
     with np.load(target) as z:
      if str(z['revision'])==aw.REVISION and np.allclose(z['offsets'],row['window_offsets']) and z['v'].shape==(2,768):completed+=1;continue
    waves=[];dense_record=records.get('fine'+str(row['task_id'])+row['row'][-1]);cache=dense/'audio'/dense_record['cache'] if dense_record else None
    for offset in row['window_offsets']:
     if time.monotonic()>=deadline:raise TimeoutError('bounded matching deadline')
     pipeline.await_idle(deadline,settle=0)
     if dense_record and cache.is_file() and offset>=dense_record['absolute_start']-.001 and offset+20<=dense_record['absolute_start']+dense_record['duration']+.001:
      with sf.SoundFile(cache) as source:
       if source.samplerate!=aw.RATE or source.channels!=1:raise ValueError('validated neutral cache rate mismatch')
       source.seek(int(round((offset-dense_record['absolute_start'])*aw.RATE)));wave=source.read(aw.SAMPLES,dtype='float32')
      if len(wave)!=aw.SAMPLES:raise ValueError('neutral stage has truncated20s')
      reused+=1
     else:
      source=Path(row['source_path']);before=aw.fingerprint(source);wave=aw.decode(source,offset,deadline)
      if aw.fingerprint(source)!=before:raise ValueError('source changed during matched decode')
      decoded+=1
     waves.append(wave)
    vectors=model.encode([{'audio':wave} for wave in waves],batch_size=2,normalize_embeddings=True,show_progress_bar=False);assert vectors.shape==(2,768) and np.isfinite(vectors).all() and np.allclose(np.linalg.norm(vectors,axis=1),1,atol=.01)
    tmp=target.with_suffix('.partial')
    with tmp.open('wb') as f:np.savez_compressed(f,v=vectors,offsets=row['window_offsets'],revision=aw.REVISION,decoded_samples=[len(w) for w in waves])
    tmp.chmod(0o600);tmp.replace(target);completed+=1;print(json.dumps({'completed_sides':completed,'sides':len(rows),'neutral_windows_reused':reused,'audio_windows_decoded':decoded}),flush=True)
 finally:
  del model;torch.cuda.empty_cache();p.save(OUT/f'extraction_report.{fl.POLICY}.json',{'sides_completed':completed,'neutral_windows_reused':reused,'audio_windows_decoded':decoded,'seconds':time.monotonic()-began,'uploads':0,'cloud_units':0})
 p.save(OUT/f'numeric_manifest.{fl.POLICY}.json',{'rows':[{k:v for k,v in row.items() if k!='source_path'} for row in rows],'model_revision':aw.PIN,'window_policy':'runtime uniform2x20s'})

def evaluation_inputs():
 fl.freeze_semantics(ROOT/'label-semantics'/f'{fl.POLICY}.json')
 versioned=OUT/f'numeric_manifest.{fl.POLICY}.json';path=versioned if versioned.exists() else OUT/'numeric_manifest.json';manifest=json.loads(path.read_text())
 if manifest['model_revision']!=aw.PIN or manifest['window_policy']!='runtime uniform2x20s':raise fl.FineLabelContractError('Matched offered feature manifest recipe/pin mismatch')
 private=json.loads((FINE/'private_manifest.json').read_text());snapshot=json.loads((ROOT/'private_snapshot.json').read_text());rows=fl.absolute_rows(fl.annotate_rows(manifest['rows'],private['rows'],snapshot['tasks']))
 if len(rows)!=40 or sum(r['y'] for r in rows)!=36:raise fl.FineLabelContractError('Frozen v2 offered40 current targets differ')
 fine=[]
 for row in rows:
  task_inputs.require_offered_audio_identity(row)
  path_cp=OUT/'embeddings'/(row['row']+'.npz');offsets=[pair[0] for pair in aw.expected_windows(dict(start_seconds=row['start'],end_seconds=row['end']))]
  with np.load(path_cp,allow_pickle=False) as z:
   v=np.asarray(z['v'],dtype=float)
   if str(z['revision'])!=aw.REVISION or v.shape!=(2,768) or z['offsets'].shape!=(2,) or not np.allclose(z['offsets'],offsets,rtol=0,atol=.0001) or not np.array_equal(z['decoded_samples'],[aw.SAMPLES]*2) or not np.isfinite(v).all() or not np.allclose(np.linalg.norm(v,axis=1),1,rtol=0,atol=.01):raise fl.FineLabelContractError('Exact offered runtime checkpoint mismatch')
   fine.append(p.unit(v.mean(0)))
 cohort_path=ROOT/'cohort.json';coarse_manifest_path=ROOT/'audio/private_manifest.json';coarse_manifest=json.loads(coarse_manifest_path.read_text())
 if coarse_manifest['cohort_sha256']!=hashlib.sha256(cohort_path.read_bytes()).hexdigest():raise fl.FineLabelContractError('Coarse frozen cohort mismatch')
 coarse=[];vectors=[]
 for row in coarse_manifest['rows']:
  v=ac.validate_checkpoint(row)
  if v is not None:coarse.append(row);vectors.append(v)
 cy=np.array([r['y'] for r in coarse]);cg=np.array([r['group'] for r in coarse]);fy=np.array([r['y'] for r in rows]);fg=np.array([r['group'] for r in rows])
 for group in sorted(set(fg)):
  test=np.flatnonzero(fg==group);excluded={rows[i]['coarse_group'] for i in test};training=~np.isin(cg,list(excluded));fl.require_binary(cy[training],'fixed coarse current-audit outer training');fl.require_binary(fy[fg!=group],'fixed fine-current numeric outer training')
  if int(training.sum())<=16:raise fl.InsufficientAbsoluteLabels('Fixed PCA16 lacks coarse training rows')
 spec={'policy':fl.POLICY,'label_target':fl.CURRENT_TARGET,'domain':'actual pre-answer offered cuts, not saved final ranges','rows':len(rows),'current_positive':int(fy.sum()),'current_negative':int((1-fy).sum()),'strict_pairs':fl.strict_pair_metrics(rows,np.zeros(len(rows)))['strict_pairs'],'coarse_rows':len(coarse),'model_revision':aw.PIN,'sampling':'existing exact two uniform20s offered-range vectors, mean then unit normalization','source_feature_manifest':path.name,'feature_manifest_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'semantics_sha256':hashlib.sha256((ROOT/'label-semantics'/f'{fl.POLICY}.json').read_bytes()).hexdigest(),'comparators':{'production13_C01':'coarse13+PCA16 C.1 recording-balanced','coarse_numeric13_C01':'coarse13 C.1 same recording-balanced control','prior2_C1':'coarse2+PCA16 C1','coarse_numeric2_C1':'coarse2 C1','fine_numeric2_C1':'verified current-acceptability2 C1'},'validation':'each whole fine channel excluded from coarse fitting/PCA/scalers; fixed fine numeric baseline holds whole fine channels; all comparators identical fine40 and coarse cohort','no_tuning':True,'future_replacement':'unknown','permanent_storage_worth':'unknown','CPU_seconds':180,'media_reads':0,'GPU':False,'production_changed':False}
 spec_path=OUT/f'evaluation_spec.{fl.POLICY}.json'
 if spec_path.exists():
  if json.loads(spec_path.read_text())!=spec:raise fl.FineLabelContractError('Immutable current evaluation specification differs')
 else:p.save(spec_path,spec)
 return rows,np.asarray(fine),coarse,np.asarray(vectors),spec

def _evaluate():
 fl.freeze_semantics(ROOT/'label-semantics'/f'{fl.POLICY}.json')
 from sklearn.preprocessing import StandardScaler
 from sklearn.decomposition import PCA
 from sklearn.linear_model import LogisticRegression
 from sklearn.metrics import roc_auc_score,brier_score_loss
 from scipy.special import expit
 rows,FE,coarse,CE,spec=evaluation_inputs();label_summary=fl.summary(rows);fy=np.array([r['y'] for r in rows]);groups=np.array([r['group'] for r in rows]);cy=np.array([r['y'] for r in coarse]);cgroup=np.asarray([r['group'] for r in coarse])
 CX=np.asarray([r['features'] for r in coarse]);CE=np.asarray(CE,dtype=float);cy=np.asarray([r['y'] for r in coarse]);cgroup=np.asarray([r['group'] for r in coarse]);FX=np.asarray([r['features'] for r in rows]);results={name:np.full(len(rows),np.nan) for name in ('production13_C01','coarse_numeric13_C01','prior2_C1','coarse_numeric2_C1','fine_numeric2_C1')};folds=[]
 for group in sorted(set(groups)):
  te=np.flatnonzero(groups==group);excluded={rows[i]['coarse_group'] for i in te};ci=np.flatnonzero(~np.isin(cgroup,list(excluded)));assert set(cgroup[ci]).isdisjoint(excluded);vids=np.array([coarse[i]['video_id'] for i in ci]);counts={v:sum(vids==v) for v in set(vids)};weight=np.array([1/counts[v] for v in vids])*len(ci)/len(counts);pc=PCA(16,svd_solver='full').fit(CE[ci]);ls=StandardScaler().fit(pc.transform(CE[ci]));latent=ls.transform(pc.transform(CE[ci]));flatent=ls.transform(pc.transform(FE[te]))
  for name,n,C,use_audio in [('production13_C01',13,.1,True),('coarse_numeric13_C01',13,.1,False),('prior2_C1',2,1.,True),('coarse_numeric2_C1',2,1.,False)]:
   sc=StandardScaler().fit(CX[ci,:n]);x=sc.transform(CX[ci,:n]);fx=sc.transform(FX[te,:n]);x=np.c_[x,latent] if use_audio else x;fx=np.c_[fx,flatent] if use_audio else fx;m=LogisticRegression(C=C,solver='liblinear',max_iter=5000,tol=1e-6).fit(x,cy[ci],sample_weight=weight if name in ('production13_C01','coarse_numeric13_C01') else None);results[name][te]=m.decision_function(fx)
  tr=np.flatnonzero(groups!=group);fscale=StandardScaler().fit(FX[tr,:2]);fm=LogisticRegression(C=1.,solver='liblinear',max_iter=5000).fit(fscale.transform(FX[tr,:2]),fy[tr]);results['fine_numeric2_C1'][te]=fm.decision_function(fscale.transform(FX[te,:2]))
  folds.append({'fine_group':group,'excluded_coarse_groups':len(excluded),'coarse_training_rows':len(ci)})
 def metrics(scores,ids=None):return current_metrics(rows,scores,ids)
 summary={k:metrics(v) for k,v in results.items()};p.save(OUT/f'report.{fl.POLICY}.json',{'evaluation_spec':spec,'label_contract':label_summary,'training_targets':{'production13_C01':'coarse triage only','coarse_numeric13_C01':'coarse triage only','prior2_C1':'coarse triage only','coarse_numeric2_C1':'coarse triage only','fine_numeric2_C1':'verified current-acceptability labels'},'target':'current acceptability on offered cuts; future replacement and permanent storage worth remain unknown','rows':len(rows),'channels':len(set(groups)),'keeps':int(fy.sum()),'validation':'fixed production recipe; leave whole fine channel out of all coarse fitting; fine_numeric2_C1 separately trains current-acceptability labels on other channels','window_policy':'matched pinned runtime2uniform20s withinofferedrange','context':'corresponding originalproposal replacedwithofferedcut, allotheroriginalproposals unchanged; cachedfullrecordingframes','comparisons':summary,'folds':folds,'limitation':'All40 verified current sides; rare negative channels and exploratory reused corpus, not independent final audit','production_changed':False});p.save(OUT/f'predictions.{fl.POLICY}.json',{'rows':[dict(row,**{k:float(v[i]) for k,v in results.items()}) for i,row in enumerate(rows)]});print(json.dumps(summary))

def evaluate():
 try:_evaluate()
 except (fl.InsufficientAbsoluteLabels,fl.FineLabelContractError) as error:
  report={'status':'insufficient_explicit_labels_or_provenance','policy':fl.POLICY,'error':str(error),'production_changed':False};p.save(OUT/f'report.{fl.POLICY}.json',report);print(json.dumps(report))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['run','evaluate','preflight']);parser.add_argument('--minutes',type=int,default=10);parser.add_argument('--dense',type=Path);args=parser.parse_args()
 if args.mode=='run':run(args.minutes,args.dense)
 elif args.mode=='preflight':
  *_,spec=evaluation_inputs();print(json.dumps(spec))
 else:evaluate()
