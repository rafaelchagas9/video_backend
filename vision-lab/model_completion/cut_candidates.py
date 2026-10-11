"""Conservative cut/recording alternatives from immutable numeric caches only."""
import argparse,json,os,sys
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor,GradientBoostingClassifier
from cut_and_whole import eligible_cuts,fine_boundaries,interval_metrics,targets,splits,constrained,save,recording_rows,classification_metrics,RECORDING_FEATURES

def nodes(estimator):
 t=estimator.tree_
 return [{'feature':int(t.feature[i]),'threshold':float(t.threshold[i]),'left':int(t.children_left[i]),'right':int(t.children_right[i]),'value':float(t.value[i,0,0])} for i in range(t.node_count)]

def fit(rows,q):
 X=np.array([r['features'] for r in rows]);y=targets(rows)
 return [GradientBoostingRegressor(loss='quantile',alpha=a,n_estimators=60,learning_rate=.05,max_depth=2,min_samples_leaf=max(3,min(10,len(rows)//5)),random_state=27).fit(X,y[:,j]) for j,a in enumerate((q,1-q))]

def prediction(models,rows):
 X=np.array([r['features'] for r in rows]);f=np.stack([m.predict(X) for m in models],1)
 return [constrained(v,[r['detected_start'],r['detected_end']]) for r,v in zip(rows,f)]

def loss(metrics):return metrics['channel_macro_iou']-4*(1-metrics['channel_macro_retained'])

def choose(rows):
 values=[]
 for q in (.01,.03,.05):
  scores=[]
  for train,test in splits(rows,3):
   if len(train)<6:continue
   tr=[rows[i] for i in train];te=[rows[i] for i in test];scores.append(loss(interval_metrics(te,prediction(fit(tr,q),te))))
  values.append((np.mean(scores) if scores else -1e9,-q))
 return -max(values)[1]

def metrics(rows,predictions):
 result=interval_metrics(rows,predictions)
 meaningful=sum((r['detected_end']-r['detected_start'])-(p[1]-p[0])>=5 for r,p in zip(rows,predictions))
 return result|{'meaningfully_shortened':meaningful,'meaningfully_shortened_fraction':meaningful/len(rows)}

def evaluate(rows,conditional=False):
 out=[None]*len(rows);folds=[]
 for train,test in splits(rows):
  tr=[rows[i] for i in train];te=[rows[i] for i in test];q=choose(tr);model=fit(tr,q);pred=prediction(model,te)
  if conditional:
   changed=np.array([abs(r['selected_start']-r['detected_start'])>1 or abs(r['selected_end']-r['detected_end'])>1 for r in tr],int)
   if len(set(changed))==2 and sum(changed)>=6:
    presence=GradientBoostingClassifier(n_estimators=60,learning_rate=.05,max_depth=2,min_samples_leaf=5,random_state=27).fit([r['features'] for r in tr],changed)
    confidence=presence.predict_proba([r['features'] for r in te])[:,1]
    model=fit([r for r,c in zip(tr,changed) if c],q);pred=prediction(model,te)
    pred=[p if c>=.9 else [r['detected_start'],r['detected_end']] for r,p,c in zip(te,pred,confidence)]
   else:pred=[[r['detected_start'],r['detected_end']] for r in te]
  for i,p in zip(test,pred):out[i]=p
  folds.append({'train':len(train),'test':len(test),'quantile':q})
 return {'identity':metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]),'candidate':metrics(rows,out),'folds':folds},out

def gate(report):
 c=report['candidate'];b=report['identity']
 return c['channel_macro_iou']>b['channel_macro_iou']+.02 and c['channel_macro_retained']>=.97 and c['retention_p10']>=.9 and c['meaningfully_shortened']>=3

def signals(rows,folder):
 sys.path.insert(0,str(Path(__file__).resolve().parents[1]));import deployed_clipper as dc
 probe=dc.load_probe();cache={}
 for vid in sorted({r['video_id'] for r in rows}):
  path=folder/'frames'/f'{vid}.npz'
  if not path.exists():continue
  with np.load(path) as z:t,v=z['t'],z['v']
  p=dc.highlight_scores(dc.classify(probe['W'],probe['b'],dc.context(v,probe['radius'])))
  s=None;audio=folder.parent/'audio'/f'{vid}.npz'
  if audio.exists():
   with np.load(audio) as z:
    if 'db' in z.files and 'flux' in z.files:
     def robust(x):
      x=np.asarray(x,float);d=1.4826*np.median(np.abs(x-np.median(x)));return np.clip((x-np.median(x))/(d or 1),-5,5)
     activity=robust(z['db'])+robust(z['flux'])
     if len(activity):s=activity[np.minimum(len(activity)-1,np.maximum(0,t.astype(int)))]
  cache[vid]=(t,p,s)
 return cache,probe['version']

def peak(rows,cache,q,mix):
 out=[]
 for r in rows:
  a,b=r['detected_start'],r['detected_end'];found=cache.get(r['video_id'])
  if q==0 or found is None:out.append([a,b]);continue
  t,p,s=found;mask=(t>=a)&(t<=b);times=t[mask];p=p[mask]
  if len(p)<3:out.append([a,b]);continue
  def ranks(x):return np.argsort(np.argsort(x,kind='stable'),kind='stable')/max(1,len(x)-1)
  value=p if mix==0 or s is None else (1-mix)*ranks(p)+mix*ranks(s[mask])
  value=np.convolve(value,np.ones(3),'same')/np.convolve(np.ones(len(value)),np.ones(3),'same')
  i=int(np.argmax(value));bar=q*value[i];lo=hi=i
  while lo>0 and value[lo-1]>=bar:lo-=1
  while hi<len(value)-1 and value[hi+1]>=bar:hi+=1
  start=max(a,float(times[lo])-10);end=min(b,float(times[hi])+15)
  out.append(constrained([(start-a)/(b-a),(end-a)/(b-a)],[a,b]))
 return out

def choose_peak(rows,cache):
 values=[]
 for q,mix in [(0,0),(.5,0),(.7,0),(.9,0),(.5,.5),(.7,.5),(.9,.5)]:
  values.append((loss(metrics(rows,peak(rows,cache,q,mix))),-q,-mix))
 best=max(values);return -best[1],-best[2]

def evaluate_peak(rows,cache):
 out=[None]*len(rows);folds=[]
 for train,test in splits(rows):
  tr=[rows[i] for i in train];te=[rows[i] for i in test];q,mix=choose_peak(tr,cache)
  for i,p in zip(test,peak(te,cache,q,mix)):out[i]=p
  folds.append({'near_peak_fraction':q,'audio_weight':mix})
 return {'identity':metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]),'candidate':metrics(rows,out),'folds':folds},out

def whole(rows):
 X=np.array([r['features'] for r in rows]);y=np.array([int(r['any_keep']) for r in rows]);p=np.full(len(y),np.nan)
 for train,test in splits(rows):
  m=GradientBoostingClassifier(n_estimators=60,learning_rate=.05,max_depth=2,min_samples_leaf=10,random_state=27).fit(X[train],y[train]);p[test]=m.predict_proba(X[test])[:,1]
 result=classification_metrics(y,p)
 final=GradientBoostingClassifier(n_estimators=60,learning_rate=.05,max_depth=2,min_samples_leaf=10,random_state=27).fit(X,y)
 return result,{'schema_version':1,'kind':'recording_any_keep_trees','feature_names':RECORDING_FEATURES,'enabled':result['auroc']>=.65 and result['brier']<.207,'automatic_action':False,'init_bias':float(final._raw_predict_init(X[:1])[0,0]),'learning_rate':.05,'trees':[nodes(t[0]) for t in final.estimators_],'fallback':'no_recording_recommendation','label_interpretation':'Coarse triage potential, not final storage worth.'}

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();c=json.loads(a.cohort.read_text());coarse=eligible_cuts(c['rows']);fine=fine_boundaries(c,a.cohort.parent)
 report={'schema_version':1,'validation':'Whole-channel outer folds; quantiles picked only in grouped training folds; fixed confidence gate .9','cuts':{},'no_media_reads':True,'no_gpu':True,'cloud_credits':0}
 for name,rows in [('coarse',coarse),('fine_versus',fine)]:
  print('Quantile cuts '+name,flush=True);report['cuts'][name]={}
  for conditional in (False,True):
   value,pred=evaluate(rows,conditional);key='conditional_quantile' if conditional else 'quantile';report['cuts'][name][key]=value
   save(a.output/f'cut_{key}_{name}_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predicted':v} for r,v in zip(rows,pred)]})
 enabled=all(gate(report['cuts'][name]['quantile']) for name in ('coarse','fine_versus'));q=choose(coarse);models=fit(coarse,q)
 save(a.output/'cut_quantile.json',{'schema_version':1,'kind':'quantile_cut_offsets','feature_names':c['features'],'enabled':enabled,'targets':['start_fraction','end_fraction'],'init_bias':[float(m.init_.constant_[0,0]) for m in models],'learning_rate':.05,'trees':[[nodes(t[0]) for t in m.estimators_] for m in models],'constraints':{'min_seconds':5},'fallback':'original_range','quantile':q,'automatic_action':False})
 save(a.output/'cut_quantile_parity.json',{'features':coarse[0]['features'],'raw_fractions':[float(m.predict([coarse[0]['features']])[0]) for m in models],'original_range':[0.,100.]})
 print('Uncapped peak cuts',flush=True);cache,version=signals(coarse+fine,a.cohort.parent);report['peak_source']={'probe':version,'recordings_with_visual':len(cache),'recordings_with_audio':sum(x[2] is not None for x in cache.values()),'caveat':'Frozen shipped state probe; cut policy test, not retrained stage1 generalization.'}
 for name,rows in [('coarse',coarse),('fine_versus',fine)]:report['cuts'][name]['uncapped_peak'],_=evaluate_peak(rows,cache)
 q,mix=choose_peak(coarse,cache);save(a.output/'cut_peak_policy.json',{'schema_version':1,'kind':'uncapped_peak','enabled':all(gate(report['cuts'][name]['uncapped_peak']) for name in ('coarse','fine_versus')),'near_peak_fraction':q,'audio_weight':mix,'max_seconds':None,'fallback':'original_range','automatic_action':False})
 print('Recording trees',flush=True);report['recording_tree_triage'],art=whole(recording_rows(c));save(a.output/'recording_triage_trees.json',art)
 report['cut_quantile_enabled']=enabled;report['error_analysis']={'fine_rows':len(fine),'fine_restored_whole':sum(abs(r['selected_start']-r['detected_start'])<=1 and abs(r['selected_end']-r['detected_end'])<=1 for r in fine),'fine_selected_over_four_minutes':sum(r['selected_end']-r['selected_start']>240 for r in fine),'fine_median_selected_fraction':float(np.median([(r['selected_end']-r['selected_start'])/(r['detected_end']-r['detected_start']) for r in fine]))}
 save(a.output/'cut_candidates_report.json',report);print(json.dumps(report,indent=2))
if __name__=='__main__':main()
