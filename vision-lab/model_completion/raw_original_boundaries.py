"""Corrected boundary contract: immutable raw proposals to final human choices."""
import argparse,json,os,time
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
import numpy as np
from sklearn.metrics import roc_auc_score
from cut_and_whole import splits,save
import frame_cuts as fc
import nonlinear_boundary as nb
RECIPES=[('linear',.1),('linear',1.),('linear',10.),('nonlinear',0),('nonlinear',1)]

def targets(cohort_path,*,for_fit=True):
 import task_generation_inputs as task_inputs
 c=json.loads(cohort_path.read_text());snapshot=json.loads((cohort_path.parent/'private_snapshot.json').read_text())
 import fine_labels as fl
 if for_fit:fl.require_task_fit_scope(snapshot['tasks'],'original-range boundary targets')
 sidecar=task_inputs.load_sidecar(cohort_path.parent);records=task_inputs.feedback_map(snapshot,sidecar);groups={r['video_id']:r['group'] for r in c['recordings']};rows=[];unknown=[];previously_trimmed=0
 for task in snapshot['tasks']:
  if task['kind']!='versus' or task['answer'] not in ('a','b','both'):continue
  for side,selected in (task.get('detail') or {}).get('best',{}).items():
   if task['answer'] not in (side,'both'):continue
   context=task['context'][side];record=records.get(context['feedback_id']);vid=context['video_id'];name=f"fine{task['id']}{side}"
   if record is None or record.get('detected_start') is None or record.get('detected_end') is None:
    unknown.append(name);continue
   generation_input=None
   if sidecar is not None:
    if task_inputs.sidecar_features(sidecar,task,side,record) is None:unknown.append(name);continue
    frozen=next(r for r in sidecar['sides'] if r['task_id']==task['id'] and r['side']==side)
    generation_input={'feedback':record,'archive':frozen['archive']}
   a,b=float(record['detected_start']),float(record['detected_end']);start,end=float(selected['start_seconds']),float(selected['end_seconds'])
   if b-a<5 or vid not in groups or not a-.1<=start<end<=b+.1:unknown.append(name);continue
   context_a,context_b=map(float,context['clip']);trimmed=abs(context_a-a)>.1 or abs(context_b-b)>.1;previously_trimmed+=trimmed
   rows.append({'row':name,'video_id':vid,'group':groups[vid],'analyzed_at':record['analyzed_at'] if sidecar is not None else task['answered_at'],'detected_start':a,'detected_end':b,'selected_start':max(a,start),'selected_end':min(b,end),'reserved_fine_holdout':bool(task['context'].get('reserved_fine_holdout',False)),'fine_data_role':'holdout' if task['context'].get('reserved_fine_holdout',False) else 'training','context_clip':[context_a,context_b],'context_pretrimmed':trimmed,'original_bound_identity':'private_snapshot immutable detected_start/end','target_identity':'detail.best final chosen start/end',**({'task_generation_input':generation_input} if generation_input else {})})
 return rows,{'known_targets':len(rows),'unknown_original_bounds':unknown,'contexts_already_trimmed':previously_trimmed}

def prepare(rows,folder):
 rows=fc.build(rows,folder)
 for r in rows:r['raw']=r['X'][:,:1152];r['numeric']=r['X'][:,-4:]
 return rows

def choose(rows,deadline):
 held=[[None]*len(rows) for _ in RECIPES]
 for tr,te in splits(rows,3):
  nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];proj=nb.projection(train)
  for j,(kind,param) in enumerate(RECIPES):
   if kind=='linear':model=fc.fit(train,param);ps=fc.probabilities(model,test)
   else:model=nb.fit(proj,train,param);ps=nb.probabilities(proj,model,test)
   for i,p in zip(te,ps):held[j][i]=p
 options=[]
 for j,ps in enumerate(held):
  for mode,level in nb.POLICIES:
   metric=fc.metrics(rows,fc.intervals(rows,ps,level,mode));score=metric['channel_macro_iou'] if metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9 else -10.;options.append((score,-level,-j,mode))
 best=max(options);return -best[2],-best[1],best[3],best[0]

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seconds',type=int,default=170);a=p.parse_args();start=time.monotonic();deadline=start+a.seconds;targets_,contract=targets(a.cohort);rows=prepare(targets_,a.cohort.parent);pred=[None]*len(rows);prob=[None]*len(rows);folds=[]
 # Compare each fixed recipe on the same outer fold, while policy/C selection remains inner-only.
 for tr,te in splits(rows):
  nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];j,level,mode,inner=choose(train,deadline);kind,param=RECIPES[j]
  if kind=='linear':model=fc.fit(train,param);ps=fc.probabilities(model,test)
  else:proj=nb.projection(train);model=nb.fit(proj,train,param);ps=nb.probabilities(proj,model,test)
  for i,value,pvalue in zip(te,fc.intervals(test,ps,level,mode),ps):pred[i]=value;prob[i]=pvalue
  folds.append({'train':len(train),'test':len(test),'kind':kind,'parameter':param,'mode':mode,'level':level,'inner_score':inner})
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);candidate=fc.metrics(rows,pred);enabled=candidate['channel_macro_iou']>identity['channel_macro_iou']+.02 and candidate['channel_macro_retained']>=.97 and candidate['retention_p10']>=.9 and candidate['meaningfully_shortened']>=3;auc=[float(roc_auc_score(r['y'][r['sample']],ps[r['sample']])) for r,ps in zip(rows,prob) if len(set(r['y'][r['sample']]))==2]
 # Save validation before final fitting so a bounded timeout cannot lose the actual-input result.
 report={'input_contract':'Immutable original detected proposal -> final detail.best human-selected interval; no pretrimmed context as input','source':contract,'rows':len(rows),'channels':len({r['group'] for r in rows}),'recipes':RECIPES,'validation':'Whole-channel outer5/inner3; model recipe, linear C and interval policy selected only on inner folds; training-fold PCA/scaling; same identity and retention gates','identity':identity,'candidate':candidate,'frame_macro_auroc':float(np.mean(auc)) if auc else None,'enabled':enabled,'folds':folds,'seconds':time.monotonic()-start,'no_media_reads':True,'no_gpu':True,'dense_audio_used':False,'no_production_writes':True}
 save(a.output/'raw_original_boundary_report.json',report);save(a.output/'raw_original_boundary_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'pretrimmed_context':r['context_clip'],'selected':[r['selected_start'],r['selected_end']],'predicted':p,'times':r['times'].tolist(),'probabilities':v.tolist()} for r,p,v in zip(rows,pred,prob)]})
 j,level,mode,_=choose(rows,deadline);kind,param=RECIPES[j]
 if kind=='linear':
  scale,model=fc.fit(rows,param);artifact={'schema_version':1,'kind':'original_frame_boundary','enabled':enabled,'raw_features':'unit visual1152 at all immutable original proposal frame timestamps','numeric_features':fc.NAMES,'numeric_mean':scale.mean_.tolist(),'numeric_scale':scale.scale_.tolist(),'weights':model.coef_[0].tolist(),'bias':float(model.intercept_[0]),'C':param,'level':level,'extraction_mode':mode,'smoothing_radius':1,'start_pad_seconds':10,'end_pad_seconds':15,'constraints':{'min_seconds':5},'max_seconds':None,'fallback':'original_range','automatic_action':False}
 else:
  proj=nb.projection(rows);model=nb.fit(proj,rows,param);artifact=nb.portable(proj,model,(param,level,mode),enabled);artifact['kind']='original_nonlinear_frame_boundary';artifact['raw_features']='unit visual1152 at all immutable original proposal frame timestamps';artifact['dense_audio_used']=False
 artifact['input_contract']=report['input_contract'];save(a.output/'raw_original_boundary_envelope.json',artifact);report['final_kind']=kind;report['final_parameter']=param;report['seconds']=time.monotonic()-start;save(a.output/'raw_original_boundary_report.json',report);print(json.dumps(report,indent=2))
if __name__=='__main__':main()
