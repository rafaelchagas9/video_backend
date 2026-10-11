"""Fixed CPU eGeMAPSv02 diagnostic on the exact heard previews; no media-source reads."""
from collections import defaultdict
import hashlib, importlib.metadata, json, os, sys, time, warnings
from pathlib import Path
import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler
LAB=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(LAB/'model_completion'))
import fine_labels as fl
ROOT=LAB/'data'/'preference-audio-20261010'
SNAPSHOT=LAB/'data'/'model-completion-20261010'/'private_snapshot.json'

def save(path,value):
    temp=path.with_suffix('.partial');temp.write_text(json.dumps(value,allow_nan=False));temp.chmod(0o600);temp.replace(path)

def annotate_cohort(payload,meta,snapshot):
    # The frozen task answers and exact pre-answer offered ranges are authoritative, never legacy y.
    return fl.annotate_rows(payload['rows'],meta['rows'],snapshot['tasks'])

def labeled_cohort(rows,values,relative=False):
    values=np.asarray(values)
    if values.ndim<1 or len(values)!=len(rows):raise ValueError('Row/feature alignment mismatch')
    if not np.isfinite(values).all():raise ValueError('Non-finite diagnostic values')
    selected=fl.ranking_rows(rows) if relative else fl.absolute_rows(rows)
    indices={row['row']:i for i,row in enumerate(rows)}
    if len(indices)!=len(rows):raise fl.FineLabelContractError('Duplicate diagnostic side identity')
    return selected,values[[indices[row['row']] for row in selected]]

def strict_pairs(rows):
    pairs=defaultdict(list)
    for i,row in enumerate(rows):pairs[row['recording']].append(i)
    result=[]
    for ids in pairs.values():
        if len(ids)!=2 or len({rows[i]['y'] for i in ids})!=2:continue
        a=next(i for i in ids if rows[i]['y']);b=next(i for i in ids if not rows[i]['y'])
        if rows[a]['group']!=rows[b]['group']:raise fl.FineLabelContractError('Ranking pair crosses channel groups')
        result.append((a,b))
    return result

def eligibility(rows):
    absolute=fl.absolute_rows(rows);ranking=fl.ranking_rows(rows)
    target={'status':'ready','rows':len(absolute)}
    try:fl.require_binary([row['y'] for row in absolute],'explicit absolute training')
    except fl.InsufficientAbsoluteLabels:target['status']='insufficient_absolute_labels'
    else:
        for group in sorted({row['group'] for row in absolute}):
            try:fl.require_binary([row['y'] for row in absolute if row['group']!=group],'held-out-channel absolute training')
            except fl.InsufficientAbsoluteLabels:
                target.update(status='insufficient_training_classes',held_out_group=str(group));break
    pairs=strict_pairs(ranking)
    relative={'status':'ready' if pairs else 'insufficient_training_pairs','strict_pairs':len(pairs)}
    for group in sorted({ranking[a]['group'] for a,b in pairs}):
        if sum(ranking[a]['group']!=group for a,b in pairs)<3:
            relative.update(status='insufficient_training_pairs',held_out_group=str(group));break
    return {'absolute':target,'relative':relative}

def metrics(rows,scores,relative=False):
    rows,scores=labeled_cohort(rows,scores,relative)
    if relative:
        details=[{'pair':rows[a]['recording'],'winner_margin':round(float(scores[a]-scores[b]),6),'correct':bool(scores[a]>scores[b])} for a,b in strict_pairs(rows)]
        return {'target':'relative_preference','strict_pairs':len(details),'correct_pairs':sum(x['correct'] for x in details),'pairs':details}
    try:fl.require_binary([r['y'] for r in rows],'explicit absolute diagnostic')
    except fl.InsufficientAbsoluteLabels:return {'status':'insufficient_absolute_labels','target':fl.CURRENT_TARGET,'rows':len(rows)}
    return {'target':fl.CURRENT_TARGET,'rows':len(rows),'auroc':round(float(roc_auc_score([r['y'] for r in rows],scores)),4)}

def fit(rows,X,relative=False):
    rows,X=labeled_cohort(rows,X,relative)
    y=np.array([r['y'] for r in rows]);groups=np.array([r['group'] for r in rows]);scores=np.full(len(rows),np.nan)
    allowed=eligibility(rows)['relative' if relative else 'absolute']
    if allowed['status']!='ready':return allowed
    held_out_groups=sorted(set(groups));strict=strict_pairs(rows) if relative else []
    details=[]
    for group in held_out_groups:
        train=groups!=group;test=~train
        if not relative:
            scaler=StandardScaler().fit(X[train]);model=LogisticRegression(C=1.,solver='liblinear',dual=False,tol=1e-6,max_iter=5000).fit(scaler.transform(X[train]),y[train]);scores[test]=model.decision_function(scaler.transform(X[test]))
        else:
            training=[(a,b) for a,b in strict if train[a]];testing=[(a,b) for a,b in strict if test[a]]
            if not testing:continue
            if len(training)<3:return {'status':'insufficient_training_pairs'}
            diff=np.array([X[a]-X[b] for a,b in training]);symmetric=np.r_[diff,-diff]
            scaler=StandardScaler().fit(symmetric);model=LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',dual=False,tol=1e-6,max_iter=5000).fit(scaler.transform(symmetric),np.r_[np.ones(len(diff)),np.zeros(len(diff))])
            for a,b in testing:
                margin=float(model.decision_function(scaler.transform((X[a]-X[b])[None,:]))[0]);details.append({'pair':rows[a]['recording'],'winner_margin':round(margin,6),'correct':margin>0})
    if relative:return {'target':'relative_preference','strict_pairs':len(details),'correct_pairs':sum(x['correct'] for x in details),'pairs':details}
    if not np.isfinite(scores).all():return {'status':'incomplete_held_out_predictions','rows':len(rows)}
    return metrics(rows,scores)

def main():
    fl.freeze_semantics(SNAPSHOT.parent/'label-semantics'/f'{fl.POLICY}.json')
    started=time.monotonic();deadline=started+300
    payload=json.loads((ROOT/'features_with_embeddings.json').read_text());meta=json.loads((ROOT/'private_manifest.json').read_text())
    annotated=annotate_cohort(payload,meta,json.loads(SNAPSHOT.read_text()));label_summary=fl.summary(annotated)
    allowed=eligibility(annotated)
    output=ROOT/'prosody';output.mkdir(exist_ok=True);output.chmod(0o700)
    if not any(value['status']=='ready' for value in allowed.values()):
        status={'status':'insufficient_labels','fine_label_policy':fl.POLICY,'label_contract':label_summary,'eligibility':allowed,'cloud_units':0}
        save(output/f'status.{fl.POLICY}.json',status)
        print(json.dumps(status,allow_nan=False),flush=True)
        return
    import opensmile
    import soundfile as sf
    heard={w['row']:w for w in meta['windows'] if w.get('selection')=='heard_preview'}
    # Recipe fixed before extraction/evaluation; no tuning against the outer predictions.
    save(output/f'spec.{fl.POLICY}.json',{'fine_label_policy':fl.POLICY,'label_target':fl.CURRENT_TARGET,'feature_domain':'heard offered preview, not final saved range','eligibility':allowed,'feature_set':'eGeMAPSv02','feature_level':'Functionals','window':'exact heard-preview-containing 30 seconds',
        'C':1.,'normalization':'training channels only','validation':'leave one whole channel out',
        'ablation':'remove columns containing loudness, equivalentSoundLevel or rmsenergy',
        'versions':{n:importlib.metadata.version(n) for n in ('opensmile','numpy','scikit-learn','soundfile')}})
    smile=opensmile.Smile(feature_set=opensmile.FeatureSet.eGeMAPSv02,feature_level=opensmile.FeatureLevel.Functionals,num_workers=1)
    names=smile.feature_names;assert len(names)==88
    rows=[];vectors=[];excluded=[]
    for row in annotated:
        if time.monotonic()>deadline:raise TimeoutError('CPU extraction budget expired')
        win=heard[row['row']];source=ROOT/'audio'/f"{win['id']}.flac"
        assert hashlib.sha256(source.read_bytes()).hexdigest()==win['sha256']
        dest=output/f"{win['id']}.json"
        if dest.exists():
            cache=json.loads(dest.read_text());assert cache['sha256']==win['sha256'];vector=np.array(cache['values'])
        else:
            signal,rate=sf.read(source,dtype='float32');assert rate==16000 and signal.shape==(480000,)
            values=smile.process_signal(signal,rate);vector=values.iloc[0].to_numpy(dtype=float)
            assert list(values.columns)==names
            if not np.isfinite(vector).all():excluded.append(row['row']);continue
            save(dest,{'sha256':win['sha256'],'values':vector.tolist()})
        assert vector.shape==(88,) and np.isfinite(vector).all()
        rows.append(row);vectors.append(vector)
    base=np.array([r['base'] for r in rows]);full=np.array(vectors)
    keep=[i for i,n in enumerate(names) if not any(term in n.lower() for term in ('loudness','equivalentsoundlevel','rmsenergy'))]
    with warnings.catch_warnings():
        warnings.simplefilter('error',ConvergenceWarning)
        comparisons={name:{'absolute_head':fit(rows,X),'relative_head':fit(rows,X,True)} for name,X in [
            ('length_score',base),('length_score_prosody',np.c_[base,full]),('length_score_prosody_without_loudness',np.c_[base,full[:,keep]])]}
    report={'label_target':fl.CURRENT_TARGET,'future_replacement':'unknown','permanent_storage_worth':'unknown','feature_domain':'heard offered preview, not final saved range','label_contract':label_summary,'usable_label_contract':fl.summary(rows),'rows':len(rows),'channels':len({r['group'] for r in rows}),'excluded_nonfinite':len(excluded),'seconds':round(time.monotonic()-started,2),
        'features':names,'without_loudness_features':len(keep),'shipped_scorer':{'absolute':metrics(rows,np.array([r['fixed_baseline'] for r in rows])),'relative':metrics(rows,np.array([r['fixed_baseline'] for r in rows]),True)},
        'comparisons':comparisons,'limits':['Eight strict pairs at most; this is an exploratory same-round diagnostic.','No model promotion; acoustic delivery features do not measure personality traits.','Music and other sounds can contaminate voice measurements.'],'cloud_units':0}
    save(output/f'report.{fl.POLICY}.json',report)
    print(json.dumps({k:v for k,v in report.items() if k not in ('features','comparisons')},allow_nan=False),flush=True)
    print(json.dumps({name:{kind:{k:v for k,v in value.items() if k!='pairs'} for kind,value in result.items()} for name,result in comparisons.items()}),flush=True)
if __name__=='__main__':main()
