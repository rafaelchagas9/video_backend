"""Matched original-range joint Gemma boundary evaluation; numeric caches only."""
import argparse,hashlib,json,os,time
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.utils.extmath import randomized_svd
from sklearn.metrics import roc_auc_score
from cut_and_whole import splits,save
import frame_cuts as fc
import nonlinear_boundary as nb
SAMPLING_DESCRIPTION='Sparse label-independent uniform 20-second samples; predictions use sampled window centres directly, without interpolation; unobserved gaps limit precise edge resolution'
REPORT_PREFIX='joint'
ARTIFACT_KIND='matched_joint_window_boundary'
NUMERIC_NAMES=list(fc.NAMES)
PIN='914f7f89142e33e77833254d9c9b90c3cef7303b'
FAMILIES=['siglip','image','audio','late_gemma','late_siglip','joint','joint_numeric','joint_siglip']
CONTROL_FAMILIES=('siglip','image','audio','late_gemma','late_siglip')
JOINT_FAMILIES=('joint','joint_numeric','joint_siglip')
RECIPES=[(family,'basic',C) for family in FAMILIES for C in (.1,1.,10.)]+[(family,'relative',1.) for family in ('audio','late_gemma','joint_numeric','joint_siglip')]

def load(cohort_file,cache):
 c=json.loads(cohort_file.read_text());rows=[];excluded=[];frame_cache={}
 coverage={r['row']:r for r in json.loads((cache/'coverage_report.json').read_text())['rows']}
 manifest={r['row']:r for r in json.loads((cache/'private_manifest.json').read_text())['rows']}
 for r in c['rows']:
  full=coverage.get(r['row'])
  if not full or not full['complete_original_coverage']:excluded.append({'row':r['row'],'reason':'incomplete_original_audio_coverage'});continue
  path=cache/'embeddings'/f"{r['row']}.npz"
  if not path.exists():excluded.append({'row':r['row'],'reason':'no_matched_joint_checkpoint'});continue
  with np.load(path) as z:
   values={k:z[k].copy() for k in z.files}
  a,b=r['detected_start'],r['detected_end'];offsets=np.asarray(values['offsets'],float);duration=b-a
  assert str(values['revision'])==PIN and abs(float(values['absolute_start'])-a)<.001 and abs(float(values['duration'])-duration)<.001
  expected=np.array([w['offset'] for w in manifest[r['row']]['windows']],float)
  if not len(offsets) or not np.array_equal(offsets,expected) or any(len(values[key])!=len(offsets) for key in ('joint','audio','image')):excluded.append({'row':r['row'],'reason':'incomplete_matched_joint_checkpoint'});continue
  assert offsets[0]<=a+.05 and offsets[-1]+20>=b-.05
  assert np.all(offsets>=a-.001) and np.all(offsets+20<=b+.001) and np.all(np.diff(offsets)>0)
  n=len(offsets)
  for key in ('joint','audio','image'):
   assert values[key].shape==(n,768) and np.isfinite(values[key]).all() and np.allclose(np.linalg.norm(values[key],axis=1),1,atol=.015)
  assert values['frame_times'].shape==(n,2) and np.isfinite(values['frame_times']).all()
  vid=r['video_id']
  if vid not in frame_cache:
   file=Path(r['visual_frame_cache']);assert hashlib.sha256(file.read_bytes()).hexdigest()==r['visual_cache_sha256']
   with np.load(file) as z:t,v=z['t'].copy(),z['v'].astype(np.float32)
   v/=np.maximum(np.linalg.norm(v,axis=1,keepdims=True),1e-9);activity=None;cheap=cohort_file.parent.parent/'audio'/f'{vid}.npz'
   if cheap.exists():
    with np.load(cheap) as z:
     if 'db' in z.files and 'flux' in z.files:
      def robust(x):
       x=np.asarray(x,float);spread=1.4826*np.median(np.abs(x-np.median(x)));return np.clip((x-np.median(x))/(spread or 1),-5,5)
      activity=robust(z['db'])+robust(z['flux'])
   frame_cache[vid]=(t,v,activity)
  t,v,activity=frame_cache[vid];visual=[]
  for offset,pair in zip(offsets,values['frame_times']):
   assert np.all(pair>=offset-.001) and np.all(pair<=offset+20+.001)
   ids=[int(np.argmin(np.abs(t-x))) for x in pair];assert np.allclose(t[ids],pair,atol=.001);mean=v[ids].mean(0);visual.append(mean/max(np.linalg.norm(mean),1e-9))
  visual=np.asarray(visual,np.float32);original=v[(t>=a)&(t<=b)];centre=original.mean(0);centre/=max(np.linalg.norm(centre),1e-9);times=offsets+10;transition=np.r_[0.,np.clip(1-np.sum(visual[1:]*visual[:-1],axis=1),0,2)];cheapvalues=np.zeros(n) if activity is None else activity[np.maximum(0,np.minimum(len(activity)-1,times.astype(int)))];numeric=np.stack([(times-a)/duration,visual@centre,transition,cheapvalues],1).astype(np.float32)
  overlap=np.maximum(0.,np.minimum(offsets+20,r['selected_end'])-np.maximum(offsets,r['selected_start']))/20;y=(overlap>=.8).astype(int);sample=[]
  for indices in (np.flatnonzero(overlap>=.8),np.flatnonzero(overlap<=.2)):
   if len(indices):sample.extend(indices[np.linspace(0,len(indices)-1,min(40,len(indices))).astype(int)].tolist())
  if not sample:excluded.append({'row':r['row'],'reason':'no_unambiguous_final_interval_window'});continue
  arrays={'siglip':visual,'image':values['image'],'audio':values['audio'],'late_gemma':np.concatenate([values['image'],values['audio']],1),'late_siglip':np.concatenate([visual,values['audio']],1),'joint':values['joint'],'joint_numeric':values['joint'],'joint_siglip':np.concatenate([visual,values['joint']],1)}
  rows.append(dict(r,times=times,offsets=offsets,arrays=arrays,numeric=numeric,y=y,sample=np.array(sample),recipe=str(values['recipe']) if 'recipe' in values else None))
 return rows,excluded

def weights(rows):return np.concatenate([np.full(len(r['sample']),80/max(1,len(r['sample']))) for r in rows])

def prepare(rows,recipe):
 family,kind,C=recipe;mean=components=None
 if kind=='relative':
  X=np.concatenate([r['arrays'][family][r['sample']] for r in rows]);w=weights(rows);mean=np.average(X,axis=0,weights=w);_,_,components=randomized_svd((X-mean)*np.sqrt(w/w.mean())[:,None],n_components=min(16,len(X)-1),n_iter=3,random_state=29)
 return {'family':family,'feature_kind':kind,'C':C,'pca_mean':mean,'pca_components':components}

def transform(pre,rows):
 result=[];family=pre['family']
 for r in rows:
  raw=r['arrays'][family];numeric=np.zeros_like(r['numeric']) if family=='joint' or family.endswith('_pure') else r.get('numeric_by_family',{}).get(family,r['numeric'])
  if pre['feature_kind']=='relative':
   pc=(raw-pre['pca_mean'])@pre['pca_components'].T;delta=np.abs(np.vstack([np.zeros_like(pc[0]),np.diff(pc,axis=0)]));mask=r.get('context_mask',np.ones(len(pc),bool));centre=pc[mask].mean(0) if np.any(mask) else np.zeros(pc.shape[1]);raw=np.concatenate([pc,pc-centre,delta],1)
  result.append(np.concatenate([raw,numeric],1).astype(np.float32))
 return result

def fit(rows,recipe):
 pre=prepare(rows,recipe);matrices=transform(pre,rows);X=np.concatenate([x[r['sample']] for x,r in zip(matrices,rows)]);y=np.concatenate([r['y'][r['sample']] for r in rows]);w=weights(rows);scale=StandardScaler().fit(X[:,-len(NUMERIC_NAMES):],sample_weight=w);X[:,-len(NUMERIC_NAMES):]=scale.transform(X[:,-len(NUMERIC_NAMES):]);model=LogisticRegression(C=recipe[2],solver='liblinear',max_iter=2000,class_weight='balanced',random_state=29).fit(X,y,sample_weight=w);return pre,scale,model

def probabilities(model,rows):
 pre,scale,m=model;out=[]
 for X in transform(pre,rows):
  X[:,-len(NUMERIC_NAMES):]=scale.transform(X[:,-len(NUMERIC_NAMES):]);p=m.predict_proba(X)[:,1];out.append(np.convolve(p,np.ones(3),'same')/np.convolve(np.ones(len(p)),np.ones(3),'same'))
 return out

def choose(rows,deadline):
 held=[[None]*len(rows) for _ in RECIPES]
 for tr,te in splits(rows,3):
  nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te]
  for j,recipe in enumerate(RECIPES):
   m=fit(train,recipe)
   for i,p in zip(te,probabilities(m,test)):held[j][i]=p
 settings=[]
 for j,ps in enumerate(held):
  options=[]
  for mode,level in nb.POLICIES:
   metric=fc.metrics(rows,fc.intervals(rows,ps,level,mode));score=metric['channel_macro_iou'] if metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9 else -10.;options.append((score,-level,-j,mode))
  best=max(options);settings.append({'recipe':j,'level':-best[1],'mode':best[3],'inner_score':best[0]})
 return settings

def gate(identity,candidate):return candidate['channel_macro_iou']>identity['channel_macro_iou']+.02 and candidate['channel_macro_retained']>=.97 and candidate['retention_p10']>=.9 and candidate['meaningfully_shortened']>=3

def error_diagnostic(rows,predictions,probs):
 channels=[]
 for group in sorted({r['group'] for r in rows}):
  ids=[i for i,r in enumerate(rows) if r['group']==group];subset=[rows[i] for i in ids];pred=[predictions[i] for i in ids];identity=fc.metrics(subset,[[r['detected_start'],r['detected_end']] for r in subset]);candidate=fc.metrics(subset,pred);leading=sum(min(r['selected_end']-r['selected_start'],max(0,p[0]-r['selected_start'])) for r,p in zip(subset,pred));trailing=sum(min(r['selected_end']-r['selected_start'],max(0,r['selected_end']-p[1])) for r,p in zip(subset,pred));auc=[roc_auc_score(r['y'][r['sample']],probs[i][r['sample']]) for r,i in zip(subset,ids) if len(set(r['y'][r['sample']]))==2];channels.append({'group':group,'rows':len(subset),'iou_delta':candidate['channel_macro_iou']-identity['channel_macro_iou'],'retained':candidate['channel_macro_retained'],'leading_selected_seconds_lost':leading,'trailing_selected_seconds_lost':trailing,'sample_classification_macro_auroc':float(np.mean(auc)) if auc else None})
 return {'per_channel':channels,'description':'Leading/trailing misses use final selected boundaries. Positive/negative window discrimination and safe interval enclosure are separate requirements.'}

def channel_bootstrap(rows,predictions):
 groups=sorted({r['group'] for r in rows});gain=[];retention=[]
 for group in groups:
  subset=[r for r in rows if r['group']==group];pred=[p for r,p in zip(rows,predictions) if r['group']==group];baseline=fc.metrics(subset,[[r['detected_start'],r['detected_end']] for r in subset]);candidate=fc.metrics(subset,pred);gain.append(candidate['channel_macro_iou']-baseline['channel_macro_iou']);retention.append(candidate['channel_macro_retained'])
 ids=np.random.default_rng(61010).integers(0,len(groups),(5000,len(groups)));gains=np.array(gain)[ids].mean(1);retains=np.array(retention)[ids].mean(1);gain_ci=np.quantile(gains,[.025,.975]);ret_ci=np.quantile(retains,[.025,.975]);return {'kind':'paired channel resampling of held-out predictions, diagnostic stability, not new independent labels','draws':5000,'gain_ci95':gain_ci.tolist(),'retention_ci95':ret_ci.tolist(),'probability_gain_positive':float(np.mean(gains>0)),'stable':bool(gain_ci[0]>0 and ret_ci[0]>=.97)}

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--cache',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seconds',type=int,default=170);a=p.parse_args();start=time.monotonic();deadline=start+a.seconds;rows,excluded=load(a.cohort,a.cache);assert len(rows)>=10 and len({r['group'] for r in rows})>=5
 names=FAMILIES+['nested_best_control']+(['nested_best_joint'] if any(x in JOINT_FAMILIES for x in FAMILIES) else [])+['nested_best_all'];predictions={name:[None]*len(rows) for name in names};probs={name:[None]*len(rows) for name in names};folds=[]
 for tr,te in splits(rows):
  nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];settings=choose(train,deadline);selected={}
  for family in FAMILIES:selected[family]=max((s for s in settings if RECIPES[s['recipe']][0]==family),key=lambda s:(s['inner_score'],-s['level'],-s['recipe']))
  control=[s for s in settings if RECIPES[s['recipe']][0] in CONTROL_FAMILIES];joint=[s for s in settings if RECIPES[s['recipe']][0] in JOINT_FAMILIES]
  for name,pool in [('nested_best_control',control),('nested_best_joint',joint),('nested_best_all',settings)]:
   if pool:selected[name]=max(pool,key=lambda s:(s['inner_score'],-s['level'],-s['recipe']))
  memo={}
  for name,s in selected.items():
   j=s['recipe']
   if j not in memo:memo[j]=probabilities(fit(train,RECIPES[j]),test)
   ps=memo[j]
   for i,value,pvalue in zip(te,fc.intervals(test,ps,s['level'],s['mode']),ps):predictions[name][i]=value;probs[name][i]=pvalue
  folds.append({'train':len(train),'test':len(test),'selections':{name:dict(s,recipe_description=RECIPES[s['recipe']]) for name,s in selected.items()}})
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);comparisons={}
 oracle=[]
 for r in rows:
  a0,b0=r['detected_start'],r['detected_end'];chosen=[r['selected_start'],r['selected_end']];options=[[a0,b0]]
  for lo in range(len(r['times'])):
   for hi in range(lo,len(r['times'])):options.append([max(a0,float(r['times'][lo])-10),min(b0,float(r['times'][hi])+15)])
  def geometry(interval):
   intersection=max(0,min(interval[1],chosen[1])-max(interval[0],chosen[0]));retained=intersection/(chosen[1]-chosen[0]);union=max(interval[1],chosen[1])-min(interval[0],chosen[0]);return intersection/union if retained>=.97 else -1.
  oracle.append(max(options,key=geometry))
 sampling_diagnostic={'clips_without_positive_sample':sum(not np.any(r['y'][r['sample']]) for r in rows),'positive_windows':sum(int(r['y'][r['sample']].sum()) for r in rows),'negative_windows':sum(int((1-r['y'][r['sample']]).sum()) for r in rows),'oracle_sample_geometry_97percent_retention':fc.metrics(rows,oracle),'oracle_is_diagnostic_only':True,'per_row':[{'row':r['row'],'positive':int(r['y'][r['sample']].sum()),'negative':int((1-r['y'][r['sample']]).sum()),'sampled_windows':len(r['times']),'largest_centre_gap_seconds':float(np.max(np.diff(r['times']))) if len(r['times'])>1 else None} for r in rows],'rows_with_both_classes':sum(len(set(r['y'][r['sample']]))==2 for r in rows)}
 for name in names:
  auc=[roc_auc_score(r['y'][r['sample']],ps[r['sample']]) for r,ps in zip(rows,probs[name]) if len(set(r['y'][r['sample']]))==2];m=fc.metrics(rows,predictions[name]);bootstrap=channel_bootstrap(rows,predictions[name]);comparisons[name]={'candidate':m,'frame_macro_auroc':float(np.mean(auc)) if auc else None,'nominal_gate':gate(identity,m),'channel_bootstrap':bootstrap,'passed':gate(identity,m) and bootstrap['stable'],'error_diagnostic':error_diagnostic(rows,predictions[name],probs[name])}
 enabled=comparisons['nested_best_all']['passed'];report={'input_contract':'Immutable original detected ranges -> final fine chosen interval; exact same complete-audio windows and two frozen storyboard frames across all modalities','rows':len(rows),'channels':len({r['group'] for r in rows}),'windows':sum(len(r['times']) for r in rows),'sampling_recipe':sorted({r['recipe'] for r in rows}),'temporal_resolution':SAMPLING_DESCRIPTION,'excluded':excluded,'identity':identity,'sampling_diagnostic':sampling_diagnostic,'comparisons':comparisons,'enabled':enabled,'recipes':RECIPES,'regularization_rationale':'Fixed C .1/1/10 spans stronger to weaker regularization; all choices use inner held-channel predictions. Relative context uses train-fold, clip-weighted PCA up to 16 components with clip-relative mean and adjacent differences, limiting dimensions for few independent clips. No outer-fold tuning.','validation':'Whole-channel outer5/inner3; C, modality, optional weighted PCA/context and policy selected training-only; identical cohorts; strict covered windows, no extrapolation','folds':folds,'seconds':time.monotonic()-start,'no_media_reads':True,'no_gpu':True,'no_production_writes':True}
 save(a.output/(REPORT_PREFIX+'_boundary_report.json'),report);save(a.output/(REPORT_PREFIX+'_boundary_predictions.json'),{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'times':r['times'].tolist(),'predictions':{name:predictions[name][i] for name in names}} for i,r in enumerate(rows)]})
 if enabled:
  settings=choose(rows,deadline);s=max(settings,key=lambda x:(x['inner_score'],-x['level'],-x['recipe']));recipe=RECIPES[s['recipe']];pre,scale,m=fit(rows,recipe);artifact={'schema_version':1,'kind':ARTIFACT_KIND,'enabled':True,'recipe':recipe,'model_revision':PIN,'pairing_recipe':rows[0]['recipe'],'numeric_features':NUMERIC_NAMES,'numeric_mean':scale.mean_.tolist(),'numeric_scale':scale.scale_.tolist(),'weights':m.coef_[0].tolist(),'bias':float(m.intercept_[0]),'pca_mean':pre['pca_mean'].tolist() if pre['pca_mean'] is not None else None,'pca_components':pre['pca_components'].tolist() if pre['pca_components'] is not None else None,'level':s['level'],'extraction_mode':s['mode'],'smoothing_radius':1,'window_seconds':20,'start_pad_seconds':10,'end_pad_seconds':15,'max_seconds':None,'constraints':{'min_seconds':5},'fallback':'original_range','automatic_action':False}
  X=transform(pre,rows)[0].copy();X[:,-len(NUMERIC_NAMES):]=(X[:,-len(NUMERIC_NAMES):]-scale.mean_)/scale.scale_;portable=X@np.array(artifact['weights'])+artifact['bias'];assert np.allclose(portable,m.decision_function(X),atol=1e-6);artifact['portable_logit_parity']='passed';save(a.output/(REPORT_PREFIX+'_boundary_envelope.json'),artifact)
 else:save(a.output/(REPORT_PREFIX+'_boundary_envelope.json'),{'schema_version':1,'kind':ARTIFACT_KIND,'enabled':False,'fallback':'original_range','automatic_action':False,'max_seconds':None})
 report['seconds']=time.monotonic()-start;save(a.output/(REPORT_PREFIX+'_boundary_report.json'),report);print(json.dumps({k:report[k] for k in ('rows','channels','windows','excluded','identity','sampling_diagnostic','comparisons','enabled','seconds')},indent=2))
if __name__=='__main__':main()
