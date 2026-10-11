"""Private local extraction and feature-only Colab evaluation. No production writes."""
from __future__ import annotations
import argparse, hashlib, json, math, os, random, resource, subprocess, sys, time
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
OUT = ROOT / 'data' / 'colab-audio-pilot-20261009'
MODEL = 'google/embeddinggemma-2'
REVISION = '914f7f89142e33e77833254d9c9b90c3cef7303b'
RATE = 16000
SECONDS = 20


def save_json(path, value):
    tmp = path.with_suffix(path.suffix + '.partial')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def busy_media_workers():
    """Never overlap Claude's audio pass or another FFmpeg job."""
    found = []
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name) == os.getpid():
            continue
        try:
            comm = (p / 'comm').read_text().strip()
            cmd = (p / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
        except (OSError, ProcessLookupError):
            continue
        if comm == 'ffmpeg' or ('audio_features.py' in cmd and comm.startswith('python')):
            found.append(int(p.name))
    return found


def await_idle(deadline, settle=30):
    quiet_since = None
    last = None
    while time.monotonic() < deadline:
        busy = busy_media_workers()
        if busy:
            quiet_since = None
            if last != len(busy):
                print(json.dumps({'status': 'waiting_for_disk', 'media_workers': len(busy)}), flush=True)
                last = len(busy)
        else:
            quiet_since = quiet_since or time.monotonic()
            if time.monotonic() - quiet_since >= settle:
                return
        time.sleep(5)
    raise TimeoutError('Local waiting budget expired; no additional media read was started.')


def read_audio_cache(video_id, start, end):
    path = ROOT / 'data' / 'audio' / f'{video_id}.npz'
    if not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as z:
            if 'db' not in z or not len(z['db']):
                return None
            if any(name not in z or len(z[name]) != len(z['db']) for name in ('flux', 'voice', 'music')):
                return None
            if int(end) > len(z['db']) + 1:
                return None  # A truncated cache must not represent the entire proposal.
            def robust(x):
                median = np.median(x)
                return (x - median) / (1.4826 * np.median(np.abs(x - median)) or 1.)
            activity = robust(z['db']) + robust(z['flux'])
            a, b = max(0, int(start)), min(int(end), len(activity))
            if b <= a:
                return None
            segment = activity[a:b]
            width = min(15, len(segment))
            peak = np.convolve(segment, np.ones(width) / width, 'valid').max()
            values = [segment.mean(), peak, z['voice'][a:b].mean(), z['music'][a:b].mean()]
            return [float(v) for v in values] if np.isfinite(values).all() else None
    except (OSError, ValueError, EOFError, KeyError):
        return None  # Claude might still be writing this cache.


def prepare(limit=96):
    import psycopg
    from label_server import PG
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / 'private_manifest.json').exists():
        refresh()
        return
    with psycopg.connect(PG) as conn:
        conn.execute('SET TRANSACTION READ ONLY')
        rows = conn.execute("""
          select f.id, f.video_id, f.clip_id, f.channel, f.verdict,
                 f.detected_start, f.detected_end, f.start_seconds, f.end_seconds,
                 f.score, f.detector, f.analyzed_at, v.file_path
          from recording_clip_feedback f
          join (select video_id,max(analyzed_at) a from recording_clip_feedback group by video_id) l
            on l.video_id=f.video_id and l.a=f.analyzed_at
          join videos v on v.id=f.video_id
          join recording_reviews r on r.video_id=f.video_id
          where f.merged_into is null and not f.added and r.saved_at is not null
            and f.verdict in ('keep','skip') order by f.id
        """).fetchall()
    group_map, recording_map = {}, {}
    eligible = []
    for fid, vid, cid, channel, verdict, ds, de, start, end, score, detector, generation, path in rows:
        try:
            if not json.loads(detector).get('model'):
                continue
        except (ValueError, TypeError, AttributeError):
            continue
        a, b = float(ds if ds is not None else start), float(de if de is not None else end)
        if a < 0 or b-a < 2 or not math.isfinite(float(score)):
            continue
        group = str(channel or f'video-{vid}').lstrip('@').lower()
        group_map.setdefault(group, f'g{len(group_map):04d}')
        recording_map.setdefault(vid, f'r{len(recording_map):04d}')
        eligible.append({'row': f'x{len(eligible):04d}', 'group': group_map[group],
                         'recording': recording_map[vid], 'y': int(verdict == 'keep'),
                         'base': [math.log(b-a), float(score)], 'audio': read_audio_cache(vid,a,b),
                         'feedback_id': fid, 'video_id': vid, 'clip_id': cid,
                         'generation': generation.isoformat(), 'path': path, 'start': a, 'end': b})
    # Balance channel/decision strata, rather than sampling only loud peaks or keeps.
    rng = random.Random(20261009)
    buckets = defaultdict(list)
    for row in eligible:
        buckets[(row['group'],row['y'])].append(row)
    for bucket in buckets.values():
        rng.shuffle(bucket)
    keys = sorted(buckets)
    rng.shuffle(keys)
    chosen = []
    while len(chosen) < min(limit,len(eligible)):
        advanced = False
        for key in keys:
            if buckets[key] and len(chosen) < limit:
                chosen.append(buckets[key].pop())
                advanced = True
        if not advanced:
            break
    selected = {r['row'] for r in chosen}
    for row in eligible:
        row['pilot'] = row['row'] in selected
    save_json(OUT/'private_manifest.json', {'version': 1,'rows': eligible,'model': MODEL,'revision': REVISION})
    refresh()


def refresh():
    manifest = json.loads((OUT/'private_manifest.json').read_text())
    public = []
    for row in manifest['rows']:
        audio = read_audio_cache(row['video_id'],row['start'],row['end'])
        public.append({k:row[k] for k in ('row','group','recording','y','base','pilot')} | {'audio':audio})
    save_json(OUT/'features.json', {'version':1,'target':'saved triage keep/skip; not final worth',
              'audio_names':['relative_activity','peak_activity','voice_band_energy','tonalness'], 'rows':public})
    print(json.dumps({'rows':len(public),'channels':len({r['group'] for r in public}),
          'pilot_clips':sum(r['pilot'] for r in public),'audio_rows':sum(r['audio'] is not None for r in public),
          'source_media_read':False,'export':str(OUT/'features.json')}),flush=True)


def restricted_child():
    os.nice(15)
    # Keep pathological media interleaving from exhausting RAM.
    resource.setrlimit(resource.RLIMIT_AS, (768*1024**2,768*1024**2))


def decode(path,start,duration):
    command = ['ionice','-c','3','ffmpeg','-nostdin','-v','error','-threads','1',
               '-filter_threads','1','-filter_complex_threads','1',
               '-ss',str(start),'-vn','-i',path,'-map','0:a:0','-threads','1','-t',str(duration),
               '-ac','1','-ar',str(RATE),'-f','s16le','-']
    result = subprocess.run(command,capture_output=True,timeout=45,preexec_fn=restricted_child)
    if result.returncode:
        raise RuntimeError(f'FFmpeg failed (exit {result.returncode})')
    if len(result.stdout) < int(max(1., duration-.25)*RATE)*2 or len(result.stdout) > (duration+1)*RATE*2:
        raise RuntimeError('Decoded audio missing or longer than the bounded window')
    return np.frombuffer(result.stdout,dtype='<i2').astype(np.float32)/32768.


def extract(minutes=60):
    os.nice(15)
    deadline = time.monotonic()+minutes*60
    manifest = json.loads((OUT/'private_manifest.json').read_text())
    cache = OUT/'embeddings'
    cache.mkdir(exist_ok=True)
    todo = [r for r in manifest['rows'] if r['pilot'] and not (cache/f"{r['row']}.npz").exists()]
    if not todo:
        print('All pilot embeddings cached.',flush=True)
        return
    await_idle(deadline)
    import torch
    from sentence_transformers import SentenceTransformer
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.bfloat16 if device == 'cuda' and torch.cuda.is_bf16_supported() else torch.float32
    model = SentenceTransformer(MODEL, revision=REVISION, device=device,
             config_kwargs={'vision_config':None}, model_kwargs={'torch_dtype':dtype},local_files_only=True)
    # Test the real audio API before opening any recording.
    synthetic = np.sin(np.arange(RATE,dtype=np.float32)*2*np.pi*440/RATE)*.1
    check = model.encode([{'audio':synthetic},{'audio':synthetic}],batch_size=2,
                         normalize_embeddings=True,show_progress_bar=False)
    assert check.shape == (2,768) and np.isfinite(check).all()
    assert np.dot(check[0],check[1]) > .99
    print(json.dumps({'status':'model_ready','device':device,'dtype':str(dtype),'audio_api':'PASS'}),flush=True)
    started = time.monotonic()
    for n,row in enumerate(todo,1):
        if time.monotonic() >= deadline:
            print('Budget reached; existing embeddings preserved.',flush=True)
            break
        await_idle(deadline,settle=0)
        try:
            source = Path(row['path'])
            cached_audio = ROOT / 'data' / 'audio_src' / f"{row['video_id']}.opus"
            if cached_audio.exists():
                probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(cached_audio)], capture_output=True, text=True, timeout=10)
                try:
                    cached_seconds = float(json.loads(probe.stdout)['format']['duration']) if probe.returncode == 0 else 0.
                except (ValueError, KeyError, TypeError):
                    cached_seconds = 0.
                if cached_seconds >= row['end'] - .25:
                    source = cached_audio
            signature = source.stat()
            duration = min(SECONDS,row['end']-row['start'])
            centres = [row['start']+(row['end']-row['start'])*fraction for fraction in (1/3,2/3)]
            offsets = sorted(set(round(max(row['start'],min(centre-duration/2,row['end']-duration)),3) for centre in centres))
            waveforms=[]
            for offset in offsets:
                await_idle(deadline,settle=0)
                waveforms.append(decode(str(source),offset,duration))
            after = source.stat()
            if (signature.st_size,signature.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):
                raise RuntimeError('Source changed during bounded extraction')
            with torch.inference_mode():
                vectors = model.encode([{'audio':w} for w in waveforms],batch_size=2,
                                      normalize_embeddings=True,show_progress_bar=False)
            if vectors.shape != (len(waveforms),768) or not np.isfinite(vectors).all():
                raise RuntimeError('Invalid embeddings')
            target=cache/f"{row['row']}.npz"
            tmp=target.with_suffix('.partial.npz')
            np.savez_compressed(tmp,v=vectors.astype(np.float32),offsets=np.array(offsets),
                duration=duration,decoded_samples=np.array([len(w) for w in waveforms]),revision=REVISION,source_size=signature.st_size,source_mtime_ns=signature.st_mtime_ns,
                source_kind='ssd_audio_cache' if source == cached_audio else 'original_recording')
            os.chmod(tmp,0o600)
            tmp.replace(target)
            del waveforms
            print(json.dumps({'status':'embedded','completed':n,'total':len(todo),
                  'elapsed_seconds':round(time.monotonic()-started,1)}),flush=True)
        except (OSError,RuntimeError,subprocess.TimeoutExpired) as e:
            print(json.dumps({'status':'skipped','row':row['row'],'reason':str(e)}),flush=True)
    export_vectors()


def export_vectors():
    features=json.loads((OUT/'features.json').read_text())
    count=0
    audit_path=OUT/'checkpoint_audit.json'
    audit=json.loads(audit_path.read_text()) if audit_path.exists() else {'accepted':[]}
    accepted=set(audit['accepted'])
    for row in features['rows']:
        path=OUT/'embeddings'/f"{row['row']}.npz"
        if path.exists():
            with np.load(path,allow_pickle=False) as z:
                if str(z['revision']) != REVISION or z['v'].ndim != 2 or z['v'].shape[1] != 768 or not np.isfinite(z['v']).all():
                    continue
                if 'decoded_samples' in z:
                    counts=z['decoded_samples']
                    duration=float(z['duration'])
                    if len(counts)!=len(z['v']) or not len(counts) or counts.min()<int(max(1.,duration-.25)*RATE) or counts.max()>(duration+1)*RATE:
                        continue
                elif row['row'] not in accepted or hashlib.sha256(path.read_bytes()).hexdigest()!=audit.get('checkpoint_sha256',{}).get(row['row']):
                    continue
                v=z['v'].mean(0)
                if float(np.linalg.norm(v))<1e-9:
                    continue
                row['embedding']=(v/max(float(np.linalg.norm(v)),1e-9)).tolist()
                count+=1
    features['model']=MODEL
    features['revision']=REVISION
    features['window_policy']='Two uniform 20-second windows per proposal; exploratory clip-level proxy.'
    save_json(OUT/'features_with_embeddings.json',features)
    print(json.dumps({'embedding_rows':count,'export':'features_with_embeddings.json'}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','refresh','extract','export'])
    parser.add_argument('--minutes',type=int,default=60)
    args=parser.parse_args()
    {'prepare':prepare,'refresh':refresh,'extract':lambda:extract(args.minutes),'export':export_vectors}[args.action]()
