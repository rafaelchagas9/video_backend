"""Exact historical task inputs from numeric review archives; no media, database or inference.

A video id alone is never a feature identity. These inputs are separate from the latest
coarse cohort. Missing original generation/range/audio coverage stays explicit.
"""
from __future__ import annotations
import copy
import math
import json
import sys
import numpy as np
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))
import training_snapshots as snapshots
import archived_audio as archive
import fine_labels as labels

VISUAL_PIN = 'siglip2/so400m-patch16-256'
FORMAT = 'kura-task-generation-inputs'
MAX_SIDECAR_BYTES = 8 * 1024 * 1024
MAX_TASKS = 10000


def referenced_feedback_ids(tasks):
    """Both sides matter, including an A/B loser who is still a current candidate."""
    ids = set()
    for task in tasks:
        if task.get('kind') != 'versus' or task.get('answer') is None:
            continue
        for side in ('a', 'b'):
            value = task.get('context', {}).get(side, {}).get('feedback_id')
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise labels.FineLabelContractError('Task side requires an exact feedback id')
            ids.add(value)
    return sorted(ids)


def retained_records(tasks, records):
    """Retain referenced feedback generations without changing latest coarse selection."""
    needed = set(referenced_feedback_ids(tasks))
    result = {}
    for row in records:
        key = row['id']
        if key in needed:
            if key in result:
                raise labels.FineLabelContractError('Duplicate task feedback identity')
            result[key] = copy.deepcopy(row)
    return [result[key] for key in sorted(result)]


def side_metadata(task, side, feedback=None):
    if side not in ('a', 'b'):
        raise labels.FineLabelContractError('Unknown task side')
    value = task.get('context', {}).get(side)
    if not isinstance(value, dict):
        raise labels.FineLabelContractError('Missing task side context')
    try:
        lo, hi = map(float, value['clip'])
        a, b = max(lo, float(value['best'][0])), min(hi, float(value['best'][1]))
        if b <= a:
            a, b = lo, hi
    except (KeyError, TypeError, ValueError) as error:
        raise labels.FineLabelContractError('Invalid task offered range') from error
    meta = dict(row=f"p{task['id']:06d}{side}", task_id=task['id'], video_id=value['video_id'],
                start=a, end=b, y=int(task.get('answer') in (side, 'both')))
    verified = labels.contract(meta, task)
    if feedback is not None:
        channel = lambda text: str(text or '').removeprefix('@').lower()
        if (feedback['id'] != value['feedback_id'] or feedback['video_id'] != value['video_id'] or
                channel(feedback.get('channel')) != channel(task.get('channel'))):
            raise labels.FineLabelContractError('Task side feedback/video/channel mismatch')
    return dict(meta, **verified, feedback_id=value['feedback_id'])


def exact_archive(feedback, root=snapshots.ROOT):
    """No latest-by-video fallback, even when another valid generation exists."""
    matches = [row for row in snapshots.manifests(feedback['video_id'], Path(root))
               if archive.generation(row['analyzedAt']) == archive.generation(str(feedback['analyzed_at']))]
    if len(matches) > 1:
        raise labels.FineLabelContractError('Duplicate archived analysis generation')
    if not matches:
        return None
    return matches[0]


def side_inputs(task, side, feedback=None, root=snapshots.ROOT, feature_builder=None):
    meta = side_metadata(task, side, feedback)
    result = dict(meta, feature_recipe='recording-v1', visual_model_revision=VISUAL_PIN,
                  features=None, archive=None,
                  offered_audio={'status': 'missing_exact_offered_audio',
                                 'original_proposal_audio_is_not_offered': True})
    if feedback is None:
        return dict(result, status='missing_feedback_generation')
    result['analyzed_at'] = str(feedback['analyzed_at'])
    result['clip_id'] = feedback['clip_id']
    saved = exact_archive(feedback, root)
    if saved is None:
        return dict(result, status='missing_exact_generation_archive')
    feature = saved['features']
    index = feature['index']
    if index['modelRevision'] != VISUAL_PIN:
        return dict(result, status='missing_compatible_generation_index')
    if saved['detectorRevision'] != feedback['detector']:
        return dict(result, status='missing_matching_generation_detector')
    if feature['identity'] != archive.feature_identity(saved):
        raise labels.FineLabelContractError('Archived task source/index identity mismatch')
    original = saved.get('proposals')
    if original is None:
        original = [dict(row, **row.get('detected', {})) for row in saved['clips']]
    original = [row for row in original if not row['id'].startswith('added-')]
    matching = [i for i, row in enumerate(original) if row['id'] == feedback['clip_id']]
    if len(matching) != 1 or feedback.get('detected_start') is None or feedback.get('detected_end') is None:
        return dict(result, status='missing_exact_original_proposal')
    at = matching[0]
    target = original[at]
    if (target['start_seconds'] != feedback['detected_start'] or
            target['end_seconds'] != feedback['detected_end']):
        return dict(result, status='missing_matching_original_range')
    duration = saved['source']['durationSeconds']
    if (not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration <= 0 or
            not 0 <= meta['start'] < meta['end'] <= duration):
        return dict(result, status='missing_offered_range_coverage')
    # Checksums/header/index identity are verified before any numeric features are built.
    timestamps, vectors = snapshots.frames(saved, Path(root))
    interval = index['intervalSeconds']
    if not isinstance(interval, (int, float)) or not math.isfinite(interval) or interval <= 0:
        raise labels.FineLabelContractError('Invalid archived frame cadence')
    if (timestamps[0] > interval + .001 or np.any(np.diff(timestamps) > interval * 2 + .001) or
            timestamps[-1] + interval * 2 < duration):
        return dict(result, status='missing_complete_generation_frames')
    proposals = [dict(id=row['id'], start=row['start_seconds'], end=row['end_seconds'], score=row['score'])
                 for row in original]
    proposals[at].update(start=meta['start'], end=meta['end'], score=float(task['context'][side]['score']))
    if feature_builder is None:
        from prepare import features as feature_builder
    features = feature_builder(proposals, duration, timestamps, vectors)[at]
    if len(features) != 13 or not all(math.isfinite(float(x)) for x in features):
        raise labels.FineLabelContractError('Invalid historical task numeric features')
    result.update(status='numeric_features_available', features=features,
                  archive=dict(analyzed_at=saved['analyzedAt'], feature_identity=feature['identity'],
                               feature_sha256=feature['sha256'], feature_file=feature['file'],
                               index=copy.deepcopy(index), detected_start=target['start_seconds'],
                               detected_end=target['end_seconds']))
    return result


def build_sidecar(tasks, records, root=snapshots.ROOT, feature_builder=None):
    tasks = [copy.deepcopy(task) for task in tasks if task.get('kind') == 'versus' and task.get('answer') is not None]
    if len(tasks) > MAX_TASKS:
        raise labels.FineLabelContractError('Task generation sidecar exceeds bounded task count')
    selected = retained_records(tasks, records)
    by_id = {row['id']: row for row in selected}
    sides = [side_inputs(task, side, by_id.get(task['context'][side]['feedback_id']), root, feature_builder)
             for task in tasks if task.get('kind') == 'versus' and task.get('answer') is not None
             for side in ('a', 'b')]
    return dict(format=FORMAT, version=1, label_policy=labels.POLICY,
                visual_model_revision=VISUAL_PIN, tasks=tasks, task_records=selected, sides=sides,
                offered_audio_coverage='Missing unless a separate exact generation/range/window receipt is validated; original-proposal means are never substituted.',
                media_reads=0, database_writes=0)


def sidecar_features(sidecar, task, side, feedback, root=snapshots.ROOT):
    """Future callers may consume only a receipt matching the exact task/generation/range."""
    if (sidecar.get('format') != FORMAT or sidecar.get('version') != 1 or
            sidecar.get('label_policy') != labels.POLICY or sidecar.get('visual_model_revision') != VISUAL_PIN):
        raise labels.FineLabelContractError('Unsupported task-generation sidecar')
    expected = side_metadata(task, side, feedback)
    matches = [row for row in sidecar['sides'] if row['task_id'] == task['id'] and row['side'] == side]
    if len(matches) != 1:
        raise labels.FineLabelContractError('Missing or duplicate frozen task side')
    row = matches[0]
    keys = ('video_id', 'feedback_id', 'start', 'end', 'current_acceptability_y', 'ranking_y', 'cut_gold')
    if any(row.get(key) != expected.get(key) for key in keys):
        raise labels.FineLabelContractError('Frozen task offered range/decision mismatch')
    if ('analyzed_at' in row and archive.generation(row['analyzed_at']) != archive.generation(str(feedback['analyzed_at']))):
        raise labels.FineLabelContractError('Frozen task analysis generation mismatch')
    if row['status'] != 'numeric_features_available':
        return None
    receipt = row.get('archive') or {}
    if (archive.generation(receipt['analyzed_at']) != archive.generation(str(feedback['analyzed_at'])) or
            receipt['index']['modelRevision'] != VISUAL_PIN or receipt['detected_start'] != feedback['detected_start'] or
            receipt['detected_end'] != feedback['detected_end'] or row['clip_id'] != feedback['clip_id'] or
            row['feature_recipe'] != 'recording-v1' or row['visual_model_revision'] != VISUAL_PIN):
        raise labels.FineLabelContractError('Frozen task feature identity/range mismatch')
    values = row['features']
    if len(values) != 13 or not all(math.isfinite(float(x)) for x in values):
        raise labels.FineLabelContractError('Invalid frozen task features')
    fresh = side_inputs(task, side, feedback, root)
    if fresh['status'] != 'numeric_features_available':
        return None
    if fresh['archive'] != receipt or not np.allclose(fresh['features'], values, rtol=0, atol=1e-10):
        raise labels.FineLabelContractError('Frozen task features no longer match exact archived generation')
    return list(values)


def load_sidecar(root):
    path = Path(root) / 'task_generation_inputs.json'
    if not path.exists():
        return None
    if path.stat().st_size > MAX_SIDECAR_BYTES:
        raise labels.FineLabelContractError('Task generation sidecar exceeds 8 MiB limit')
    return json.loads(path.read_text())


def feedback_map(snapshot, sidecar=None):
    """Fine-only resolver: the snapshot's latest coarse records remain unchanged."""
    result = {row['id']: row for row in snapshot['records']}
    if sidecar is not None:
        if sidecar.get('format') != FORMAT or sidecar.get('version') != 1 or sidecar.get('label_policy') != labels.POLICY:
            raise labels.FineLabelContractError('Unsupported task-generation sidecar')
        needed = set(referenced_feedback_ids(snapshot['tasks'])); seen = set()
        for row in sidecar['task_records']:
            if row['id'] in seen:
                raise labels.FineLabelContractError('Duplicate task feedback identity')
            seen.add(row['id'])
            if row['id'] not in needed:
                raise labels.FineLabelContractError('Unreferenced task feedback row')
            if row['id'] in result and result[row['id']] != row:
                raise labels.FineLabelContractError('Conflicting task feedback generation')
            result[row['id']] = row
    return result


def require_offered_audio_identity(row):
    """An original-proposal mean or bare id/offset NPZ is not an offered-audio receipt."""
    if 'generation_input' in row:
        raise labels.FineLabelContractError('Exact offered-audio generation/range/window receipt is missing; numeric task features remain available')


def archived_frame_inputs(feedback, receipt, root=snapshots.ROOT):
    """A boundary consumer's generation key also binds its original input range."""
    saved = exact_archive(feedback, root)
    if saved is None:
        return None
    f = saved['features']
    if (f['identity'] != archive.feature_identity(saved) or f['identity'] != receipt['feature_identity'] or
            f['sha256'] != receipt['feature_sha256'] or f['index'] != receipt['index'] or
            f['index']['modelRevision'] != VISUAL_PIN or saved['detectorRevision'] != feedback['detector'] or
            receipt['detected_start'] != feedback['detected_start'] or receipt['detected_end'] != feedback['detected_end']):
        raise labels.FineLabelContractError('Boundary archive generation/source/index/range mismatch')
    originals = saved.get('proposals')
    if originals is None:
        originals = [dict(row, **row.get('detected', {})) for row in saved['clips']]
    matching = [row for row in originals if row['id'] == feedback['clip_id']]
    if len(matching) != 1 or matching[0]['start_seconds'] != feedback['detected_start'] or matching[0]['end_seconds'] != feedback['detected_end']:
        raise labels.FineLabelContractError('Boundary archived original proposal mismatch')
    t, v = snapshots.frames(saved, Path(root))
    interval = f['index']['intervalSeconds']
    if not isinstance(interval, (int, float)) or not math.isfinite(interval) or interval <= 0:
        raise labels.FineLabelContractError('Invalid archived frame cadence')
    if (t[0] > interval + .001 or np.any(np.diff(t) > interval * 2 + .001) or
            t[-1] + interval * 2 < saved['source']['durationSeconds']):
        return None
    return t, v
