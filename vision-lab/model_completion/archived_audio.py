"""Read frozen numeric audio after source/catalog deletion; never open media or use a model."""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import math
import re
import sys
from pathlib import Path
import numpy as np
LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))
import training_snapshots as snapshots
PIN = 'google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b'
MAX_BYTES = 1024 * 1024


def generation(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    # Drizzle's timestamp-without-timezone contract treats its naive values as UTC.
    return parsed.replace(tzinfo=dt.timezone.utc) if parsed.tzinfo is None else parsed.astimezone(dt.timezone.utc)


def js_json(value):
    """JSON.stringify ordering/number spelling for the frozen source/index identity array."""
    if isinstance(value, list): return '[' + ','.join(js_json(v) for v in value) + ']'
    if isinstance(value, float):
        if not math.isfinite(value): raise ValueError('Nonfinite identity number')
        if value == 0: return '0'
        if value.is_integer() and abs(value) < 1e21: return str(int(value))
        text = repr(value)
        if 'e' in text:
            base, exponent = text.split('e'); exponent = int(exponent)
            if -6 <= exponent < 21:
                from decimal import Decimal
                return format(Decimal(text), 'f')
            return base.removesuffix('.0') + 'e' + ('+' if exponent >= 0 else '-') + str(abs(exponent))
        return text
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def feature_identity(manifest):
    s, i = manifest['source'], manifest['features']['index']
    fields = [s['videoId'], s['fileName'], s['fileHash'], s['fileSizeBytes'], s['durationSeconds'],
              i['modelRevision'], i['storyboardGeneratedAt'], i['indexedAt'], i['intervalSeconds'], i['frameCount'], 1152]
    return hashlib.sha256(js_json(fields).encode()).hexdigest()


def embedding(row, root=snapshots.ROOT):
    """Return a matching original-proposal vector, None when absent, raise on corrupted receipts."""
    root = Path(root)
    for manifest in snapshots.manifests(row['video_id'], root):
        if generation(manifest['analyzedAt']) != generation(row['analyzed_at']): continue
        receipt = manifest.get('audio_features')
        if not receipt: continue
        if receipt.get('modelRevision') != PIN: return None
        features = manifest['features']
        if (features['identity'] != feature_identity(manifest) or
                receipt['featureIdentity'] != features['identity'] or
                features['index']['modelRevision'] != 'siglip2/so400m-patch16-256'):
            raise ValueError('Frozen audio/frame source identity mismatch')
        file = receipt['file']
        if (not isinstance(file, str) or not re.fullmatch(r'audio-[a-f0-9]{64}\.json', file) or
                file != 'audio-' + receipt['sha256'] + '.json'):
            raise ValueError('Invalid frozen audio path')
        path = root / str(row['video_id']) / file
        size = path.stat().st_size
        if not 0 < size <= MAX_BYTES or size != receipt['bytes']:
            raise ValueError('Frozen audio size mismatch')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != receipt['sha256']:
            raise ValueError('Frozen audio checksum mismatch')
        payload = json.loads(raw)
        if payload['modelRevision'] != PIN or not isinstance(payload['proposals'], list) or len(payload['proposals']) > 60:
            raise ValueError('Invalid frozen audio model/coverage')
        # Verifies checksum, binary header, generation index, dimensions and finite values; numeric only.
        snapshots.frames(manifest, root)
        proposals = manifest.get('proposals')
        if proposals is None:
            proposals = [dict(c, **c.get('detected', {})) for c in manifest['clips'] if not c['id'].startswith('added-')]
        originals = {p['id']: p for p in proposals if not p['id'].startswith('added-')}
        result, seen = None, set()
        for item in payload['proposals']:
            original = originals.get(item['id'])
            if item['id'] in seen or original is None:
                raise ValueError('Frozen audio proposal identity mismatch')
            seen.add(item['id'])
            a, b = item['start_seconds'], item['end_seconds']
            if (a != original['start_seconds'] or b != original['end_seconds'] or
                    not math.isfinite(a) or not math.isfinite(b) or b-a < 20):
                raise ValueError('Frozen audio original range mismatch')
            vector = np.asarray(item['embedding'], dtype=np.float32)
            if vector.shape != (768,) or not np.isfinite(vector).all() or not .99 < float(np.linalg.norm(vector)) < 1.01:
                raise ValueError('Invalid frozen audio vector')
            if item['id'] == row['clip_id'] and a == row['detected_start'] and b == row['detected_end']:
                result = vector.copy()
        return result
    return None
