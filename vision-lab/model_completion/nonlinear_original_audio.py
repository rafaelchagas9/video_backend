"""One fixed nonlinear semantic cut recipe on complete immutable originals."""
import argparse,json,time
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score
import dense_original_window_boundaries as da
import nonlinear_boundary as nb
import joint_window_boundaries as jw
import frame_cuts as fc
from cut_and_whole import splits,save

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--cache',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seconds',type=int,default=170);a=p.parse_args();start=time.monotonic();deadline=start+a.seconds;rows,excluded=da.load(a.cohort,a.cache)
 for r in rows:r['raw']=r['arrays']['late_siglip']
 nb.CONFIGS=[dict(max_leaf_nodes=15,min_samples_leaf=30,l2_regularization=5.)];pred=[None]*len(rows);probs=[None]*len(rows);folds=[]
 for tr,te in splits(rows):
  nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];config,level,mode,score=nb.choose(train,deadline);proj=nb.projection(train);model=nb.fit(proj,train,config);ps=nb.probabilities(proj,model,test)
  for i,x,v in zip(te,fc.intervals(test,ps,level,mode),ps):pred[i]=x;probs[i]=v
  folds.append({'train':len(train),'test':len(test),'mode':mode,'level':level,'inner_score':score})
 identity=fc.metrics(rows,[[r['detected_start'],r['detected_end']] for r in rows]);candidate=fc.metrics(rows,pred);bootstrap=jw.channel_bootstrap(rows,pred);nominal=jw.gate(identity,candidate);enabled=nominal and bootstrap['stable'];auc=[roc_auc_score(r['y'][r['sample']],ps[r['sample']]) for r,ps in zip(rows,probs) if len(set(r['y'][r['sample']]))==2]
 config,level,mode,_=nb.choose(rows,deadline);proj=nb.projection(rows);model=nb.fit(proj,rows,config);artifact=nb.portable(proj,model,(config,level,mode),enabled);artifact['kind']='nonlinear_original_audio_boundary';artifact['raw_features']='exact-window two-frozen-frame SigLIP1152 + matched unit Gemma audio768; complete immutable originals, no interpolation';artifact['input_contract']='immutable original -> final selected';x=nb.transform(proj,rows)[0][0];raw=artifact['init_bias']
 for tree in artifact['trees']:
  idx=0
  while tree[idx]['feature']>=0:node=tree[idx];idx=node['left'] if x[node['feature']]<=node['threshold'] else node['right']
  raw+=tree[idx]['value']
 assert abs(raw-float(model._raw_predict(x[None,:])[0,0]))<1e-8
 report={'input_contract':'Complete immutable original ranges -> final fine chosen interval','rows':len(rows),'channels':len({r['group'] for r in rows}),'windows':sum(len(r['times']) for r in rows),'fixed_recipe':dict(nb.CONFIGS[0],max_iter=80,learning_rate=.05,pca_components=16,context='within-clip deviation and adjacent PC differences',weights='clip and class balanced',early_stopping=False),'validation':'Whole-channel outer5/inner3; PCA fitted training-only; only interval policy selected in inner folds; fixed architecture; identity allowed','identity':identity,'candidate':candidate,'window_macro_auroc':float(np.mean(auc)),'nominal_gate':nominal,'bootstrap':bootstrap,'enabled':enabled,'error_diagnostic':jw.error_diagnostic(rows,pred,probs),'folds':folds,'excluded':excluded,'seconds':time.monotonic()-start,'portable_tree_parity':'passed','no_media_reads':True,'no_gpu':True,'no_production_writes':True}
 save(a.output/'nonlinear_original_audio_report.json',report);save(a.output/'nonlinear_original_audio_envelope.json',artifact);save(a.output/'nonlinear_original_audio_predictions.json',{'rows':[{'row':r['row'],'group':r['group'],'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predicted':p,'times':r['times'].tolist(),'probabilities':v.tolist()} for r,p,v in zip(rows,pred,probs)]});print(json.dumps(report,indent=2))
if __name__=='__main__':main()
