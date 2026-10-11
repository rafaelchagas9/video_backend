"""Prepare a bounded, sanitized local audio cohort; no uploads or production writes."""
import json,sys,os,time,subprocess,random,hashlib
from pathlib import Path
from collections import defaultdict
import numpy as np
import pipeline as p
OUT=p.ROOT/'data'/'audio-comparison-v2-20261009'
RATE=16000; SAMPLES=30*RATE

def audio_bytes(source,start):
    command=['ionice','-c','3','ffmpeg','-nostdin','-v','error','-threads','1','-filter_threads','1','-filter_complex_threads','1',
             '-ss',str(round(start,3)),'-vn','-i',str(source),'-map','0:a:0','-threads','1',
             '-af','aresample=16000:async=1:first_pts=0','-t','30','-ac','1','-ar',str(RATE),'-f','s16le','-']
    result=subprocess.run(command,capture_output=True,timeout=45,preexec_fn=p.restricted_child)
    if result.returncode or len(result.stdout)!=SAMPLES*2:
        raise ValueError('bounded decode did not produce exactly thirty seconds')
    samples=np.frombuffer(result.stdout,dtype='<i2')
    if not np.any(samples): raise ValueError('all-zero window')
    return samples.astype(np.float32)/32768.

def run(limit=64,minutes=12):
    import soundfile as sf
    OUT.mkdir(parents=True,exist_ok=True);os.chmod(OUT,0o700)
    audio_dir=OUT/'audio';audio_dir.mkdir(exist_ok=True);os.chmod(audio_dir,0o700)
    private_path=OUT/'private_manifest.json'
    if private_path.exists():
        private=json.loads(private_path.read_text())
    else:
        rows=json.loads((p.OUT/'private_manifest.json').read_text())['rows']
        eligible=[r for r in rows if r['end']-r['start']>=30 and Path(r['path']).is_file()]
        rng=random.Random(20261010);by_record=defaultdict(list)
        for r in eligible:by_record[r['recording']].append(r)
        for bucket in by_record.values():rng.shuffle(bucket)
        records=list(by_record);rng.shuffle(records)
        # First two rows per recording favour both verdicts, independent of sound/model outputs.
        ordered=[]
        for rec in records:
            bucket=by_record[rec];keep=next((r for r in bucket if r['y']),None);skip=next((r for r in bucket if not r['y']),None)
            chosen=[r for r in (keep,skip) if r is not None]
            ordered.extend(chosen)
            by_record[rec]=[r for r in bucket if r not in chosen]
        while any(by_record.values()):
            for rec in records:
                if by_record[rec]:ordered.append(by_record[rec].pop())
        private={'version':2,'rows':ordered[:limit],'windows':[],'excluded':[],'selected':min(limit,len(ordered))}
        p.save_json(private_path,private)
    deadline=time.monotonic()+minutes*60;p.await_idle(deadline,settle=0)
    done={w['row'] for w in private['windows']};excluded={r['row'] for r in private['excluded']}
    for r in private['rows']:
        if r['row'] in done|excluded:continue
        if time.monotonic()>=deadline:break
        new=[]
        try:
            p.await_idle(deadline,settle=0)
            source=Path(r['path']);sidecar=p.ROOT/'data'/'audio_src'/f"{r['video_id']}.opus"
            for candidate in ([sidecar,source] if sidecar.exists() else [source]):
                probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type,duration','-of','json',str(candidate)],capture_output=True,text=True,timeout=15)
                if probe.returncode:continue
                meta=json.loads(probe.stdout);streams=[s for s in meta['streams'] if s['codec_type']=='audio']
                duration=float(streams[0].get('duration') or meta['format']['duration']) if streams else 0.
                if duration>=r['end']-.25:source=candidate;break
            else:raise ValueError('source audio duration does not cover proposal')
            sig=source.stat();span=r['end']-r['start']
            offsets=[r['start']+span*f-15 for f in (1/6,1/2,5/6)]
            # Extra activity-selected window; all models receive precisely the same four windows.
            feature=p.ROOT/'data'/'audio'/f"{r['video_id']}.npz"
            with np.load(feature,allow_pickle=False) as z:
                a=max(0,int(r['start']));b=min(len(z['db']),int(r['end']))
                def robust(v):
                    median=np.median(v);return (v-median)/(1.4826*np.median(abs(v-median)) or 1.)
                activity=robust(z['db'])+robust(z['flux'])
                peak=a+int(np.argmax(np.convolve(activity[a:b],np.ones(30)/30,'valid')))
                offsets.append(float(peak))
            offsets=[round(max(r['start'],min(v,r['end']-30)),3) for v in offsets]
            for k,offset in enumerate(offsets):
                p.await_idle(deadline,settle=0)
                wid=f"w{len(private['windows'])+len(new)+1:06d}";target=audio_dir/f'{wid}.flac'
                wave=audio_bytes(source,offset)
                sf.write(target,wave,RATE,format='FLAC',subtype='PCM_16')
                target.chmod(0o600)
                # soundfile/libFLAC writes no copied source tags. Confirm via ffprobe.
                tags=subprocess.run(['ffprobe','-v','error','-show_entries','format_tags:stream_tags','-of','json',str(target)],capture_output=True,text=True,timeout=10)
                tagged=json.loads(tags.stdout)
                assert not tagged.get('format',{}).get('tags') and all(not s.get('tags') for s in tagged.get('streams',[]))
                new.append({'row':r['row'],'id':wid,'offset':offset,'selection':k,'samples':len(wave),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'source_kind':int(source==sidecar)})
            after=source.stat()
            if (sig.st_size,sig.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('source changed')
            private['windows'].extend(new)
            print(json.dumps({'completed_proposals':len({w['row'] for w in private['windows']}),'selected':private['selected']}),flush=True)
        except (OSError,ValueError,KeyError,IndexError,AssertionError,subprocess.TimeoutExpired) as error:
            for w in new:(audio_dir/f"{w['id']}.flac").unlink(missing_ok=True)
            private['excluded'].append({'row':r['row'],'reason':type(error).__name__})
        p.save_json(private_path,private)
    public=[]
    for r in private['rows']:
        windows=[{'id':w['id']} for w in private['windows'] if w['row']==r['row']]
        if len(windows)!=4:continue
        public.append({key:r[key] for key in ('row','group','recording','y','base')}|{'audio':p.read_audio_cache(r['video_id'],r['start'],r['end']),'windows':windows})
    p.save_json(OUT/'cohort.json',{'version':2,'target':'saved coarse keep/skip triage, not final worth','rows':public})
    summary={'selected':private['selected'],'usable_proposals':len(public),'channels':len({r['group'] for r in public}),'keeps':sum(r['y'] for r in public),'windows':sum(len(r['windows']) for r in public),'excluded':len(private['excluded']),'audio_bytes':sum(f.stat().st_size for f in audio_dir.glob('*.flac')),'raw_video_uploaded':False,'metadata_tags':0}
    p.save_json(OUT/'preparation.json',summary);print(json.dumps(summary),flush=True)
if __name__=='__main__':run()
