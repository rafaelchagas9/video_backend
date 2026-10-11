"""Add the heard snippet to every side, reusing validated uniform-window inference."""
import copy, hashlib, json, os, shutil, subprocess, time
from pathlib import Path
import soundfile as sf
import psycopg
import pipeline as p
import models_v2 as m
from label_server import PG
from preference_audio import OUT, inputs
from prepare_v2 import audio_bytes

def main():
    backup=OUT/'uniform_only';backup.mkdir(exist_ok=True);backup.chmod(0o700)
    names=('private_manifest.json','cohort.json','evaluation_spec.json','report.json','features_with_embeddings.json','RESULTS.md','run_summary.json')
    for name in names:
        if not (backup/name).exists():shutil.copy2(OUT/name,backup/name)
    if not (backup/'numeric_results.json').exists():shutil.copy2(OUT/'results'/'numeric_results.json',backup/'numeric_results.json')
    private=json.loads((OUT/'private_manifest.json').read_text());cohort=json.loads((OUT/'cohort.json').read_text())
    prior=json.loads((backup/'numeric_results.json').read_text())
    originals=json.loads((backup/'cohort.json').read_text())
    olditems=m._validate(inputs(originals))
    assert prior['cohort_sha256']==hashlib.sha256(json.dumps([(x['window'],x['sha256']) for x in olditems]).encode()).hexdigest()
    assert prior['models']=={n:{'model':repo,'revision':rev} for n,(repo,rev) in m.MODEL_PINS.items()}
    with psycopg.connect(PG) as conn:
        conn.execute('SET TRANSACTION READ ONLY')
        tasks={r[0]:r[1:] for r in conn.execute("SELECT id,context,answer,answered_at FROM recording_label_tasks WHERE kind='versus'").fetchall()}
    deadline=time.monotonic()+600
    for row in private['rows']:
        context,answer,at=tasks[row['task_id']];assert answer==row['answer'] and at.isoformat()==row['answered_at']
        if any(w['row']==row['row'] and w.get('selection')=='heard_preview' for w in private['windows']):continue
        side=context[row['row'][-1]];snippet=side.get('snippet',side['best'])
        a=max(row['start'],float(snippet[0]));b=min(row['end'],float(snippet[1]))
        assert 0 < b-a <= 30
        offset=round(max(row['start'],min((a+b)/2-15,row['end']-30)),3)
        assert offset<=a+.001 and offset+30>=b-.001
        p.await_idle(deadline,settle=0)
        if deadline-time.monotonic()<45:raise TimeoutError('Decode budget exhausted')
        source=Path(row['path']);signature=source.stat()
        wid=f"w{len(private['windows'])+1:06d}";target=OUT/'audio'/f'{wid}.flac'
        sf.write(target,audio_bytes(source,offset),16000,format='FLAC',subtype='PCM_16');target.chmod(0o600)
        tags=subprocess.run(['ffprobe','-v','error','-show_entries','format_tags:stream_tags','-of','json',str(target)],capture_output=True,text=True,timeout=10)
        metadata=json.loads(tags.stdout);assert not metadata.get('format',{}).get('tags') and all(not s.get('tags') for s in metadata.get('streams',[]))
        after=source.stat();assert (signature.st_size,signature.st_mtime_ns)==(after.st_size,after.st_mtime_ns)
        private['windows'].append({'row':row['row'],'id':wid,'offset':offset,'selection':'heard_preview','sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'ssd_cache':False})
        p.save_json(OUT/'private_manifest.json',private)
    for row in cohort['rows']:
        row['windows']=[{'id':w['id']} for w in private['windows'] if w['row']==row['row']]
        assert len(row['windows'])==3
    items=m._validate(inputs(cohort));cached={w['window']:w for w in prior['windows']}
    old=copy.deepcopy(prior);old['batches']=[]
    old['cohort_sha256']=hashlib.sha256(json.dumps([(x['window'],x['sha256']) for x in items]).encode()).hexdigest()
    old['windows']=[copy.deepcopy(cached[x['window']]) if x['window'] in cached else {'window':x['window'],**{f:None for f in m.FIELDS},'status':{f:-1 for f in m.FIELDS}} for x in items]
    existing=OUT/'results'/'numeric_results.json'
    if json.loads(existing.read_text())['cohort_sha256']!=old['cohort_sha256']:m._atomic(existing,old)
    p.save_json(OUT/'cohort.json',cohort)
    spec=json.loads((OUT/'evaluation_spec.json').read_text());spec['samples']=json.loads((backup/'evaluation_spec.json').read_text())['samples']+'; plus a 30-second window containing the entire exact heard snippet for every side'
    spec['diagnostic_note']='Uniform-only result preserved; this extension fixes preview coverage, not a new independent holdout.'
    p.save_json(OUT/'evaluation_spec.json',spec)
    print(json.dumps({'sides':len(cohort['rows']),'windows':len(items),'previous_windows_reused':len(cached),'new_windows':len(items)-len(cached)}),flush=True)

if __name__=='__main__':
    try:main()
    except Exception as e:
        import sys,traceback
        print(json.dumps({'status':'failed','type':type(e).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno} for f in traceback.extract_tb(e.__traceback__)]}),flush=True);sys.exit(1)
