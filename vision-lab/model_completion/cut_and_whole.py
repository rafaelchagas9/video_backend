"""Numeric-only cut and recording heads. Never changes production decisions.

OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 python cut_and_whole.py --cohort PATH --output DIR
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
from collections import defaultdict
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('OMP_NUM_THREADS', '2')
import numpy as np
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

RECORDING_FEATURES = ['log_seconds', 'log_proposals', 'score_mean', 'score_max',
                      'proposed_coverage', 'dispersion_mean', 'transition_mean', 'has_frames_fraction']


def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.partial')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False)); tmp.chmod(0o600); tmp.replace(path)


def splits(rows, k=5):
    counts = defaultdict(int)
    for row in rows: counts[row['group']] += 1
    load = [0] * min(k, len(counts)); assignment = {}
    for group in sorted(counts, key=lambda g: (-counts[g], g)):
        f = int(np.argmin(load)); assignment[group] = f; load[f] += counts[group]
    ids = np.array([assignment[r['group']] for r in rows])
    return [(np.flatnonzero(ids != i), np.flatnonzero(ids == i)) for i in range(len(load))]


def constrained(fractions, span):
    a, b = span; seconds = b - a
    minimum = min(5., seconds)
    start = a + np.clip(fractions[0], 0., 1.) * seconds
    end = a + np.clip(fractions[1], 0., 1.) * seconds
    start = min(max(float(start), a), b - minimum)
    end = min(max(float(end), start + minimum), b)
    return [start, end]


def interval_metrics(rows, predictions):
    iou, retained, extra, shortened = [], [], [], []
    by_group = defaultdict(list)
    for i, (row, pred) in enumerate(zip(rows, predictions)):
        truth = [row['selected_start'], row['selected_end']]
        overlap = max(0., min(truth[1], pred[1]) - max(truth[0], pred[0]))
        union = max(truth[1], pred[1]) - min(truth[0], pred[0])
        iou.append(overlap / max(1e-9, union))
        retained.append(overlap / max(1e-9, truth[1] - truth[0]))
        extra.append(max(0., pred[1] - pred[0] - overlap) / max(1e-9, truth[1] - truth[0]))
        shortened.append(pred[1] - pred[0] < row['detected_end'] - row['detected_start'] - 1.)
        by_group[row['group']].append(i)
    if not rows: return {'rows': 0}
    macro = lambda values: float(np.mean([np.mean(np.array(values)[indices]) for indices in by_group.values()]))
    changed = [i for i,r in enumerate(rows) if abs(r['selected_start']-r['detected_start'])>1. or abs(r['selected_end']-r['detected_end'])>1.]
    return {'rows':len(rows), 'channels':len(by_group), 'mean_iou':float(np.mean(iou)),
            'channel_macro_iou':macro(iou), 'selected_duration_retained':float(np.mean(retained)),
            'channel_macro_retained':macro(retained), 'retention_p10':float(np.quantile(retained,.1)),
            'mean_excess_fraction':float(np.mean(extra)), 'modified_labels':len(changed),
            'modified_iou':float(np.mean(np.array(iou)[changed])) if changed else None,
            'shortened_predictions':sum(shortened)}


def eligible_cuts(rows):
    result = []
    for row in rows:
        if not row['y'] or row['added'] or row['keep_whole'] or not row['has_original_edges']: continue
        a,b = row['detected_start'], row['detected_end']; s,e = row['selected_start'],row['selected_end']
        if not all(v is not None and math.isfinite(v) for v in [a,b,s,e]): continue
        if b-a < 5 or not a-.1 <= s < e <= b+.1: continue
        result.append(dict(row,selected_start=max(a,s),selected_end=min(b,e)))
    return result


def targets(rows):
    return np.array([[(r['selected_start']-r['detected_start'])/(r['detected_end']-r['detected_start']),
                     (r['selected_end']-r['detected_start'])/(r['detected_end']-r['detected_start'])] for r in rows])


def fit_cut(rows, alpha):
    import fine_labels as fl
    fl.require_fit_scope(rows,'cut offset fitting')
    X = np.array([r['features'] for r in rows]); y = targets(rows)
    return make_pipeline(StandardScaler(),Ridge(alpha=alpha)).fit(X,y)


def predict_cut(model, rows):
    fractions = model.predict(np.array([r['features'] for r in rows]))
    return [constrained(f,[r['detected_start'],r['detected_end']]) for r,f in zip(rows,fractions)]


def choose_alpha(rows):
    if len({r['group'] for r in rows}) < 3: return 100.
    candidates = []
    for alpha in (1.,10.,100.):
        values = []
        for train,test in splits(rows,3):
            if len(train)<4: continue
            trainrows=[rows[i] for i in train]; testrows=[rows[i] for i in test]
            m=interval_metrics(testrows,predict_cut(fit_cut(trainrows,alpha),testrows))
            values.append(m['channel_macro_iou']-4.*(1.-m['channel_macro_retained']))
        candidates.append((float(np.mean(values)) if values else -np.inf,alpha))
    return max(candidates)[1]


def portable(model):
    scaler, estimator = model.steps[0][1],model.steps[1][1]
    return {'mean':scaler.mean_.tolist(),'scale':scaler.scale_.tolist(),
            'weights':estimator.coef_.tolist(),'bias':np.asarray(estimator.intercept_).tolist()}


def cuts(cohort):
    rows=eligible_cuts(cohort['rows']); identity=[[r['detected_start'],r['detected_end']] for r in rows]
    result={'target':'saved kept-range outcome, not frame-level worth labels','identity':interval_metrics(rows,identity),
            'validation':'whole-channel outer folds; alpha selected in training-only grouped folds',
            'limitations':['Coarse keep means potential; saved trims may not be polished storage boundaries.',
                           'Versus confirmation had earlier confusing UX; fine outcomes are a separate diagnostic.']}
    artifact={'schema_version':1,'kind':'cut_offsets','feature_names':cohort['features'],'enabled':False,
              'fallback':'original_range','constraints':{'min_seconds':5},'targets':['start_fraction','end_fraction']}
    if len(rows)<12 or len({r['group'] for r in rows})<3:
        result['status']='insufficient_cut_labels'; return result,artifact
    predictions=[None]*len(rows); folds=[]
    for train,test in splits(rows):
        trainrows=[rows[i] for i in train]; testrows=[rows[i] for i in test]
        if len(trainrows)<4: result['status']='insufficient_training_fold'; return result,artifact
        alpha=choose_alpha(trainrows); model=fit_cut(trainrows,alpha)
        for i,pred in zip(test,predict_cut(model,testrows)): predictions[i]=pred
        folds.append({'train':len(train),'test':len(test),'alpha':alpha})
    metrics=interval_metrics(rows,predictions); result.update(candidate=metrics,folds=folds)
    base=result['identity']
    enabled=(len(rows)>=30 and len({r['group'] for r in rows})>=8 and metrics['channel_macro_iou']>base['channel_macro_iou']+.02
             and metrics['channel_macro_retained']>=.97 and metrics['retention_p10']>=.9)
    result['status']='validated_candidate' if enabled else 'preserve_original_range'
    result['gate']={'min_rows':30,'min_channels':8,'min_macro_iou_gain':.02,'min_macro_selected_retention':.97,'min_retention_p10':.9}
    alpha=choose_alpha(rows); final=fit_cut(rows,alpha)
    artifact.update(portable(final),enabled=enabled,alpha=alpha)
    # Known-channel temporal diagnostic never drives selection.
    dated=[dict(r,validation_time=r.get('updated_at') or r.get('analyzed_at')) for r in rows if r.get('updated_at') or r.get('analyzed_at')]
    if len(dated)>=20:
        times=sorted(set(r['validation_time'] for r in dated)); cutoff=times[min(len(times)-1,int(.8*len(times)))]
        train=[r for r in dated if r['validation_time']<cutoff]; test=[r for r in dated if r['validation_time']>=cutoff]
        if len(train)>=8 and len(test)>=4:
            result['chronological']={'time_field':'updated_at, or answered_at for versus','cutoff':cutoff,'train':len(train),'test':len(test),
                                    'identity':interval_metrics(test,[[r['detected_start'],r['detected_end']] for r in test]),
                                    'candidate':interval_metrics(test,predict_cut(fit_cut(train,choose_alpha(train)),test))}
    return result,artifact


def covered(ranges):
    merged=[]
    for a,b in sorted(ranges):
        if not merged or a>merged[-1][1]: merged.append([a,b])
        else: merged[-1][1]=max(b,merged[-1][1])
    return sum(b-a for a,b in merged)


def recording_rows(cohort):
    rows_by_video=defaultdict(list)
    for row in cohort['rows']:
        if not row['added'] and not row['keep_whole'] and row['has_original_edges']: rows_by_video[row['video_id']].append(row)
    index={name:i for i,name in enumerate(cohort['features'])}; output=[]
    for recording in cohort['recordings']:
        original=rows_by_video[recording['video_id']]
        if recording.get('original_proposals'):
            original=[dict(r, detected_start=r['start'], detected_end=r['end']) for r in recording['original_proposals']]
        if not original: continue
        duration=max(1.,float(recording['duration'] or max(r['detected_end'] for r in original)))
        scores=[float(r['score']) for r in original]
        features=[math.log(duration),math.log1p(len(original)),float(np.mean(scores)),max(scores),
                  min(1.,covered([(max(0.,r['detected_start']),min(duration,r['detected_end'])) for r in original])/duration)]
        features += [float(np.mean([r['features'][index[name]] for r in original])) for name in ('dispersion_mean','transition_mean','has_frames')]
        if recording.get('features') is not None:
            assert len(recording['features'])==len(RECORDING_FEATURES)
            features=recording['features']
        output.append(dict(recording,features=features,analyzed_at=recording.get('analyzed_at') or max((r.get('analyzed_at') or '') for r in original)))
    return output


def classification_metrics(y,p):
    return {'rows':len(y),'positives':int(sum(y)),'auroc':float(roc_auc_score(y,p)) if len(set(y))==2 else None,
            'brier':float(brier_score_loss(y,p))}


def recording_head(rows,target):
    artifact={'schema_version':1,'kind':target,'feature_names':RECORDING_FEATURES,'enabled':False,
              'fallback':'no_recording_recommendation','automatic_action':False}
    if target!='recording_any_keep':
        # Human clarification invalidates both near-full positives and mixed low-
        # coverage negatives. Preserve historical reports; never fit this proxy.
        artifact.update(label_policy='whole-recording-current-review-v1', invalidated=True)
        return {'target':target,'status':'invalidated_whole_coverage_proxy',
                'label_policy':'whole-recording-current-review-v1','model_fit_count':0,
                'limitation':'Near-full keeps mean edited clips only. Only explicit keep_whole and nonempty saved all-skip reviews define current whole labels; mixed recordings are unknown.',
                'historical_results_preserved':True},artifact
    selected=rows; labels=np.array([int(r['any_keep']) for r in rows]); caveat='Triage potential, not final storage worth.'
    result={'target':target,'rows':len(selected),'channels':len({r['group'] for r in selected}),'positives':int(sum(labels)),
            'explicit_whole':sum(r['explicit_whole'] for r in selected),'limitation':caveat,
            'validation':'whole channels held out; training-fold scaling, fixed C=1',
            'features_exclude':['selected ranges','keep verdicts','added/whole synthetic proposal rows']}
    if len(selected)<20 or len(set(labels))<2 or min(sum(labels),len(labels)-sum(labels))<5 or result['channels']<5:
        result['status']='insufficient_recording_labels'; return result,artifact
    X=np.array([r['features'] for r in selected]); predictions=np.full(len(selected),np.nan); baseline=predictions.copy()
    for train,test in splits(selected):
        if len(set(labels[train]))<2:
            result['status']='insufficient_training_classes'; return result,artifact
        model=make_pipeline(StandardScaler(),LogisticRegression(C=1.,solver='liblinear',max_iter=2000)).fit(X[train],labels[train])
        predictions[test]=model.predict_proba(X[test])[:,1]; baseline[test]=labels[train].mean()
    result['candidate']=classification_metrics(labels,predictions); result['base_rate']=classification_metrics(labels,baseline)
    enabled=target=='recording_any_keep' and result['candidate']['brier']<result['base_rate']['brier']-.01 and result['candidate']['auroc']>=.65
    result['status']='validated_triage_suggestion' if enabled else 'no_automatic_recommendation'
    dated=sorted([(r.get('analyzed_at'),i) for i,r in enumerate(selected) if r.get('analyzed_at')])
    if len(dated)>=25:
        cutoff=dated[int(.8*len(dated))][0]
        train=np.array([i for time,i in dated if time<cutoff]);test=np.array([i for time,i in dated if time>=cutoff])
        if len(train)>=15 and len(test)>=5 and len(set(labels[train]))==2:
            temporal=make_pipeline(StandardScaler(),LogisticRegression(C=1.,solver='liblinear',max_iter=2000)).fit(X[train],labels[train])
            result['chronological']={'time_field':'recording analyzed_at','cutoff':cutoff,'train':len(train),'test':len(test),
                                     'candidate':classification_metrics(labels[test],temporal.predict_proba(X[test])[:,1]),
                                     'base_rate':classification_metrics(labels[test],np.full(len(test),labels[train].mean())),
                                     'limitation':'Analysis-time cohort split; retrospective labels are not a true forward deployment trial.'}
    model=make_pipeline(StandardScaler(),LogisticRegression(C=1.,solver='liblinear',max_iter=2000)).fit(X,labels)
    values=portable(model); values['weights']=values['weights'][0]; values['bias']=values['bias'][0]
    artifact.update(values,enabled=enabled,label_interpretation=caveat)
    return result,artifact


def fine_boundaries(cohort,folder,*,for_fit=True):
    path=folder/'private_snapshot.json'
    if not path.exists(): return []
    snapshot=json.loads(path.read_text()); byvid=defaultdict(list)
    import fine_labels as fl
    if for_fit:fl.require_task_fit_scope(snapshot['tasks'],'fine boundary targets')
    groups={r['video_id']:r['group'] for r in cohort['recordings']}
    durations={r['video_id']:r['duration'] for r in cohort['recordings']}
    for record in snapshot['records']: byvid[record['video_id']].append(record)
    # Pure numeric helper shared with production feature parity; no database access.
    from prepare import features as frame_features
    result=[]
    for task in snapshot['tasks']:
        if task['kind']!='versus' or task['answer'] not in ('a','b','both'): continue
        for side,selected in (task.get('detail') or {}).get('best',{}).items():
            if task['answer'] not in (side,'both'): continue
            context=task['context'][side];vid=context['video_id']
            if vid not in groups: continue
            a,b=map(float,context['clip']);start=float(selected['start_seconds']);end=float(selected['end_seconds'])
            if b-a<5. or not a-.1<=start<end<=b+.1: continue
            proposals=[]; target=None
            for rec in byvid[vid]:
                if rec['added']: continue
                proposal={'start':float(rec['detected_start'] if rec['detected_start'] is not None else rec['start_seconds']),
                          'end':float(rec['detected_end'] if rec['detected_end'] is not None else rec['end_seconds']),
                          'score':float(rec['score'])}
                if rec['id']==context['feedback_id']:
                    proposal.update(start=a,end=b,score=float(context['score']));target=len(proposals)
                proposals.append(proposal)
            if target is None:
                target=len(proposals);proposals.append({'start':a,'end':b,'score':float(context['score'])})
            cached=folder/'frames'/f'{vid}.npz'
            if cached.exists():
                with np.load(cached) as z: t,v=z['t'],z['v']
            else: t=v=None
            feature=frame_features(proposals,durations[vid],t,v)[target]
            result.append({'row':f"fine{task['id']}{side}",'video_id':vid,'group':groups[vid],
                           'reserved_fine_holdout':bool(task['context'].get('reserved_fine_holdout',False)),'fine_data_role':'holdout' if task['context'].get('reserved_fine_holdout',False) else 'training','analyzed_at':task['answered_at'],'y':1,'added':False,'keep_whole':False,
                           'has_original_edges':True,'detected_start':a,'detected_end':b,
                           'selected_start':max(a,start),'selected_end':min(b,end),'features':feature})
    return result


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--cohort',type=Path,required=True); parser.add_argument('--output',type=Path,required=True); args=parser.parse_args()
    cohort=json.loads(args.cohort.read_text()); assert all(len(r['features'])==len(cohort['features']) for r in cohort['rows'])
    assert np.isfinite(np.array([r['features'] for r in cohort['rows']])).all()
    cutreport,cutartifact=cuts(cohort); recordings=recording_rows(cohort)
    fine=fine_boundaries(cohort,args.cohort.parent)
    if fine:
        fine_report,_=cuts({'features':cohort['features'],'rows':fine})
        cutreport['fine_versus_confirmation']=fine_report
        # Fine confirmations are a separate evidence gate, not merely extra coarse examples.
        if cutartifact['enabled']:
            candidate=fine_report.get('candidate',{}); base=fine_report.get('identity',{})
            if candidate.get('channel_macro_iou',0.)<=base.get('channel_macro_iou',1.) or candidate.get('channel_macro_retained',0.)<.97:
                cutartifact['enabled']=False;cutreport['status']='preserve_original_range'
                cutreport['fine_confirmation_gate']='Fine held-out confirmations do not support automatic shrinking.'
    triagereport,triageartifact=recording_head(recordings,'recording_any_keep')
    wholereport,wholeartifact=recording_head(recordings,'recording_whole_coverage_proxy')
    report={'schema_version':1,'cohort_sha256':hashlib.sha256(args.cohort.read_bytes()).hexdigest(),
            'cuts':cutreport,'recording_triage':triagereport,'recording_whole_proxy':wholereport,
            'no_production_writes':True,'no_media_reads':True,'cloud_credits':0}
    for name,value in [('cuts.json',cutartifact),('recording_triage.json',triageartifact),('recording_whole_proxy.invalidated-whole-review-v1.json',wholeartifact),('cut_and_whole_report.whole-review-v1.json',report)]: save(args.output/name,value)
    print(json.dumps(report,indent=2,allow_nan=False))

if __name__=='__main__': main()
