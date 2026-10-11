"""One fixed sound-event complement to pooled span preference; numeric inputs only."""
from __future__ import annotations
import argparse, hashlib, inspect, json, signal, time
PROCESS_STARTED = time.monotonic()
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd
import clap_original_audio as clap
import structured_span_preference as spans
import frame_cuts as fc
import joint_window_boundaries as jw
import nonlinear_boundary as nb
from cut_and_whole import save, splits
from pixel_temporal_boundaries import pair_bootstrap

FAMILIES = ['span_zero_clap_C1', 'span_clap16_C1']
POLICY = {
 'primary': FAMILIES[1], 'control': FAMILIES[0], 'C': 1., 'seconds': 90,
 'cohort': 'Exactly the same21 immutable complete originals/10channels/1149 windows; same5 incomplete exclusions; no partial CLAP checkpoints or target-conditioned inclusion',
 'target': 'Saved selected interval preferred to label-independent alternative spans; omitted material absolute quality is unknown; no outside-bad labels',
 'hypothesis': 'Sound-event CLAP may complement Gemma semantic audio for interval preference; no dimension or head grid',
 'model_pin': clap.PIN, 'recipe': clap.RECIPE,
 'audio_input': 'Exact existing20s mono16k stage windows; polyphase48k upsample, two10s512 CLAP unit vectors, mean then unit-normalize. Upsampling adds no original content above8kHz',
 'features': 'Existing28(Gemma PCA16+SigLIP PCA8+4geometry) followed by CLAP PCA16 =44; same overlap pooling for both audio models; control zeros only final16 features',
 'pca': 'Training-original windows only, every original total1; weighted mean/randomizedSVD,n_iter3,seed29. Fixed16 Gemma,8 SigLIP,16 CLAP; never gold-conditioned',
 'training': 'C1 liblinear symmetric gold-minus-alternative logistic, no intercept/class_weight,max_iter2000,seed29; each fine original total80 signed weight; same weighted StandardScaler(with_mean=False) fitted on all44 trainpairfeatures for both heads',
 'candidates': spans.POLICY['candidates'], 'alternatives': spans.POLICY['alternatives'], 'tie': spans.POLICY['decision'],
 'folds': 'Same outer5/inner3 whole channels; all PCA/scaling/head/policy selection inside current training fold',
 'selection': 'Each family selects identity vsargmax inner only; argmax requires macroIoU>identity,macroretention>=.97,p10>=.9',
 'gate': spans.POLICY['gate'],
 'limits': 'One90s CPU attempt including imports/loading/evaluation; no retries/tuning/media/GPU/cloud/DB/labels; envelope disabled until independent audit/runtime parity',
 'pooling_limitation': spans.POLICY['pooling_limitation'], 'coarse_prior': 'None: independent coarse preference trial failed; no stacking or selection from its outcomes'
}


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def freeze(path, value):
 path = Path(path)
 if path.exists():
  if json.loads(path.read_text()) != value: raise ValueError('Immutable CLAP span preregistration differs')
 else: save(path, value)


def projection(rows):
 pre = {}; weights = np.concatenate([np.full(len(r['offsets']),1/len(r['offsets'])) for r in rows])
 for family, count in [('audio',16),('siglip',8),('clap',16)]:
  X = np.concatenate([r['arrays'][family] for r in rows]); mean = np.average(X, axis=0, weights=weights)
  if len(X) <= count or X.shape[1] < count or not np.isfinite(X).all(): raise ValueError('Insufficient/nonfinite training PCA input')
  _,_,components = randomized_svd((X-mean)*np.sqrt(weights/weights.mean())[:,None],n_components=count,n_iter=3,random_state=29)
  pre[family] = (mean, components)
 return pre


def features(pre, row, intervals):
 existing = spans.features(pre,row,intervals); mean,components = pre['clap']
 projected = (row['arrays']['clap']-mean)@components.T
 return np.c_[existing,spans.overlap_pool(row['offsets'],projected,intervals)]


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


def checkpoint_receipt(path, row, stage, receipt_sha, root):
 before=path.stat()
 if path.is_symlink() or before.st_dev!=root.stat().st_dev: raise ValueError('CLAP numeric checkpoint must be regular same-SSD file')
 values=clap.validate_checkpoint(path,stage,receipt_sha,require_complete=True)
 with np.load(path,allow_pickle=False) as z:
  expected={'receipt_sha256':receipt_sha,'staged_audio_sha256':stage['cache_sha256'],'alignment':stage['alignment'],'absolute_start':row['detected_start'],'duration':row['detected_end']-row['detected_start'],'source_rate':16000,'input_rate':48000}
  for key,value in expected.items():
   if np.asarray(z[key]).ndim!=0 or z[key].item()!=value: raise ValueError('CLAP checkpoint range/source/sample identity mismatch')
  if not np.array_equal(z['source_fingerprint'],stage['source_fingerprint']) or not np.array_equal(z['offsets'],row['offsets']): raise ValueError('CLAP checkpoint source/offset mismatch')
 digest=sha(path);after=path.stat()
 if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns): raise ValueError('CLAP numeric checkpoint changed')
 return values,{'row':row['row'],'sha256':digest,'bytes':before.st_size,'mtime_ns':before.st_mtime_ns,'identity_sha256':clap.identity_sha(stage,receipt_sha),'windows':len(values)}


def load(root,deadline):
 rows,excluded,hashes=spans.load(root,deadline)
 receipt_path=root/'joint-gemma/audio_reuse_manifest.json';numeric_path=root/'joint-gemma/dense-original-audio/numeric_manifest.json';manifest_path=root/'joint-gemma/dense-original-clap/numeric_manifest.json'
 for path in (receipt_path,numeric_path,manifest_path): hashes[str(path.relative_to(root))]=sha(path)
 receipt=json.loads(receipt_path.read_text());numeric=json.loads(numeric_path.read_text());manifest=json.loads(manifest_path.read_text());receipt_sha=hashes[str(receipt_path.relative_to(root))]
 stages,_=clap.validate_metadata(receipt,numeric);stage_by={r['row']:r for r in stages};by={r['row']:r for r in manifest['rows']}
 if manifest.get('recipe')!=clap.RECIPE or manifest.get('revision')!=clap.PIN or manifest.get('receipt_sha256')!=receipt_sha or manifest.get('window_seconds')!=20 or manifest.get('offset_unit')!='absolute media seconds': raise ValueError('CLAP numeric manifest recipe/model mismatch')
 if len(manifest['rows'])!=21 or set(by)!={r['row'] for r in rows}: raise ValueError('CLAP numeric manifest incomplete/duplicate/cohort mismatch')
 receipts=[]
 for row in rows:
  nb.check(deadline);stage=stage_by[row['row']];entry=by[row['row']]
  expected={'group':row['group'],'original_start':row['detected_start'],'original_end':row['detected_end'],'complete_original_coverage':True,'identity_sha256':clap.identity_sha(stage,receipt_sha),'staged_audio_sha256':stage['cache_sha256'],'source_fingerprint':stage['source_fingerprint'],'offsets':row['offsets'].tolist()}
  if any(entry.get(k)!=v for k,v in expected.items()): raise ValueError('CLAP manifest original generation/range/window mismatch')
  path=root/'joint-gemma/dense-original-clap/embeddings'/f"{row['row']}.npz";values,proof=checkpoint_receipt(path,row,stage,receipt_sha,root)
  row['arrays']['clap']=values;receipts.append(proof)
 if sum(r['windows'] for r in receipts)!=1149: raise ValueError('CLAP fixed window count changed')
 sources=[Path(__file__),Path(clap.__file__),Path(spans.__file__),Path(spans.da.__file__),Path(fc.__file__),Path(jw.__file__),Path(nb.__file__),Path(spans.raw.__file__),Path(inspect.getsourcefile(save)),Path(inspect.getsourcefile(pair_bootstrap))]
 for path in sources: hashes[str(path)]=sha(path)
 for path in (receipt_path,numeric_path,manifest_path):
  if sha(path)!=hashes[str(path.relative_to(root))]: raise ValueError('Frozen CLAP metadata changed')
 return rows,{'source_and_metadata_sha256':hashes,'clap_checkpoints':receipts,'excluded':excluded,'rows':21,'channels':10,'windows':1149,'fine_rows':[r['row'] for r in rows],'fine_groups':sorted({r['group'] for r in rows})}


def specification():
 # Can freeze before extraction completes: source/contract only, no private input access or fits.
 import task_generation_inputs as historical
 sources=[Path(__file__),Path(__file__).with_name('clap_span_preference_test.py'),Path(clap.__file__),Path(clap.aw.__file__),Path(spans.__file__),Path(spans.da.__file__),Path(fc.__file__),Path(jw.__file__),Path(nb.__file__),Path(spans.raw.__file__),Path(historical.__file__),Path(historical.archive.__file__),Path(historical.snapshots.__file__),Path(inspect.getsourcefile(save)),Path(inspect.getsourcefile(pair_bootstrap))]
 return {'policy':POLICY,'source_sha256':{str(path):sha(path) for path in sources},'no_fits':True,'execution_requires':'Independent source and complete numeric preflight audit; separate explicit authorization for sole90sCPU run'}


def preregister(out):
 freeze(out/'preregistered.json',specification());print(json.dumps({'preregistered':True,'dimensions':44,'no_fits':True}))


def preflight(root,out):
 if json.loads((out/'preregistered.json').read_text())!=specification(): raise ValueError('Fixed CLAP source/preregistration changed')
 rows,proof=load(root,time.monotonic()+30);folds=[]
 for tr,te in splits(rows,5):
  train=[rows[i] for i in tr];folds.append({'train_groups':sorted({r['group'] for r in train}),'test_groups':sorted({rows[i]['group'] for i in te}),'inner':[{'train_groups':sorted({train[i]['group'] for i in itr}),'test_groups':sorted({train[i]['group'] for i in ite})} for itr,ite in splits(train,3)]})
 freeze(out/'numeric_preflight.json',{'proof':proof,'folds':folds,'no_fits':True});print(json.dumps({'preflight':'ready','rows':21,'channels':10,'windows':1149,'no_fits':True}))


def run(root,out):
 if (out/'attempt.json').exists() or (out/'clap_span_report.json').exists(): raise ValueError('One attempt only; historical output immutable')
 spec=json.loads((out/'preregistered.json').read_text());frozen_numeric=json.loads((out/'numeric_preflight.json').read_text());deadline=PROCESS_STARTED+90;status={'status':'failed','enabled':False,'policy':POLICY}
 def expire(signum,frame): raise TimeoutError('90-second total CLAP CPU deadline')
 signal.signal(signal.SIGALRM,expire);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()));save(out/'attempt.json',{'one_attempt':True,'seconds':90})
 try:
  rows,proof=load(root,deadline)
  if spec!=specification() or frozen_numeric['proof']!=proof: raise ValueError('Frozen CLAP contract/source/numeric identity differs')
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
  save(out/'clap_span_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predictions':{f:predictions[f][i] for f in FAMILIES}} for i,r in enumerate(rows)]})
 except TimeoutError as error: status.update(status='expired',error=str(error),seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 except Exception as error: status.update(status='failed',error=f'{type(error).__name__}: {error}',seconds=time.monotonic()-PROCESS_STARTED,no_rerun=True)
 finally: signal.setitimer(signal.ITIMER_REAL,0)
 save(out/'clap_span_report.json',status);save(out/'clap_span_envelope.json',{'schema_version':1,'kind':'clap_pooled_span_preference','enabled':False,'fallback':'original_range','automatic_action':False,'validation_passed':bool(status.get('primary_validation_passed',False))});print(json.dumps({'status':status['status'],'rows':status.get('rows'),'channels':status.get('channels'),'seconds':status.get('seconds'),'primary_validation_passed':status.get('primary_validation_passed',False),'enabled':False,'error':status.get('error'),'metrics':{f:v['candidate'] for f,v in status.get('comparisons',{}).items()}}));return status

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['preregister','preflight','run']);p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();{'preregister':lambda:preregister(a.output),'preflight':lambda:preflight(a.root,a.output),'run':lambda:run(a.root,a.output)}[a.mode]()
