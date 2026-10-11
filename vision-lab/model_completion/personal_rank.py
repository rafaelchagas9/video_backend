"""Known-channel personalization, trained without a query recording's own labels."""
import json,sys,time
from pathlib import Path
import numpy as np
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
sys.path.insert(0,str(Path(__file__).resolve().parent))
import rank as r
from prepare import ROOT,save,unit

def features(training,T,V,query,Q,W):
 out=[]
 for row,x,v in zip(query,Q,W):
  ix=[i for i,t in enumerate(training) if t['group']==row['group'] and t['video_id']!=row['video_id'] and not t['keep_whole']]
  keep=[i for i in ix if training[i]['y']];skip=[i for i in ix if not training[i]['y']]
  # Shrink small prototypes; missing preference is zero, never inferred from held-out labels.
  sims=[float(v@unit(V[ids].mean(0)))*len(ids)/(len(ids)+3) if ids else 0. for ids in (keep,skip)]
  out.append(np.r_[x,sims,sims[0]-sims[1],float(bool(keep) and bool(skip))])
 return np.array(out)

def fit_predict(rows,X,V,query,Q,W,C):
 Z=features(rows,X,V,rows,X,V);z=features(rows,X,V,query,Q,W);scale=StandardScaler().fit(Z)
 counts={v:sum(t['video_id']==v for t in rows) for v in {t['video_id'] for t in rows}};weight=np.array([1/counts[t['video_id']] for t in rows]);weight*=len(weight)/sum(weight)
 model=LogisticRegression(C=C,solver='liblinear',max_iter=5000).fit(scale.transform(Z),[t['y'] for t in rows],sample_weight=weight)
 return model.decision_function(scale.transform(z)),z[:,-1]>0

def folds(rows,n=4):return GroupKFold(min(n,len({t['video_id'] for t in rows}))).split(np.zeros(len(rows)),groups=[t['video_id'] for t in rows])

def select(rows,X,V):
 scores=[]
 for C in (.1,1.,10.):
  pred=np.zeros(len(rows))
  for tr,te in folds(rows,3):pred[te],_=fit_predict([rows[i] for i in tr],X[tr],V[tr],[rows[i] for i in te],X[te],V[te],C)
  m=r.metrics(rows,pred);scores.append((m['recording_macro_pair_accuracy'],m['top1'],-C,C))
 return max(scores)[-1]

def main():
 start=time.monotonic();data=json.loads((ROOT/'cohort.json').read_text());rows=[t for t in data['rows'] if t['has_original_edges']];vdata=json.loads((ROOT/'visual_predictions.json').read_text());assert vdata['rows']==[t['row'] for t in rows];X=np.array([t['features'] for t in rows]);V=np.array(vdata['vectors']);out=np.zeros(len(rows));base=np.zeros(len(rows));known=np.zeros(len(rows),dtype=bool);details=[]
 for f,(tr,te) in enumerate(folds(rows,5)):
  tt=[rows[i] for i in tr];C=select(tt,X[tr],V[tr]);out[te],known[te]=fit_predict(tt,X[tr],V[tr],[rows[i] for i in te],X[te],V[te],C);base[te]=r.Model(r.SPECS[1],1.).fit(tt,X[tr]).predict(X[te]);details.append({'fold':f,'C':C})
 candidate=r.metrics(rows,out);baseline=r.metrics(rows,base)
 dates={v:max(t['updated_at'] for t in rows if t['video_id']==v) for v in {t['video_id'] for t in rows}};order=sorted(dates,key=dates.get);train=set(order[:int(.75*len(order))]);tr=np.array([i for i,t in enumerate(rows) if t['video_id'] in train]);te=np.array([i for i,t in enumerate(rows) if t['video_id'] not in train]);tt=[rows[i] for i in tr];C=select(tt,X[tr],V[tr]);cp,ck=fit_predict(tt,X[tr],V[tr],[rows[i] for i in te],X[te],V[te],C);bp=r.Model(r.SPECS[1],1.).fit(tt,X[tr]).predict(X[te]);chron={'candidate':r.metrics([rows[i] for i in te],cp),'baseline':r.metrics([rows[i] for i in te],bp),'known_rows':int(ck.sum()),'test_rows':len(te),'split':'last label updated_at per recording'}
 report={'target':'known-channel coarse-triage personalization; not final worth','candidate':candidate,'baseline':baseline,'difference':r.cluster_difference(candidate,baseline),'known_rows':int(known.sum()),'rows':len(rows),'chronological':chron,'folds':details,'seconds':time.monotonic()-start};save(ROOT/'personal_report.json',report);save(ROOT/'personal_predictions.json',{'rows':[t['row'] for t in rows],'candidate':out.tolist(),'base':base.tolist(),'known':known.tolist()});print(json.dumps({k:v for k,v in report.items() if k not in ('candidate','baseline','chronological')}));print(json.dumps({'candidate':{k:v for k,v in candidate.items() if k!='recordings'},'baseline':{k:v for k,v in baseline.items() if k!='recordings'},'chronological':{k:({a:b for a,b in v.items() if a!='recordings'} if isinstance(v,dict) else v) for k,v in chron.items()}}))
if __name__=='__main__':main()
