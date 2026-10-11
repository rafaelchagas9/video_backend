"""Feature-only CPU comparison. All learned transforms are fit on training folds."""
import json
from pathlib import Path
from collections import defaultdict
import numpy as np
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler, Normalizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, balanced_accuracy_score


def fold_ids(rows,n=5):
    counts=defaultdict(int)
    for r in rows: counts[r['group']]+=1
    loads=[0]*min(n,len(counts))
    assigned={}
    for group,count in sorted(counts.items(),key=lambda x:(-x[1],x[0])):
        fold=int(np.argmin(loads)); assigned[group]=fold; loads[fold]+=count
    return np.array([assigned[r['group']] for r in rows])


def features(rows,kind):
    base=np.array([r['base'] for r in rows],dtype=np.float64)
    if kind=='base':return base
    audio=np.array([r['audio'] for r in rows],dtype=np.float64) if 'audio' in kind else None
    vectors=np.array([r['embedding'] for r in rows],dtype=np.float64) if 'embedding' in kind else None
    # Unit vectors have a meaningful shared scale; don't inflate every one of 768 dimensions.
    extras=[]
    if audio is not None: extras.append(audio)
    if vectors is not None: extras.append(vectors)
    return np.hstack([base,*extras])


def held_out(rows,kind):
    from sklearn.compose import ColumnTransformer
    X=features(rows,kind); y=np.array([r['y'] for r in rows]); folds=fold_ids(rows)
    scores=np.full(len(y),np.nan)
    valid=[]
    width=6 if 'audio' in kind else 2
    for fold in sorted(set(folds)):
        train=folds!=fold; test=~train
        if len(set(y[train]))<2:continue
        assert set(r['group'] for i,r in enumerate(rows) if train[i]).isdisjoint(
               set(r['group'] for i,r in enumerate(rows) if test[i]))
        scaler=ColumnTransformer([('numeric',StandardScaler(),list(range(width)))],remainder='passthrough')
        model=make_pipeline(scaler,LogisticRegression(C=1.,max_iter=1000))
        model.fit(X[train],y[train]); scores[test]=model.decision_function(X[test]);valid.append(int(fold))
    mask=np.isfinite(scores)
    if mask.sum()!=len(y) or len(set(y[mask]))<2:
        return {'status':'insufficient_class_coverage','scored':int(mask.sum()),'total':len(y)}
    by_video=defaultdict(list)
    for i,r in enumerate(rows):by_video[r['recording']].append(i)
    correct=total=0.
    for ids in by_video.values():
        for k in (i for i in ids if y[i]):
            for s in (i for i in ids if not y[i]):
                total+=1;correct+=1. if scores[k]>scores[s] else .5 if scores[k]==scores[s] else 0.
    return {'status':'ok','rows':len(y),'channels':len(set(r['group'] for r in rows)),
            'keeps':int(y.sum()),'auroc':round(float(roc_auc_score(y,scores)),4),
            'balanced_accuracy':round(float(balanced_accuracy_score(y,scores>0)),4),
            'within_recording_pairs':int(total),
            'pair_accuracy':round(correct/total,4) if total else None,'valid_folds':valid}


def evaluate(payload):
    rows=payload['rows']; report={'target':payload['target'],'normalization':'training-fold only',
         'raw_media_uploaded':False,'comparisons':{},'limitations':[
         'Saved keep/skip labels measure coarse triage, not final storage preference.',
         'Audio-available cohorts may differ from the whole library.',
         'Embedding windows sample clips; they do not label every second.']}
    cohorts=[('all_saved',[r for r in rows],['base']),
             ('audio_cached',[r for r in rows if r['audio'] is not None],['base','base_audio']),
             ('embedding_pilot',[r for r in rows if 'embedding' in r],['base','base_embedding']),
             ('embedding_and_audio',[r for r in rows if 'embedding' in r and r['audio'] is not None],
                ['base','base_audio','base_embedding','base_audio_embedding'])]
    for name,cohort,kinds in cohorts:
        if len(cohort)<20 or len(set(r['group'] for r in cohort))<5 or len(set(r['y'] for r in cohort))<2:
            report['comparisons'][name]={'status':'waiting_for_features','rows':len(cohort)}
            continue
        report['comparisons'][name]={kind:held_out(cohort,kind) for kind in kinds}
    return report


def self_test():
    rows=[{'row':str(i),'group':f'g{i//4}','recording':f'r{i//4}','y':i%2,
           'base':[float(i+1),float(i%2)],'audio':[float(i%2),0.,1.,2.]} for i in range(40)]
    r=evaluate({'rows':rows,'target':'synthetic'})
    assert r['comparisons']['audio_cached']['base_audio']['status']=='ok'
    assert r['comparisons']['audio_cached']['base_audio']['auroc']>.99
    assert r['comparisons']['embedding_pilot']['status']=='waiting_for_features'
    assert set(fold_ids(rows))==set(range(5))
    assert fold_ids(rows[:4]).tolist()==[0]*4
    print('fold separation and comparison smoke tests: PASS')


if __name__=='__main__':
    import sys
    if len(sys.argv)==2 and sys.argv[1]=='--self-test':self_test()
    else:
        source=Path(sys.argv[1]);result=evaluate(json.loads(source.read_text()))
        destination=source.parent/'report.json'
        destination.write_text(json.dumps(result,indent=2,allow_nan=False))
        print(json.dumps(result,indent=2))
