"""Reproduce stage-one validation/export without media, GPU or production writes.

Uses current reviewed decisions, hand labels and local embedding archives. Five whole-channel
folds mine their own hard negatives. Fixed production threshold; no validation-driven sweep.
Run from vision-lab with OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 .venv/bin/python model_completion/stage1_complete.py.
"""
from __future__ import annotations
import hashlib,json,os,sys,time,warnings
from dataclasses import asdict,replace
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','2');os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import numpy as np
import deployed_data as dd
import deployed_clipper as dc
import deployed_eval as de
from sklearn.exceptions import ConvergenceWarning
from sklearn.metrics import roc_auc_score
OUT=ROOT/'model_completion'/'artifacts'/'stage1'

def archived_frames(vid):
    p=dd.CACHE/f'{vid}.npz'
    if p.exists():
        with np.load(p) as z:return z['t'].copy(),z['v'].copy(),str(z['source'])
    found=dd._from_snapshot(vid)
    return found if found is not None else dd._from_old_cache(vid)

def save(name,value):
    target=OUT/name;tmp=target.with_suffix(target.suffix+'.tmp')
    tmp.write_text(json.dumps(value,indent=2,default=lambda x:float(x)));tmp.chmod(0o600);tmp.replace(target)

def tally(t):
    return asdict(t)|{'judged_precision':t.precision,'precision_floor':t.precision_floor,'kept_recall':t.kept_recall,'hand_recall':t.hand_recall,'hand_precision':t.hand_precision,'minutes_per_hour':t.minutes_per_hour}

def main():
    began=time.monotonic();OUT.mkdir(parents=True,exist_ok=True);OUT.chmod(0o700)
    dd.frames=archived_frames;de.OUT=OUT
    corpus=de.corpus();de.load_training_frames(corpus)
    folds=de.outer_folds(corpus,'channel');classes=len(dc.CLASSES)
    groups={ch:f'g{i:03d}' for i,ch in enumerate(sorted(set(corpus.channel.values())))}
    input_snapshot={'clips':{str(v):[asdict(replace(clip,channel=groups[corpus.channel[v]])) for clip in clips] for v,clips in corpus.clips.items()},'labels':corpus.labels,'channels':{str(v):groups[ch] for v,ch in corpus.channel.items()},'folds':folds,'training_frames_sha256':hashlib.sha256((OUT/'frames.npz').read_bytes()).hexdigest()}
    save('inputs.json',input_snapshot)
    input_sha256=hashlib.sha256((OUT/'inputs.json').read_bytes()).hexdigest()
    hand_positive=np.isin(corpus.hand_y,de.POSITIVE)
    hand_scores={k:np.full(len(corpus.hand_y),np.nan) for k in ('base','negatives')}
    totals={k:de.Tally() for k in ('base','negatives')}
    fold_models={};fold_neg=[];per_recording={k:{} for k in ('base','negatives')}
    with warnings.catch_warnings():
        warnings.simplefilter('error',ConvergenceWarning)
        for fold in range(5):
            training={v for v in corpus.recordings if folds[v]!=fold};held={v for v in corpus.recordings if folds[v]==fold}
            assert {corpus.channel[v] for v in training}.isdisjoint({corpus.channel[v] for v in held})
            pair=de.train_pair(corpus,training);fold_neg.append(pair['negatives'][2])
            for variant,(W,b,count) in pair.items():
                fold_models[f'{fold}/{variant}']=(W,b)
                mask=np.isin(corpus.hand_vid,list(held));probs=dc.classify(W,b,corpus.hand_X[mask])
                hand_scores[variant][mask]=probs[:,de.POSITIVE].sum(1)
            for vid in sorted(held):
                t,F=de.features(vid)
                for variant,(W,b,count) in pair.items():
                    scores=dc.highlight_scores(dc.classify(W,b,F));result=de.judge(vid,t,scores,de.PRODUCTION_THRESHOLD,corpus)
                    totals[variant].add(result);per_recording[variant][vid]=result
            print(json.dumps({'fold_done':fold+1,'folds':5,'elapsed_seconds':round(time.monotonic()-began,1)}),flush=True)
        final=de.train_pair(corpus,set(corpus.recordings))
    assert all(np.isfinite(scores).all() for scores in hand_scores.values())
    # Equal-frame matching on the same clean recordings. The shipped file was trained on these
    # hand-labelled/hardnegative recordings, so their entire channels are excluded for this test.
    shipped=dc.load_probe();trained_channels={corpus.channel.get(v,dd.channel(v)) for v in set(corpus.labels)|set(dd.stored_negatives())}
    clean=[v for v in corpus.recordings if v in corpus.clips and corpus.channel[v] not in trained_channels]
    shipped_clean=de.Tally();clean_variants={k:de.Tally() for k in totals}
    for vid in clean:
        t,F=de.features(vid);scores=dc.highlight_scores(dc.classify(shipped['W'],shipped['b'],F));shipped_clean.add(de.judge(vid,t,scores,de.PRODUCTION_THRESHOLD,corpus))
        for variant in totals:clean_variants[variant].add(per_recording[variant][vid])
    eligible=[k for k in totals if totals[k].kept_recall>=totals['base'].kept_recall-.02 and totals[k].wrong_found<=totals['base'].wrong_found]
    selected=min(eligible,key=lambda k:(totals[k].wrong_found,-totals[k].precision,-totals[k].kept_recall))
    W,b,n=final[selected]
    payload={'version':'stage1-candidate-20261010','model_revision':'siglip2/so400m-patch16-256','classes':list(dc.CLASSES),'context_radius':de.RADIUS,'dimension':int(W.shape[1]//2),'weights':W.round(6).tolist(),'bias':b.round(6).tolist(),'labelled_frames':len(corpus.hand_y),'feedback_negatives':n,'labelled_recordings':len(set(corpus.hand_vid)),'metrics':{'auroc':float(roc_auc_score(hand_positive,hand_scores[selected])),'clip_precision':totals[selected].precision,'clip_recall':totals[selected].kept_recall}}
    # Round-trip export equality guards the shipped JSON convention.
    assert np.max(abs(np.array(payload['weights'])-W))<=5.01e-7
    save('candidate.json',payload)
    check=clean_variants[selected]
    promote=bool(clean and check.kept_recall>=shipped_clean.kept_recall and check.wrong_found<=shipped_clean.wrong_found and check.precision_floor>=shipped_clean.precision_floor+.02)
    raw_labels=dd.hand_labels();valid_recordings=len(set(corpus.hand_vid));current=json.loads((dc.MODELS/'recordings-highlight-probe.json').read_text())
    report={'input_snapshot_sha256':input_sha256,'version':1,'stage':'what-is-happening detector','validation':'5-fold whole-channel holdout; each training fold mines its own hard negatives; fixed production threshold','threshold':de.PRODUCTION_THRESHOLD,'source':'local archived numeric frames only; no raw media or GPU','corpus':{'reviewed_decisions':sum(len(v) for v in corpus.clips.values()),'recoverable_recordings':len(corpus.recordings),'hand_frames':len(corpus.hand_y),'hand_recordings':valid_recordings,'missing_hand_recordings':len(set(raw_labels)-set(corpus.hand_vid)),'wrong_detection_pool_frames':len(corpus.pool_vid)},'shipped':{'version':current['version'],'hand_frames':current['labelled_frames'],'hand_recordings':current['labelled_recordings']},'whole_channel_oof':{k:tally(totals[k])|{'hand_auroc':float(roc_auc_score(hand_positive,hand_scores[k]))} for k in totals},'clean_shipped_channels_comparison':{'recordings':len(clean),'shipped':tally(shipped_clean),**{k:tally(v) for k,v in clean_variants.items()}},'fold_negative_counts':fold_neg,'selected_candidate_variant':selected,'candidate_sha256':hashlib.sha256((OUT/'candidate.json').read_bytes()).hexdigest(),'promotion_gate':'same unseen-channel recordings: no kept-recall decrease, no wrong-detection increase, precision-floor gain >=0.02','promotion_recommended':promote,'production_changed':False,'limitations':['Latest keep/skip labels encode coarse triage, not final storage preference.','Kept recall is relative to past proposals; 40 completed audit windows supply a separate recall check.','Archived numerical embeddings recover deleted hand-labelled recordings without media.','Existing hard-negative pseudo-labels are not reused in held-out training; each fold remakes them.'],'elapsed_seconds':round(time.monotonic()-began,2)}
    save('report.json',report)
    print(json.dumps({k:report[k] for k in ('corpus','selected_candidate_variant','promotion_recommended','elapsed_seconds')}),flush=True)
if __name__=='__main__':main()
