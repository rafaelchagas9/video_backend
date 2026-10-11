"""Second bounded iteration: content vectors with train-only PCA and portable linear weights."""
from __future__ import annotations
import json,sys,time,warnings,hashlib
from pathlib import Path
import numpy as np
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score,brier_score_loss
from sklearn.exceptions import ConvergenceWarning
sys.path.insert(0,str(Path(__file__).resolve().parent))
import prepare as p
import rank as r
ROOT=p.ROOT
SPECS=[(k,n) for k in ('point','pair') for n in (8,32)]
CS=[.1,1.,10.]

def vectors(rows):
 out=[];cache={}
 for row in rows:
  vid=row['video_id']
  if vid not in cache:
   path=ROOT/'frames'/f'{vid}.npz'
   if path.exists():
    with np.load(path) as z:cache[vid]=(z['t'],p.unit(z['v'].astype(np.float64)))
   else:cache[vid]=None
  found=cache[vid]
  if found:
   t,v=found;seg=v[(t>=row['detected_start'])&(t<=row['detected_end'])];mean=p.unit(seg.mean(0)) if len(seg) else np.zeros(1152)
  else:mean=np.zeros(1152)
  out.append(mean)
 return np.array(out)

class Visual:
 def __init__(self,kind,n,C):self.kind=kind;self.n=n;self.C=C
 def fit(self,rows,X,V):
  self.pca=PCA(n_components=min(self.n,len(rows)-1),svd_solver='randomized',random_state=42).fit(V)
  self.scaler=StandardScaler().fit(np.c_[X,self.pca.transform(V)]);Z=self.scaler.transform(np.c_[X,self.pca.transform(V)]);y=np.array([row['y'] for row in rows])
  if self.kind=='point':
   counts={v:sum(row['video_id']==v for row in rows) for v in {row['video_id'] for row in rows}};w=np.array([1./counts[row['video_id']] for row in rows]);w*=len(w)/w.sum()
   self.model=LogisticRegression(C=self.C,solver='liblinear',max_iter=5000,tol=1e-6).fit(Z,y,sample_weight=w)
  else:
   pp=r.pairs(rows);d=np.array([Z[k]-Z[s] for k,s,w in pp]);w=np.array([w for k,s,w in pp]);w*=len(w)/w.sum()
   self.model=LogisticRegression(C=self.C,solver='liblinear',fit_intercept=False,max_iter=5000,tol=1e-6).fit(np.r_[d,-d],np.r_[np.ones(len(d)),np.zeros(len(d))],sample_weight=np.r_[w,w])
  return self
 def predict(self,X,V):return self.model.decision_function(self.scaler.transform(np.c_[X,self.pca.transform(V)]))
 def export(self,gate):
  coeff=self.model.coef_[0]/self.scaler.scale_;vis=coeff[13:]@self.pca.components_;bias=float(self.model.intercept_[0]-coeff@self.scaler.mean_-vis@self.pca.mean_)
  return {'weights':coeff[:13].tolist(),'bias':bias,'gate_passed':gate,'visual_weights':vis.tolist(),'spec':f'visual_{self.kind}_pca{self.n}','visual_recipe':'normalized_mean_original_proposal_frames'}

def select(rows,X,V,nfold):
 trials=[]
 for kind,n in SPECS:
  for C in CS:
   out=np.full(len(rows),np.nan)
   for tr,te in r.splits(rows,nfold):out[te]=Visual(kind,n,C).fit([rows[i] for i in tr],X[tr],V[tr]).predict(X[te],V[te])
   m=r.metrics(rows,out);trials.append((m['recording_macro_pair_accuracy'],m['top1'],kind,n,C))
 win=max(trials,key=lambda x:(x[0],x[1],-x[3],-x[4]));return win[2:],trials

def main():
 start=time.monotonic();payload=json.loads((ROOT/'cohort.json').read_text());rows=[row for row in payload['rows'] if row['has_original_edges']];X=np.array([row['features'] for row in rows]);V=vectors(rows);assert V.shape==(len(rows),1152) and np.isfinite(V).all()
 save=p.save;save(ROOT/'visual_spec.json',{'PCA':[8,32],'C':CS,'modes':['point','pair'],'fit':'PCA and scaling inside training channels only','selection':'nested3inner5outer, macrorecording pair then top1','gate':'>=.02macroabovefittedbase,top1no worse,recall@2noworse,channelbootstraplower>-.02','snapshot_sha256':hashlib.sha256((ROOT/'cohort.json').read_bytes()).hexdigest(),'iteration':'same saved corpus as prior numeric run; exploratory repeated experiments'})
 nested=np.full(len(rows),np.nan);accept=np.full(len(rows),np.nan);base=np.full(len(rows),np.nan);folds=[]
 with warnings.catch_warnings():
  warnings.simplefilter('error',ConvergenceWarning)
  for f,(tr,te) in enumerate(r.splits(rows,5)):
   tt=[rows[i] for i in tr];(kind,n,C),_ =select(tt,X[tr],V[tr],3);nested[te]=Visual(kind,n,C).fit(tt,X[tr],V[tr]).predict(X[te],V[te]);accept[te]=Visual('point',8,.1).fit(tt,X[tr],V[tr]).predict(X[te],V[te]);base[te]=r.Model(('base','point',[0,1]),1.).fit(tt,X[tr]).predict(X[te]);folds.append({'fold':f,'kind':kind,'pca':n,'C':C});print(json.dumps({'visual_outer_fold_done':f+1,'seconds':round(time.monotonic()-start,1)}),flush=True)
  candidate=r.metrics(rows,nested);baseline=r.metrics(rows,base);diff=r.cluster_difference(candidate,baseline)
  gate=bool(candidate['recording_macro_pair_accuracy']>=baseline['recording_macro_pair_accuracy']+.02 and candidate['top1']>=baseline['top1'] and candidate['keeper_recall_at_k'][1]>=baseline['keeper_recall_at_k'][1] and diff['channel_bootstrap_95'][0]>-.02)
  (kind,n,C),trials=select(rows,X,V,5);final=Visual(kind,n,C).fit(rows,X,V);classifier=Visual('point',8,.1).fit(rows,X,V)
  y=np.array([row['y'] for row in rows]);probs=1/(1+np.exp(-accept));bprobs=1/(1+np.exp(-base));ag=bool(roc_auc_score(y,accept)>=roc_auc_score(y,base)+.015 and brier_score_loss(y,probs)<=brier_score_loss(y,bprobs))
  report={'rows':len(rows),'channels':len({row['group'] for row in rows}),'selected':{'kind':kind,'pca':n,'C':C},'candidate':candidate,'baseline':baseline,'difference':diff,'gate_passed':gate,'acceptance':{'auroc':float(roc_auc_score(y,accept)),'baseline_auroc':float(roc_auc_score(y,base)),'brier':float(brier_score_loss(y,probs)),'baseline_brier':float(brier_score_loss(y,bprobs)),'gate_passed':ag},'folds':folds,'seconds':round(time.monotonic()-start,1)}
  save(ROOT/'visual_report.json',report);save(ROOT/'visual_candidate.json',{'triage':final.export(gate),'acceptance':classifier.export(ag)});save(ROOT/'visual_predictions.json',{'rows':[row['row'] for row in rows],'final':final.predict(X,V).tolist(),'oof':nested.tolist(),'acceptance':accept.tolist(),'features':X.tolist(),'vectors':V.tolist()})
  print(json.dumps({k:v for k,v in report.items() if k not in ('candidate','baseline','folds')},allow_nan=False),flush=True)
  print(json.dumps({'candidate':{k:v for k,v in candidate.items() if k!='recordings'},'baseline':{k:v for k,v in baseline.items() if k!='recordings'}}),flush=True)
if __name__=='__main__':main()
