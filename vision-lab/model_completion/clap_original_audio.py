"""Predeclared CLAP complement: validated SSD stages -> numeric checkpoints only.

No downloader, originals, FFmpeg, cloud, labels, fitting, or transcript persistence.
Execution requires the reviewed official checkpoint to have been downloaded first.
"""
from __future__ import annotations
import contextlib, fcntl, hashlib, json, math, os, re, sys, time
from pathlib import Path
PROCESS_STARTED = time.monotonic()
for k in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'): os.environ[k] = '2'
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_PROGRESS_BARS='1')
import numpy as np
import soundfile as sf
LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB / 'model_completion'))
import audio_cache_worker as aw
from prepare import ROOT
BASE = ROOT / 'joint-gemma'
OUT = BASE / 'dense-original-clap'
MODEL = 'laion/larger_clap_general'
REVISION = 'ada0c23a36c4e8582805bb38fec3905903f18b41'
PIN = MODEL + '@' + REVISION
WEIGHT_SHA = '314eb00cce6ad68d25237b8446b659ccdb136ed4672c1bca470f142f72455026'
WEIGHT_BYTES = 776444665
RECIPE = 'clap-general-original-dense20s-two10s-unitmean-16k-to48k-v1'
MAX_SECONDS = 1200
INPUT_SHA = {
    'audio_reuse_manifest.json': '7dc237cabf892430bf72a67c0c69c704fac16cf165408a13309c82b1faebfde1',
    'dense-original-audio/numeric_manifest.json': '2af6760422a96951d99cbe6797ce128751a6f6e3ccd2cf102af16b121a31eb43',
}



def check(deadline):
    if time.monotonic() >= deadline: raise TimeoutError('CLAP pilot wall budget expired')


def sha(path, deadline=None):
    value = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            if deadline is not None: check(deadline)
            value.update(block)
    return value.hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    tmp = path.with_suffix('.partial')
    with tmp.open('w') as f:
        json.dump(value, f, allow_nan=False, separators=(',', ':')); f.flush(); os.fsync(f.fileno())
    tmp.chmod(0o600); tmp.replace(path)


def identity(r, receipt_sha):
    return {'row': r['row'], 'original_start': r['original_start'], 'original_end': r['original_end'],
            'offsets': r['dense_offsets'], 'audio_start': r['audio_start'], 'audio_end': r['audio_end'],
            'staged_audio_sha256': r['cache_sha256'], 'source_fingerprint': r['source_fingerprint'],
            'receipt_sha256': receipt_sha, 'alignment': r['alignment'], 'revision': REVISION,
            'recipe': RECIPE, 'source_rate': 16000, 'input_rate': 48000}


def identity_sha(r, receipt_sha):
    return hashlib.sha256(json.dumps(identity(r, receipt_sha), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_metadata(receipt, numeric):
    rows = [r for r in receipt['rows'] if r.get('complete_original_coverage') is True]
    by_id = {r['row']: r for r in numeric['rows']}
    if len(rows) != 21 or sum(len(r['dense_offsets']) for r in rows) != 1149: raise ValueError('frozen full-original cohort changed')
    if len({r['row'] for r in rows}) != len(rows): raise ValueError('duplicate stage identity')
    for r in rows:
        if not re.fullmatch(r'fine\d+[ab]', r['row']): raise ValueError('nonpseudonymous stage identity')
        n = by_id[r['row']]
        source_fp = r.get('source_fingerprint')
        if not isinstance(source_fp,list) or len(source_fp)!=2 or any(type(x) is not int or x<0 or x>2**63-1 for x in source_fp):
            raise ValueError('source fingerprint must be two nonnegative int64 values')
        if any(r[k] != n[k] for k in ('video_id', 'feedback_id', 'clip_id', 'original_start', 'original_end') if k in n):
            raise ValueError('numeric stage identity mismatch')
        if r['original_start'] != n['detected_start'] or r['original_end'] != n['detected_end']:
            raise ValueError('immutable original range mismatch')
        if not np.array_equal(r['dense_offsets'], n['offsets']): raise ValueError('window sampling mismatch')
        if r.get('rate') != 16000 or r.get('channels') != 1 or r.get('alignment') != 'aresample_async_first_pts_0':
            raise ValueError('stage sampling/alignment mismatch')
        a, b = r['original_start'], r['original_end']; offsets = np.asarray(r['dense_offsets'], dtype=float)
        if not math.isfinite(a) or not math.isfinite(b) or b <= a or offsets.ndim != 1 or not np.isfinite(offsets).all():
            raise ValueError('invalid original timeline')
        expected = list(np.arange(a, b - 20 + .001, 20))
        if not expected or abs(expected[-1] - (b - 20)) > .001: expected.append(b - 20)
        if len(offsets) != len(expected) or not np.allclose(offsets, expected, atol=.001, rtol=0):
            raise ValueError('offsets must be label-independent dense20s plus end-aligned tail')
        if offsets[0] < r['audio_start'] - .001 or offsets[-1] + 20 > r['audio_end'] + .001:
            raise ValueError('unsupported audio tail')
    if len({by_id[r['row']]['group'] for r in rows}) != 10: raise ValueError('frozen group count changed')
    return rows, by_id


def verify_stage(r, stage_root, deadline):
    path = Path(r['cache_path'])
    if path.is_symlink() or path.parent.resolve() != stage_root.resolve() or not re.fullmatch(r'c\d{3}\.flac', path.name):
        raise ValueError('only neutral frozen SSD stages allowed')
    s = path.stat()
    if not path.is_file() or s.st_dev != stage_root.stat().st_dev or [s.st_size, s.st_mtime_ns] != r['cache_fingerprint']:
        raise ValueError('SSD stage fingerprint changed')
    if sha(path, deadline) != r['cache_sha256']: raise ValueError('SSD stage checksum changed')
    info = sf.info(path)
    if info.channels != 1 or info.samplerate != 16000 or r['audio_start'] + info.frames / 16000 < r['audio_end'] - .001:
        raise ValueError('SSD stage actual coverage changed')
    return path


def read_window(handle, r, offset):
    sample = round((offset - r['audio_start']) * 16000)
    if sample < 0: raise ValueError('negative staged offset')
    handle.seek(sample); wave = handle.read(320000, dtype='float32')
    if wave.shape != (320000,) or not np.isfinite(wave).all(): raise ValueError('incomplete/nonfinite window; never pad')
    return wave


def halves(wave):
    from scipy.signal import resample_poly
    wave = np.asarray(wave, dtype=np.float32)
    if wave.shape != (320000,) or not np.isfinite(wave).all(): raise ValueError('expected exact20s mono16k')
    # Polyphase upsample once, then split; no restored >8kHz information is claimed.
    converted = resample_poly(wave, 3, 1).astype(np.float32)
    if converted.shape != (960000,) or not np.isfinite(converted).all(): raise ValueError('resampler coverage mismatch')
    return [converted[:480000], converted[480000:]]


def unit_mean(vectors):
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim != 3 or vectors.shape[1:] != (2, 512) or not np.isfinite(vectors).all(): raise ValueError('CLAP half-vector shape')
    norms = np.linalg.norm(vectors, axis=-1, keepdims=True)
    if np.any(norms < 1e-8): raise ValueError('zero CLAP half-vector')
    value = (vectors / norms).mean(axis=1); norms = np.linalg.norm(value, axis=1, keepdims=True)
    if np.any(norms < 1e-8): raise ValueError('cancelled CLAP unitmean')
    return (value / norms).astype(np.float32)


def checkpoint(path, vectors, r, receipt_sha):
    values = np.asarray(vectors, np.float32).reshape(-1, 512); count = len(values)
    if count > len(r['dense_offsets']) or not np.isfinite(values).all() or not np.allclose(np.linalg.norm(values, axis=1), 1, atol=.01):
        raise ValueError('invalid checkpoint vectors')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700); path.parent.chmod(0o700)
    tmp = path.with_suffix('.partial')
    with tmp.open('wb') as f:
        np.savez_compressed(f, clap=values, offsets=np.asarray(r['dense_offsets'][:count]), planned_offsets=np.asarray(r['dense_offsets']),
            decoded_samples=np.full(count, 320000), resampled_samples=np.full(count, 960000), half_samples=np.full((count, 2), 480000),
            revision=REVISION, recipe=RECIPE, identity_sha256=identity_sha(r, receipt_sha), receipt_sha256=receipt_sha,
            staged_audio_sha256=r['cache_sha256'], source_fingerprint=np.asarray(r['source_fingerprint']),
            absolute_start=r['original_start'], duration=r['original_end']-r['original_start'], alignment=r['alignment'],
            complete=(count == len(r['dense_offsets'])), source_rate=16000, input_rate=48000)
        f.flush(); os.fsync(f.fileno())
    tmp.chmod(0o600); tmp.replace(path)


def validate_checkpoint(path, r, receipt_sha, require_complete=True):
    with np.load(path, allow_pickle=False) as z:
        n = len(z['clap'])
        scalars=('revision','recipe','identity_sha256','receipt_sha256','staged_audio_sha256','alignment','source_rate','input_rate','absolute_start','duration','complete')
        if any(z[k].shape != () for k in scalars) or z['source_fingerprint'].shape != (2,): raise ValueError('checkpoint metadata shape mismatch')
        if str(z['revision']) != REVISION or str(z['recipe']) != RECIPE or str(z['identity_sha256']) != identity_sha(r, receipt_sha): raise ValueError('checkpoint provenance mismatch')
        if (str(z['receipt_sha256']) != receipt_sha or str(z['staged_audio_sha256']) != r['cache_sha256']
            or not np.array_equal(z['source_fingerprint'], r['source_fingerprint'])
            or str(z['alignment']) != r['alignment'] or int(z['source_rate']) != 16000 or int(z['input_rate']) != 48000
            or float(z['absolute_start']) != r['original_start'] or float(z['duration']) != r['original_end']-r['original_start']):
            raise ValueError('checkpoint source/timeline mismatch')
        if not np.array_equal(z['planned_offsets'], r['dense_offsets']) or not np.array_equal(z['offsets'], r['dense_offsets'][:n]): raise ValueError('checkpoint offsets mismatch')
        if z['clap'].shape != (n, 512) or not np.isfinite(z['clap']).all() or not np.allclose(np.linalg.norm(z['clap'], axis=1), 1, atol=.01): raise ValueError('checkpoint vectors mismatch')
        if z['decoded_samples'].shape != (n,) or z['resampled_samples'].shape != (n,) or z['half_samples'].shape != (n,2): raise ValueError('checkpoint sample array shape mismatch')
        if not np.all(z['decoded_samples'] == 320000) or not np.all(z['resampled_samples'] == 960000) or not np.all(z['half_samples'] == 480000): raise ValueError('checkpoint sample coverage mismatch')
        if n > len(r['dense_offsets']) or bool(z['complete']) != (n == len(r['dense_offsets'])) or (require_complete and n != len(r['dense_offsets'])): raise ValueError('checkpoint incomplete')
        return z['clap'].copy()


def budget_viable(seconds, completed, remaining, deadline):
    return completed > 0 and 1.5 * seconds / completed * remaining + 30 <= deadline - time.monotonic()


def run():
    began = PROCESS_STARTED; deadline = began + MAX_SECONDS; os.nice(10)
    lock = (LAB.parent / 'data/models/recording-audio-jobs/.worker.lock').open('a+')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if (OUT/'run_summary.json').exists():
        lock.close(); raise ValueError('sole pilot already has a receipt; no automatic rerun')
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700); OUT.chmod(0o700)
    for relative, expected in INPUT_SHA.items():
        if sha(BASE/relative, deadline) != expected: raise ValueError('frozen input generation/metadata changed')
    receipt_path = BASE / 'audio_reuse_manifest.json'; receipt_sha = INPUT_SHA['audio_reuse_manifest.json']
    receipt = json.loads(receipt_path.read_text()); numeric = json.loads((BASE / 'dense-original-audio/numeric_manifest.json').read_text())
    rows, by_id = validate_metadata(receipt, numeric)
    summary = {'status':'preflight', 'recipe':RECIPE, 'model':PIN, 'rows':21, 'planned_windows':1149,
        'completed_windows':0, 'uploads':0, 'cloud_units':0, 'original_media_reads':0, 'ffmpeg_processes':0,
        'source_rate':16000, 'input_rate':48000, 'bandwidth_limitation':'16k stage has no original content above8kHz', 'seconds':0.}
    atomic_json(OUT / 'run_summary.json', summary)
    model = None
    try:
        with aw.watchdog(deadline):
            aw.await_idle(deadline, gpu=True)
            for r in rows: verify_stage(r, BASE / 'audio', deadline)
            from huggingface_hub import hf_hub_download
            # LOCAL ONLY: this call cannot fetch public weights or private data.
            weight = Path(hf_hub_download(MODEL, 'pytorch_model.bin', revision=REVISION, local_files_only=True))
            if weight.stat().st_size != WEIGHT_BYTES or sha(weight, deadline) != WEIGHT_SHA: raise ValueError('official pinned CLAP weights mismatch')
            import torch
            from transformers import ClapFeatureExtractor, ClapModel
            torch.set_num_threads(2)
            if not torch.cuda.is_available(): raise ValueError('localGPU unavailable')
            processor = ClapFeatureExtractor.from_pretrained(MODEL, revision=REVISION, local_files_only=True)
            if processor.sampling_rate != 48000 or processor.nb_max_samples != 480000: raise ValueError('CLAP processor sampling mismatch')
            with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                model = ClapModel.from_pretrained(MODEL, revision=REVISION, local_files_only=True,
                    trust_remote_code=False, weights_only=True, use_safetensors=False, dtype=torch.float32).to('cuda').eval()
            if model.config.projection_dim != 512 or model.config.audio_config.enable_fusion: raise ValueError('CLAP checkpoint architecture mismatch')
            def encode(waves):
                check(deadline); inputs = [part for wave in waves for part in halves(wave)]
                features = processor(inputs, sampling_rate=48000, truncation='rand_trunc', padding='pad', return_tensors='pt').to('cuda')
                with torch.inference_mode(): result = model.get_audio_features(**features).pooler_output
                value = result.detach().float().cpu().numpy(); torch.cuda.synchronize()
                if torch.cuda.max_memory_allocated() > 8 * 1024**3: raise MemoryError('CLAP8GiB memory ceiling')
                return unit_mean(value.reshape(len(waves), 2, 512))
            # No private sample enters model until synthetic API/determinism succeeds.
            tone = .01 * np.sin(2*np.pi*440*np.arange(320000)/16000).astype(np.float32)
            first = encode([tone]); second = encode([tone])
            if not np.allclose(first, second, atol=1e-4, rtol=0): raise ValueError('CLAP synthetic nondeterminism')
            atomic_json(OUT / 'synthetic_report.json', {'status':'passed', 'unit512':True, 'seconds':time.monotonic()-began})
            benchmark_started = None; benchmark_count = 0; benchmark_checked = False; completed = []
            for r in rows:
                path = Path(r['cache_path']); vectors = []
                target = OUT / 'embeddings' / (r['row']+'.npz')
                if target.exists(): raise ValueError('sole pilot output already exists; no automatic rerun')
                with sf.SoundFile(path) as handle:
                    for start in range(0, len(r['dense_offsets']), 2):
                        aw.await_idle(deadline); check(deadline)
                        if benchmark_started is None: benchmark_started = time.monotonic()
                        waves = [read_window(handle, r, offset) for offset in r['dense_offsets'][start:start+2]]
                        vectors.extend(encode(waves)); checkpoint(target, vectors, r, receipt_sha)
                        summary['completed_windows'] += len(waves); benchmark_count += len(waves)
                        if not benchmark_checked and benchmark_count >= 8:
                            elapsed = time.monotonic()-benchmark_started
                            viable = budget_viable(elapsed, benchmark_count, 1149-summary['completed_windows'], deadline)
                            atomic_json(OUT/'throughput_report.json', {'windows':benchmark_count,'seconds':elapsed,'safety_factor':1.5,'reserve_seconds':30,'viable':viable})
                            if not viable: raise TimeoutError('CLAP measured workload cannot fit original wall budget')
                            benchmark_checked = True
                        summary.update(seconds=time.monotonic()-began, peak_gpu_gib=torch.cuda.max_memory_allocated()/1024**3)
                        atomic_json(OUT/'run_summary.json', summary)
                if [path.stat().st_size,path.stat().st_mtime_ns] != r['cache_fingerprint']: raise ValueError('stage changed during inference')
                validate_checkpoint(target,r,receipt_sha)
                n=by_id[r['row']]
                completed.append({'row':r['row'],'group':n['group'],'original_start':r['original_start'],'original_end':r['original_end'],
                    'offsets':r['dense_offsets'],'complete_original_coverage':True,'identity_sha256':identity_sha(r,receipt_sha),
                    'staged_audio_sha256':r['cache_sha256'],'source_fingerprint':r['source_fingerprint']})
                atomic_json(OUT/'numeric_manifest.json', {'recipe':RECIPE,'revision':PIN,'receipt_sha256':receipt_sha,'window_seconds':20,'offset_unit':'absolute media seconds','rows':completed})
                print(json.dumps({'rows_complete':len(completed),'windows_complete':summary['completed_windows'],'seconds':summary['seconds']}),flush=True)
            summary['status']='complete'
    except BaseException as exc:
        import traceback
        summary.update(status='failed', error_type=type(exc).__name__, error_frames=[{'file':Path(x.filename).name,'line':x.lineno} for x in traceback.extract_tb(exc.__traceback__)])
        raise
    finally:
        summary['seconds']=time.monotonic()-began; atomic_json(OUT/'run_summary.json', summary)
        if model is not None:
            import torch
            del model; torch.cuda.empty_cache()
        lock.close()

if __name__ == '__main__':
    try: run()
    except Exception as exc:
        import traceback
        print(json.dumps({'status':'failed','error_type':type(exc).__name__,'frames':[{'file':Path(x.filename).name,'line':x.lineno} for x in traceback.extract_tb(exc.__traceback__)]}),flush=True)
        raise SystemExit(1)
