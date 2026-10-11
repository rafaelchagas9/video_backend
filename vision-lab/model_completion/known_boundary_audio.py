"""Nested recording-held-out boundary evaluation for known-channel personalization."""
import argparse,json,time
from pathlib import Path
import numpy as np
import dense_boundary_audio as d
from cut_and_whole import fine_boundaries,save,splits
import frame_cuts as fc
KINDS=['position','visual','audio','combined']
POLICIES=[('global',q) for q in (0.,.3,.4,.5,.6,.7)]+[('relative_quantile',q) for q in (.05,.1,.2,.3)]+[('contrast_mass',q) for q in (.001,.01,.03,.05)]+[('max_sum_relative',q) for q in (.1,.2,.3,.5)]
def record_splits(rows,k=5):return splits([dict(r,group=str(r['video_id'])) for r in rows],k)
def choose(rows):
 options=[]
 for kind in KINDS:
  for C in (.1,1.,10.):
   held=[None]*len(rows);known=[]
   for tr,te in record_splits(rows,3):
    channels={rows[i]['group'] for i in tr};a=[rows[i] for i in tr];b=[rows[i] for i in te]
    model=fc.fit(d.variant_rows(a,kind),C)
    for i,p in zip(te,fc.probabilities(model,d.variant_rows(b,kind))):
     held[i]=p
     if rows[i]['group'] in channels:known.append(i)
   if not known:continue
   subset=[rows[i] for i in known];probs=[held[i] for i in known]
   for mode,level in POLICIES:
    metric=fc.metrics(subset,fc.intervals(subset,probs,level,mode));options.append((fc.objective(metric),-level,-C,-KINDS.index(kind),mode))
 if not options:return 'position',.1,0.,'global'
 best=max(options);return KINDS[-best[3]],-best[2],-best[1],best[4]
def main():
 a=argparse.ArgumentParser();a.add_argument('--cohort',type=Path,required=True);a.add_argument('--dense',type=Path,required=True);a.add_argument('--output',type=Path);a=a.parse_args();out=a.output or a.dense
 c=json.loads(a.cohort.read_text());fine=fine_boundaries(c,a.cohort.parent);manifest=json.loads((a.dense/'staging_manifest.json').read_text());src=json.loads((a.cohort.parent.parent/'preference-audio-20261010'/'private_manifest.json').read_text());mapping={f"fine{r['task_id']}{r['row'][-1]}":r for r in src['rows']};score={r['row']:mapping[r['row']]['base'][1] for r in fine}
 rows=d.numeric_rows(fine,manifest['rows'],a.dense,a.cohort.parent,score);pred=[None]*len(rows);known=[];folds=[]
 for tr,te in record_splits(rows):
  train=[rows[i] for i in tr];test=[rows[i] for i in te];channels={r['group'] for r in train};kind,C,level,mode=choose(train);model=fc.fit(d.variant_rows(train,kind),C);prob=fc.probabilities(model,d.variant_rows(test,kind));values=fc.intervals(test,prob,level,mode)
  for i,value in zip(te,values):
   if rows[i]['group'] in channels:pred[i]=value;known.append(i)
   else:pred[i]=[rows[i]['detected_start'],rows[i]['detected_end']]
  folds.append({'train_recordings':len({r['video_id'] for r in train}),'test_recordings':len({r['video_id'] for r in test}),'known_clips':sum(rows[i]['group'] in channels for i in te),'variant':kind,'C':C,'level':level,'mode':mode})
 subset=[rows[i] for i in known];identity=fc.metrics(subset,[[r['detected_start'],r['detected_end']] for r in subset]);candidate=fc.metrics(subset,[pred[i] for i in known]);passed=candidate['channel_macro_iou']>identity['channel_macro_iou']+.02 and candidate['channel_macro_retained']>=.97 and candidate['retention_p10']>=.9 and candidate['meaningfully_shortened']>=3
 report={'validation':'Whole recordings held out in outer5 and inner3 folds; hyperparameters and modality picked on inner known-channel cohort only; unseen channels retain original range','fine_clips':len(rows),'known_test_clips':len(known),'known_test_recordings':len({rows[i]['video_id'] for i in known}),'known_channels':len({rows[i]['group'] for i in known}),'known_clip_fraction':len(known)/len(rows),'matched_known_identity':identity,'matched_known_candidate':candidate,'passed':passed,'folds':folds}
 save(out/'known_boundary_report.json',report);save(out/'known_boundary_predictions.json',{'rows':[{'row':r['row'],'known':i in known,'predicted':pred[i]} for i,r in enumerate(rows)]});print(json.dumps(report,indent=2))
if __name__=='__main__':main()
