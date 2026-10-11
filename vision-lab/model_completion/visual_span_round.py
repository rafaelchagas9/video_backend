"""One preregistered visual-only interval-choice learner; training snapshots only."""
import time
PROCESS_STARTED=time.monotonic()
import argparse,collections,hashlib,json,os,signal
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','2');os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd
import fine_labels as fl
from cut_and_whole import splits
ROOT=Path(__file__).resolve().parents[1]/'data/model-completion-20261010'
OUT=ROOT/'completed-round-20261010/visual-span'
FEATURE_SHA='014b9a6c69e1d55eeff0f9af0daf2e3f3f7c33437255ee88d04cbf9c00099a98'
SPEC_SHA='b76a382318bf59c445a7de98c8fceb92457c5f6042f70a59a3e00ec41e708821'
FAMILIES=('visual_span_PCA8_geometry4_C1','zero8_geometry4_C1')

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def file_sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Single180s total CPU budget expired; no retry')
def save(path,value):
 data=json.dumps(value,sort_keys=True,allow_nan=False,indent=2).encode();path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as output:output.write(data);output.flush();os.fsync(output.fileno())

def grid(a,b,t,v):
 """<=128 label-independent endpoints; uniform coverage plus frozen visual changes."""
 t=np.asarray(t,float);v=np.asarray(v,float)
 if not 0<=a<b or t.ndim!=1 or v.ndim!=2 or len(t)!=len(v) or not len(t) or not np.isfinite(t).all() or not np.isfinite(v).all():raise ValueError('Invalid frame grid inputs')
 edges=np.unique(np.r_[a,b,np.clip(t,a,b),np.clip(t+5,a,b)])
 if len(edges)>128:
  chosen=set(np.linspace(0,len(edges)-1,64).astype(int).tolist());norm=np.linalg.norm(v,axis=1)
  if np.any(norm<1e-8):raise ValueError('Zero visual vector')
  unit=v/norm[:,None];changes=1-np.sum(unit[1:]*unit[:-1],axis=1)
  candidates=sorted(((float(-d),float(t[j+1])) for j,d in enumerate(changes) if a<t[j+1]<b))
  for _,edge in candidates:
   chosen.add(int(np.searchsorted(edges,edge)))
   if len(chosen)>=128:break
  # Sparse transition inputs may not cover all boundaries; deterministic remaining fill.
  for i in np.linspace(0,len(edges)-1,len(edges)).astype(int):
   if len(chosen)>=128:break
   chosen.add(int(i))
  edges=edges[sorted(chosen)]
 lo,hi=np.triu_indices(len(edges),1);valid=edges[hi]-edges[lo]>=min(5.,b-a)-1e-9
 spans=np.c_[edges[lo[valid]],edges[hi[valid]]]
 if len(spans)>8128 or not np.any(np.all(np.isclose(spans,[a,b],rtol=0,atol=1e-9),axis=1)):raise ValueError('Original missing or grid cap exceeded')
 return spans

def frame_row(meta,base,deadline,*,for_fit=True):
 check(deadline)
 if for_fit:fl.require_fit_scope([meta])
 elif meta.get('no_labels_accessed') is not True:raise ValueError('Evaluation adapter requires pre-answer metadata without labels')
 identity=meta['numeric_identity'];receipt=meta['frame_checkpoint'];path=(base/receipt['file']).resolve()
 if path.parent!= (base/'frames').resolve() or path.stat().st_dev!=base.stat().st_dev or file_sha(path)!=receipt['sha256'] or digest(identity)!=receipt['identity_sha256']:raise ValueError('Exact SSD numeric-frame receipt mismatch')
 for key in ('video_id','analyzed_at','index','source_fingerprint'):
  if identity[key]!=meta[key]:raise ValueError('Frame source/generation/index mismatch')
 with np.load(path,allow_pickle=False) as z:
  if str(z['identity_sha256'])!=receipt['identity_sha256']:raise ValueError('Frame checkpoint identity mismatch')
  times=np.asarray(z['t'],float);vectors=np.asarray(z['v'],float)
 if vectors.shape!=(meta['index']['frame_count'],1152) or times.shape!=(len(vectors),) or not np.isfinite(vectors).all() or not np.isfinite(times).all() or np.any(np.diff(times)<=0) or meta['index']['interval_seconds']!=5 or meta['index']['model_revision']!='siglip2/so400m-patch16-256':raise ValueError('Frame shape/model/cadence invalid')
 if not np.all(np.abs(np.linalg.norm(vectors,axis=1)-1)<.02):raise ValueError('Stored frame vectors not unit normalized')
 a,b=map(float,meta['original_range']);mask=(times<b)&(times+5>a);t=times[mask];v=vectors[mask]
 lo=np.maximum(t,a);hi=np.minimum(t+5,b)
 if not len(t) or lo[0]>a+.001 or hi[-1]<b-.001 or np.any(lo[1:]>hi[:-1]+.001) or np.any(hi<=lo):raise ValueError('Immutable original has incomplete5s frame coverage')
 original=digest({k:meta[k] for k in ('feedback_id','video_id','analyzed_at','original_range','source_fingerprint','index')})
 return {'original':original,'group':meta['group'],'a':a,'b':b,'t':t,'v':v,'lo':lo,'hi':hi,'grid':grid(a,b,t,v),'frame_sha256':receipt['sha256'],'reserved_fine_holdout':meta['reserved_fine_holdout'],'fine_data_role':meta['fine_data_role']}

def load(base,deadline):
 spec=ROOT/'completed-round-20261010/preregistered_methods.json'
 if file_sha(spec)!=SPEC_SHA:raise ValueError('Frozen methods preregistration changed')
 source=base/'feature_cohort.json'
 if file_sha(source)!=FEATURE_SHA:raise ValueError('Frozen training-only numeric cohort checksum differs')
 payload=json.loads(source.read_text())
 if payload['format']!='kura-new-round-training-features' or len(payload['rows'])!=48 or payload['policy']!=fl.POLICY:raise ValueError('Fixed training-only feature cohort differs')
 reserved=set(payload['reserved_creators_excluded']);fl.require_fit_scope(payload['rows'])
 if any(r['group'] in reserved for r in payload['rows']):raise ValueError('Reserved creator leaked into training')
 expected={'targeted-label-round':'427b2dea332252828071765d544aa361425cd5f2e1237deb7e232b92958daf79','connected-label-round':'fd396120017ba57d5c83467af0c326c6d3ea9132f41ab8a92cb6eca0ea4617dc'}
 if {x['batch']:x['answer_sha256'] for x in payload['answers']}!=expected:raise ValueError('Exact training-answer bindings differ')
 unique={};frame_cache={}
 for meta in payload['rows']:
  check(deadline);fl._checked(meta);gold=meta['cut_gold']
  if gold is None:continue
  key=digest({k:meta[k] for k in ('feedback_id','video_id','analyzed_at','original_range','source_fingerprint','index')})
  if key not in frame_cache:frame_cache[key]=frame_row(meta,base,deadline)
  row=dict(frame_cache[key]);g=[fl._number(gold['start_seconds']),fl._number(gold['end_seconds'])]
  if not row['a']<=g[0]<g[1]<=row['b']:raise ValueError('Training gold outside original')
  observation=digest([key,meta['offered_range'],g]);row.update(row=observation,gold=g,offered_range=meta['offered_range'])
  if observation in unique and unique[observation]['group']!=row['group']:raise ValueError('Original creator conflict')
  unique[observation]=row
 rows=[unique[k] for k in sorted(unique)];gold_by_original=collections.defaultdict(set)
 for row in rows:gold_by_original[row['original']].add(tuple(row['gold']))
 for row in rows:row['all_gold']=sorted(gold_by_original[row['original']])
 if len(rows)!=20 or len(frame_cache)!=19 or len({r['group'] for r in rows})!=12:raise ValueError('Fixed20cuts/19originals/12creators differ')
 return rows,{'feature_cohort_sha256':file_sha(source),'preregistration_sha256':SPEC_SHA,'frame_sha256':sorted({r['frame_sha256'] for r in rows}),'reserved_creators_excluded':len(reserved),'holdout_outcomes_accessed':False,'observations':20,'originals':19,'creators':12}

def projection(rows):
 fl.require_fit_scope(rows)
 unique={r['original']:r for r in rows};x=np.concatenate([r['v'] for r in unique.values()]);w=np.concatenate([(r['hi']-r['lo'])/np.sum(r['hi']-r['lo']) for r in unique.values()]);mean=np.average(x,axis=0,weights=w)
 if len(x)<=8:raise ValueError('Too few training frames for fixedPCA8')
 _,_,components=randomized_svd((x-mean)*np.sqrt(w/w.mean())[:,None],n_components=8,n_iter=3,random_state=29)
 return mean,components

def pooled(row,values,spans):
 spans=np.asarray(spans,float);edges,inverse=np.unique(spans.ravel(),return_inverse=True);width=row['hi']-row['lo'];occupancy=np.clip(edges[:,None]-row['lo'][None,:],0,width[None,:]);integral=occupancy@values;mass=occupancy.sum(1);lo,hi=inverse.reshape(-1,2).T;den=mass[hi]-mass[lo]
 if np.any(den<=0):raise ValueError('Span lacks numeric coverage')
 return (integral[hi]-integral[lo])/den[:,None]

def features(pre,row,spans):
 spans=np.asarray(spans,float);a,b=row['a'],row['b'];length=spans[:,1]-spans[:,0]
 if np.any(length<=0) or np.any(spans[:,0]<a-1e-9) or np.any(spans[:,1]>b+1e-9):raise ValueError('Illegal original interval')
 visual=pooled(row,(row['v']-pre[0])@pre[1].T,spans)
 return np.c_[visual,np.log(length),length/(b-a),(spans[:,0]-a)/(b-a),(spans[:,1]-a)/(b-a)]

def alternatives(row):
 spans=row['grid'][np.unique(np.linspace(0,len(row['grid'])-1,min(64,len(row['grid']))).astype(int))]
 valid=np.ones(len(spans),bool)
 for gold in row['all_gold']:valid&=~np.all(np.isclose(spans,gold,rtol=0,atol=1e-9),axis=1)
 return spans[valid]

def fit(rows,deadline):
 check(deadline);fl.require_fit_scope(rows);pre=projection(rows);x=[];y=[];w=[];counts=collections.Counter(r['original'] for r in rows)
 for row in rows:
  alt=alternatives(row)
  if not len(alt):raise ValueError('No non-gold fixed alternatives')
  difference=features(pre,row,[row['gold']])[0]-features(pre,row,alt);x.extend([difference,-difference]);y.extend([np.ones(len(alt),int),np.zeros(len(alt),int)]);w.extend([np.full(len(alt),1/(2*len(alt)*counts[row['original']]))]*2)
 x=np.concatenate(x);y=np.concatenate(y);w=np.concatenate(w);scale=StandardScaler(with_mean=False).fit(x,sample_weight=w);models={}
 for family in FAMILIES:
  check(deadline);values=x.copy()
  if family==FAMILIES[1]:values[:,:8]=0
  models[family]=LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=2000,random_state=29).fit(scale.transform(values),y,sample_weight=w)
 return {'pre':pre,'scale':scale,'models':models,'groups':sorted({r['group'] for r in rows}),'originals':sorted(counts)}

def best(row,scores):
 if len(scores)!=len(row['grid']) or not np.isfinite(scores).all():raise ValueError('Invalid span scores')
 tied=np.flatnonzero(np.abs(scores-np.max(scores))<=1e-10)
 i=max(tied,key=lambda i:(bool(np.allclose(row['grid'][i],[row['a'],row['b']],rtol=0,atol=1e-9)),row['grid'][i,1]-row['grid'][i,0],-row['grid'][i,0],-row['grid'][i,1]))
 return row['grid'][i].tolist()

def predict(model,rows,deadline):
 result={f:[] for f in FAMILIES};cached={}
 for row in rows:
  check(deadline)
  if row['original'] not in cached:
   x=model['scale'].transform(features(model['pre'],row,row['grid']));values={}
   for family in FAMILIES:
    z=x.copy()
    if family==FAMILIES[1]:z[:,:8]=0
    values[family]=best(row,model['models'][family].decision_function(z))
   cached[row['original']]=values
  for family in FAMILIES:result[family].append(cached[row['original']][family])
 return result

def per_creator(rows,pred):
 originals=collections.defaultdict(list);channels={}
 for row,p in zip(rows,pred):
  lo,hi=row['gold'];overlap=max(0,min(hi,p[1])-max(lo,p[0]));union=max(hi,p[1])-min(lo,p[0]);originals[row['original']].append([overlap/union,overlap/(hi-lo)]);channels[row['original']]=row['group']
 result=collections.defaultdict(list)
 for key,values in originals.items():result[channels[key]].append(np.mean(values,axis=0))
 return {key:np.mean(values,axis=0) for key,values in result.items()}

def metrics(rows,pred):
 by=per_creator(rows,pred);ret=[max(0,min(r['gold'][1],p[1])-max(r['gold'][0],p[0]))/(r['gold'][1]-r['gold'][0]) for r,p in zip(rows,pred)];short={r['original'] for r,p in zip(rows,pred) if (r['b']-r['a'])-(p[1]-p[0])>=5}
 return {'creator_macro_iou':float(np.mean([x[0] for x in by.values()])),'creator_macro_retained':float(np.mean([x[1] for x in by.values()])),'retention_p10':float(np.quantile(ret,.1)),'meaningfully_shortened_originals':len(short),'observations':len(rows),'originals':len({r['original'] for r in rows}),'creators':len(by)}

def identity(rows):return [[r['a'],r['b']] for r in rows]
def policies(rows,deadline):
 held={f:[None]*len(rows) for f in FAMILIES};receipts=[]
 for tr,te in splits(rows,3):
  train=[rows[i] for i in tr];test=[rows[i] for i in te];m=fit(train,deadline);p=predict(m,test,deadline)
  if set(m['groups'])&{r['group'] for r in test}:raise ValueError('Inner creator leakage')
  for f in FAMILIES:
   for i,value in zip(te,p[f]):held[f][i]=value
  receipts.append({'training_creators':len(m['groups']),'test_creators':len({r['group'] for r in test}),'training_originals':len(m['originals'])})
 base=metrics(rows,identity(rows));decision={}
 for f in FAMILIES:
  actual=metrics(rows,held[f]);decision[f]='argmax' if actual['creator_macro_iou']>base['creator_macro_iou'] and actual['creator_macro_retained']>=.97 and actual['retention_p10']>=.9 else 'identity'
 return decision,{'inner_argmax':{f:metrics(rows,held[f]) for f in FAMILIES},'inner_identity':base,'receipts':receipts}

def bootstrap(rows,pred,control):
 a=per_creator(rows,pred);b=per_creator(rows,identity(rows));c=per_creator(rows,control);keys=sorted(a);gain=np.array([a[k][0]-b[k][0] for k in keys]);ret=np.array([a[k][1] for k in keys]);relative=np.array([a[k][0]-c[k][0] for k in keys]);rng=np.random.default_rng(31);ids=rng.integers(0,len(keys),(5000,len(keys)));zero=float((np.sum(np.abs(gain)<=1e-12)/len(keys))**len(keys));relzero=float((np.sum(np.abs(relative)<=1e-12)/len(keys))**len(keys))
 return {'iou_gain_ci95':np.quantile(gain[ids].mean(1),[.025,.975]).tolist(),'retention_lower95':float(np.quantile(ret[ids].mean(1),.025)),'control_gain_ci95':np.quantile(relative[ids].mean(1),[.025,.975]).tolist(),'exact_zero_gain_mass':zero,'exact_zero_control_gain_mass':relzero,'channels':len(keys),'samples':5000}

def export(model,policy,receipts):
 return {'schema_version':1,'kind':'visual_structured_span_PCA8_C1','enabled':False,'pending_reserved_evaluation':True,'preregistration_sha256':SPEC_SHA,'input_domain':'full immutable original5s cached SigLIP1152','policy':policy,'max_endpoints':128,'max_spans':8128,'pca_mean':model['pre'][0].tolist(),'pca_components':model['pre'][1].tolist(),'numeric_scale':model['scale'].scale_.tolist(),'weights':model['models'][FAMILIES[0]].coef_[0].tolist(),'bias':0.,'score_tie_tolerance':1e-10,'max_duration_seconds':None,'fallback':'original_range','automatic_action':False,'receipts':receipts}

def run(base,out,seconds):
 deadline=PROCESS_STARTED+seconds
 def expired(*args):raise TimeoutError('Total180s process deadline expired; no retry')
 signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,max(.001,deadline-time.monotonic()))
 if out.exists():raise ValueError('No rerun or output overwrite allowed')
 out.mkdir(parents=True,mode=0o700)
 try:
  rows,receipts=load(base,deadline);held={f:[None]*len(rows) for f in FAMILIES};folds=[]
  for fold,(tr,te) in enumerate(splits(rows,5)):
   train=[rows[i] for i in tr];test=[rows[i] for i in te];decision,inner=policies(train,deadline);m=fit(train,deadline);p=predict(m,test,deadline)
   if set(m['groups'])&{r['group'] for r in test}:raise ValueError('Outer creator leakage')
   for f in FAMILIES:
    values=identity(test) if decision[f]=='identity' else p[f]
    for i,value in zip(te,values):held[f][i]=value
   folds.append({'fold':fold,'training_creators':len(m['groups']),'test_creators':len({r['group'] for r in test}),'policy':decision,'inner':inner})
   save(out/f'fold{fold}.json',folds[-1]);print(json.dumps({'completed_outer_folds':fold+1}),flush=True)
  base_metrics=metrics(rows,identity(rows));candidate={f:metrics(rows,held[f]) for f in FAMILIES};bounds=bootstrap(rows,held[FAMILIES[0]],held[FAMILIES[1]]);primary=candidate[FAMILIES[0]]
  nominal=primary['creator_macro_iou']>base_metrics['creator_macro_iou']+.02 and primary['creator_macro_retained']>=.97 and primary['retention_p10']>=.9 and primary['meaningfully_shortened_originals']>=3
  gate=nominal and bounds['iou_gain_ci95'][0]>0 and bounds['retention_lower95']>=.97 and bounds['control_gain_ci95'][0]>0 and bounds['exact_zero_gain_mass']<.025 and bounds['exact_zero_control_gain_mass']<.025
  final_policy,inner=policies(rows,deadline);final=fit(rows,deadline);check(deadline);envelope=export(final,final_policy[FAMILIES[0]],receipts);save(out/'candidate.json',envelope)
  predictions=[{'row':r['row'],'original':r['original'],'group':r['group'],'original_range':[r['a'],r['b']],'gold':r['gold'],**{f:held[f][i] for f in FAMILIES}} for i,r in enumerate(rows)]
  save(out/'predictions.json',predictions);report={'status':'training_only_complete','source_sha256':file_sha(__file__),'candidate_sha256':file_sha(out/'candidate.json'),'receipts':receipts,'identity':base_metrics,'comparisons':candidate,'bootstrap':bounds,'training_nominal_gate':bool(nominal),'training_full_gate':bool(gate),'folds':folds,'final_policy':final_policy,'final_inner':inner,'enabled':False,'reserved_outcomes_accessed':False,'elapsed_seconds':time.monotonic()-PROCESS_STARTED,'domain':'Immutable original to saved interval preference; omitted material not bad','production_changed':False};save(out/'report.json',report);print(json.dumps({'status':report['status'],'training_full_gate':bool(gate),'elapsed_seconds':round(report['elapsed_seconds'],2)}))
 except Exception as error:
  save(out/'failure.json',{'status':'failed_or_expired_no_retry','error_type':type(error).__name__,'error':str(error),'elapsed_seconds':time.monotonic()-PROCESS_STARTED,'reserved_outcomes_accessed':False,'production_changed':False});raise
 finally:signal.setitimer(signal.ITIMER_REAL,0)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--features',type=Path,default=ROOT/'new-round-training');parser.add_argument('--output',type=Path,default=OUT);parser.add_argument('--seconds',type=int,default=180);a=parser.parse_args()
 if a.seconds!=180:parser.error('Fixed total180s budget only')
 run(a.features,a.output,a.seconds)
