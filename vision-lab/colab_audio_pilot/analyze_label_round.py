"""Read-only label-round analysis using numeric caches; no media, uploads or model promotion."""
import json
import math
import sys
import warnings
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
import pipeline as pilot
sys.path.insert(0,str(pilot.ROOT/'model_completion'))
import fine_labels as fl

sys.path.insert(0, str(pilot.ROOT))
from label_server import PG
import psycopg

OUT = pilot.ROOT / 'data' / 'label-round-1-20261009'


def evaluate(rows, audio=False):
    rows=fl.absolute_rows(rows)
    fl.require_binary([r['y'] for r in rows],'current-acceptability cohort')
    for g in sorted({r['group'] for r in rows}):fl.require_binary([r['y'] for r in rows if r['group']!=g],'current-acceptability outer training fold')
    width = 6 if audio else 2
    X = np.array([r['base'] + (r['audio'] if audio else []) for r in rows], dtype=float)
    assert X.shape == (len(rows), width) and np.isfinite(X).all()
    y = np.array([r['y'] for r in rows])
    groups = np.array([r['group'] for r in rows])
    scores = np.full(len(rows), np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter('error', ConvergenceWarning)
        for group in sorted(set(groups)):
            train, test = groups != group, groups == group
            assert set(groups[train]).isdisjoint(set(groups[test]))
            assert len(set(y[train])) == 2
            model = make_pipeline(StandardScaler(), LogisticRegression(C=1., solver='liblinear', dual=False, max_iter=5000, tol=1e-6))
            model.fit(X[train], y[train])
            scores[test] = model.decision_function(X[test])
    assert np.isfinite(scores).all()
    return metrics(rows, scores) | {'validation': 'leave-one-whole-channel-out; train-fold scaling; fixed C=1'}


def metrics(rows, scores):
    labels=fl.absolute_rows(rows);fl.require_binary([r['y'] for r in labels],'numeric exporter current-acceptability metrics')
    return {'rows':len(rows),'channels':len({r['group'] for r in rows}),'target':fl.CURRENT_TARGET,
            'auroc':round(float(roc_auc_score([r['y'] for r in labels],scores)),4),**fl.strict_pair_metrics(rows,scores)}


def main():
    fl.freeze_semantics(pilot.ROOT/'data/model-completion-20261010/label-semantics'/f'{fl.POLICY}.json')
    with psycopg.connect(PG) as conn:
        conn.execute('SET TRANSACTION READ ONLY')
        tasks = conn.execute("""SELECT id,kind,stratum,channel,answer,reasons,context,detail,
            answered_at,start_seconds,end_seconds FROM recording_label_tasks
            WHERE kind IN ('recall-audit','versus') ORDER BY id""").fetchall()
    assert tasks and all(t[4] is not None for t in tasks), 'Round is not complete'
    audit = [t for t in tasks if t[1] == 'recall-audit']
    versus = [t for t in tasks if t[1] == 'versus']
    groups, rows, cuts = {}, [], []
    for index, task in enumerate(versus):
        _, _, _, channel, answer, _, context, detail, *_ = task
        groups.setdefault(channel, f'g{len(groups):03d}')
        for side in ('a', 'b'):
            value = context[side]
            a,b = value['clip']
            offered_start=max(a,value['best'][0]);offered_end=min(b,value['best'][1])
            if offered_end<=offered_start:offered_start,offered_end=a,b
            legacy=int(answer in (side,'both'))
            row={'row':f'p{index:03d}{side}','pair':f'p{index:03d}','recording':f'p{index:03d}','group':groups[channel],
                'task_id':task[0],'video_id':value['video_id'],'start':offered_start,'end':offered_end,'y':fl.current_acceptability(answer),'legacy_y':legacy,
                'base':[math.log(max(1.,b-a)),float(value['score'])],'feature_start':a,'feature_end':b,
                'audio':pilot.read_audio_cache(value['video_id'],a,b),'fixed_baseline':value['baseline']}
            row.update(fl.contract(dict(row,y=legacy),{'id':task[0],'kind':'versus','answer':answer,'context':context,'detail':detail}))
            rows.append(row)
        for side, selected in (detail or {}).get('best',{}).items():
            keep, offered = context[side]['clip'], context[side]['best']
            a,b = selected['start_seconds'], selected['end_seconds']
            assert keep[0] - .01 <= a < b <= keep[1] + .01
            cuts.append({'accepted': selected['accepted'], 'seconds': b-a, 'original_seconds': keep[1]-keep[0],
                'longer': b-a > offered[1]-offered[0]+1.1, 'shorter': b-a < offered[1]-offered[0]-1.1,
                'whole': abs(a-keep[0])<1.1 and abs(b-keep[1])<1.1})
    cached = [r for r in rows if r['audio'] is not None]
    comparisons = {'shipped_baseline': metrics(rows, np.array([r['fixed_baseline'] for r in rows])),
        'learned_length_score': evaluate(rows), 'audio_matched_length_score': evaluate(cached),
        'audio_matched_length_score_audio': evaluate(cached, True)}
    manifest = json.loads((pilot.ROOT/'data'/'audio-comparison-v2-20261009'/'private_manifest.json').read_text())
    covered = {r['feedback_id'] for r in manifest['rows']}
    coverage = {'sides': sum(t[6][s]['feedback_id'] in covered for t in versus for s in ('a','b')),
        'strict_pairs': sum(t[4] in ('a','b') and all(t[6][s]['feedback_id'] in covered for s in ('a','b')) for t in versus)}
    audit_strata = {}
    for stratum in sorted({t[2] for t in audit}):
        selected = [t for t in audit if t[2]==stratum]
        audit_strata[stratum] = {'reviewed':len(selected),'keep':sum(t[4]=='keep' for t in selected)}
    report = {'all_visible_tasks_answered': True, 'tasks':len(tasks), 'audit':audit_strata,
        'versus':dict(Counter(t[4] for t in versus)), 'cuts':{'total':len(cuts), 'accepted_unchanged':sum(c['accepted'] for c in cuts),
            'longer_than_offered':sum(c['longer'] for c in cuts), 'shorter_than_offered':sum(c['shorter'] for c in cuts),
            'whole_keep':sum(c['whole'] for c in cuts), 'selected_seconds':round(sum(c['seconds'] for c in cuts),1),
            'original_keep_seconds':round(sum(c['original_seconds'] for c in cuts),1)},
        'comparisons':comparisons, 'semantic_pilot_overlap':coverage,
        'limitations':['Only eight strict comparisons across seven channels; one pair changes accuracy by 12.5 percentage points.',
            'A/B and both retain both current candidates; neither rejects both currently. Future replacement/permanent storage remain unknown.',
            'Audit sampling was spread across channels; raw counts are not a library-wide recall estimate.',
            'Cached semantic embeddings describe original coarse proposals and cover only two strict pairs; they have not been evaluated on the full new preference round.',
            'Cheap audio is aggregated over original kept clips, whereas comparison previews show offered cuts.',
            'No model promotion or production decision changes; no media reads or uploads.'],
        'cloud_compute_units':0}
    OUT.mkdir(exist_ok=True)
    pilot.save_json(OUT/f'features.{fl.POLICY}.json',{'target':fl.CURRENT_TARGET,'policy':fl.POLICY,'feature_domain':'Full context.clip numeric/cheap-audio inputs, not offered or final saved edges','rows':rows})
    pilot.save_json(OUT/f'report.{fl.POLICY}.json',dict(report,label_target=fl.CURRENT_TARGET,future_replacement='unknown',permanent_storage_worth='unknown'))
    keep = sum(t[4]=='keep' for t in audit)
    shipped = comparisons['shipped_baseline']
    base, audio = comparisons['audio_matched_length_score'], comparisons['audio_matched_length_score_audio']
    text = f'''# Label round 1: implementation feedback

All 60 tasks are saved: 40 recall audits and 20 versus pairs.

- Audit: {keep}/40 useful windows, all in new-time (3/10). Outside (0/14), no-keep (0/8), and near-miss (0/8) found none. This supports reviewing the newer detector's extra proposals; it does not justify lowering the threshold across the library or claiming a recall percentage.
- Preference: left 4, right 4, both 10, neither 2. There are only 8 strict winner comparisons across 7 channels. Both A/B clips are current keep candidates; ranking distinguishes the winner. Future replacement/permanent storage remain unknown.
- Cuts: 23/28 were lengthened, 3 shortened, and 8 restored the whole keep. Only 1 offered cut was accepted unchanged. These decisions favor longer cuts; revisit the four-minute cap. The earlier confusing confirmation screen may have influenced some choices, so do not treat this round alone as validated ground truth for automatic trimming.
- Shipped length + score orders {shipped['correct_pairs']}/8 strict pairs correctly. CPU-only whole-channel-held-out fits on the identical {base['rows']}-side cohort order {base['correct_pairs']}/{base['strict_pairs']} with length + score and {audio['correct_pairs']}/{audio['strict_pairs']} with cheap audio. On that same cohort, current-acceptability AUROC is {base['auroc']:.3f} without cheap audio and {audio['auroc']:.3f} with it. One side lacks a complete audio cache and is excluded from both fits. These small counts cannot establish a reliable model improvement.
- Existing semantic pilot outputs cover only {coverage['sides']}/40 sides and {coverage['strict_pairs']}/8 strict pairs, sampled from original coarse proposals. They are insufficient for a valid full-round Gemma/Whisper/Qwen comparison. A future semantic pass must use ranges aligned with what was shown in the versus round; compare identical eligible cohorts and hold out whole channels.

No new media processing, cloud spending, model promotion, or changes to saved decisions occurred in this analysis.
'''
    (OUT/f'RESULTS.{fl.POLICY}.md').write_text(text)
    print(json.dumps(report,indent=2))

if __name__=='__main__': main()
