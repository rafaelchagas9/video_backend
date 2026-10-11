"""One fixed candidate-boundary contrast complement; cached numeric inputs only."""
from __future__ import annotations
import argparse, hashlib, inspect, json, signal, time
PROCESS_STARTED = time.monotonic()
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd
import structured_span_preference as spans
import frame_cuts as fc
import joint_window_boundaries as jw
import nonlinear_boundary as nb
from cut_and_whole import save, splits
from pixel_temporal_boundaries import pair_bootstrap

FAMILIES = ['span_zero_boundary_C1', 'span_boundary_contrast_C1']
POLICY = {
 'primary':FAMILIES[1],'control':FAMILIES[0],'C':1.,'seconds':90,
 'cohort':spans.POLICY['cohort'],
 'target':spans.POLICY['target'],
 'hypothesis':'Candidate-specific onset/offset contrast may distinguish precise boundaries from mean interval content. Neither outside band is labeled bad; no occupancy labels',
 'features':'Existing28(Gemma PCA16+SigLIP PCA8+4geometry) plus signed onset/offset GemmaPC16 each(32), signed onset/offset SigLIPPC8 each(16), preceding/following outside-band availability flags(2):78. Matched control zeros only final50',
 'bands':'Inside first/last min20s of candidate; outside preceding/following max20s clipped strictly to immutable original. Same basis and exact overlap pool inside-minus-outside. Absent outside => zero contrast and flag0; available outside => flag1. No extrapolation or candidate/gold-conditioned basis',
 'pca':spans.POLICY['pca'],
 'training':'C1 liblinear symmetric gold-minus-alternative logistic,no intercept/class_weight,max_iter2000,seed29; each original total80 signed weight; SAMEweighted StandardScaler(with_mean=False) on all78 training-pair features for both fixed heads',
 'candidates':spans.POLICY['candidates'],'alternatives':spans.POLICY['alternatives'],'tie':spans.POLICY['decision'],
 'folds':'Same outer5/inner3 whole channels; projection/scaler/head/policy choices inside current training fold',
 'selection':'Identity vsargmax inner only; argmax requires macroIoU>identity,macroretention>=.97,p10>=.9',
 'gate':spans.POLICY['gate'],
 'limits':'One90s CPU attempt including imports/loading/evaluation; no retries/tuning/newvectors/media/GPU/cloud/labels/DB; envelope disabled until independent audit/runtime parity',
 'pooling_limitation':'Boundary bands use overlapping20s cached-window overlap means, not fresh exact band encodings. No original-range exterior is consulted or extrapolated; outside absolute quality unknown',
 'independence':'No boundary contrast or coarse-prior dependency/results/features; this representation was fixed before boundary contrast outcomes'
}


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def freeze(path, value):
 path = Path(path)
 if path.exists():
  if json.loads(path.read_text()) != value: raise ValueError('Immutable boundary contrast span preregistration differs')
 else: save(path, value)


def projection(rows): return spans.projection(rows)


def boundary_features(pre,row,intervals):
 intervals=np.asarray(intervals,float);a,b=row['detected_start'],row['detected_end']
 if intervals.ndim!=2 or intervals.shape[1]!=2 or not np.isfinite(intervals).all() or np.any(intervals[:,1]<=intervals[:,0]) or np.any(intervals[:,0]<a-1e-9) or np.any(intervals[:,1]>b+1e-9):raise ValueError('Boundary candidate outside immutable original')
 start,end=intervals.T;inside_on=np.c_[start,np.minimum(start+20,end)];inside_off=np.c_[np.maximum(start,end-20),end]
 outside_on=np.c_[np.maximum(a,start-20),start];outside_off=np.c_[end,np.minimum(b,end+20)]
 available_on=outside_on[:,1]-outside_on[:,0]>1e-9;available_off=outside_off[:,1]-outside_off[:,0]>1e-9;result=[]
 for family in ('audio','siglip'):
  mean,components=pre[family];projected=(row['arrays'][family]-mean)@components.T
  on=np.zeros((len(intervals),len(components)));off=on.copy()
  if np.any(available_on):on[available_on]=spans.overlap_pool(row['offsets'],projected,inside_on[available_on])-spans.overlap_pool(row['offsets'],projected,outside_on[available_on])
  if np.any(available_off):off[available_off]=spans.overlap_pool(row['offsets'],projected,inside_off[available_off])-spans.overlap_pool(row['offsets'],projected,outside_off[available_off])
  result.extend([on,off])
 return np.c_[*result,available_on.astype(float),available_off.astype(float)]


def features(pre,row,intervals):return np.c_[spans.features(pre,row,intervals),boundary_features(pre,row,intervals)]


def symmetric_pairs(pre, rows):
 X=[]; y=[]; weights=[]; counts=[]
 for row in rows:
  alternatives=spans.alternatives(row)
  if not len(alternatives): raise ValueError('No nonself span alternatives')
  gold=features(pre,row,[[row['selected_start'],row['selected_end']]])[0]; difference=gold-features(pre,row,alternatives); n=len(alternatives)
  X.extend([difference,-difference]);y.extend([np.ones(n,int),np.zeros(n,int)]);weights.append(np.full(2*n,80/(2*n)))
  counts.append({'row':row['row'],'alternatives':n,'signed_pairs':2*n,'total_weight':80.})
 return np.concatenate(X),np.concatenate(y),np.concatenate(weights),counts


def fit(rows,deadline):
 nb.check(deadline);pre=projection(rows);X,y,weights,counts=symmetric_pairs(pre,rows)
 scale=StandardScaler(with_mean=False).fit(X,sample_weight=weights); models={}
 for family in FAMILIES:
  nb.check(deadline);values=X.copy()
  if family==FAMILIES[0]: values[:,28:]=0.
  models[family]=LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=2000,random_state=29).fit(scale.transform(values),y,sample_weight=weights)
 return {'pre':pre,'scale':scale,'models':models,'train_rows':sorted(r['row'] for r in rows),'train_groups':sorted({r['group'] for r in rows}),'pair_counts':counts}


def predict(model,rows,deadline):
 result={family:[] for family in FAMILIES}
 for row in rows:
  nb.check(deadline);X=features(model['pre'],row,row['grid'])
  for family in FAMILIES:
   values=X.copy()
   if family==FAMILIES[0]: values[:,28:]=0.
   result[family].append(spans.best_span(row,model['models'][family].decision_function(model['scale'].transform(values))))
 return result


def inner_choice(rows,deadline):
 held={family:[None]*len(rows) for family in FAMILIES}; receipts=[]
 for tr,te in splits(rows,3):
  train=[rows[i] for i in tr];test=[rows[i] for i in te];model=fit(train,deadline);prediction=predict(model,test,deadline)
  testgroups={r['group'] for r in test}
  if set(model['train_groups'])&testgroups: raise ValueError('Inner channel leak')
  for family in FAMILIES:
   for i,value in zip(te,prediction[family]): held[family][i]=value
  receipts.append({'train_groups':model['train_groups'],'test_groups':sorted(testgroups),'training_pairs':model['pair_counts']})
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]); settings={}
 for family in FAMILIES:
  metric=fc.metrics(rows,held[family]);use=metric['channel_macro_iou']>identity['channel_macro_iou'] and metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9
  settings[family]={'policy':'argmax' if use else 'identity','inner_argmax':metric,'inner_identity':identity}
 return settings,receipts


def load(root,deadline):
 rows,excluded,hashes=spans.load(root,deadline)
 for path in source_paths():hashes[str(path)]=sha(path)
 return rows,{'source_and_metadata_sha256':hashes,'excluded':excluded,'rows':21,'channels':10,'windows':1149,'fine_rows':[r['row'] for r in rows],'fine_groups':sorted({r['group'] for r in rows})}


def source_paths():
 import task_generation_inputs as historical
 return [Path(__file__),Path(__file__).with_name('boundary_contrast_span_test.py'),Path(spans.__file__),Path(spans.da.__file__),Path(fc.__file__),Path(jw.__file__),Path(nb.__file__),Path(spans.raw.__file__),Path(historical.__file__),Path(historical.archive.__file__),Path(historical.snapshots.__file__),Path(inspect.getsourcefile(save)),Path(inspect.getsourcefile(pair_bootstrap))]


def specification():
 return {'policy':POLICY,'source_sha256':{str(path):sha(path) for path in source_paths()},'no_fits':True,'execution_requires':'Independent source and full numeric preflight audit; separate explicit authorization for sole90sCPU run'}


def preregister(out):
 freeze(out/'preregistered.json',specification());print(json.dumps({'preregistered':True,'dimensions':78,'no_fits':True}))


def preflight(root,out):
 if json.loads((out/'preregistered.json').read_text())!=specification(): raise ValueError('Fixed boundary contrast source/preregistration changed')
 rows,proof=load(root,time.monotonic()+30);folds=[]
 for tr,te in splits(rows,5):
  train=[rows[i] for i in tr];folds.append({'train_groups':sorted({r['group'] for r in train}),'test_groups':sorted({rows[i]['group'] for i in te}),'inner':[{'train_groups':sorted({train[i]['group'] for i in itr}),'test_groups':sorted({train[i]['group'] for i in ite})} for itr,ite in splits(train,3)]})
 freeze(out/'numeric_preflight.json',{'proof':proof,'folds':folds,'no_fits':True});print(json.dumps({'preflight':'ready','rows':21,'channels':10,'windows':1149,'no_fits':True}))


def run(root,out):
 if (out/'attempt.json').exists() or (out/'boundary_contrast_report.json').exists(): raise ValueError('One attempt only; historical output immutable')
 spec=json.loads((out/'preregistered.json').read_text());frozen_numeric=json.loads((out/'numeric_preflight.json').read_text());deadline=PROCESS_STARTED+90;status={'status':'failed','enabled':False,'policy':POLICY}
 def expire(signum,frame): raise TimeoutError('90-second total boundary contrast CPU deadline')
 signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()));save(out/'attempt.json',{'one_attempt':True,'seconds':90})
 try:
  rows,proof=load(root,deadline)
  if spec!=specification() or frozen_numeric['proof']!=proof: raise ValueError('Frozen boundary contrast contract/source/numeric identity differs')
  predictions={family:[None]*len(rows) for family in FAMILIES};folds=[]
  for tr,te in splits(rows,5):
   nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];settings,inner=inner_choice(train,deadline);model=fit(train,deadline);candidate=predict(model,test,deadline)
   if set(model['train_groups'])&{r['group'] for r in test}: raise ValueError('Outer channel leak')
   for family in FAMILIES:
    for i,row,value in zip(te,test,candidate[family]): predictions[family][i]=value if settings[family]['policy']=='argmax' else [row['detected_start'],row['detected_end']]
   folds.append({'train_groups':model['train_groups'],'test_groups':sorted({r['group'] for r in test}),'settings':settings,'inner_folds':inner,'training_pairs':model['pair_counts']});save(out/'partial_validation.json',{'complete':False,'completed_outer_folds':len(folds),'folds':folds,'predictions':predictions})
  original=[[r['detected_start'],r['detected_end']] for r in rows];identity=fc.metrics(rows,original);comparisons={}
  for family in FAMILIES:
   nb.check(deadline);metric=fc.metrics(rows,predictions[family]);boot=jw.channel_bootstrap(rows,predictions[family]);paired=pair_bootstrap(rows,predictions[family],original);boot['exact_zero_mass']=paired['exact_zero_mass'];boot['stable']=bool(boot['stable'] and paired['stable_gain']);comparisons[family]={'candidate':metric,'nominal_gate':jw.gate(identity,metric),'channel_bootstrap':boot,'passed_identity_gate':bool(jw.gate(identity,metric) and boot['stable'])}
  matched=pair_bootstrap(rows,predictions[FAMILIES[1]],predictions[FAMILIES[0]]);passed=bool(comparisons[FAMILIES[1]]['passed_identity_gate'] and matched['stable_gain']);nb.check(deadline)
  status={'status':'completed','policy':POLICY,'rows':21,'channels':10,'windows':1149,'identity':identity,'comparisons':comparisons,'matched_control_bootstrap':matched,'primary_validation_passed':passed,'enabled':False,'proof':proof,'folds':folds,'seconds':time.monotonic()-PROCESS_STARTED,'no_media_reads':True,'no_gpu_cloud_or_db_writes':True}
  save(out/'boundary_contrast_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predictions':{f:predictions[f][i] for f in FAMILIES}} for i,r in enumerate(rows)]})
 except TimeoutError as error: status.update(status='expired',error=str(error),seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 except Exception as error: status.update(status='failed',error=f'{type(error).__name__}: {error}',seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 finally: signal.setitimer(signal.ITIMER_REAL,0)
 save(out/'boundary_contrast_report.json',status);save(out/'boundary_contrast_envelope.json',{'schema_version':1,'kind':'boundary_contrast_span_preference','enabled':False,'fallback':'original_range','automatic_action':False,'validation_passed':bool(status.get('primary_validation_passed',False))});print(json.dumps({'status':status['status'],'rows':status.get('rows'),'channels':status.get('channels'),'seconds':status.get('seconds'),'primary_validation_passed':status.get('primary_validation_passed',False),'enabled':False,'error':status.get('error'),'metrics':{f:v['candidate'] for f,v in status.get('comparisons',{}).items()}}));return status

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['preregister','preflight','run']);p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();{'preregister':lambda:preregister(a.output),'preflight':lambda:preflight(a.root,a.output),'run':lambda:run(a.root,a.output)}[a.mode]()
