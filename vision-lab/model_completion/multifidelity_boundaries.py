"""Fine final boundaries plus low-weight coarse outside-trim negatives only."""
import argparse,json,os,time
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd
from sklearn.metrics import roc_auc_score
from cut_and_whole import eligible_cuts,splits,save
import raw_original_boundaries as raw
import frame_cuts as fc
import nonlinear_boundary as nb
WEAK_WEIGHT=.2
RECIPES=raw.RECIPES

def weights(rows):return np.concatenate([np.full(len(r['sample']),80*(WEAK_WEIGHT if r.get('weak') else 1)/max(1,len(r['sample']))) for r in rows])

def coarse_rows(cohort,fine,folder):
 eligible=eligible_cuts(cohort['rows']);rawrows=fc.build(eligible,folder);output=[];vetoed=0
 for r in rawrows:
  times=r['times'];ids=np.flatnonzero((times<r['selected_start']-5)|(times>r['selected_end']+5))
  # Gold chosen intervals take priority over coarse exclusions from overlapping proposals.
  for gold in fine:
   if gold['video_id']!=r['video_id']:continue
   mask=(times[ids]>=gold['selected_start']-5)&(times[ids]<=gold['selected_end']+5);vetoed+=int(mask.sum());ids=ids[~mask]
  if not len(ids):continue
  ids=ids[np.linspace(0,len(ids)-1,min(40,len(ids))).astype(int)];vectors=r['X'][:,:1152];delta=np.vstack([np.zeros_like(vectors[0]),np.diff(vectors,axis=0)])
  # Keep only negatives, while context/deltas retain the full ORIGINAL proposal feature recipe.
  output.append(dict(r,raw=vectors[ids].copy(),raw_mean=vectors.mean(0),raw_delta=delta[ids].copy(),numeric=r['X'][ids,-4:].copy(),X=r['X'][ids].copy(),times=times[ids].copy(),y=np.zeros(len(ids),int),sample=np.arange(len(ids)),weak=True))
 return output,{'eligible_coarse_kept_intervals':len(eligible),'weak_negative_clips':len(output),'weak_negative_frames':sum(len(r['sample']) for r in output),'gold_overlap_frames_vetoed':vetoed,'coarse_clip_weight':WEAK_WEIGHT,'coarse_inside_frames_are_unlabeled':True}

def projection(rows):
 X=np.concatenate([r['raw'][r['sample']] for r in rows]);w=weights(rows);mean=np.average(X,axis=0,weights=w);_,_,components=randomized_svd((X-mean)*np.sqrt(w/w.mean())[:,None],n_components=16,n_iter=3,random_state=29);return mean,components

def transform(proj,rows):
 mean,components=proj;out=[]
 for r in rows:
  pc=(r['raw']-mean)@components.T;centre=(r.get('raw_mean',r['raw'].mean(0))-mean)@components.T;delta=r.get('raw_delta',np.vstack([np.zeros_like(r['raw'][0]),np.diff(r['raw'],axis=0)]));out.append(np.concatenate([pc,pc-centre,np.abs(delta@components.T),r['numeric']],1))
 return out

def fit(rows,kind,param,proj=None):
 y=np.concatenate([r['y'][r['sample']] for r in rows]);w=weights(rows);pos=w[y==1].sum();neg=w[y==0].sum();assert pos>0 and neg>0;total=w.sum();w[y==1]*=total/(2*pos);w[y==0]*=total/(2*neg)
 if kind=='linear':
  X=np.concatenate([r['X'][r['sample']] for r in rows]);scale=StandardScaler().fit(X[:,-4:],sample_weight=w);X[:,-4:]=scale.transform(X[:,-4:]);m=LogisticRegression(C=param,solver='liblinear',max_iter=2000,random_state=29).fit(X,y,sample_weight=w);return scale,m
 X=np.concatenate([v[r['sample']] for v,r in zip(transform(proj,rows),rows)]);return HistGradientBoostingClassifier(max_iter=80,learning_rate=.05,early_stopping=False,random_state=29,**nb.CONFIGS[param]).fit(X,y,sample_weight=w)

def probabilities(rows,kind,model,proj=None):
 if kind=='linear':return fc.probabilities(model,rows)
 result=[]
 for x in transform(proj,rows):
  p=model.predict_proba(x)[:,1];result.append(np.convolve(p,np.ones(3),'same')/np.convolve(np.ones(len(p)),np.ones(3),'same'))
 return result

def allowed(weak,test):
 channels={r['group'] for r in test};return [r for r in weak if r['group'] not in channels]

def choose(fine,weak,deadline):
 held=[[None]*len(fine) for _ in RECIPES]
 for tr,te in splits(fine,3):
  nb.check(deadline);gold=[fine[i] for i in tr];test=[fine[i] for i in te];training=gold+allowed(weak,test);proj=projection(training)
  for j,(kind,param) in enumerate(RECIPES):
   model=fit(training,kind,param,proj);ps=probabilities(test,kind,model,proj)
   for i,p in zip(te,ps):held[j][i]=p
 options=[]
 for j,ps in enumerate(held):
  for mode,level in nb.POLICIES:
   metric=fc.metrics(fine,fc.intervals(fine,ps,level,mode));score=metric['channel_macro_iou'] if metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9 else -10.;options.append((score,-level,-j,mode))
 best=max(options);return -best[2],-best[1],best[3],best[0]

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seconds',type=int,default=170);a=p.parse_args();start=time.monotonic();deadline=start+a.seconds;targets,contract=raw.targets(a.cohort);fine=raw.prepare(targets,a.cohort.parent);cohort=json.loads(a.cohort.read_text());weak,counts=coarse_rows(cohort,fine,a.cohort.parent);pred=[None]*len(fine);probs=[None]*len(fine);folds=[]
 for tr,te in splits(fine):
  nb.check(deadline);gold=[fine[i] for i in tr];test=[fine[i] for i in te];pool=allowed(weak,test);j,level,mode,inner=choose(gold,pool,deadline);kind,param=RECIPES[j];training=gold+pool;assert not ({r['group'] for r in training}&{r['group'] for r in test});proj=projection(training) if kind=='nonlinear' else None;model=fit(training,kind,param,proj);ps=probabilities(test,kind,model,proj)
  for i,pvalue,v in zip(te,fc.intervals(test,ps,level,mode),ps):pred[i]=pvalue;probs[i]=v
  folds.append({'gold_train':len(gold),'gold_test':len(test),'weak_train_clips':len(pool),'weak_frames':sum(len(r['sample']) for r in pool),'kind':kind,'parameter':param,'mode':mode,'level':level,'inner_score':inner,'coarse_heldout_channel_overlap':0})
 identity=fc.metrics(fine,[[r['detected_start'],r['detected_end']] for r in fine]);candidate=fc.metrics(fine,pred);auc=[float(roc_auc_score(r['y'][r['sample']],p[r['sample']])) for r,p in zip(fine,probs) if len(set(r['y'][r['sample']]))==2];enabled=candidate['channel_macro_iou']>identity['channel_macro_iou']+.02 and candidate['channel_macro_retained']>=.97 and candidate['retention_p10']>=.9 and candidate['meaningfully_shortened']>=3
 report={'input_contract':'Immutable original detected proposal -> final fine human chosen interval','fine_source':contract,'coarse_source':counts,'rows':len(fine),'channels':len({r['group'] for r in fine}),'validation':'Whole-fine-channel outer5 and inner3; ALL coarse rows from test channels excluded at both levels; training-fold PCA/scaling; joint model/linear-C/policy selection training-only; fixed coarse weight0.2','identity':identity,'candidate':candidate,'frame_macro_auroc':float(np.mean(auc)),'enabled':enabled,'folds':folds,'seconds':time.monotonic()-start,'no_media_reads':True,'no_gpu':True,'no_production_writes':True}
 save(a.output/'multifidelity_boundary_report.json',report);save(a.output/'multifidelity_boundary_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predicted':p,'times':r['times'].tolist(),'probabilities':v.tolist()} for r,p,v in zip(fine,pred,probs)]})
 # Only fit a deployable artifact if the unchanged held-out gate actually passed.
 if enabled:
  j,level,mode,_=choose(fine,weak,deadline);kind,param=RECIPES[j];training=fine+weak;proj=projection(training) if kind=='nonlinear' else None;model=fit(training,kind,param,proj)
  if kind=='nonlinear':artifact=nb.portable(proj,model,(param,level,mode),True);artifact.update(kind='original_multifidelity_nonlinear_boundary',raw_features='unitvisual1152',numeric_features=fc.NAMES)
  else:
   scale,m=model;artifact={'schema_version':1,'kind':'original_multifidelity_frame_boundary','enabled':True,'numeric_features':fc.NAMES,'numeric_mean':scale.mean_.tolist(),'numeric_scale':scale.scale_.tolist(),'weights':m.coef_[0].tolist(),'bias':float(m.intercept_[0]),'C':param,'level':level,'extraction_mode':mode,'smoothing_radius':1,'start_pad_seconds':10,'end_pad_seconds':15,'constraints':{'min_seconds':5},'max_seconds':None,'automatic_action':False,'fallback':'original_range'}
  save(a.output/'multifidelity_boundary_envelope.json',artifact)
 else:save(a.output/'multifidelity_boundary_envelope.json',{'schema_version':1,'kind':'original_multifidelity_frame_boundary','enabled':False,'automatic_action':False,'fallback':'original_range','max_seconds':None})
 report['seconds']=time.monotonic()-start;save(a.output/'multifidelity_boundary_report.json',report);print(json.dumps(report,indent=2))
if __name__=='__main__':main()
