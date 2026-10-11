"""One bounded nonlinear temporal boundary check; immutable numeric inputs only."""
import argparse,json,os,time
from pathlib import Path
os.environ.setdefault('OPENBLAS_NUM_THREADS','2');os.environ.setdefault('OMP_NUM_THREADS','2')
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.utils.extmath import randomized_svd
from sklearn.metrics import roc_auc_score
from cut_and_whole import fine_boundaries,splits,save
import frame_cuts as fc
CONFIGS=[dict(max_leaf_nodes=7,min_samples_leaf=20,l2_regularization=3.),dict(max_leaf_nodes=15,min_samples_leaf=30,l2_regularization=5.)]
POLICIES=[('global',q) for q in (0.,.3,.4,.5,.6,.7)]+[('relative_quantile',q) for q in (.05,.1,.2,.3)]+[('contrast_mass',q) for q in (.001,.01,.03,.05)]+[('max_sum_relative',q) for q in (.1,.2,.3,.5)]

def check(deadline):
 if time.monotonic()>=deadline:raise TimeoutError('Bounded nonlinear comparison expired.')

def load(cohort_path,dense):
 cohort=json.loads(cohort_path.read_text());fine=fine_boundaries(cohort,cohort_path.parent);manifest=json.loads((dense/'staging_manifest.json').read_text());mapping={r['row']:r for r in manifest['rows']};rows=fc.build([r for r in fine if r['row'] in mapping],cohort_path.parent)
 for row in rows:
  r=mapping[row['row']]
  with np.load(dense/'embeddings'/f"{row['row']}.npz") as z:
   assert str(z['revision'])==manifest['model'][1] and float(z['absolute_start'])==r['absolute_start'] and float(z['duration'])==r['duration'];v=z['v'];times=r['absolute_start']+z['offsets']+10
  audio=np.stack([np.interp(row['times'],times,v[:,i]) for i in range(768)],1);audio/=np.maximum(np.linalg.norm(audio,axis=1,keepdims=True),1e-9);row['raw']=np.concatenate([row['X'][:,:1152],audio],1).astype(np.float32);row['numeric']=row['X'][:,-4:]
 return rows

def projection(rows):
 X=np.concatenate([r['raw'][r['sample']] for r in rows]);w=np.concatenate([np.full(len(r['sample']),80/max(1,len(r['sample']))) for r in rows]);mean=np.average(X,axis=0,weights=w);weighted=(X-mean)*np.sqrt(w/w.mean())[:,None];_,_,components=randomized_svd(weighted,n_components=min(16,len(X)-1),n_iter=3,random_state=29);return mean,components

def transform(proj,rows):
 mean,components=proj;output=[]
 for r in rows:
  pc=(r['raw']-mean)@components.T;context=pc-pc.mean(0);delta=np.abs(np.vstack([np.zeros_like(pc[0]),np.diff(pc,axis=0)]));output.append(np.concatenate([pc,context,delta,r['numeric']],1))
 return output

def fit(proj,rows,config):
 matrices=transform(proj,rows);X=np.concatenate([x[r['sample']] for x,r in zip(matrices,rows)]);y=np.concatenate([r['y'][r['sample']] for r in rows]);w=np.concatenate([np.full(len(r['sample']),80/max(1,len(r['sample']))) for r in rows]);positive=w[y==1].sum();negative=w[y==0].sum();assert positive>0 and negative>0;total=w.sum();w[y==1]*=total/(2*positive);w[y==0]*=total/(2*negative)
 model=HistGradientBoostingClassifier(max_iter=80,learning_rate=.05,early_stopping=False,random_state=29,**CONFIGS[config]).fit(X,y,sample_weight=w);return model

def probabilities(proj,model,rows):
 output=[]
 for x in transform(proj,rows):
  p=model.predict_proba(x)[:,1];output.append(np.convolve(p,np.ones(3),'same')/np.convolve(np.ones(len(p)),np.ones(3),'same'))
 return output

def choose(rows,deadline):
 held=[[None]*len(rows) for _ in CONFIGS]
 for tr,te in splits(rows,3):
  check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];proj=projection(train)
  for config in range(len(CONFIGS)):
   model=fit(proj,train,config)
   for i,p in zip(te,probabilities(proj,model,test)):held[config][i]=p
 options=[]
 for config in range(len(CONFIGS)):
  for mode,level in POLICIES:
   m=fc.metrics(rows,fc.intervals(rows,held[config],level,mode));score=m['channel_macro_iou'] if m['channel_macro_retained']>=.97 and m['retention_p10']>=.9 else -10.;options.append((score,-level,-config,mode))
 best=max(options);return -best[2],-best[1],best[3],best[0]

def portable(proj,model,setting,enabled):
 mean,components=proj;trees=[]
 for stage in model._predictors:
  nodes=stage[0].nodes
  assert not np.any(nodes['is_categorical'])
  trees.append([{'feature':int(n['feature_idx']) if not n['is_leaf'] else -2,'threshold':float(n['num_threshold']),'left':int(n['left']) if not n['is_leaf'] else -1,'right':int(n['right']) if not n['is_leaf'] else -1,'value':float(n['value'])} for n in nodes])
 return {'schema_version':1,'kind':'nonlinear_temporal_boundary','enabled':enabled,'automatic_action':False,'raw_features':'unit visual1152 + interpolated unit Gemma768','pca_mean':mean.tolist(),'pca_components':components.tolist(),'projected_features':'PC16 + PC-minus-clip-mean16 + absolute-PC-neighbor-difference16 + numeric4','numeric_features':fc.NAMES,'init_bias':float(model._baseline_prediction[0,0]),'trees':trees,'node_values_include_learning_rate':True,'level':setting[1],'extraction_mode':setting[2],'smoothing_radius':1,'start_pad_seconds':10,'end_pad_seconds':15,'constraints':{'min_seconds':5},'max_seconds':None,'fallback':'original_range'}

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--dense',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seconds',type=int,default=170);a=p.parse_args();deadline=time.monotonic()+a.seconds;rows=load(a.cohort,a.dense);pred=[None]*len(rows);probs=[None]*len(rows);folds=[]
 for tr,te in splits(rows):
  check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];config,level,mode,score=choose(train,deadline);proj=projection(train);model=fit(proj,train,config);ps=probabilities(proj,model,test)
  for i,x,v in zip(te,fc.intervals(test,ps,level,mode),ps):pred[i]=x;probs[i]=v
  folds.append({'train':len(train),'test':len(test),'config':config,'mode':mode,'level':level,'inner_score':score})
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);candidate=fc.metrics(rows,pred);auc=[roc_auc_score(r['y'][r['sample']],ps[r['sample']]) for r,ps in zip(rows,probs) if len(set(r['y'][r['sample']]))==2];enabled=candidate['channel_macro_iou']>identity['channel_macro_iou']+.02 and candidate['channel_macro_retained']>=.97 and candidate['retention_p10']>=.9 and candidate['meaningfully_shortened']>=3
 config,level,mode,_=choose(rows,deadline);proj=projection(rows);model=fit(proj,rows,config);artifact=portable(proj,model,(config,level,mode),enabled)
 # Verify exported tree sum before storing any portable head.
 x=transform(proj,rows)[0][0];raw=artifact['init_bias']
 for tree in artifact['trees']:
  idx=0
  while tree[idx]['feature']>=0:node=tree[idx];idx=node['left'] if x[node['feature']]<=node['threshold'] else node['right']
  raw+=tree[idx]['value']
 expected=float(model._raw_predict(x[None,:])[0,0]);assert abs(raw-expected)<1e-8
 report={'validation':'Whole-channel outer5 and inner3; PCA and weighting fitted using training clips only; clip-balanced and class-balanced weights; no random frame holdouts or early stopping','rows':len(rows),'channels':len({r['group'] for r in rows}),'configs':CONFIGS,'identity':identity,'candidate':candidate,'frame_macro_auroc':float(np.mean(auc)),'enabled':enabled,'folds':folds,'seconds':time.monotonic()-(deadline-a.seconds),'gate':'macroIoU improvement>.02, selected duration retention>=.97, p10>=.9, meaningful cuts>=3','no_media_reads':True,'no_gpu':True,'no_production_writes':True,'portable_tree_parity':'passed'}
 save(a.output/'nonlinear_boundary_report.json',report);save(a.output/'nonlinear_boundary_envelope.json',artifact);save(a.output/'nonlinear_boundary_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predicted':p,'times':r['times'].tolist(),'probabilities':v.tolist()} for r,p,v in zip(rows,pred,probs)]});print(json.dumps(report,indent=2))
if __name__=='__main__':main()
