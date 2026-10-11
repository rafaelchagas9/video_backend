"""Nested grouped model selection, portable export and independent chronological check."""
from __future__ import annotations
import hashlib,json,math,sys,time,warnings
from collections import defaultdict
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.exceptions import ConvergenceWarning
from lightgbm import LGBMRanker
sys.path.insert(0,str(Path(__file__).resolve().parent))
from prepare import ROOT,FEATURES,save

SPECS=[('length','point', [0]),('base_point','point',[0,1]),('base_pair','pair',[0,1]),('context_point','point',list(range(13))),('context_pair','pair',list(range(13))),('context_list','list',list(range(13)))]
CS=[.1,1.,10.]

def pairs(rows):
 by=defaultdict(list)
 for i,r in enumerate(rows):by[r['video_id']].append(i)
 return [(k,s,1./(len(keep)*len(skip))) for ids in by.values() for keep in [[i for i in ids if rows[i]['y']]] for skip in [[i for i in ids if not rows[i]['y']]] for k in keep for s in skip]

def metrics(rows,scores):
 by=defaultdict(list)
 for i,r in enumerate(rows):by[r['video_id']].append(i)
 rec=[];total=right=0.
 for vid,ids in by.items():
  keep=[i for i in ids if rows[i]['y']];skip=[i for i in ids if not rows[i]['y']]
  if not keep or not skip:continue
  acc=np.mean([float(scores[k]>scores[s])+.5*float(scores[k]==scores[s]) for k in keep for s in skip]);total+=len(keep)*len(skip);right+=acc*len(keep)*len(skip)
  order=sorted(ids,key=lambda i:(-scores[i],rows[i]['detected_start'],rows[i]['clip_id']))
  recall=[sum(rows[i]['y'] for i in order[:k])/len(keep) for k in (1,2,3)]
  last=max(order.index(i) for i in keep);seconds=sum(rows[i]['detected_end']-rows[i]['detected_start'] for i in order[:last+1])
  rec.append({'video_id':vid,'group':rows[ids[0]]['group'],'pair_accuracy':float(acc),'top1':int(rows[order[0]]['y']),'keeper_recall_at_k':recall,'seconds_until_all_keeps':float(seconds)})
 if not rec:return {'status':'no_mixed_recordings'}
 y=[r['y'] for r in rows]
 return {'rows':len(rows),'channels':len({r['group'] for r in rows}),'mixed_recordings':len(rec),'pairs':int(total),'correct_pairs':float(right),'pair_accuracy':float(right/total),'recording_macro_pair_accuracy':float(np.mean([r['pair_accuracy'] for r in rec])),'top1':float(np.mean([r['top1'] for r in rec])),'keeper_recall_at_k':np.mean([r['keeper_recall_at_k'] for r in rec],axis=0).tolist(),'mean_seconds_until_all_keeps':float(np.mean([r['seconds_until_all_keeps'] for r in rec])),'auroc':float(roc_auc_score(y,scores)) if len(set(y))==2 else None,'recordings':rec}

class Model:
 def __init__(self,spec,C):self.spec=spec;self.C=C
 def fit(self,rows,X):
  name,kind,cols=self.spec;Z=X[:,cols];y=np.array([r['y'] for r in rows]);groups=np.array([r['video_id'] for r in rows]);counts={g:sum(groups==g) for g in set(groups)}
  self.scaler=StandardScaler().fit(Z);Z=self.scaler.transform(Z)
  if kind=='point':
   self.model=LogisticRegression(C=self.C,solver='liblinear',max_iter=5000,tol=1e-6).fit(Z,y,sample_weight=np.array([1./counts[g] for g in groups])*len(rows)/len(counts))
  elif kind=='pair':
   pp=pairs(rows)
   if not pp:raise ValueError('No training pairs')
   diff=np.array([Z[k]-Z[s] for k,s,w in pp]);weight=np.array([w for k,s,w in pp]);weight*=len(weight)/weight.sum()
   self.model=LogisticRegression(C=self.C,solver='liblinear',fit_intercept=False,max_iter=5000,tol=1e-6).fit(np.r_[diff,-diff],np.r_[np.ones(len(diff)),np.zeros(len(diff))],sample_weight=np.r_[weight,weight])
  else:
   order=np.argsort(groups,kind='stable');q=[sum(groups==g) for g in sorted(set(groups))]
   self.model=LGBMRanker(objective='rank_xendcg',n_estimators=60,num_leaves=7,max_depth=3,min_child_samples=15,reg_lambda=10.,reg_alpha=1.,learning_rate=.05,random_state=420,num_threads=2,verbosity=-1)
   self.model.fit(Z[order],y[order],group=q)
  return self
 def predict(self,X):
  Z=self.scaler.transform(X[:,self.spec[2]])
  return self.model.predict(Z) if self.spec[1]=='list' else self.model.decision_function(Z)
 def export(self,gate):
  cols=self.spec[2];mean=np.zeros(13);scale=np.ones(13);mean[cols]=self.scaler.mean_;scale[cols]=np.maximum(self.scaler.scale_,1e-12)
  if self.spec[1]=='list':return {'kind':'trees','gate_passed':gate,'mean':mean.tolist(),'scale':scale.tolist(),'trees':self.model.booster_.dump_model()['tree_info'],'columns':cols,'spec':self.spec[0]}
  weights=np.zeros(13);weights[cols]=self.model.coef_[0]
  return {'weights':weights.tolist(),'bias':float(self.model.intercept_[0]),'mean':mean.tolist(),'scale':scale.tolist(),'gate_passed':gate,'spec':self.spec[0]}

def splits(rows,n):
 groups=np.array([r['group'] for r in rows]);return list(GroupKFold(n_splits=min(n,len(set(groups)))).split(np.zeros(len(rows)),[r['y'] for r in rows],groups))

def selection(rows,X,n=3):
 trials=[]
 for spec in SPECS:
  for C in ([1.] if spec[1]=='list' else CS):
   out=np.full(len(rows),np.nan)
   for train,test in splits(rows,n):
    m=Model(spec,C).fit([rows[i] for i in train],X[train]);out[test]=m.predict(X[test])
   mm=metrics(rows,out)
   trials.append((mm['recording_macro_pair_accuracy'],mm['top1'],-len(spec[2]),spec,C))
 chosen=max(trials,key=lambda t:t[:3]);return chosen[3],chosen[4],[{'spec':t[3][0],'C':t[4],'macro_pair':t[0],'top1':t[1]} for t in trials]

def cluster_difference(a,b):
 ar={r['video_id']:r for r in a['recordings']};br={r['video_id']:r for r in b['recordings']};groups=defaultdict(list)
 for vid in ar.keys()&br.keys():groups[ar[vid]['group']].append(ar[vid]['pair_accuracy']-br[vid]['pair_accuracy'])
 keys=sorted(groups);rng=np.random.default_rng(42);boot=[]
 for _ in range(1000):boot.append(np.mean([d for k in rng.choice(keys,len(keys),replace=True) for d in groups[k]]))
 return {'mean_delta':float(np.mean([v for vv in groups.values() for v in vv])),'channel_bootstrap_95':np.quantile(boot,[.025,.975]).tolist(),'resampling_unit':'whole channel; pairs never treated independent'}

def main():
 began=time.monotonic();payload=json.loads((ROOT/'cohort.json').read_text());rows=payload['rows'];X=np.array([r['features'] for r in rows]);assert X.shape==(len(rows),13) and np.isfinite(X).all()
 if not all(r['has_original_edges'] for r in rows):
  # Old reviewed edges with no detector originals cannot be pre-decision model inputs.
  ids=[i for i,r in enumerate(rows) if r['has_original_edges']];rows=[rows[i] for i in ids];X=X[ids]
 y=np.array([r['y'] for r in rows]);oof={s[0]:np.full(len(rows),np.nan) for s in SPECS};joint=np.full(len(rows),np.nan);folds=[]
 save(ROOT/'ranking_spec.json',{'specs':[[s[0],s[1],s[2]] for s in SPECS],'C':CS,'outer_folds':5,'inner_folds':3,'selection':'recording macro pair accuracy then top1 then smaller recipe','gate':'nested selected > fitted base macro by >=.02; top1 no worse; keeper recall@2 no worse; bootstrap lower bound >-.02','targets':'triage only; fine versus held separate','snapshot_sha256':hashlib.sha256((ROOT/'cohort.json').read_bytes()).hexdigest()})
 with warnings.catch_warnings():
  warnings.simplefilter('error',ConvergenceWarning)
  for f,(train,test) in enumerate(splits(rows,5)):
   tr=[rows[i] for i in train];spec,C,inner=selection(tr,X[train]);joint[test]=Model(spec,C).fit(tr,X[train]).predict(X[test])
   for s in SPECS:oof[s[0]][test]=Model(s,1.).fit(tr,X[train]).predict(X[test])
   folds.append({'fold':f,'selected':spec[0],'C':C,'train_channels':len({r['group'] for r in tr}),'test_channels':len({rows[i]['group'] for i in test}),'inner':inner})
   print(json.dumps({'outer_fold_done':f+1,'selected':spec[0],'elapsed_seconds':round(time.monotonic()-began,1)}),flush=True)
  reports={name:metrics(rows,scores) for name,scores in oof.items()};reports['nested_selected']=metrics(rows,joint)
  shipped=np.array([-6.654+.8134*r['features'][0]+1.7894*r['score'] for r in rows]);reports['shipped']=metrics(rows,shipped)
  diff=cluster_difference(reports['nested_selected'],reports['base_point']);best=reports['nested_selected'];base=reports['base_point']
  gate=bool(best['recording_macro_pair_accuracy']>=base['recording_macro_pair_accuracy']+.02 and best['top1']>=base['top1'] and best['keeper_recall_at_k'][1]>=base['keeper_recall_at_k'][1] and diff['channel_bootstrap_95'][0]>-.02)
  spec,C,inner=selection(rows,X,5);final=Model(spec,C).fit(rows,X)
  # Classifier selection has its own objective; pair scores are not probabilities.
  acceptance_oof=np.full(len(rows),np.nan);base_accept_oof=np.full(len(rows),np.nan)
  def select_accept(rr,xx):
   trials=[]
   for asp in [SPECS[1],SPECS[3]]:
    for ac in CS:
     pred=np.full(len(rr),np.nan)
     for atr,ate in splits(rr,3):
      logits=Model(asp,ac).fit([rr[i] for i in atr],xx[atr]).predict(xx[ate]);pred[ate]=1/(1+np.exp(-np.clip(logits,-40,40)))
     yy=np.array([r['y'] for r in rr]);trials.append((brier_score_loss(yy,pred),-roc_auc_score(yy,pred),len(asp[2]),asp,ac))
   chosen=min(trials,key=lambda x:x[:3]);return chosen[3],chosen[4]
  for tr,te in splits(rows,5):
   asp,ac=select_accept([rows[i] for i in tr],X[tr]);acceptance_oof[te]=Model(asp,ac).fit([rows[i] for i in tr],X[tr]).predict(X[te]);base_accept_oof[te]=Model(SPECS[1],1.).fit([rows[i] for i in tr],X[tr]).predict(X[te])
  acceptance_prob=1/(1+np.exp(-np.clip(acceptance_oof,-40,40)));base_accept_prob=1/(1+np.exp(-np.clip(base_accept_oof,-40,40)))
  acceptance_metrics={'auroc':float(roc_auc_score(y,acceptance_prob)),'brier':float(brier_score_loss(y,acceptance_prob)),'base_auroc':float(roc_auc_score(y,base_accept_prob)),'base_brier':float(brier_score_loss(y,base_accept_prob)),'target':'coarse-triage potential; no automatic rejection'}
  acceptance_gate=bool(acceptance_metrics['auroc']>=acceptance_metrics['base_auroc'] and acceptance_metrics['brier']<=acceptance_metrics['base_brier'])
  asp,ac=select_accept(rows,X);accept=Model(asp,ac).fit(rows,X)
  # Split by the last label's availability, never by the recording analysis date.
  label_dates={v:max(r['updated_at'] for r in rows if r['video_id']==v) for v in {r['video_id'] for r in rows}}
  chronology=sorted((t,v) for v,t in label_dates.items());cut=max(1,int(len(chronology)*.75));trainvid={v for _,v in chronology[:cut]};training=[i for i,r in enumerate(rows) if r['video_id'] in trainvid];testing=[i for i,r in enumerate(rows) if r['video_id'] not in trainvid]
  chron=None
  if len(training)>30 and len(testing)>10:
   ss,cc,_=selection([rows[i] for i in training],X[training]);cm=Model(ss,cc).fit([rows[i] for i in training],X[training]);chron={'selected':ss[0],'C':cc,'candidate':metrics([rows[i] for i in testing],cm.predict(X[testing])),'shipped':metrics([rows[i] for i in testing],shipped[testing])}
  report={'target':'coarse triage ordering, not final storage worth','rows':len(rows),'keeps':int(y.sum()),'channels':len({r['group'] for r in rows}),'reports':reports,'acceptance':dict(acceptance_metrics,gate_passed=acceptance_gate,selected=asp[0],C=ac),'folds':folds,'difference_vs_fitted_base':diff,'chronological':chron,'chosen':{'spec':spec[0],'C':C},'gate_passed':gate,'seconds':round(time.monotonic()-began,2)}
  artifact={'schema_version':1,'version':'recording-model-20261010','model_revision':payload['model_revision'],'feature_recipe':payload['feature_recipe'],'features':FEATURES,'heads':{'triage':final.export(gate),'acceptance':accept.export(acceptance_gate)},'validation':{'snapshot_sha256':hashlib.sha256((ROOT/'cohort.json').read_bytes()).hexdigest(),'nested_macro_pair':best['recording_macro_pair_accuracy'],'gate_passed':gate,'cohort':'coarse-triage'}}
  save(ROOT/'ranking_report.json',report);save(ROOT/'ranking_candidate.json',artifact)
  save(ROOT/'ranking_predictions.json',{'rows':[r['row'] for r in rows],'oof':{k:v.tolist() for k,v in oof.items()},'nested':joint.tolist(),'shipped':shipped.tolist(),'final':final.predict(X).tolist(),'features':X.tolist()})
  print(json.dumps({k:v for k,v in report.items() if k not in ('reports','folds','chronological')}),flush=True)
  print(json.dumps({n:{k:v for k,v in m.items() if k not in ('recordings',)} for n,m in reports.items()}),flush=True)
if __name__=='__main__':main()
