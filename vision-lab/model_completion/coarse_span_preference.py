"""One fixed weak edited-span preference prior; cached numeric data only.

No frame is labeled bad. A saved edited span is ranked above alternative spans.
"""
from __future__ import annotations
import argparse,hashlib,json,signal,time
PROCESS_STARTED=time.monotonic()
from collections import Counter
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd
import structured_span_preference as spans
import edited_coarse_temporal_prior as edited
import frame_cuts as fc
import joint_window_boundaries as jw
import nonlinear_boundary as nb
import task_generation_inputs as historical
from cut_and_whole import eligible_cuts,save,splits
from pixel_temporal_boundaries import pair_bootstrap

FAMILIES=['span_zero_prior_C1','span_coarse_preference_C1']
POLICY={
 'primary':FAMILIES[1],'control':FAMILIES[0],'coarse_C':.1,'fine_C':1.,'seconds':90,
 'coarse':'74 recoverable genuinely edited original coarse keeps /30 channels; unchanged46 excluded, missing2 excluded;8s minimum saved span retained',
 'fine':'Same21 complete original fine targets/10channels/1149 existing dense20s audio windows; same5 exclusions for both heads',
 'target':'WEAK saved edited span preferred to label-independent alternatives; omitted frames have unknown absolute quality; no inside/outside classification',
 'coarse_features':'PCA8 frozen SigLIP5s cells pooled by exact time overlap plus log(seconds), duration_fraction, start_fraction,end_fraction; no audio prior',
 'visual_cells':'Validated unit raw frame at t represents [t,t+5); intersect with immutable original bounds. Fine21 require full continuous coverage. Coarse-only weak proxies pool observed overlap without extrapolation; coverage fractions/tails are frozen. SAME5s cell pooling for prior training/application',
 'coarse_projection':'Permitted coarse original cells only; each recording total1 split equally among its edited clips and by cell duration; weighted centered randomizedSVD8,n_iter3,seed29; never gold-conditioned',
 'coarse_alternatives':'Legal spans from original endpoints plus visual cell boundaries,minimum min(5,original seconds),no maximum; remove zero-observed spans before inspecting gold, then64 uniformgrid alternatives; omit exactself only,do not replace',
 'coarse_training':'C.1 liblinear symmetric gold-minus-alternative logistic, no intercept/class weighting,max_iter2000,seed29; each recording total80 split equally among clips and signed pairs; train-only weighted StandardScaler(with_mean=False)',
 'fine_features':'Existing28(audioPCA16+fineSigLIPPCA8+4geometry) plus one raw prior score; matched control zeros scalar29; identical fine projections/scaler/alternatives/record weights',
 'fine_training':'Existing fixedC1 symmetric span logistic,no intercept; each fine original total80 signed weight; no grid or new target labels',
 'folds':'Outer5/inner3 whole fine channels; exclude ALL fixedfine channels absent from each current trainfold from coarse PCA/scaler/head. Inner folds also exclude outer-held channels',
 'selection':'Each fixed family selects identity vsargmax only using inner fine folds; argmax requires macroIoU>identity and retention>=.97/p10>=.9. No held-gold endpoint injected into candidate grid',
 'tie':'Prefer original, then longer, then earlier start/end within1e-10 score tie',
 'gate':'Same IoU>identity+.02,macroretention>=.97,p10>=.9,>=3 shortening>=5s;5000pairedchannel bootstrap lowergain>0/lowerretention>=.97; gain over zero-prior control lower>0; exact zero-mass guard',
 'limits':'One90s CPU attempt including imports/loading/evaluation; no retries/tuning/newmedia/GPU/cloud/labels/DB writes; keep production disabled pending independent audit/runtime parity',
 'limitation':'Five-second frozen visual and overlapping20s audio pooling are approximate span features, not exact fresh encodings or proof outside material is worthless'
}
COARSE=[];FINE_GROUPS=set();PRIORS={};PRIOR_RECEIPTS=[]


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def frozen(path,value):
 path=Path(path)
 if path.exists():
  if json.loads(path.read_text())!=value:raise ValueError('Immutable coarse-span preregistration differs')
 else:save(path,value)


def visual_cells(t,v,a,b,complete=True):
 t=np.asarray(t,float);v=np.asarray(v,float)
 if t.ndim!=1 or v.ndim!=2 or len(t)!=len(v) or v.shape[1]!=1152 or not len(t) or not np.isfinite(t).all() or not np.isfinite(v).all() or not a<b or np.any(np.abs(np.diff(t)-5)> .001):raise ValueError('Invalid frozen5s visual cells')
 norm=np.linalg.norm(v,axis=1)
 if np.any(norm<.99) or np.any(norm>1.01):raise ValueError('Frozen visual vector is zero/nonunit')
 lo=np.maximum(t,a);hi=np.minimum(t+5,b);mask=hi>lo;lo=lo[mask];hi=hi[mask];v=v[mask]
 if not len(lo) or np.any(np.abs(lo[1:]-hi[:-1])>.001) or (complete and (abs(lo[0]-a)>.001 or abs(hi[-1]-b)>.001)):raise ValueError('Original lacks continuous5s visual cell coverage')
 v=v/np.linalg.norm(v,axis=1,keepdims=True)
 return {'cell_starts':lo,'cell_ends':hi,'cell_vectors':v,'visual_complete':complete}


def pool_cells(row,values,intervals):
 values=np.asarray(values,float);intervals=np.asarray(intervals,float);lo=row['cell_starts'];hi=row['cell_ends']
 if values.ndim!=2 or len(values)!=len(lo) or intervals.ndim!=2 or intervals.shape[1]!=2 or not np.isfinite(values).all() or not np.isfinite(intervals).all() or np.any(intervals[:,1]<=intervals[:,0]):raise ValueError('Invalid5s cell pool')
 if np.any(intervals[:,0]<row['detected_start']-1e-9) or np.any(intervals[:,1]>row['detected_end']+1e-9):raise ValueError('Pooled span outside original')
 edges,inverse=np.unique(intervals.ravel(),return_inverse=True);occupancy=np.clip(edges[:,None]-lo[None,:],0,hi-lo);integral=occupancy@values;mass=occupancy.sum(1);a,b=inverse.reshape(-1,2).T;denom=mass[b]-mass[a]
 if np.any(denom<=0) or (row.get('visual_complete',True) and not np.allclose(denom,intervals[:,1]-intervals[:,0],rtol=0,atol=.002)):raise ValueError('Pooled span lacks required observed visual coverage')
 return (integral[b]-integral[a])/denom[:,None]


def coarse_grid(row):
 edges=np.unique(np.r_[row['detected_start'],row['detected_end'],row['cell_starts'],row['cell_ends']]);left,right=np.triu_indices(len(edges),1);valid=edges[right]-edges[left]>=min(5.,row['detected_end']-row['detected_start'])-1e-9
 grid=np.c_[edges[left[valid]],edges[right[valid]]];mass=observed_mass(row,grid);row['zero_observed_grid_exclusions']=int(np.sum(mass<=0));return grid[mass>0]


def observed_mass(row,intervals):
 intervals=np.asarray(intervals,float);edges,inverse=np.unique(intervals.ravel(),return_inverse=True);mass=np.clip(edges[:,None]-row['cell_starts'][None,:],0,row['cell_ends']-row['cell_starts']).sum(1);a,b=inverse.reshape(-1,2).T;return mass[b]-mass[a]


def coverage_receipt(row):
 original=np.array([[row['detected_start'],row['detected_end']]]);gold=np.array([[row['selected_start'],row['selected_end']]]);alt=spans.alternatives(row)
 g=observed_mass(row,gold)[0];am=observed_mass(row,alt)
 if g<=0 or np.any(am<=0):raise ValueError('Weak gold/alternative has zero observed visual coverage')
 return {'row':row['row'],'original_observed_fraction':float(observed_mass(row,original)[0]/(original[0,1]-original[0,0])),'missing_head_seconds':float(max(0,row['cell_starts'][0]-row['detected_start'])),'missing_tail_seconds':float(max(0,row['detected_end']-row['cell_ends'][-1])),'gold_observed_fraction':float(g/(gold[0,1]-gold[0,0])),'alternative_min_observed_fraction':float(np.min(am/(alt[:,1]-alt[:,0]))),'zero_observed_grid_exclusions':row.get('zero_observed_grid_exclusions',0)}


def allowed(training_groups):
 blocked=FINE_GROUPS-set(training_groups);rows=[r for r in COARSE if r['group'] not in blocked]
 if not rows or {r['group'] for r in rows}&blocked:raise ValueError('Held-out fine channel in coarse span prior')
 return rows,blocked


def projection_weights(rows):
 counts=Counter(r['video_id'] for r in rows)
 return np.concatenate([(r['cell_ends']-r['cell_starts'])/np.sum(r['cell_ends']-r['cell_starts'])/counts[r['video_id']] for r in rows])


def prior_features(pre,row,intervals):
 mean,components=pre;projected=(row['cell_vectors']-mean)@components.T
 return np.c_[pool_cells(row,projected,intervals),spans.geometry(row,intervals)]


def prior_pairs(pre,rows):
 counts=Counter(r['video_id'] for r in rows);X=[];y=[];w=[];receipt=[]
 for row in rows:
  alternatives=spans.alternatives(row)
  if not len(alternatives):raise ValueError('No nonself coarse alternatives')
  gold=prior_features(pre,row,[[row['selected_start'],row['selected_end']]])[0];difference=gold-prior_features(pre,row,alternatives);n=len(alternatives)
  X.extend([difference,-difference]);y.extend([np.ones(n,int),np.zeros(n,int)]);weight=80/counts[row['video_id']];w.append(np.full(n*2,weight/(n*2)));receipt.append({'row':row['row'],'video_id':row['video_id'],'alternatives':n,'signed_pairs':2*n,'total_weight':weight})
 return np.concatenate(X),np.concatenate(y),np.concatenate(w),receipt


def prior(training_groups,deadline):
 key=frozenset(training_groups)
 if key in PRIORS:return PRIORS[key]
 rows,blocked=allowed(key);nb.check(deadline);w=projection_weights(rows);X=np.concatenate([r['cell_vectors'] for r in rows]);mean=np.average(X,axis=0,weights=w)
 if len(X)<=8:raise ValueError('Coarse PCA8 has insufficient cells')
 _,_,components=randomized_svd((X-mean)*np.sqrt(w/w.mean())[:,None],n_components=8,n_iter=3,random_state=29);pre=(mean,components);pairs,y,weights,counts=prior_pairs(pre,rows);nb.check(deadline)
 scale=StandardScaler(with_mean=False).fit(pairs,sample_weight=weights);model=LogisticRegression(C=.1,fit_intercept=False,solver='liblinear',max_iter=2000,random_state=29).fit(scale.transform(pairs),y,sample_weight=weights);value={'pre':pre,'scale':scale,'model':model}
 PRIORS[key]=value;PRIOR_RECEIPTS.append({'fine_train_channels':sorted(key),'blocked_fine_channels':sorted(blocked),'coarse_train_channels':sorted({r['group'] for r in rows}),'coarse_rows':[r['row'] for r in rows],'coarse_clips':len(rows),'coarse_cells':len(X),'pairs':counts,'held_channel_overlap':0});return value


def prior_scores(model,row,intervals):return model['model'].decision_function(model['scale'].transform(prior_features(model['pre'],row,intervals)))


def fine_features(model,row,intervals):return np.c_[spans.features(model['pre'],row,intervals),prior_scores(model['prior'],row,intervals)]


def fit(rows,deadline):
 nb.check(deadline);pre=spans.projection(rows);coarse_prior=prior({r['group'] for r in rows},deadline);context={'pre':pre,'prior':coarse_prior};X=[];y=[];weights=[];counts=[]
 for row in rows:
  alternatives=spans.alternatives(row);gold=fine_features(context,row,[[row['selected_start'],row['selected_end']]])[0];d=gold-fine_features(context,row,alternatives);n=len(alternatives)
  if not n:raise ValueError('No fine alternatives')
  X.extend([d,-d]);y.extend([np.ones(n,int),np.zeros(n,int)]);weights.append(np.full(n*2,80/(n*2)));counts.append({'row':row['row'],'alternatives':n,'signed_pairs':2*n,'total_weight':80.})
 X=np.concatenate(X);y=np.concatenate(y);weights=np.concatenate(weights);scale=StandardScaler(with_mean=False).fit(X,sample_weight=weights);models={}
 for family in FAMILIES:
  nb.check(deadline);values=X.copy()
  if family==FAMILIES[0]:values[:,-1]=0.
  models[family]=LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=2000,random_state=29).fit(scale.transform(values),y,sample_weight=weights)
 return dict(context,scale=scale,models=models,pair_counts=counts,train_rows=sorted(r['row'] for r in rows),train_groups=sorted({r['group'] for r in rows}))


def predict(model,rows,deadline):
 result={family:[] for family in FAMILIES}
 for row in rows:
  nb.check(deadline);X=fine_features(model,row,row['grid'])
  for family in FAMILIES:
   values=X.copy()
   if family==FAMILIES[0]:values[:,-1]=0.
   result[family].append(spans.best_span(row,model['models'][family].decision_function(model['scale'].transform(values))))
 return result


def inner_choice(rows,deadline):
 held={family:[None]*len(rows) for family in FAMILIES};receipts=[]
 for tr,te in splits(rows,3):
  train=[rows[i] for i in tr];test=[rows[i] for i in te];model=fit(train,deadline);prediction=predict(model,test,deadline)
  if set(model['train_groups'])&{r['group'] for r in test}:raise ValueError('Inner channel leak')
  for family in FAMILIES:
   for i,p in zip(te,prediction[family]):held[family][i]=p
  receipts.append({'train_groups':model['train_groups'],'test_groups':sorted({r['group'] for r in test}),'training_pairs':model['pair_counts']})
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);settings={}
 for family in FAMILIES:
  metric=fc.metrics(rows,held[family]);use=metric['channel_macro_iou']>identity['channel_macro_iou'] and metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9;settings[family]={'policy':'argmax' if use else 'identity','inner_argmax':metric,'inner_identity':identity}
 return settings,receipts


def archive_index_receipt(feedback,t,v,archive_root=historical.snapshots.ROOT):
 saved=historical.exact_archive(feedback,archive_root)
 if saved is None:raise ValueError('Exact archived coarse generation/index is absent')
 f=saved['features'];index=f['index']
 if index['modelRevision']!=historical.VISUAL_PIN or saved['detectorRevision']!=feedback['detector'] or f['identity']!=historical.archive.feature_identity(saved):raise ValueError('Archived coarse source/index/model identity mismatch')
 originals=saved.get('proposals')
 if originals is None:originals=[dict(row,**row.get('detected',{})) for row in saved['clips']]
 matches=[row for row in originals if row['id']==feedback['clip_id']]
 if len(matches)!=1 or matches[0]['start_seconds']!=feedback['detected_start'] or matches[0]['end_seconds']!=feedback['detected_end']:raise ValueError('Archived coarse original proposal mismatch')
 at,av=historical.snapshots.frames(saved,archive_root)
 if not np.array_equal(at,t) or not np.array_equal(av.astype(np.float16),np.asarray(v,dtype=np.float16)):raise ValueError('Frozen coarse cache differs from exact archived numeric payload')
 return {'source':'exact_generation_archive','analyzed_at':saved['analyzedAt'],'source_identity_sha256':hashlib.sha256(json.dumps(saved['source'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),'feature_identity':f['identity'],'feature_sha256':f['sha256'],'index':index}


def load(root,deadline):
 rows,excluded,metadata_hashes=spans.load(root,deadline);cohort=json.loads((root/'cohort.json').read_text());snapshot=json.loads((root/'private_snapshot.json').read_text());all_fine=json.loads((root/'actual_fine_cohort.json').read_text())['rows'];eligible=eligible_cuts(cohort['rows']);changed=[r for r in eligible if edited.edited(r)];join=edited.verify_join(dict(cohort,rows=changed),all_fine,snapshot)
 if len(eligible)!=122 or len(changed)!=76:raise ValueError('Fixed122/76 weak edited cohort differs')
 coarse=[];receipts={};cache={};missing=[]
 changed_ids={r['row'] for r in changed}
 for row in changed+rows:
  is_coarse=row['row'] in changed_ids
  nb.check(deadline);vid=row['video_id'];path=root/'frames'/f'{vid}.npz'
  if not path.exists():
   if is_coarse:missing.append(row['row']);continue
   raise ValueError('Fine5s visual frame source missing')
  if vid not in cache:
   before=path.stat()
   if before.st_dev!=root.stat().st_dev:raise ValueError('Numeric visual cache outside frozen SSD')
   sha=digest(path)
   with np.load(path,allow_pickle=False) as z:t=z['t'].copy();v=z['v'].copy()
   after=path.stat()
   if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('Frozen visual cache changed')
   index=snapshot['indices'].get(str(vid))
   if index is None:
    feedback=next(x for x in snapshot['records'] if x['id']==row['feedback_id']);index=archive_index_receipt(feedback,t,v)
   elif index[0]!='siglip2/so400m-patch16-256' or index[1]!=len(t):raise ValueError('Frozen visual cache/index pin/count mismatch')
   cache[vid]=(t,v);receipts[vid]={'video_id':vid,'sha256':sha,'bytes':before.st_size,'mtime_ns':before.st_mtime_ns,'index':index}
  t,v=cache[vid];cells=visual_cells(t,v,row['detected_start'],row['detected_end'],complete=not is_coarse)
  if is_coarse:
   value=dict(row,**cells);value['grid']=coarse_grid(value);pool_cells(value,value['cell_vectors'][:,:1],[[value['selected_start'],value['selected_end']]]);value['coverage']=coverage_receipt(value)
   coarse.append(value)
  else:
   expected=next(r for r in all_fine if r['row']==row['row'])
   if receipts[vid]['sha256']!=expected['visual_cache_sha256']:raise ValueError('Fine5s visual hash differs from immutable target receipt')
   row.update(cells)
 if len(coarse)!=74 or len({r['group'] for r in coarse})!=30 or min(r['selected_end']-r['selected_start'] for r in coarse)!=8.:raise ValueError('Fixed74/30 weak span support differs')
 COARSE.clear();COARSE.extend(coarse);FINE_GROUPS.clear();FINE_GROUPS.update(r['group'] for r in rows);PRIORS.clear();PRIOR_RECEIPTS.clear()
 for vid,receipt in receipts.items():
  stat=(root/'frames'/f'{vid}.npz').stat()
  if (stat.st_size,stat.st_mtime_ns)!=(receipt['bytes'],receipt['mtime_ns']):raise ValueError('Visual cache changed during loading')
 import inspect
 sources=[Path(__file__),Path(spans.__file__),Path(edited.__file__),Path(fc.__file__),Path(jw.__file__),Path(nb.__file__),Path(historical.__file__),Path(historical.archive.__file__),Path(historical.snapshots.__file__),Path(inspect.getsourcefile(eligible_cuts)),Path(inspect.getsourcefile(spans.raw.targets)),Path(inspect.getsourcefile(pair_bootstrap))]
 metadata_hashes.update({str(path):digest(path) for path in sources});proof={'metadata_and_source_sha256':metadata_hashes,'visual_cache_receipts':list(receipts.values()),'coarse_rows':[r['row'] for r in coarse],'coarse_groups':sorted({r['group'] for r in coarse}),'fine_rows':[r['row'] for r in rows],'fine_groups':sorted(FINE_GROUPS),'coarse_count':74,'coarse_channels':30,'fine_count':21,'fine_channels':10,'fine_windows':1149,'coarse_min_selected_seconds':8.,'coarse_observed_coverage':[r['coverage'] for r in coarse],'fine_full5s_coverage':True,'join':join,'missing_coarse_numeric_rows':missing,'excluded_fine':excluded}
 return rows,proof


def preflight(root,out):
 rows,proof=load(root,time.monotonic()+30);folds=[]
 for tr,te in splits(rows,5):
  train=[rows[i] for i in tr];pool,blocked=allowed({r['group'] for r in train});inner=[]
  for itr,ite in splits(train,3):
   ipool,iblocked=allowed({train[i]['group'] for i in itr});inner.append({'training_clips':len(ipool),'training_channels':len({r['group'] for r in ipool}),'blocked':sorted(iblocked)})
  folds.append({'train_groups':sorted({r['group'] for r in train}),'test_groups':sorted({rows[i]['group'] for i in te}),'prior_clips':len(pool),'prior_channels':len({r['group'] for r in pool}),'blocked':sorted(blocked),'inner':inner})
 spec={'policy':POLICY,'provenance':proof,'preflight_folds':folds,'no_fits':True};frozen(out/'preregistered.json',spec);print(json.dumps({'preflight':'ready','coarse_spans':74,'fine_spans':21,'fine_windows':1149,'no_fits':True}));return spec


def run(root,out):
 if (out/'attempt.json').exists() or (out/'coarse_span_report.json').exists():raise ValueError('One attempt only; historical output is immutable')
 spec=json.loads((out/'preregistered.json').read_text());deadline=PROCESS_STARTED+90;status={'status':'failed','enabled':False,'policy':POLICY}
 def expire(signum,frame):raise TimeoutError('90-second total CPU deadline')
 signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()));save(out/'attempt.json',{'one_attempt':True,'seconds':90})
 try:
  rows,proof=load(root,deadline)
  if spec['policy']!=POLICY or spec['provenance']!=proof:raise ValueError('Frozen preregistration/source/cache identity differs')
  pred={family:[None]*len(rows) for family in FAMILIES};folds=[]
  for tr,te in splits(rows,5):
   nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];settings,inner=inner_choice(train,deadline);model=fit(train,deadline);candidate=predict(model,test,deadline)
   if set(model['train_groups'])&{r['group'] for r in test}:raise ValueError('Outer channel leak')
   for family in FAMILIES:
    for i,r,p in zip(te,test,candidate[family]):pred[family][i]=p if settings[family]['policy']=='argmax' else [r['detected_start'],r['detected_end']]
   folds.append({'train_groups':model['train_groups'],'test_groups':sorted({r['group'] for r in test}),'settings':settings,'inner_folds':inner,'fine_training_pairs':model['pair_counts']});save(out/'partial_validation.json',{'complete':False,'completed_outer_folds':len(folds),'folds':folds,'prior_fits':PRIOR_RECEIPTS,'predictions':pred})
  original=[[r['detected_start'],r['detected_end']] for r in rows];identity=fc.metrics(rows,original);comparisons={}
  for family in FAMILIES:
   nb.check(deadline);metric=fc.metrics(rows,pred[family]);boot=jw.channel_bootstrap(rows,pred[family]);paired=pair_bootstrap(rows,pred[family],original);boot['exact_zero_mass']=paired['exact_zero_mass'];boot['stable']=bool(boot['stable'] and paired['stable_gain']);comparisons[family]={'candidate':metric,'nominal_gate':jw.gate(identity,metric),'channel_bootstrap':boot,'passed_identity_gate':bool(jw.gate(identity,metric) and boot['stable'])}
  matched=pair_bootstrap(rows,pred[FAMILIES[1]],pred[FAMILIES[0]]);passed=bool(comparisons[FAMILIES[1]]['passed_identity_gate'] and matched['stable_gain']);nb.check(deadline)
  status={'status':'completed','policy':POLICY,'rows':21,'channels':10,'windows':1149,'identity':identity,'comparisons':comparisons,'matched_control_bootstrap':matched,'primary_validation_passed':passed,'enabled':False,'provenance':proof,'prior_fits':PRIOR_RECEIPTS,'folds':folds,'seconds':time.monotonic()-PROCESS_STARTED,'no_media_reads':True,'no_gpu_cloud_or_db_writes':True}
  save(out/'coarse_span_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predictions':{f:pred[f][i] for f in FAMILIES}} for i,r in enumerate(rows)]})
 except TimeoutError as error:status.update(status='expired',error=str(error),seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 except Exception as error:status.update(status='failed',error=f'{type(error).__name__}: {error}',seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 finally:signal.setitimer(signal.ITIMER_REAL,0)
 save(out/'coarse_span_report.json',status);save(out/'coarse_span_envelope.json',{'schema_version':1,'kind':'weak_coarse_span_preference','enabled':False,'fallback':'original_range','automatic_action':False,'validation_passed':bool(status.get('primary_validation_passed',False))});print(json.dumps({'status':status['status'],'rows':status.get('rows'),'channels':status.get('channels'),'seconds':status.get('seconds'),'primary_validation_passed':status.get('primary_validation_passed',False),'enabled':False,'error':status.get('error'),'metrics':{family:value['candidate'] for family,value in status.get('comparisons',{}).items()}}));return status

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['preflight','run']);p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();preflight(a.root,a.output) if a.mode=='preflight' else run(a.root,a.output)
