"""Fine-only frame preference cuts. Cached numeric frames/audio features only."""
import argparse,json,os,sys
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score
from cut_and_whole import fine_boundaries,splits,save,constrained,interval_metrics

NAMES=['position_fraction','cosine_to_clip','transition','relative_audio_activity']

def build(rows,folder):
 cache={};output=[]
 for row in rows:
  vid=row['video_id'];path=folder/'frames'/f'{vid}.npz';generation=row.get('task_generation_input');key=vid if generation is None else (vid,generation['feedback']['analyzed_at'],generation['archive']['feature_identity'])
  if generation is None and not path.exists():continue
  if key not in cache:
   if generation is None:
    with np.load(path) as z:t,v=z['t'],z['v'].astype(np.float32)
   else:
    import task_generation_inputs as task_inputs
    loaded=task_inputs.archived_frame_inputs(generation['feedback'],generation['archive'])
    if loaded is None:continue
    t,v=loaded;v=v.astype(np.float32)
   v=v/np.maximum(np.linalg.norm(v,axis=1,keepdims=True),1e-9);activity=None;audio=folder.parent/'audio'/f'{vid}.npz'
   if generation is None and audio.exists():
    with np.load(audio) as z:
     if 'db' in z.files and 'flux' in z.files:
      def robust(x):
       x=np.asarray(x,float);d=1.4826*np.median(np.abs(x-np.median(x)));return np.clip((x-np.median(x))/(d or 1),-5,5)
      activity=robust(z['db'])+robust(z['flux'])
   cache[key]=(t,v,activity)
  t,v,activity=cache[key];a,b=row['detected_start'],row['detected_end'];mask=(t>=a)&(t<=b);times=t[mask];vectors=v[mask]
  if len(times)<3:continue
  centre=vectors.mean(0);centre/=max(np.linalg.norm(centre),1e-9)
  transition=np.r_[0.,np.clip(1-np.sum(vectors[1:]*vectors[:-1],axis=1),0,2)]
  audio=np.zeros(len(times)) if activity is None else activity[np.minimum(len(activity)-1,np.maximum(0,times.astype(int)))]
  numeric=np.stack([(times-a)/(b-a),vectors@centre,transition,audio],1)
  y=((times>=row['selected_start'])&(times<=row['selected_end'])).astype(int)
  # Uncertain five-second boundary band contributes neither class.
  positive=np.flatnonzero((times>=row['selected_start']+5)&(times<=row['selected_end']-5))
  negative=np.flatnonzero((times<row['selected_start']-5)|(times>row['selected_end']+5))
  sample=[]
  for indices in (positive,negative):
   if len(indices):sample.extend(indices[np.linspace(0,len(indices)-1,min(40,len(indices))).astype(int)].tolist())
  if not sample:continue
  X=np.concatenate([vectors,numeric],1).astype(np.float32)
  output.append(dict(row,times=times,X=X,y=y,sample=np.array(sample),audio_present=activity is not None))
 return output

def fit(rows,C):
 import fine_labels as fl
 fl.require_fit_scope(rows,'frame boundary fitting')
 X=np.concatenate([r['X'][r['sample']] for r in rows]);y=np.concatenate([r['y'][r['sample']] for r in rows])
 w=np.concatenate([np.full(len(r['sample']),80/max(1,len(r['sample']))) for r in rows]);scale=StandardScaler().fit(X[:,-4:],sample_weight=w)
 X[:,-4:]=scale.transform(X[:,-4:]);model=LogisticRegression(C=C,solver='liblinear',max_iter=2000,class_weight='balanced',random_state=29).fit(X,y,sample_weight=w)
 return scale,model

def probabilities(model,rows):
 scale,m=model;output=[]
 for r in rows:
  X=r['X'].copy();X[:,-4:]=scale.transform(X[:,-4:]);p=m.predict_proba(X)[:,1]
  output.append(np.convolve(p,np.ones(3),'same')/np.convolve(np.ones(len(p)),np.ones(3),'same'))
 return output

def intervals(rows,probs,threshold,mode='global'):
 result=[]
 for r,p in zip(rows,probs):
  a,b=r['detected_start'],r['detected_end']
  if mode=='relative_quantile':
   ids=np.flatnonzero(p>=np.quantile(p,threshold))
  elif mode=='max_sum_relative':
   values=p-np.quantile(p,threshold);best=-np.inf;current=0.;candidate_start=0;lo=hi=0
   for i,value in enumerate(values):
    if current<=0:current=float(value);candidate_start=i
    else:current+=float(value)
    if current>best:best=current;lo=candidate_start;hi=i
   ids=np.array([lo,hi])
  elif mode=='contrast_mass':
   mass=np.maximum(0.,p-np.quantile(p,.3))+.001;cdf=np.cumsum(mass)/mass.sum()
   lo=int(np.searchsorted(cdf,threshold));hi=min(len(p)-1,int(np.searchsorted(cdf,1.-threshold)))
   ids=np.array([lo,hi])
  else:ids=np.flatnonzero(p>=threshold)
  if threshold==0 or not len(ids):result.append([a,b]);continue
  start=max(a,float(r['times'][ids[0]])-10);end=min(b,float(r['times'][ids[-1]])+15)
  result.append(constrained([(start-a)/(b-a),(end-a)/(b-a)],[a,b]))
 return result

def metrics(rows,pred):
 x=interval_metrics(rows,pred);x['meaningfully_shortened']=sum((r['detected_end']-r['detected_start'])-(p[1]-p[0])>=5 for r,p in zip(rows,pred));return x

def objective(m):return m['channel_macro_iou']-4*(1-m['channel_macro_retained'])

def select(rows):
 options=[]
 for C in (.1,1.,10.):
  held=[None]*len(rows)
  for train,test in splits(rows,3):
   tr=[rows[i] for i in train];te=[rows[i] for i in test];model=fit(tr,C)
   for i,p in zip(test,probabilities(model,te)):held[i]=p
  policies=[('global',q) for q in (0.,.3,.4,.5,.6,.7)]+[('relative_quantile',q) for q in (.05,.1,.2,.3)]+[('contrast_mass',q) for q in (.001,.01,.03,.05)]+[('max_sum_relative',q) for q in (.1,.2,.3,.5)]
  for mode,threshold in policies:options.append((objective(metrics(rows,intervals(rows,held,threshold,mode))),-threshold,-C,mode))
 best=max(options);return -best[2],-best[1],best[3]

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--cohort',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);a=parser.parse_args();cohort=json.loads(a.cohort.read_text());allrows=fine_boundaries(cohort,a.cohort.parent);rows=build(allrows,a.cohort.parent)
 pred=[None]*len(rows);outprobs=[None]*len(rows);folds=[]
 for fold,(train,test) in enumerate(splits(rows)):
  tr=[rows[i] for i in train];te=[rows[i] for i in test];C,threshold,mode=select(tr);model=fit(tr,C);p=probabilities(model,te)
  for i,value,probs in zip(test,intervals(te,p,threshold,mode),p):pred[i]=value;outprobs[i]=probs
  folds.append({'train_clips':len(train),'test_clips':len(test),'C':C,'threshold':threshold,'mode':mode});print('Completed frame-cut outer fold '+str(fold+1),flush=True)
 identity=metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);candidate=metrics(rows,pred)
 enabled=candidate['channel_macro_iou']>identity['channel_macro_iou']+.02 and candidate['channel_macro_retained']>=.97 and candidate['retention_p10']>=.9 and candidate['meaningfully_shortened']>=3
 auc=[]
 for r,p in zip(rows,outprobs):
  ids=r['sample']
  if len(set(r['y'][ids]))==2:auc.append(float(roc_auc_score(r['y'][ids],p[ids])))
 frontier=[]
 for extraction in ('global','relative_quantile','contrast_mass','max_sum_relative'):
  levels={'global':[.3,.4,.5,.6,.7],'relative_quantile':[.05,.1,.2,.3],'contrast_mass':[.001,.01,.03,.05],'max_sum_relative':[.1,.2,.3,.5]}[extraction]
  for level in levels:frontier.append(dict(mode=extraction,level=level,metrics=metrics(rows,intervals(rows,outprobs,level,extraction))))
 C,threshold,mode=select(rows);scale,model=fit(rows,C)
 artifact={'schema_version':1,'kind':'frame_cut_envelope','enabled':enabled,'target':'Fine interval-selection preference; no frame labels inferred from coarse keeps',
           'embedding_dimensions':1152,'numeric_features':NAMES,'numeric_mean':scale.mean_.tolist(),'numeric_scale':scale.scale_.tolist(),
           'weights':model.coef_[0].tolist(),'bias':float(model.intercept_[0]),'C':C,'threshold':threshold,'extraction_mode':mode,'smoothing_radius':1,
           'start_pad_seconds':10,'end_pad_seconds':15,'max_seconds':None,'constraints':{'min_seconds':5},'fallback':'original_range','automatic_action':False}
 report={'fine_clip_labels':len(allrows),'eligible_with_frames':len(rows),'channels':len({r['group'] for r in rows}),'clips_with_audio':sum(r['audio_present'] for r in rows),
         'validation':'Five outer whole-channel folds; C and envelope threshold chosen in three inner training-channel folds; numeric scaling fit on training frames only',
         'sample_rule':'Max40 inside and40 outside frames per original clip; ignore5second boundary band; equal clip weight',
         'policy_frontier_diagnostic_only_not_used_to_select':frontier,'identity':identity,'candidate':candidate,'folds':folds,'policy_candidates':['global_probability','relative_probability_quantile','contrast_probability_mass','max_sum_contiguous_region'],'frame_macro_auroc_on_modified_clips':float(np.mean(auc)) if auc else None,'enabled':enabled,
         'limitations':['Only28 fine cut confirmations; previous confirmation UX may influence these targets.',
                        'Chosen interval indicates wanted content but does not claim every outside frame is intrinsically bad.',
                        'Content is represented by sparse SigLIP stills and cheap audio activity, not fine speech/music semantics.'],
         'no_media_reads':True,'no_gpu':True,'cloud_credits':0}
 save(a.output/'frame_cut_envelope.json',artifact);save(a.output/'frame_cut_report.json',report)
 save(a.output/'frame_cut_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predicted':p,'times':r['times'].tolist(),'probabilities':s.tolist()} for r,p,s in zip(rows,pred,outprobs)]})
 print(json.dumps(report,indent=2))
if __name__=='__main__':main()
