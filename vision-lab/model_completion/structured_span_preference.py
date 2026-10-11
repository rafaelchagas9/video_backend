"""Fixed pooled-span preference; final choices supervise intervals, not frame worth."""
import argparse, hashlib, json, signal, time
PROCESS_STARTED = time.monotonic()
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd
import dense_original_window_boundaries as da
import frame_cuts as fc
import joint_window_boundaries as jw
import nonlinear_boundary as nb
import raw_original_boundaries as raw
from cut_and_whole import save, splits
from pixel_temporal_boundaries import pair_bootstrap, exact_zero_diagnostic

FAMILIES = ['span_geometry_C1', 'span_content_C1']
POLICY = {
 'primary': 'span_content_C1', 'control': 'span_geometry_C1', 'C': 1.,
 'cohort': '21 complete immutable originals / 10 channels / 1149 validated dense 20s windows; same five incomplete originals excluded from both heads',
 'target': 'Human final selected interval is preferred to label-independent alternative spans; omitted material is not assigned a bad/negative frame label',
 'features': 'Overlap-weighted pooled audio train-fold PCA16 + frozen SigLIP train-fold PCA8 + log(seconds), duration_fraction, start_fraction, end_fraction; geometry control zeros the first24',
 'pca': 'Training-original windows only; every original total1, weighted centering/randomized SVD, seed29, n_iter3; no gold-conditioned frame selection',
 'scaling': 'All28 symmetric gold-minus-alternative features, weighted StandardScaler fit only on training pairs; no centering at inference because pairwise differences cancel means',
 'candidates': 'All legal spans from original endpoints plus every validated dense window start/end, duration >= min(5,original seconds), no duration cap; no held-out gold endpoints injected',
 'alternatives': 'Exactly64 uniformly indexed label-independent grid alternatives per original (or all if fewer); remove exact self-comparison after sampling, do not replace it',
 'training': 'C1 liblinear symmetric logistic, no intercept, max_iter2000, seed29; gold-minus-alternative positive and its negation negative; each original total80 signed sample weight, no class_weight',
 'decision': 'Argmax legal span; score ties within1e-10 prefer original then longer then earlier start/end',
 'policies': ['identity', 'argmax'], 'policy_selection': 'Outer5/inner3 whole channels; each fixed family chooses argmax only if inner macro IoU improves identity and retention >=.97 / p10 >=.9, otherwise identity',
 'gate': 'Primary IoU > identity+.02, macro retention >=.97, p10 >=.9, >=3 cuts shortened >=5s; 5000 paired-channel bootstrap lower gain >0 and lower retention >=.97; paired control gain lower >0; exact zero-mass guard',
 'seconds': 90, 'no_new_representations': True,
 'pooling_limitation': '20s overlapping-window vectors pooled by overlap, not a fresh exact-span encoding; no extrapolation and no claim omitted content is worthless',
 'production': 'Envelope remains disabled pending independent review and runtime parity; no media/GPU/cloud/new labels/DB writes'
}


def candidate_grid(row):
 a, b = float(row['detected_start']), float(row['detected_end'])
 offsets = np.asarray(row['offsets'], float)
 if not a < b or not len(offsets) or not np.isfinite(offsets).all():
  raise ValueError('Invalid original or dense offsets')
 if offsets[0] > a+.001 or offsets[-1]+20 < b-.001 or np.any(np.diff(offsets) <= 0) or np.any(np.diff(offsets) > 20.001) or np.any(offsets < a-.001) or np.any(offsets+20 > b+.001):
  raise ValueError('Dense windows do not completely cover the original')
 edges = np.unique(np.r_[a, b, offsets, offsets+20])
 # Only clamp timestamp roundoff; never extrapolate cached coverage.
 edges = np.clip(edges, a, b)
 edges = np.unique(edges)
 left, right = np.triu_indices(len(edges), 1)
 valid = edges[right]-edges[left] >= min(5., b-a)-1e-9
 spans = np.c_[edges[left[valid]], edges[right[valid]]]
 if not np.any(np.all(np.isclose(spans, [a,b], rtol=0, atol=1e-9), axis=1)):
  raise ValueError('Original interval missing from candidates')
 return spans


def alternatives(row):
 grid = row['grid']
 ids = np.unique(np.linspace(0, len(grid)-1, min(64,len(grid))).astype(int))
 # Selection happens without looking at gold. Only zero self-comparisons are omitted.
 gold = np.array([row['selected_start'],row['selected_end']], float)
 return grid[ids][~np.all(np.isclose(grid[ids],gold,rtol=0,atol=1e-9),axis=1)]


def overlap_pool(offsets, values, spans):
 offsets = np.asarray(offsets,float); values = np.asarray(values,float); spans = np.asarray(spans,float)
 if values.ndim != 2 or len(values) != len(offsets) or spans.ndim != 2 or spans.shape[1] != 2 or not np.isfinite(values).all() or np.any(spans[:,1] <= spans[:,0]):
  raise ValueError('Invalid pooled interval feature input')
 # Integrate only at distinct candidate edges, avoiding candidate-by-window matrices.
 edges, inverse = np.unique(spans.ravel(), return_inverse=True)
 occupancy = np.clip(edges[:,None]-offsets[None,:],0.,20.)
 integral = occupancy @ values; mass = occupancy.sum(1)
 lo, hi = inverse.reshape(-1,2).T
 denominator = mass[hi]-mass[lo]
 if np.any(denominator <= 0): raise ValueError('Interval has no numeric-window coverage')
 return (integral[hi]-integral[lo])/denominator[:,None]


def geometry(row,spans):
 a,b = row['detected_start'],row['detected_end']; spans = np.asarray(spans,float); duration = spans[:,1]-spans[:,0]
 if np.any(spans[:,0] < a-1e-9) or np.any(spans[:,1] > b+1e-9):raise ValueError('Interval outside original')
 return np.c_[np.log(duration),duration/(b-a),(spans[:,0]-a)/(b-a),(spans[:,1]-a)/(b-a)]


def projection(rows):
 result = {}; w = np.concatenate([np.full(len(r['offsets']),1/len(r['offsets'])) for r in rows])
 for family,count in [('audio',16),('siglip',8)]:
  X = np.concatenate([r['arrays'][family] for r in rows]); mean = np.average(X,axis=0,weights=w)
  _,_,components = randomized_svd((X-mean)*np.sqrt(w/w.mean())[:,None],n_components=count,n_iter=3,random_state=29)
  result[family] = (mean,components)
 return result


def features(pre,row,spans):
 pcs = []
 for family in ('audio','siglip'):
  mean,components = pre[family]
  projected = (row['arrays'][family]-mean) @ components.T
  pcs.append(overlap_pool(row['offsets'],projected,spans))
 return np.c_[*pcs,geometry(row,spans)]


def symmetric_pairs(pre,rows):
 X=[]; y=[]; weights=[]; counts=[]
 for row in rows:
  spans=alternatives(row)
  if not len(spans):raise ValueError('No non-self training alternatives')
  gold=features(pre,row,[[row['selected_start'],row['selected_end']]])[0]
  differences=gold-features(pre,row,spans)
  X.extend([differences,-differences]);y.extend([np.ones(len(spans),int),np.zeros(len(spans),int)])
  weights.append(np.full(2*len(spans),80/(2*len(spans))))
  counts.append({'row':row['row'],'alternatives':len(spans),'signed_pairs':2*len(spans),'total_weight':80.})
 return np.concatenate(X),np.concatenate(y),np.concatenate(weights),counts


def fit(rows,deadline):
 nb.check(deadline);pre=projection(rows);X,y,w,counts=symmetric_pairs(pre,rows)
 scale=StandardScaler(with_mean=False).fit(X,sample_weight=w)
 models={}
 for family in FAMILIES:
  nb.check(deadline);values=X.copy()
  if family == FAMILIES[0]:values[:,:24]=0.
  values=scale.transform(values)
  model=LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=2000,random_state=29).fit(values,y,sample_weight=w)
  models[family]=model
 return {'projection':pre,'scale':scale,'models':models,'pair_counts':counts,'train_rows':sorted(r['row'] for r in rows),'train_groups':sorted({r['group'] for r in rows})}


def best_span(row,scores):
 spans=row['grid'];scores=np.asarray(scores,float)
 if scores.shape != (len(spans),) or not np.isfinite(scores).all():raise ValueError('Invalid span scores')
 tied=np.flatnonzero(np.abs(scores-scores.max()) <= 1e-10)
 a,b=row['detected_start'],row['detected_end']
 index=max(tied,key=lambda i:(bool(np.allclose(spans[i],[a,b],rtol=0,atol=1e-9)),spans[i,1]-spans[i,0],-spans[i,0],-spans[i,1]))
 return spans[index].tolist()


def predict(model,rows,deadline):
 predictions={family:[] for family in FAMILIES}
 for row in rows:
  nb.check(deadline);X=model['scale'].transform(features(model['projection'],row,row['grid']))
  for family in FAMILIES:
   values=X.copy()
   if family==FAMILIES[0]:values[:,:24]=0.
   predictions[family].append(best_span(row,model['models'][family].decision_function(values)))
 return predictions


def inner_choice(rows,deadline):
 held={family:[None]*len(rows) for family in FAMILIES};receipts=[]
 for tr,te in splits(rows,3):
  train=[rows[i] for i in tr];test=[rows[i] for i in te];model=fit(train,deadline);prediction=predict(model,test,deadline)
  if set(model['train_groups']) & {r['group'] for r in test}:raise ValueError('Inner channel leakage')
  for family in FAMILIES:
   for i,p in zip(te,prediction[family]):held[family][i]=p
  receipts.append({'train_groups':model['train_groups'],'test_groups':sorted({r['group'] for r in test}),'training_pairs':model['pair_counts']})
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);settings={}
 for family in FAMILIES:
  metric=fc.metrics(rows,held[family]);use=metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9 and metric['channel_macro_iou']>identity['channel_macro_iou']
  settings[family]={'policy':'argmax' if use else 'identity','inner_argmax':metric,'inner_identity':identity}
 return settings,receipts


def load(root,deadline):
 paths=[root/'actual_fine_cohort.json',root/'cohort.json',root/'private_snapshot.json',root/'joint-gemma/audio_reuse_manifest.json']
 hashes={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
 recreated,_=raw.targets(root/'cohort.json');expected={r['row']:r for r in recreated}
 actual=json.loads((root/'actual_fine_cohort.json').read_text())['rows']
 if len(actual)!=26 or set(expected)!={r['row'] for r in actual}:raise ValueError('Frozen26 final-cut target identity mismatch')
 ssd_device=root.stat().st_dev
 for r in actual:
  for key in ('video_id','group','detected_start','detected_end','selected_start','selected_end'):
   if r[key]!=expected[r['row']][key]:raise ValueError('Immutable original/final gold provenance mismatch')
  frame=Path(r['visual_frame_cache']);checkpoint=root/'joint-gemma/dense-original-audio/embeddings'/f"{r['row']}.npz"
  if frame.exists() and frame.stat().st_dev!=ssd_device:raise ValueError('Numeric frame cache is not on the frozen SSD')
  if checkpoint.exists() and checkpoint.stat().st_dev!=ssd_device:raise ValueError('Numeric audio checkpoint is not on the frozen SSD')
  cheap=root.parent/'audio'/f"{r['video_id']}.npz"
  if cheap.exists() and cheap.stat().st_dev!=ssd_device:raise ValueError('Cheap numeric audio cache is not on the frozen SSD')
 rows,excluded=da.load(root/'actual_fine_cohort.json',root/'joint-gemma/dense-original-audio');nb.check(deadline)
 if len(rows)!=21 or len({r['group'] for r in rows})!=10 or sum(len(r['offsets']) for r in rows)!=1149:raise ValueError('Fixed21/10/1149 matched numeric cohort mismatch')
 if len(excluded)!=5 or any(x['reason']!='incomplete_original_audio_coverage' for x in excluded):raise ValueError('Unexpected exclusions')
 for row in rows:row['grid']=candidate_grid(row)
 for p in paths:
  if hashlib.sha256(p.read_bytes()).hexdigest()!=hashes[str(p.relative_to(root))]:raise ValueError('Frozen metadata changed during loading')
 return rows,excluded,hashes


def run(root,out,seconds=90):
 if seconds!=90:raise ValueError('Preregistered total deadline is90 seconds')
 deadline=PROCESS_STARTED+seconds;status={'status':'failed','enabled':False,'policy':POLICY}
 if (out/'structured_span_report.json').exists():raise ValueError('Historical result exists; no rerun/overwrite')
 def expire(signum,frame):raise TimeoutError('90-second total cached numeric loading/evaluation deadline')
 signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
 try:
  rows,excluded,hashes=load(root,deadline);pred={family:[None]*len(rows) for family in FAMILIES};folds=[]
  for tr,te in splits(rows,5):
   nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];settings,inner=inner_choice(train,deadline);model=fit(train,deadline);candidate=predict(model,test,deadline)
   if set(model['train_groups']) & {r['group'] for r in test}:raise ValueError('Outer channel leakage')
   for family in FAMILIES:
    for i,r,p in zip(te,test,candidate[family]):pred[family][i]=p if settings[family]['policy']=='argmax' else [r['detected_start'],r['detected_end']]
   folds.append({'train_groups':model['train_groups'],'test_groups':sorted({r['group'] for r in test}),'settings':settings,'inner_folds':inner,'training_pairs':model['pair_counts']})
   save(out/'partial_validation.json',{'complete':False,'completed_outer_folds':len(folds),'folds':folds,'predictions':pred})
  identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);comparisons={}
  for family in FAMILIES:
   nb.check(deadline);metric=fc.metrics(rows,pred[family]);boot=jw.channel_bootstrap(rows,pred[family]);paired_identity=pair_bootstrap(rows,pred[family],[[r['detected_start'],r['detected_end']] for r in rows]);boot['exact_zero_mass']=paired_identity['exact_zero_mass'];boot['stable']=bool(boot['stable'] and paired_identity['stable_gain'])
   comparisons[family]={'candidate':metric,'nominal_gate':jw.gate(identity,metric),'channel_bootstrap':boot,'passed_identity_gate':bool(jw.gate(identity,metric) and boot['stable'])}
  matched=pair_bootstrap(rows,pred[FAMILIES[1]],pred[FAMILIES[0]]);passed=bool(comparisons[FAMILIES[1]]['passed_identity_gate'] and matched['stable_gain']);nb.check(deadline)
  status={'status':'completed','policy':POLICY,'rows':21,'channels':10,'windows':1149,'candidate_spans':sum(len(r['grid']) for r in rows),'excluded':excluded,'source_sha256':hashes,'identity':identity,'comparisons':comparisons,'matched_control_bootstrap':matched,'primary_validation_passed':passed,'enabled':False,'folds':folds,'seconds':time.monotonic()-PROCESS_STARTED,'no_media_reads':True,'no_gpu_cloud_or_db_writes':True}
  save(out/'structured_span_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'grid_candidates':len(r['grid']),'predictions':{f:pred[f][i] for f in FAMILIES}} for i,r in enumerate(rows)]})
 except TimeoutError as error:status.update(status='expired',error=str(error),seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 except Exception as error:status.update(status='failed',error=f'{type(error).__name__}: {error}',seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 signal.setitimer(signal.ITIMER_REAL,0);save(out/'structured_span_report.json',status);save(out/'structured_span_envelope.json',{'schema_version':1,'kind':'structured_pooled_span_preference','enabled':False,'fallback':'original_range','automatic_action':False,'validation_passed':bool(status.get('primary_validation_passed',False))});print(json.dumps(status,indent=2));return status

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();run(a.root,a.output)
