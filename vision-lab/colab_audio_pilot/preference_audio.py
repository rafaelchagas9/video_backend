"""Bounded local preference comparison. No uploads, saved transcripts or production writes."""
from __future__ import annotations
import argparse, copy, hashlib, json, math, os, subprocess, sys, time, traceback, warnings
from pathlib import Path
import numpy as np
import pipeline as p
import models_v2 as models
import evaluate_v2 as ev
from prepare_v2 import audio_bytes
from sklearn.exceptions import ConvergenceWarning
OUT = p.ROOT / 'data' / 'preference-audio-20261010'
sys.path.insert(0,str(p.ROOT/'model_completion'))
import fine_labels as fl
FROZEN_TASKS=p.ROOT/'data'/'model-completion-20261010'/'private_snapshot.json'


def bounded(value, duration):
    clip = [max(0., float(value['clip'][0])), min(float(value['clip'][1]), duration or math.inf)]
    assert clip[1] > clip[0]
    a, b = max(clip[0], float(value['best'][0])), min(clip[1], float(value['best'][1]))
    return [a,b] if b > a else clip


def snapshot():
    import psycopg
    from label_server import PG
    OUT.mkdir(parents=True, exist_ok=True); OUT.chmod(0o700)
    path = OUT / 'private_manifest.json'
    if path.exists(): return json.loads(path.read_text())
    with psycopg.connect(PG) as conn:
        conn.execute('SET TRANSACTION READ ONLY')
        tasks = conn.execute("SELECT id,channel,answer,context,answered_at FROM recording_label_tasks WHERE kind='versus' ORDER BY id").fetchall()
        assert len(tasks)==20 and all(t[2] in ('a','b','both','neither') for t in tasks)
        vids = sorted({int(t[3][s]['video_id']) for t in tasks for s in ('a','b')})
        videos = {v[0]:v[1:] for v in conn.execute('SELECT id,file_path,duration_seconds FROM videos WHERE id=ANY(%s)',(vids,)).fetchall()}
    rows=[]; groups={}
    for i,(tid,channel,answer,context,at) in enumerate(tasks):
        groups.setdefault(channel, f'g{len(groups):03d}')
        for side in ('a','b'):
            val=context[side]; vid=int(val['video_id']); source,duration=videos[vid]
            start,end=bounded(val, float(duration) if duration else None)
            assert end-start >= 30
            rows.append({'row':f'p{i:03d}{side}','group':groups[channel],'recording':f'p{i:03d}',
                'y':int(answer in (side,'both')), 'legacy_y':int(answer in (side,'both')),'current_acceptability_y':fl.current_acceptability(answer),'legacy_y_role':'Historical winner membership only, not current rejection','base':[math.log(end-start),float(val['score'])],
                'audio':p.read_audio_cache(vid,start,end),'video_id':vid,'path':source,
                'start':start,'end':end,'task_id':tid,'answer':answer,'answered_at':at.isoformat()})
    private={'version':1,'rows':rows,'windows':[],'excluded':[]}
    p.save_json(path,private)
    p.save_json(OUT/f'evaluation_spec.{fl.POLICY}.json', {'target':fl.CURRENT_TARGET,
        'samples':'two uniform 30-second windows centered at one-third and two-thirds of the offered cut; clamped to that cut; overlap allowed',
        'base':'log offered cut duration and detector score; no post-choice trimmed duration',
        'models':models.MODEL_PINS,'C':1.,'validation':'leave-one-whole-channel-out',
        'aggregation':'fixed normalized mean and max; text coverage control',
        'promotion':'none from this small availability-selected round'})
    return private


def prepare(seconds):
    import soundfile as sf
    fl.freeze_semantics(FROZEN_TASKS.parent/'label-semantics'/f'{fl.POLICY}.json')
    began=time.monotonic(); deadline=began+seconds; private=snapshot()
    verified=fl.annotate_rows(private['rows'],private['rows'],json.loads(FROZEN_TASKS.read_text())['tasks'])
    audio=OUT/'audio'; audio.mkdir(exist_ok=True);audio.chmod(0o700)
    done={w['row'] for w in private['windows']}; excluded={x['row'] for x in private['excluded']}
    p.await_idle(deadline,settle=0)
    for row in private['rows']:
        if row['row'] in done|excluded: continue
        if time.monotonic() >= deadline: break
        new=[]; targets=[]
        try:
            p.await_idle(deadline,settle=0)
            source=Path(row['path']); sidecar=p.ROOT/'data'/'audio_src'/f"{row['video_id']}.opus"
            for candidate in ([sidecar,source] if sidecar.exists() else [source]):
                probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type,duration','-of','json',str(candidate)],capture_output=True,text=True,timeout=min(15,max(1,deadline-time.monotonic())))
                if probe.returncode:continue
                meta=json.loads(probe.stdout); streams=[s for s in meta['streams'] if s['codec_type']=='audio']
                duration=float(streams[0].get('duration') or meta['format']['duration']) if streams else 0.
                if duration>=row['end']-.25: source=candidate; break
            else: raise ValueError('Source cannot cover offered cut')
            signature=source.stat()
            offsets=[round(max(row['start'],min(row['start']+(row['end']-row['start'])*f-15,row['end']-30)),3) for f in (1/3,2/3)]
            for offset in offsets:
                p.await_idle(deadline,settle=0)
                if deadline-time.monotonic()<45: raise TimeoutError('Insufficient decode budget')
                wid=f"w{len(private['windows'])+len(new)+1:06d}"; target=audio/f'{wid}.flac';targets.append(target)
                wave=audio_bytes(source,offset); sf.write(target,wave,16000,format='FLAC',subtype='PCM_16');target.chmod(0o600)
                probe=subprocess.run(['ffprobe','-v','error','-show_entries','format_tags:stream_tags','-of','json',str(target)],capture_output=True,text=True,timeout=10)
                tags=json.loads(probe.stdout)
                assert not tags.get('format',{}).get('tags') and all(not s.get('tags') for s in tags.get('streams',[]))
                new.append({'row':row['row'],'id':wid,'offset':offset,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'ssd_cache':source==sidecar})
            after=source.stat();assert (signature.st_size,signature.st_mtime_ns)==(after.st_size,after.st_mtime_ns)
            private['windows'].extend(new)
            print(json.dumps({'prepared_sides':len(private['windows'])//2,'selected_sides':len(private['rows'])}),flush=True)
        except TimeoutError:
            for target in targets:target.unlink(missing_ok=True)
            p.save_json(OUT/'private_manifest.json',private); raise
        except (OSError,ValueError,KeyError,AssertionError,subprocess.TimeoutExpired) as error:
            for target in targets:target.unlink(missing_ok=True)
            private['excluded'].append({'row':row['row'],'reason':type(error).__name__})
        p.save_json(OUT/'private_manifest.json',private)
    public=[]
    for row in verified:
        windows=[{'id':w['id']} for w in private['windows'] if w['row']==row['row']]
        if len(windows)>=2:
            public.append({k:row[k] for k in ('row','group','recording','base','audio','task_id','video_id','start','end','fine_label_policy','label_target','legacy_y','current_acceptability_y','absolute_y','ranking_y','future_replacement_y','permanent_storage_y','cut_gold')}|{'y':row['current_acceptability_y'],'windows':windows})
    p.save_json(OUT/f'cohort.{fl.POLICY}.json',{'target':fl.CURRENT_TARGET,'rows':public})
    assert len(public)+len(private['excluded'])==len(private['rows']), 'Preparation incomplete; resume before inference'
    print(json.dumps({'preparation_complete':True,'sides':len(public),'excluded':len(private['excluded']),'seconds':round(time.monotonic()-began,2)}),flush=True)


def inputs(cohort):
    return [{'window':w['id'],'path':str(OUT/'audio'/f"{w['id']}.flac")} for r in cohort['rows'] for w in r['windows']]


def infer(seconds):
    began=time.monotonic();cohort=json.loads((OUT/f'cohort.{fl.POLICY}.json' if (OUT/f'cohort.{fl.POLICY}.json').exists() else OUT/'cohort.json').read_text())
    report=models.run_windows(inputs(cohort),OUT/'results',deadline=began+seconds,batch_size=2)
    summary={'status':'completed','seconds':round(time.monotonic()-began,2),'coverage':report['coverage']}
    p.save_json(OUT/'run_summary.json',summary);print(json.dumps(summary),flush=True)


def heldout(rows,kind,allow=False):
    try:
        rows=fl.absolute_rows(rows);fl.require_binary([r['y'] for r in rows],'absolute held-out metrics')
        groups=np.array([r['group'] for r in rows]);y=np.array([r['y'] for r in rows])
        for group in sorted(set(groups)):fl.require_binary(y[groups!=group],'absolute outer training fold')
    except (fl.InsufficientAbsoluteLabels,fl.FineLabelContractError) as error:return {'status':'insufficient_explicit_labels_or_provenance','error':str(error)}
    X,width=ev.features(rows,kind,allow);scores=np.full(len(rows),np.nan)
    for group in sorted(set(groups)):
        train,test=groups!=group,groups==group
        ev._assert_disjoint(rows,train,test)
        if len(set(y[train]))<2:return {'status':'insufficient_training_class_coverage'}
        model=ev.build_model(width,1.);model.fit(X[train],y[train]);scores[test]=model.decision_function(X[test])
    from analyze_label_round import metrics
    return {'status':'ok',**metrics([r|{'pair':r['recording']} for r in rows],scores),
            'predictions':[{'row':r['row'],'score':round(float(s),6)} for r,s in zip(rows,scores)]}


def pairwise_heldout(rows, kind, allow=False):
    """Strict winners train a relative head; both/neither never invent a winner."""
    from collections import defaultdict
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    rows=fl.ranking_rows(rows);X,width=ev.features(rows,kind,allow); bypair=defaultdict(list)
    for i,row in enumerate(rows):bypair[row['recording']].append(i)
    pairs=[]
    for indices in bypair.values():
        if len(indices)==2 and len({rows[i]['y'] for i in indices})==2:
            winner=next(i for i in indices if rows[i]['y']);loser=next(i for i in indices if not rows[i]['y'])
            assert rows[winner]['group']==rows[loser]['group']
            pairs.append((winner,loser,rows[winner]['group']))
    predictions=[]
    for group in sorted({g for _,_,g in pairs}):
        train=[(a,b) for a,b,g in pairs if g!=group];test=[(a,b) for a,b,g in pairs if g==group]
        if len(train)<3:return {'status':'insufficient_training_pairs','strict_pairs':len(pairs)}
        difference=np.array([X[a]-X[b] for a,b in train]);differences=np.concatenate((difference,-difference))
        scaler=StandardScaler().fit(differences[:,:width]);differences[:,:width]=scaler.transform(differences[:,:width])
        model=LogisticRegression(C=1.,fit_intercept=False,solver='liblinear',dual=False,max_iter=5000,tol=1e-6).fit(differences,np.r_[np.ones(len(train)),np.zeros(len(train))])
        for a,b in test:
            v=(X[a]-X[b])[None,:];v[:,:width]=scaler.transform(v[:,:width]);score=float(model.decision_function(v)[0])
            predictions.append({'pair':rows[a]['recording'],'winner_margin':round(score,6),'correct':score>0})
    return {'status':'ok','strict_pairs':len(pairs),'channels':len({g for _,_,g in pairs}),
        'correct_pairs':sum(x['correct'] for x in predictions),'predictions':predictions}


def evaluate():
    fl.freeze_semantics(FROZEN_TASKS.parent/'label-semantics'/f'{fl.POLICY}.json')
    cohort=json.loads((OUT/f'cohort.{fl.POLICY}.json' if (OUT/f'cohort.{fl.POLICY}.json').exists() else OUT/'cohort.json').read_text());numeric=json.loads((OUT/'results'/'numeric_results.json').read_text());private=json.loads((OUT/'private_manifest.json').read_text());frozen=json.loads(FROZEN_TASKS.read_text());cohort['rows']=fl.annotate_rows(cohort['rows'],private['rows'],frozen['tasks']);cohort['fine_label_contract']=fl.summary(cohort['rows']);cohort['target']='Current keep acceptability on offered cuts; relative preference, saved cuts, future replacement and permanent storage remain separate'
    items=models._validate(inputs(cohort));fingerprint=hashlib.sha256(json.dumps([(i['window'],i['sha256']) for i in items]).encode()).hexdigest()
    assert fingerprint==numeric['cohort_sha256']
    assert numeric['models']=={n:{'model':repo,'revision':rev} for n,(repo,rev) in models.MODEL_PINS.items()}
    byid={w['window']:w for w in numeric['windows']}
    for row in cohort['rows']:
        for win in row['windows']:
            source=byid[win['id']];win.update({f:source[f] for f in models.FIELDS});win['status']=source['status']
    known={r['row']:r for r in json.loads((p.ROOT/'data'/'label-round-1-20261009'/'features.json').read_text())['rows']}
    for row in cohort['rows']:
        assert known[row['row']].get('legacy_y',known[row['row']]['y'])==row['legacy_y']
        row['fixed_baseline']=known[row['row']]['fixed_baseline']
    p.save_json(OUT/f'features_with_embeddings.{fl.POLICY}.json',cohort)
    window_meta={w['id']:w for w in json.loads((OUT/'private_manifest.json').read_text())['windows']}
    reports={}
    for sampling in ('combined','uniform_only','heard_preview_only'):
        variant=copy.deepcopy(cohort)
        for row in variant['rows']:
            if sampling!='combined':
                row['windows']=[w for w in row['windows'] if (window_meta[w['id']].get('selection')=='heard_preview')==(sampling=='heard_preview_only')]
        reports[sampling]=compare_cohort(variant,sampling)
    report={'target':cohort['target'],'fine_label_contract':cohort['fine_label_contract'],'coverage':numeric['coverage'],'variants':reports,
        'shipped_scorer_note':'Fixed score recorded when this pair was drawn; prior coarse-triage training, not a newly held-out fitted head.',
        'diagnostic_note':'Sampling variants are exploratory checks on the same judgments, not independent confirmation.'}
    p.save_json(OUT/f'report.{fl.POLICY}.json',report)
    for sampling,result in reports.items():
        print(json.dumps({'sampling':sampling,'cohorts':{name:{'sides':v['sides'],'shipped':v.get('shipped_scorer'),'relative_heads':{kind:{k:z for k,z in value.items() if k!='predictions'} for kind,value in v.get('relative_heads',{}).items()},'current_acceptability_heads':{kind:{k:z for k,z in value.items() if k!='predictions'} for kind,value in v['models'].items()}} for name,v in result['comparisons'].items()}}),flush=True)


def compare_cohort(cohort,sampling):
    rows=ev.validate_rows(cohort);report={'target':cohort['target'],'relative_objective':'symmetric strict-winner feature differences; no intercept; both/neither excluded from relative training','validation':'leave-one-whole-channel-out, fixed C=1, numeric training-fold scaling','sampling':sampling,'comparisons':{},
        'fine_label_policy':fl.POLICY,'absolute_objective':'A/B and both make both clips current-positive; neither makes both current-negative; future replacement and permanent storage unknown','limitations':['Eight strict pairs at most; one pair changes accuracy by 12.5 percentage points.','Current acceptability is not permanent storage worth; A/B retains both candidates and separately identifies a winner.','These windows sample the offered cuts, not entire clips; no post-answer cut features.','Transcripts are not checked against reference text; downstream ranking is not an ASR accuracy benchmark.','Failed/rejected inference is excluded, never zero-filled. Successful no-text is explicit and has a coverage-only control.','This round alone cannot justify promotion or a full-recording pass.']}
    cohorts=[('all',rows,['baseline'],False),('cheap',[r for r in rows if ev.complete(r,cheap=True)],['baseline','cheap_audio'],False),
        ('gemma',[r for r in rows if ev.complete(r,('gemma_audio',))],['baseline','gemma_audio'],False),
        ('whisper',[r for r in rows if ev.complete(r,('gemma_audio','whisper_text'),allow_no_text=True)],['baseline','whisper_coverage','gemma_audio','whisper_text','gemma_whisper'],True),
        ('qwen',[r for r in rows if ev.complete(r,('gemma_audio','qwen_text'),allow_no_text=True)],['baseline','qwen_coverage','gemma_audio','qwen_text','gemma_qwen'],True),
        ('common',[r for r in rows if ev.complete(r,ev.REPRESENTATIONS,cheap=True,allow_no_text=True)],list(ev.MODELS),True)]
    with warnings.catch_warnings():
        warnings.simplefilter('error',ConvergenceWarning)
        for name,selected,kinds,allow in cohorts:
            result={'sides':len(selected),'channels':len({r['group'] for r in selected}),'models':{}}
            absolute=fl.absolute_rows(selected);relative=fl.ranking_rows(selected);result['absolute_sides']=len(absolute);result['absolute_unknown']=len(selected)-len(absolute);result['relative_sides']=len(relative)
            if absolute and len({r['y'] for r in absolute})==2:
                from analyze_label_round import metrics
                result['shipped_scorer']=metrics([r|{'pair':r['recording']} for r in absolute],np.array([r['fixed_baseline'] for r in absolute]))
            if len(absolute)>=20 and len({r['group'] for r in absolute})>=5 and len({r['y'] for r in absolute})==2:
                result['models']={kind:heldout(selected,kind,allow) for kind in kinds}
            else:result['status']='insufficient_explicit_absolute_coverage'
            # Relative pairs remain usable even when absolute class coverage is absent.
            if relative:result['relative_heads']={kind:pairwise_heldout(selected,kind,allow) for kind in kinds}
            report['comparisons'][name]=result
    return report


def selftest():
    assert bounded({'clip':[-5,100],'best':[20,110]},90)==[20,90]
    assert bounded({'clip':[5,100],'best':[110,130]},90)==[5,90]
    # Whole-channel held-out training must have both classes; vectors stay unit scale.
    absolute=[{'row':f'x{i}','group':f'g{i//2}','recording':f'p{i//2}','fine_label_policy':fl.POLICY,'absolute_y':(i//2)%2,'ranking_y':None,'y':(i//2)%2,'base':[float((i//2)%2),.5],'audio':None,'windows':[]} for i in range(12)]
    relative=[{'row':f'x{i}','group':f'g{i//2}','recording':f'p{i//2}','fine_label_policy':fl.POLICY,'absolute_y':1,'ranking_y':i%2,'y':i%2,'base':[float(i%2),.5],'audio':None,'windows':[]} for i in range(12)]
    assert heldout(absolute,'baseline')['auroc']==1.
    assert pairwise_heldout(relative,'baseline')['correct_pairs']==6
    assert heldout(relative,'baseline')['status']=='insufficient_explicit_labels_or_provenance'
    print('Range and channel-held-out checks passed.')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','infer','evaluate','selftest']);parser.add_argument('--seconds',type=int,default=900);args=parser.parse_args()
    try:
        if args.action in ('prepare','infer'):globals()[args.action](args.seconds)
        else:globals()[args.action]()
    except Exception as error:
        # Never serialize exception values: private paths or generated text could be included.
        print(json.dumps({'status':'failed','type':type(error).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name} for f in traceback.extract_tb(error.__traceback__)]}),flush=True);sys.exit(1)
