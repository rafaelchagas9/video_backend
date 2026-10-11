"""Bounded Colab runner: opaque 30 s audio -> numeric-only checkpoints.

run_windows([{'window': 'w000001', 'path': '/content/audio/w000001.flac'}],
            '/content/results', deadline=time.monotonic() + 1200)
Transcripts exist only in RAM. The coordinator must release its runtime in finally.
A coordinator watchdog remains necessary for native CUDA calls that ignore signals.
"""
from __future__ import annotations

import contextlib
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import threading
import time
import zlib

MODEL_PINS = {
    'eg': ('google/embeddinggemma-2', '914f7f89142e33e77833254d9c9b90c3cef7303b'),
    'whisper': ('openai/whisper-large-v3-turbo', '41f01f3fe87f28c78e2fbf8b568835947dd65ed9'),
    'qwen': ('Qwen/Qwen3-ASR-1.7B-hf', 'bcd2b5b7f32b480ab5790554cfa8347f246a14f3'),
}
# These public releases were checked against PyPI; the notebook installs them.
DEPENDENCIES = ('transformers==5.19.0', 'sentence-transformers==6.1.0',
                'soundfile==0.14.0', 'accelerate==1.15.0')
RATE, SAMPLES = 16000, 480000
FIELDS = ('gemma_audio', 'whisper_text', 'qwen_text')
# Status: -1 pending, 0 empty/no-text, 1 usable, 2 rejected generation.


class BudgetExpired(TimeoutError):
    pass


class ModelFailure(RuntimeError):
    """Generic messages only: underlying errors may contain decoded private text."""


def _check(deadline):
    if not math.isfinite(deadline) or time.monotonic() >= deadline:
        raise BudgetExpired('Pilot time budget expired; completed numeric checkpoints remain.')


@contextlib.contextmanager
def _watchdog(deadline):
    _check(deadline)
    supported = hasattr(signal, 'setitimer') and threading.current_thread() is threading.main_thread()
    if not supported:
        yield
        _check(deadline)
        return
    def expire(signum, frame):
        raise BudgetExpired('Pilot time budget expired; completed numeric checkpoints remain.')
    old_handler = signal.getsignal(signal.SIGALRM)
    old_timer = signal.getitimer(signal.ITIMER_REAL)
    started = time.monotonic()
    signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, deadline - started)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
        if old_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(.001, old_timer[0] - (time.monotonic() - started)), old_timer[1])


def _atomic(path, value):
    path = Path(path)
    tmp = path.with_suffix('.partial')
    with tmp.open('w') as handle:
        json.dump(value, handle, allow_nan=False, separators=(',', ':'))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _vector(value):
    import numpy as np
    vector = np.asarray(value, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if vector.shape != (768,) or not np.isfinite(vector).all() or not .99 < norm < 1.01:
        raise ModelFailure('Invalid embedding shape, norm or finite values.')
    return (vector / norm).tolist()


def _audio(path):
    import numpy as np
    import soundfile as sf
    waveform, rate = sf.read(path, dtype='float32', always_2d=False)
    if rate != RATE or waveform.ndim != 1 or len(waveform) != SAMPLES or not np.isfinite(waveform).all():
        raise ModelFailure('Input must be finite, mono, 16 kHz and exactly 30 seconds.')
    return waveform


def _validate(windows):
    """Reject private names; no original path or input metadata enters checkpoints."""
    seen, items = set(), []
    for item in windows:
        if set(item) != {'window', 'path'}:
            raise ValueError('Window input permits only window and path fields.')
        wid, path = item['window'], Path(item['path'])
        if not isinstance(wid, str) or not re.fullmatch(r'w\d{6}', wid) or path.name != wid + '.flac' or wid in seen:
            raise ValueError('Expected unique opaque wNNNNNN IDs and matching FLAC basenames.')
        if path.is_symlink() or not path.is_file():
            raise ValueError('Window file missing or symbolic link.')
        seen.add(wid)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        items.append({'window': wid, 'path': path, 'sha256': digest})
    if not items:
        raise ValueError('No sanitized windows supplied.')
    return items


def _release(torch):
    gc.collect()
    torch.cuda.empty_cache()


def _load_eg(torch, text_only=False):
    from sentence_transformers import SentenceTransformer
    repo, revision = MODEL_PINS['eg']
    config = {'vision_config': None}
    if text_only:
        config['audio_config'] = None
    return SentenceTransformer(repo, revision=revision, device='cuda',
                               config_kwargs=config, model_kwargs={'torch_dtype': torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32})


def _text_status(text, token_limit_reached=False):
    text = text.strip()
    if not text or not re.sub(r'\[[^]]*\]|<[^>]*>|\([^)]*\)', '', text).strip():
        return 0
    data = text.encode('utf-8')
    if token_limit_reached or len(data) / max(1, len(zlib.compress(data))) > 2.4:
        return 2
    return 1


def _asr_batch(kind, model, processor, waveforms, torch, deadline):
    from transformers import StoppingCriteria, StoppingCriteriaList
    class StopAtDeadline(StoppingCriteria):
        def __call__(self, input_ids, scores, **kwargs):
            _check(deadline)
            return False
    stop = StoppingCriteriaList([StopAtDeadline()])
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
    if kind == 'whisper':
        inputs = processor(waveforms, sampling_rate=RATE, return_tensors='pt',
                           return_attention_mask=True).to('cuda', dtype)
        output = model.generate(**inputs, max_new_tokens=440, do_sample=False,
                                task='transcribe', return_timestamps=False, stopping_criteria=stop)
        texts = processor.batch_decode(output, skip_special_tokens=True)
        # Reserve eight positions within Whisper's 448-token decoder context.
        # Whisper's short-form wrapper may already strip its decoder prefix.
        # Remove it only when the returned tokens actually start with it.
        prefix_length = 0
        if output.shape[1] and int(output[0, 0]) == model.generation_config.decoder_start_token_id:
            initial = output[0, :8].tolist()
            no_timestamps = model.generation_config.no_timestamps_token_id
            if no_timestamps not in initial:
                raise ModelFailure('Unexpected Whisper decoder prefix.')
            prefix_length = initial.index(no_timestamps) + 1
        generated = output[:, prefix_length:]
        limit = 440
    else:
        inputs = processor.apply_transcription_request(waveforms, language=None,
                                                       audio_kwargs={'sampling_rate': RATE}).to('cuda', dtype)
        output = model.generate(**inputs, max_new_tokens=512, do_sample=False, stopping_criteria=stop)
        generated = output[:, inputs['input_ids'].shape[1]:]
        texts = processor.decode(generated, return_format='transcription_only')
        if isinstance(texts, str):
            texts = [texts]
        limit = 512
    if len(texts) != len(waveforms):
        raise ModelFailure('ASR batch output count differs from the fixed cohort.')
    eos = model.generation_config.eos_token_id
    eos = set(eos if isinstance(eos, list) else [eos])
    eos.discard(None)
    statuses = [_text_status(text, generated.shape[1] >= limit and not any(int(t) in eos for t in tokens))
                for text, tokens in zip(texts, generated)]
    del inputs, output, generated
    return texts, statuses


def run_windows(windows, output_dir, *, deadline, batch_size=4):
    """Return numeric report; checkpoint each completed batch; safe to resume.

    deadline is an absolute time.monotonic() deadline. No GPU is started by import; float32 fallback is used without native bf16.
    Never print the return of an ASR function or serialize local variables.
    """
    _check(deadline)
    if not 1 <= batch_size <= 16:
        raise ValueError('Batch size must be between 1 and 16.')
    items = _validate(windows)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = output_dir / 'numeric_results.json'
    fingerprint = hashlib.sha256(json.dumps([(i['window'], i['sha256']) for i in items]).encode()).hexdigest()
    pins = {name: {'model': repo, 'revision': rev} for name, (repo, rev) in MODEL_PINS.items()}
    report = {'version': 2, 'cohort_sha256': fingerprint, 'models': pins, 'duration_seconds': 30,
              'batches': [], 'coverage': {}, 'windows': [
                  {'window': i['window'], **{f: None for f in FIELDS},
                   'status': {f: -1 for f in FIELDS}} for i in items]}
    if checkpoint.exists():
        previous = json.loads(checkpoint.read_text())
        if set(previous) != set(report) or any(set(r) != {'window', *FIELDS, 'status'} for r in previous.get('windows', [])):
            raise ValueError('Checkpoint has unexpected fields.')
        if previous.get('cohort_sha256') != fingerprint or previous.get('models') != pins:
            raise ValueError('Checkpoint belongs to another cohort or model revision.')
        if [r['window'] for r in previous['windows']] != [i['window'] for i in items]:
            raise ValueError('Checkpoint window order differs.')
        report = previous
        for row in report['windows']:
            for field in FIELDS:
                if row[field] is not None:
                    row[field] = _vector(row[field])
    def save(stage, seconds=0., count=0):
        if count:
            report['batches'].append({'stage': stage, 'seconds': round(seconds, 4), 'windows': count})
        report['coverage'] = {field: {str(status): sum(r['status'][field] == status for r in report['windows'])
                                     for status in (-1, 0, 1, 2)} for field in FIELDS}
        _atomic(checkpoint, report)
    save('initial')
    model = processor = None
    transcripts = []
    # Suppress library output, warnings and progress; errors are deliberately generic.
    os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            import torch
            from transformers import AutoProcessor, AutoModelForSpeechSeq2Seq, AutoModelForMultimodalLM
            if not torch.cuda.is_available():
                raise ModelFailure('This runner requires a torch GPU device.')
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
            with _watchdog(deadline), torch.inference_mode():
                pending = [n for n, row in enumerate(report['windows']) if row['status']['gemma_audio'] < 0]
                if pending:
                    model = _load_eg(torch)
                    for start in range(0, len(pending), batch_size):
                        _check(deadline)
                        indices = pending[start:start + batch_size]
                        began = time.monotonic()
                        waves = [_audio(items[n]['path']) for n in indices]
                        vectors = model.encode([{'audio': w} for w in waves], batch_size=batch_size,
                                               normalize_embeddings=True, show_progress_bar=False)
                        if vectors.shape != (len(indices), 768):
                            raise ModelFailure('Audio embedding batch shape mismatch.')
                        for n, vector in zip(indices, vectors):
                            report['windows'][n]['gemma_audio'] = _vector(vector)
                            report['windows'][n]['status']['gemma_audio'] = 1
                        del waves, vectors
                        save('gemma_audio', time.monotonic() - began, len(indices))
                    model = None
                    _release(torch)
                for kind in ('whisper', 'qwen'):
                    field = kind + '_text'
                    pending = [n for n, row in enumerate(report['windows']) if row['status'][field] < 0]
                    if not pending:
                        continue
                    _check(deadline)
                    began = time.monotonic()
                    repo, revision = MODEL_PINS[kind]
                    processor = AutoProcessor.from_pretrained(repo, revision=revision)
                    factory = AutoModelForSpeechSeq2Seq if kind == 'whisper' else AutoModelForMultimodalLM
                    model = factory.from_pretrained(repo, revision=revision, dtype=dtype,
                                                    attn_implementation='sdpa').to('cuda').eval()
                    save(kind + '_load', time.monotonic() - began, 1)
                    for start in range(0, len(pending), batch_size):
                        _check(deadline)
                        indices = pending[start:start + batch_size]
                        began = time.monotonic()
                        waves = [_audio(items[n]['path']) for n in indices]
                        texts, statuses = _asr_batch(kind, model, processor, waves, torch, deadline)
                        for n, text, status in zip(indices, texts, statuses):
                            if status == 1:
                                transcripts.append((n, text))
                            else:
                                report['windows'][n]['status'][field] = status
                        del waves, texts, statuses, text
                        save(kind + '_asr', time.monotonic() - began, len(indices))
                    model = processor = None
                    _release(torch)
                    if transcripts:
                        _check(deadline)
                        model = _load_eg(torch, text_only=True)
                        for start in range(0, len(transcripts), batch_size):
                            _check(deadline)
                            part = transcripts[start:start + batch_size]
                            began = time.monotonic()
                            vectors = model.encode([t for _, t in part], prompt_name='Classification',
                                                   batch_size=batch_size, normalize_embeddings=True,
                                                   show_progress_bar=False)
                            if vectors.shape != (len(part), 768):
                                raise ModelFailure('Text embedding batch shape mismatch.')
                            for (n, _), vector in zip(part, vectors):
                                report['windows'][n][field] = _vector(vector)
                                report['windows'][n]['status'][field] = 1
                            del part, vectors
                            save(kind + '_text', time.monotonic() - began, min(batch_size, len(transcripts) - start))
                    transcripts.clear()
                    model = processor = None
                    _release(torch)
                _check(deadline)
        except BudgetExpired:
            save('budget')
            raise
        except Exception:
            save('error')
            raise ModelFailure('Model stage failed; numeric partial checkpoints retained; raw exception suppressed.') from None
        finally:
            transcripts.clear()
            model = processor = None
            if 'torch' in locals():
                _release(torch)
    save('complete')
    return report
