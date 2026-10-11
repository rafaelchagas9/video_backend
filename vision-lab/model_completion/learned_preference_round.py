"""Fixed offered-clip preference experiment. Never substitutes original-range labels.

Creator-blocked folds remove a whole comparison if either participant is held out.
Reserved answers can be evaluated only against an already frozen candidate bundle.
"""
from __future__ import annotations
import argparse,collections,hashlib,json,math,os,time
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
import numpy as np
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
import fine_labels as fl

SPEC={'schema_version':1,'target':'relative_full_offered_clip_preference','judgment_scope':'User watched beyond15s whenever needed; both A/B sides stay current candidates','candidate':'numeric13_plus_training_PCA8_offered_SigLIP_mean','control':'identical_numeric13_plus_zero8','C':1.0,'fit_intercept':False,'PCA_components':8,'random_seed':42,'training':'Only explicit A/B edges; each comparison total weight1 across signed symmetric logistic loss; PCA distinct training offered versions; scaler training symmetric differences', 'visual_sampling':'Mean of unit point-frame vectors whose timestamps are inclusively inside exact offered bounds; no overlap extrapolation','folds':'Leave one creator out; remove entire training pair when EITHER creator is held out; cross pairs may be evaluated twice, report unique decision count separately','gate':{'minimum_strict_pairs':12,'minimum_creator_folds':6,'minimum_macro_accuracy':.75,'minimum_macro_gain':.05,'creator_macro_bootstrap_lower':0.0},'reserved_gate':{'minimum_strict_pairs':3,'minimum_accuracy':.75,'candidate_no_worse_than_numeric':True},'scope':'Offered ranges only; no promotion to original proposals without matched validation; no calibrated acceptance, deletion or whole-recording target','audio':'No unmatched audio included','budget_seconds':180}

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def frozen(path,value):
 path=Path(path);data=json.dumps(value,sort_keys=True,indent=2,allow_nan=False).encode()
 if path.exists():
  if path.read_bytes()!=data:raise ValueError('Immutable preference artifact differs')
  return
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700)
 with path.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 path.chmod(0o600)
def check(deadline):
 if time.monotonic()>deadline:raise TimeoutError('Bounded preference fit expired')
def node_key(row):
 return hashlib.sha256(json.dumps([row['feedback_id'],row['video_id'],row['analyzed_at'],row['offered_range'],row['source_fingerprint'],row['index']],sort_keys=True,separators=(',',':')).encode()).hexdigest()
def validated(rows,reserved,for_fit=True):
 rows=list(rows);reserved=set(reserved)
 if for_fit:fl.require_fit_scope(rows,'offered preference model fitting')
 identities=set();nodes={};by=collections.defaultdict(list)
 for row in rows:
  if for_fit and row['group'] in reserved:raise ValueError('Reserved creator cannot fit preference model')
  fl._checked(row)
  identity=(row['task_id'],row['side'])
  if identity in identities:raise ValueError('Duplicate comparison side')
  identities.add(identity);x=np.asarray(row['features'],float);v=np.asarray(row['visual_mean'],float)
  if x.shape!=(13,) or v.shape!=(1152,) or not np.isfinite(x).all() or not np.isfinite(v).all() or abs(np.linalg.norm(v)-1)>.02:raise ValueError('Invalid exact offered numeric/visual inputs')
  a,b=row['offered_range'];lo,hi=row['original_range']
  if not 0<=lo<=a<b<=hi or abs(row['start']-a)>.001 or abs(row['end']-b)>.001:raise ValueError('Exact offered range mismatch')
  key=node_key(row);value=(row['group'],x,v)
  if key in nodes and (nodes[key][0]!=value[0] or not np.array_equal(nodes[key][1],x) or not np.array_equal(nodes[key][2],v)):raise ValueError('Exact offered node input conflict')
  nodes[key]=value;by[row['task_id']].append(row)
 pairs=[]
 for tid,rr in sorted(by.items()):
  if len(rr)!=2 or {r['side'] for r in rr}!={'a','b'} or len({r['answer'] for r in rr})!=1:raise ValueError('Complete matching comparison required')
  rr.sort(key=lambda r:r['side']);answer=rr[0]['answer'];ys=[r['ranking_y'] for r in rr]
  if answer in ('both','neither'):
   if ys!=[None,None]:raise ValueError('No-clear-winner cannot become a draw loss')
   continue
  if answer not in ('a','b') or set(ys)!={0,1} or any(r['current_acceptability_y']!=1 for r in rr):raise ValueError('Strict preference/acceptance contract differs')
  if any(r['ranking_y']!=int(answer==r['side']) for r in rr):raise ValueError('Exact answer/side ranking direction differs')
  winner=next(r for r in rr if r['ranking_y']==1);loser=next(r for r in rr if r['ranking_y']==0)
  pairs.append({'task_id':tid,'winner':node_key(winner),'loser':node_key(loser),'creators':sorted({r['group'] for r in rr})})
 return nodes,pairs

class Fit:
 def fit(self,nodes,pairs):
  keys=sorted({p[k] for p in pairs for k in ('winner','loser')})
  if len(keys)<9 or not pairs:raise ValueError('Insufficient distinct training nodes for fixed PCA8')
  self.keys=keys;self.groups=sorted({nodes[k][0] for k in keys});X=np.asarray([nodes[k][1] for k in keys]);V=np.asarray([nodes[k][2] for k in keys]);self.pca=PCA(n_components=8,svd_solver='full').fit(V);z_primary=np.c_[X,self.pca.transform(V)];index={k:i for i,k in enumerate(keys)};d_primary=np.asarray([z_primary[index[p['winner']]]-z_primary[index[p['loser']]] for p in pairs]);self.scale=StandardScaler().fit(np.r_[d_primary,-d_primary])
  self.models={}
  for kind in ('visual','numeric'):
   z=np.c_[X,self.pca.transform(V)]
   if kind=='numeric':z[:,13:]=0
   z=self.scale.transform(z);index={k:i for i,k in enumerate(keys)};d=np.asarray([z[index[p['winner']]]-z[index[p['loser']]] for p in pairs])
   self.models[kind]=LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',max_iter=5000,tol=1e-9,random_state=42).fit(np.r_[d,-d],np.r_[np.ones(len(d)),np.zeros(len(d))],sample_weight=np.full(2*len(d),.5))
  return self
 def score(self,nodes,kind):
  keys=sorted(nodes);X=np.asarray([nodes[k][1] for k in keys]);V=np.asarray([nodes[k][2] for k in keys]);z=np.c_[X,self.pca.transform(V)]
  if kind=='numeric':z[:,13:]=0
  values=self.models[kind].decision_function(self.scale.transform(z));return dict(zip(keys,map(float,values)))
 def export(self,kind):
  raw=self.models[kind].coef_[0]/self.scale.scale_;vw=raw[13:]@self.pca.components_ if kind=='visual' else np.zeros(1152)
  bias=-float(raw@self.scale.mean_+vw@self.pca.mean_)
  return {'schema_version':1,'kind':'offered_clip_preference_linear','numeric_weights':raw[:13].tolist(),'visual_weights':vw.tolist(),'bias':bias,'visual_recipe':'unit_mean_unit_frames_inside_exact_offered_range','feature_recipe':'recording-v1-replace_exact_offered_proposal','target':'relative_full_offered_clip_preference','probability_calibrated':False,'automatic_action':False}

def portable_score(head,nodes):
 return {k:float(head['bias']+np.dot(head['numeric_weights'],value[1])+np.dot(head['visual_weights'],value[2])) for k,value in nodes.items()}
def margins(pairs,scores):return {p['task_id']:scores[p['winner']]-scores[p['loser']] for p in pairs}
def accuracy(values):return float(np.mean([float(v>1e-10)+.5*float(abs(v)<=1e-10) for v in values])) if values else None

def fit_round(cohort,out):
 start=time.monotonic();deadline=start+180;data=json.loads(Path(cohort).read_text());rows=data['rows'];reserved=data['reserved_creators_excluded'];nodes,pairs=validated(rows,reserved)
 spec=dict(SPEC,cohort_sha256=sha(cohort),source_sha256=sha(__file__),methods_preregistered_sha256=sha(Path(cohort).parent.parent/'completed-round-20261010/preregistered_methods.json'));frozen(out/'preregistered.json',spec)
 groups=sorted({g for p in pairs for g in p['creators']});folds=[];unique=collections.defaultdict(lambda:collections.defaultdict(list))
 for group in groups:
  check(deadline);train=[p for p in pairs if group not in p['creators']];test=[p for p in pairs if group in p['creators']];model=Fit().fit(nodes,train)
  if group in model.groups:raise ValueError('Held creator entered PCA/scaler/model fitting')
  results={}
  for kind in ('visual','numeric'):
   m=margins(test,model.score(nodes,kind));results[kind]={'accuracy':accuracy(list(m.values())),'margins':m}
   for tid,value in m.items():unique[tid][kind].append(value)
  folds.append({'held_creator':group,'training_pairs':len(train),'testing_pairs':len(test),'train_nodes':model.keys,'train_creators':model.groups,'results':results})
 delta=np.asarray([f['results']['visual']['accuracy']-f['results']['numeric']['accuracy'] for f in folds]);rng=np.random.default_rng(42);boot=np.mean(rng.choice(delta,size=(2000,len(delta)),replace=True),axis=1);ci=np.quantile(boot,[.025,.975]).tolist()
 macro={kind:float(np.mean([f['results'][kind]['accuracy'] for f in folds])) for kind in ('visual','numeric')};unique_accuracy={kind:accuracy([float(np.mean(v[kind])) for v in unique.values()]) for kind in ('visual','numeric')}
 gate=bool(len(pairs)>=12 and len(groups)>=6 and macro['visual']>=.75 and macro['visual']-macro['numeric']>=.05 and ci[0]>0)
 final=Fit().fit(nodes,pairs);heads={kind:final.export(kind) for kind in ('visual','numeric')}
 for kind,head in heads.items():
  expected=final.score(nodes,kind);got=portable_score(head,nodes)
  if max(abs(expected[k]-got[k]) for k in nodes)>1e-7:raise ValueError('Portable offered score parity failed')
 report={'strict_unique_pairs':len(pairs),'distinct_offered_nodes':len(nodes),'creator_folds':len(groups),'macro_accuracy':macro,'unique_pair_accuracy':unique_accuracy,'macro_gain':float(delta.mean()),'creator_macro_bootstrap_95':ci,'bootstrap_limit':'Creator-blocked CV folds share training data; cross decisions occur in two folds, unique count remains explicit','gate_passed':gate,'folds':folds,'seconds':time.monotonic()-start,'holdout_opened':False,'production_changed':False}
 bundle={'schema_version':1,'preregistered_sha256':sha(out/'preregistered.json'),'cohort_sha256':sha(cohort),'fit_source_sha256':sha(__file__),'training_gate_passed':gate,'heads':heads,'training_creators':groups,'reserved_creators':reserved,'inference_scope':'Exact offered ranges only; not original proposals','report_sha256':None}
 frozen(out/'training_report.json',report);bundle['report_sha256']=sha(out/'training_report.json');frozen(out/'frozen_candidate.json',bundle)
 print(json.dumps({k:report[k] for k in ('strict_unique_pairs','distinct_offered_nodes','creator_folds','macro_accuracy','unique_pair_accuracy','macro_gain','creator_macro_bootstrap_95','gate_passed','seconds','holdout_opened')}))
 return report

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();fit_round(a.cohort,a.out)
