"""Fixed known-channel prototypes, held whole recordings out, immutable originals."""
import argparse,json,time
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score
import dense_original_window_boundaries as da
import joint_window_boundaries as jw
import nonlinear_boundary as nb
import frame_cuts as fc
from cut_and_whole import save
KINDS=['audio_prototype','fusion_prototype','audio_conditioned']

def leaves(rows):
 for vid in sorted({r['video_id'] for r in rows}):yield [i for i,r in enumerate(rows) if r['video_id']!=vid],[i for i,r in enumerate(rows) if r['video_id']==vid]

def prototype_probs(train,test,kind):
 family='late_siglip' if kind=='fusion_prototype' else 'audio_pure';proto={}
 for group in {r['group'] for r in train}:
  values=[]
  for label in (0,1):
   means=[]
   for r in train:
    if r['group']!=group:continue
    ids=r['sample'][r['y'][r['sample']]==label]
    if not len(ids):continue
    raw=r['arrays'][family][ids];raw=raw/np.maximum(np.linalg.norm(raw,axis=1,keepdims=True),1e-9);mean=raw.mean(0);means.append(mean/max(np.linalg.norm(mean),1e-9))
   if not means:break
   mean=np.mean(means,0);values.append(mean/max(np.linalg.norm(mean),1e-9))
  if len(values)==2:proto[group]=values
 globalps=jw.probabilities(jw.fit(train,('audio_pure','basic',.1)),test) if kind=='audio_conditioned' else None
 probs=[];available=[]
 for i,r in enumerate(test):
  present=r['group'] in proto;available.append(present)
  if present:
   negative,positive=proto[r['group']];raw=r['arrays'][family];raw=raw/np.maximum(np.linalg.norm(raw,axis=1,keepdims=True),1e-9);margin=raw@(positive-negative);p=1/(1+np.exp(-5*margin));p=np.convolve(p,np.ones(3),'same')/np.convolve(np.ones(len(p)),np.ones(3),'same')
   if globalps is not None:p=.5*p+.5*globalps[i]
  else:p=np.ones(len(r['times']))
  probs.append(p)
 return probs,available

def choose(rows,deadline):
 options=[]
 for j,kind in enumerate(KINDS):
  held=[None]*len(rows);known=[];available=[False]*len(rows)
  for tr,te in leaves(rows):
   nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];ps,ok=prototype_probs(train,test,kind);groups={r['group'] for r in train}
   for i,p,valid in zip(te,ps,ok):held[i]=p;available[i]=valid
   known.extend(i for i in te if rows[i]['group'] in groups)
  if not known:continue
  subset=[rows[i] for i in known];ps=[held[i] for i in known]
  for mode,level in nb.POLICIES:
   pred=fc.intervals(subset,ps,level,mode)
   for x,i in enumerate(known):
    if not available[i]:pred[x]=[rows[i]['detected_start'],rows[i]['detected_end']]
   metric=fc.metrics(subset,pred);score=metric['channel_macro_iou'] if metric['channel_macro_retained']>=.97 and metric['retention_p10']>=.9 else -10
   options.append((score,-level,-j,mode))
 if not options:return KINDS[0],0.,'global'
 best=max(options);return KINDS[-best[2]],-best[1],best[3]

def main():
 p=argparse.ArgumentParser();p.add_argument('--cohort',type=Path,required=True);p.add_argument('--cache',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seconds',type=int,default=115);a=p.parse_args();start=time.monotonic();deadline=start+a.seconds;rows,excluded=da.load(a.cohort,a.cache);pred=[None]*len(rows);prob=[None]*len(rows);known=[];folds=[]
 for tr,te in leaves(rows):
  nb.check(deadline);train=[rows[i] for i in tr];test=[rows[i] for i in te];kind,level,mode=choose(train,deadline);ps,available=prototype_probs(train,test,kind);proposed=fc.intervals(test,ps,level,mode);groups={r['group'] for r in train};trainvids={r['video_id'] for r in train};assert not trainvids&{r['video_id'] for r in test}
  for i,value,pvalue,ok in zip(te,proposed,ps,available):
   is_known=rows[i]['group'] in groups
   if is_known:known.append(i)
   pred[i]=value if is_known and ok else [rows[i]['detected_start'],rows[i]['detected_end']];prob[i]=pvalue
  folds.append({'test_recording':test[0]['video_id'],'test_rows':[r['row'] for r in test],'known':sum(r['group'] in groups for r in test),'prototype_available':sum(available),'kind':kind,'mode':mode,'level':level})
 subset=[rows[i] for i in known];matched=[pred[i] for i in known];identity=fc.metrics(subset,[[r['detected_start'],r['detected_end']] for r in subset]);candidate=fc.metrics(subset,matched);bootstrap=jw.channel_bootstrap(subset,matched);nominal=jw.gate(identity,candidate);auc=[roc_auc_score(rows[i]['y'][rows[i]['sample']],prob[i][rows[i]['sample']]) for i in known if len(set(rows[i]['y'][rows[i]['sample']]))==2];chronological=[]
 for r in rows:
  prior=[q for q in rows if q['video_id']!=r['video_id'] and q['group']==r['group'] and q['analyzed_at']<r['analyzed_at']]
  if prior:chronological.append(r)
 report={'input_contract':'Immutable original ranges -> final chosen interval; known-channel personalization only','validation':'Outer leave-whole-recording-out; inner leave-whole-recording-out chooses fixed three recipes/cut policy on matched known-channel subset only. Prototypes always built from OTHER training recordings; unavailable positive/outside class forces identity. Unseen channels identity.','rows':len(rows),'known_rows':len(known),'known_recordings':len({r['video_id'] for r in subset}),'known_channels':len({r['group'] for r in subset}),'coverage':len(known)/len(rows),'identity':identity,'candidate':candidate,'nominal_gate':nominal,'bootstrap':bootstrap,'passed':nominal and bootstrap['stable'],'window_macro_auroc':float(np.mean(auc)),'error_diagnostic':jw.error_diagnostic(subset,matched,[prob[i] for i in known]),'chronological':{'known_rows':len(chronological),'channels':len({r['group'] for r in chronological}),'status':'insufficient independent chronological known-channel targets for promotion','timestamp':'human judgment analyzed_at; equal-time paired judgments not ordered'},'fixed_recipes':KINDS,'fixed_conditioning':{'prototype_sigmoid_margin_scale':5,'global_C':.1,'global_mix':.5,'global_features':'audio_pure','class_missing':'identity'},'folds':folds,'excluded':excluded,'seconds':time.monotonic()-start,'no_media_reads':True,'no_gpu':True}
 save(a.output/'known_original_prototype_report.json',report);save(a.output/'known_original_prototype_predictions.json',{'rows':[{'row':r['row'],'known':i in known,'original':[r['detected_start'],r['detected_end']],'selected':[r['selected_start'],r['selected_end']],'predicted':pred[i]} for i,r in enumerate(rows)]});save(a.output/'known_original_prototype_envelope.json',{'schema_version':1,'enabled':False,'fallback':'original_range','promotion_requires_chronological_validation':True});print(json.dumps(report,indent=2))
if __name__=='__main__':main()
