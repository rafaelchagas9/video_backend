"""Evaluate conservative likely-skip defaults; never delete or hide proposals."""
import json,sys,time
from pathlib import Path
import numpy as np
from scipy.special import expit
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
sys.path.insert(0,str(Path(__file__).resolve().parent))
import prepare as p,rank as r

def predict(rows,X,E,Q,F):
 sc=StandardScaler().fit(X);pc=PCA(16,svd_solver='full').fit(E);ls=StandardScaler().fit(pc.transform(E));z=np.c_[sc.transform(X),ls.transform(pc.transform(E))];q=np.c_[sc.transform(Q),ls.transform(pc.transform(F))];counts={v:sum(t['video_id']==v for t in rows) for v in {t['video_id'] for t in rows}};w=np.array([1/counts[t['video_id']] for t in rows]);w*=len(rows)/w.sum();m=LogisticRegression(C=.1,solver='liblinear',max_iter=5000,tol=1e-6).fit(z,[t['y'] for t in rows],sample_weight=w);return expit(m.decision_function(q))

def threshold(rows,prob):
 y=np.array([t['y'] for t in rows]);valid=[t for t in np.arange(.05,.51,.025) if np.mean(prob[y==1]>=t)>=.98];return float(max(valid)) if valid else 0.

def main():
 start=time.monotonic();data=json.loads((p.ROOT/'audio'/'range_scores.json').read_text());lookup={t['row']:t for t in json.loads((p.ROOT/'cohort.json').read_text())['rows']};rows=[lookup[t['row']] for t in data['rows']];X=np.array([t['features'] for t in rows]);E=np.array([t['embedding'] for t in data['rows']]);y=np.array([t['y'] for t in rows]);probs=np.zeros(len(rows));skip=np.zeros(len(rows),dtype=bool);folds=[]
 for f,(tr,te) in enumerate(r.splits(rows,5)):
  rr=[rows[i] for i in tr];q=np.zeros(len(tr))
  for it,ie in r.splits(rr,3):q[ie]=predict([rr[i] for i in it],X[tr][it],E[tr][it],X[tr][ie],E[tr][ie])
  t=threshold(rr,q);probs[te]=predict(rr,X[tr],E[tr],X[te],E[te]);skip[te]=probs[te]<t;folds.append({'fold':f,'threshold':t,'training_oof_keeper_recall':float(np.mean(q[np.array([v['y'] for v in rr])==1]>=t))})
 missed=int(np.sum(skip & (y==1)));removed=int(np.sum(skip & (y==0)));recall=1-missed/int(y.sum());fraction=removed/int(np.sum(y==0));gate=bool(recall>=.98 and fraction>=.1);full_threshold=threshold(rows,probs);report={'target':'coarse-triage likely-skip defaults; all proposals remain inspectable','rows':len(rows),'keeps':int(y.sum()),'skips':int(np.sum(y==0)),'keeper_recall':recall,'keeps_marked_likely_skip':missed,'skips_marked_likely_skip':removed,'skip_fraction':fraction,'gate_passed':gate,'selection':'threshold selected only on inner held-out training channels at >=98% keeper recall','folds':folds,'final_threshold':full_threshold,'automatic_deletion':False,'seconds':time.monotonic()-start};p.save(p.ROOT/'pruning_report.json',report);p.save(p.ROOT/'pruning_candidate.json',{'enabled':gate,'kind':'likely_skip_default','threshold':full_threshold,'audio_only':True,'keep_visible':True,'automatic_action':False});print(json.dumps(report))
if __name__=='__main__':main()
