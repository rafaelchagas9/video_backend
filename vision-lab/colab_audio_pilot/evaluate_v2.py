"""CPU-only, nested channel-held-out comparison of numeric audio representations.

No media, transcripts, filenames or original channel names are read or returned.
Mean and elementwise-max aggregation are fixed before evaluation, never selected
using outer test results. Failed/missing inference excludes the whole row.
Explicit successful no-text outputs permit aggregation of the remaining transcript
vectors, with their coverage fraction supplied as a numeric feature.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path

import numpy as np
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

DIMENSION = 768
C_VALUES = (0.1, 1.0, 10.0, 100.0)
REPRESENTATIONS = ('gemma_audio', 'whisper_text', 'qwen_text')
MODELS = {
    'baseline': (False, ()),
    'cheap_audio': (True, ()),
    'gemma_audio': (False, ('gemma_audio',)),
    'cheap_gemma_audio': (True, ('gemma_audio',)),
    'whisper_coverage': (False, ('whisper_text',)),
    'whisper_text': (False, ('whisper_text',)),
    'qwen_coverage': (False, ('qwen_text',)),
    'qwen_text': (False, ('qwen_text',)),
    'gemma_whisper': (False, ('gemma_audio', 'whisper_text')),
    'gemma_qwen': (False, ('gemma_audio', 'qwen_text')),
}


def _vector(value, width, description):
    if not isinstance(value, (list, tuple)) or len(value) != width:
        raise ValueError(f'{description}: incorrect numeric vector width')
    result = np.asarray(value, dtype=np.float64)
    if not np.isfinite(result).all():
        raise ValueError(f'{description}: nonfinite values')
    return result


def validate_rows(payload):
    """Reject malformed data without including private input values in errors."""
    if not isinstance(payload, dict) or not isinstance(payload.get('rows'), list):
        raise ValueError('Expected an object containing a rows list')
    rows = payload['rows']
    seen = set()
    recording_groups = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Each row must be an object')
        for key in ('row', 'group', 'recording'):
            if not isinstance(row.get(key), str) or not row[key]:
                raise ValueError('Missing pseudonymous row/group/recording identifier')
        if row['row'] in seen:
            raise ValueError('Duplicate pseudonymous row identifier')
        seen.add(row['row'])
        group = recording_groups.setdefault(row['recording'], row['group'])
        if group != row['group']:
            raise ValueError('One recording belongs to multiple channel groups')
        if row.get('y') not in (0, 1):
            raise ValueError('Targets must be binary saved keep/skip decisions')
        _vector(row.get('base'), 2, 'Base features')
        if row.get('audio') is not None:
            _vector(row['audio'], 4, 'Cheap audio features')
        windows = row.get('windows')
        if not isinstance(windows, list):
            raise ValueError('Each row must include a windows list')
        ids = set()
        for window in windows:
            if not isinstance(window, dict) or not isinstance(window.get('id'), str):
                raise ValueError('Each window needs a pseudonymous identifier')
            if window['id'] in ids:
                raise ValueError('Duplicate window identifier within a row')
            ids.add(window['id'])
            statuses = window.get('status', {})
            if not isinstance(statuses, dict):
                raise ValueError('Window status must be a representation/status mapping')
            if any(value not in (-1, 0, 1, 2) for value in statuses.values()):
                raise ValueError('Unsupported inference status')
            for representation in REPRESENTATIONS:
                value = window.get(representation)
                status = statuses.get(representation)
                if status == 0 and representation == 'gemma_audio':
                    raise ValueError('Direct audio cannot have a no-text status')
                if status in (-1, 0, 2) and value is not None:
                    raise ValueError('Nonusable inference status has an embedding')
                if value is not None:
                    vector = _vector(value, DIMENSION, 'Embedding')
                    if np.linalg.norm(vector) <= 1e-12:
                        raise ValueError('Embedding has zero norm')
    return rows


def fold_ids(rows, n=5):
    """Assign whole channels, balancing row counts without looking at labels."""
    counts = defaultdict(int)
    for row in rows:
        counts[row['group']] += 1
    if not counts:
        return np.array([], dtype=int)
    loads = [0] * min(n, len(counts))
    assigned = {}
    for group, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        fold = int(np.argmin(loads))
        assigned[group] = fold
        loads[fold] += count
    return np.array([assigned[row['group']] for row in rows], dtype=int)


def _assert_disjoint(rows, train, test):
    train_groups = {row['group'] for row, use in zip(rows, train) if use}
    test_groups = {row['group'] for row, use in zip(rows, test) if use}
    assert train_groups.isdisjoint(test_groups), 'Channel leakage across folds'
    train_recordings = {row['recording'] for row, use in zip(rows, train) if use}
    test_recordings = {row['recording'] for row, use in zip(rows, test) if use}
    assert train_recordings.isdisjoint(test_recordings), 'Recording leakage across folds'


def window_status(window, representation):
    """Legacy usable vectors remain valid; an unspecified missing vector is pending."""
    status = window.get('status', {}).get(representation)
    if status is None:
        return 1 if window.get(representation) is not None else -1
    if status == 1 and window.get(representation) is None:
        return -1
    return status


def representation_state(row, representation):
    statuses = [window_status(window, representation) for window in row['windows']]
    if not statuses or any(status not in (0, 1) for status in statuses):
        return 'blocked_inference'
    if representation == 'gemma_audio':
        return 'complete' if all(status == 1 for status in statuses) else 'blocked_inference'
    if not any(status == 1 for status in statuses):
        return 'all_no_text'
    return 'partial_no_text' if any(status == 0 for status in statuses) else 'complete'


def complete(row, representations=(), cheap=False, allow_no_text=False):
    if cheap and row.get('audio') is None:
        return False
    accepted = ('complete', 'partial_no_text', 'all_no_text') if allow_no_text else ('complete', 'partial_no_text')
    return all(representation_state(row, representation) in accepted
               for representation in representations)


def aggregate(row, representation, allow_no_text=False):
    vectors = np.asarray([
        window[representation] for window in row['windows']
        if window_status(window, representation) == 1
    ], dtype=np.float64)
    if len(vectors) == 0:
        if allow_no_text and representation_state(row, representation) == 'all_no_text':
            return np.zeros(DIMENSION * 2, dtype=np.float64)
        raise ValueError('No usable vectors available for aggregation')
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    mean = vectors.mean(axis=0)
    maximum = vectors.max(axis=0)
    # An exactly cancelled mean is zero, never amplified or replaced with a label.
    mean /= max(float(np.linalg.norm(mean)), 1e-12)
    maximum /= max(float(np.linalg.norm(maximum)), 1e-12)
    return np.concatenate((mean, maximum))


def features(rows, kind, allow_no_text=False):
    cheap, representations = MODELS[kind]
    text_representations = [key for key in representations if key != 'gemma_audio']
    if not all(complete(row, representations, cheap, allow_no_text) for row in rows):
        raise ValueError('Model cohort includes pending, rejected or entirely missing outputs')
    output = []
    for row in rows:
        parts = [np.asarray(row['base'], dtype=np.float64)]
        if cheap:
            parts.append(np.asarray(row['audio'], dtype=np.float64))
        # Coverage is learned/scaled only within training folds, before unit vectors.
        if text_representations:
            parts.append(np.asarray([
                sum(window_status(window, key) == 1 for window in row['windows']) / len(row['windows'])
                for key in text_representations
            ], dtype=np.float64))
        if not kind.endswith('_coverage'):
            parts.extend(aggregate(row, representation, allow_no_text) for representation in representations)
        output.append(np.concatenate(parts))
    width = (6 if cheap else 2) + len(text_representations)
    return np.asarray(output), width


def build_model(numeric_width, c):
    transforms = ColumnTransformer(
        [('numeric', StandardScaler(), list(range(numeric_width)))],
        remainder='passthrough',
    )
    # Embedding coordinates remain on their shared unit-vector scale.
    classifier = LogisticRegression(C=c, solver='liblinear', dual=False, tol=1e-6,
                                    max_iter=5000, random_state=20261009)
    return make_pipeline(transforms, classifier)


def select_c(X, y, rows, numeric_width):
    """Inner validation sees only the outer training channels."""
    folds = fold_ids(rows, n=3)
    candidate_results = []
    for c in C_VALUES:
        scores = np.full(len(y), np.nan)
        for fold in sorted(set(folds)):
            test = folds == fold
            train = ~test
            _assert_disjoint(rows, train, test)
            if len(np.unique(y[train])) < 2:
                continue
            model = build_model(numeric_width, c)
            model.fit(X[train], y[train])
            scores[test] = model.decision_function(X[test])
        if np.isfinite(scores).all() and len(np.unique(y)) == 2:
            metric = float(balanced_accuracy_score(y, scores > 0))
            candidate_results.append((c, metric))
    if not candidate_results:
        return C_VALUES[0], 'fallback_insufficient_inner_class_coverage', []
    best = max(metric for _, metric in candidate_results)
    # Candidates are ordered ascending; ties (including numerical ties) prefer less flexibility.
    chosen = next(c for c, metric in candidate_results if metric >= best - 1e-12)
    details = [{'C': c, 'balanced_accuracy': round(metric, 6)} for c, metric in candidate_results]
    return chosen, 'inner_channel_validation', details


def counts(rows):
    kept = sum(row['y'] for row in rows)
    return {'rows': len(rows), 'channels': len({row['group'] for row in rows}),
            'recordings': len({row['recording'] for row in rows}),
            'keeps': int(kept), 'skips': len(rows) - int(kept),
            'windows': sum(len(row['windows']) for row in rows)}


def held_out(rows, kind, allow_no_text=False):
    X, width = features(rows, kind, allow_no_text)
    y = np.array([row['y'] for row in rows], dtype=int)
    folds = fold_ids(rows)
    scores = np.full(len(y), np.nan)
    selections = []
    for fold in sorted(set(folds)):
        test = folds == fold
        train = ~test
        _assert_disjoint(rows, train, test)
        if len(np.unique(y[train])) < 2:
            continue
        train_rows = [row for row, use in zip(rows, train) if use]
        c, selection, inner = select_c(X[train], y[train], train_rows, width)
        model = build_model(width, c)
        model.fit(X[train], y[train])
        scores[test] = model.decision_function(X[test])
        selections.append({'fold': int(fold), 'C': c, 'selection': selection,
                           'inner_candidates': inner, 'train_rows': int(train.sum()),
                           'test_rows': int(test.sum())})
    if not np.isfinite(scores).all() or len(np.unique(y)) < 2:
        return {'status': 'insufficient_class_coverage', **counts(rows),
                'scored_rows': int(np.isfinite(scores).sum()), 'folds': selections}
    by_recording = defaultdict(list)
    for index, row in enumerate(rows):
        by_recording[row['recording']].append(index)
    correct = 0.0
    pairs = 0
    pair_recordings = 0
    for indices in by_recording.values():
        kept = [index for index in indices if y[index]]
        skipped = [index for index in indices if not y[index]]
        if kept and skipped:
            pair_recordings += 1
        for keep in kept:
            for skip in skipped:
                pairs += 1
                correct += 1.0 if scores[keep] > scores[skip] else 0.5 if scores[keep] == scores[skip] else 0.0
    return {'status': 'ok', **counts(rows),
            'auroc': round(float(roc_auc_score(y, scores)), 4),
            'balanced_accuracy': round(float(balanced_accuracy_score(y, scores > 0)), 4),
            'within_recording_pairs': pairs, 'recordings_with_pairs': pair_recordings,
            'pair_accuracy': round(correct / pairs, 4) if pairs else None,
            'folds': selections}


def evaluate(payload):
    rows = validate_rows(payload)
    report = {
        'target': 'saved_keep_skip_coarse_triage',
        'normalization': 'numeric features fit inside each training fold; unit embeddings passthrough',
        'aggregation': 'usable-vector L2 normalization; concatenated L2-normalized mean and elementwise max; transcript usable-window fraction is a numeric feature',
        'regularization': {'C_candidates': list(C_VALUES), 'selection': 'inner whole-channel balanced accuracy; ties choose smaller C'},
        'outer_validation': 'up to five whole-channel folds, row-count balanced without labels',
        'input_coverage': counts(rows),
        'eligible_output_rows': {key: sum(complete(row, (key,)) for row in rows) for key in REPRESENTATIONS},
        'representation_coverage': {key: {state: sum(representation_state(row, key) == state for row in rows)
            for state in ('complete', 'partial_no_text', 'all_no_text', 'blocked_inference')}
            for key in REPRESENTATIONS},
        'comparisons': {},
        'limitations': [
            'Saved keep/skip labels measure coarse triage, not final storage preference.',
            'Pending, rejected or unspecified missing inference excludes the proposal; failed outputs are never zero-filled.',
            'Explicit successful no-text windows are omitted from transcript-vector aggregation and represented by their usable-window coverage fraction.',
            'Text-available comparisons exclude entirely no-text proposals. Separate all-completed-inference comparisons retain them as zero aggregate vectors with an explicit zero usable-window fraction; failed or pending outputs are still excluded.',
            'Completed with no text does not establish that speech was absent. Coverage-only heads distinguish text-production availability from semantic information.',
            "The main comparison uses identical eligible rows and sampled windows; transcript means/maxima use only that model's usable text vectors.",
            'A larger cohort result cannot be compared numerically against a smaller cohort as a model effect.',
            'Few channels, rows or mixed-decision recordings limit inference; point estimates have no uncertainty interval.',
            'Sampled windows do not describe every second of a proposal; transcript embeddings do not retain all delivery cues.',
            'Mean-plus-max aggregation and C candidates were fixed before reading outer test results.',
        ],
    }
    cohorts = [
        ('baseline_all', rows, ('baseline',)),
        ('cheap_audio', [row for row in rows if complete(row, cheap=True)], ('baseline', 'cheap_audio')),
        ('direct_audio', [row for row in rows if complete(row, ('gemma_audio',))], ('baseline', 'gemma_audio')),
        ('direct_audio_with_cheap', [row for row in rows if complete(row, ('gemma_audio',), cheap=True)], ('baseline', 'cheap_audio', 'gemma_audio', 'cheap_gemma_audio')),
        ('whisper_matched', [row for row in rows if complete(row, ('gemma_audio', 'whisper_text'))], ('baseline', 'gemma_audio', 'whisper_text', 'gemma_whisper')),
        ('qwen_matched', [row for row in rows if complete(row, ('gemma_audio', 'qwen_text'))], ('baseline', 'gemma_audio', 'qwen_text', 'gemma_qwen')),
        ('whisper_all_completed', [row for row in rows if complete(row, ('gemma_audio', 'whisper_text'), allow_no_text=True)], ('baseline', 'whisper_coverage', 'whisper_text', 'gemma_whisper')),
        ('qwen_all_completed', [row for row in rows if complete(row, ('gemma_audio', 'qwen_text'), allow_no_text=True)], ('baseline', 'qwen_coverage', 'qwen_text', 'gemma_qwen')),
        ('main_matched', [row for row in rows if complete(row, REPRESENTATIONS, cheap=True)], tuple(MODELS)),
    ]
    for name, cohort, kinds in cohorts:
        result = {'coverage': counts(cohort), 'excluded_rows': len(rows) - len(cohort)}
        if len(cohort) < 20 or len({row['group'] for row in cohort}) < 5 or len({row['y'] for row in cohort}) < 2:
            result['status'] = 'insufficient_coverage'
            result['models'] = {}
        else:
            result['status'] = 'evaluated'
            result['models'] = {kind: held_out(cohort, kind, allow_no_text=name.endswith('_all_completed')) for kind in kinds}
        report['comparisons'][name] = result
    return report


def self_test():
    def embedding(label):
        vector = [0.0] * DIMENSION
        vector[label] = 1.0
        return vector

    rows = [
        {'row': f'x{i:04d}', 'group': f'g{i // 4:04d}', 'recording': f'r{i // 4:04d}',
         'y': i % 2, 'base': [float(i + 1), float(i % 2)],
         'audio': [float(i % 2), 0.0, 1.0, 2.0],
         'windows': [{'id': f'w{i:04d}_{j}', 'status': {key: 1 for key in REPRESENTATIONS},
                      **{key: embedding(i % 2) for key in REPRESENTATIONS}} for j in range(2)]}
        for i in range(24)
    ]
    assignments = fold_ids(rows)
    assert len(set(assignments)) == 5
    for fold in set(assignments):
        _assert_disjoint(rows, assignments != fold, assignments == fold)
    # Train-only transform: a held-out extreme must not shift fitted means.
    X, width = features(rows, 'gemma_audio')
    model = build_model(width, 1.0)
    model.fit(X[:16], np.array([row['y'] for row in rows[:16]]))
    scaler = model.named_steps['columntransformer'].named_transformers_['numeric']
    assert np.allclose(scaler.mean_, X[:16, :2].mean(axis=0))
    held_out_extreme = X[16:17].copy()
    held_out_extreme[0, 0] = 1e9
    transformed = model.named_steps['columntransformer'].transform(held_out_extreme)
    assert transformed[0, 0] > 1e6
    assert np.array_equal(transformed[:, width:], held_out_extreme[:, width:])
    assert np.allclose(scaler.mean_, X[:16, :2].mean(axis=0))
    # Legitimate partial no-text stays eligible; failures, pending and wholly no-text do not.
    rows[0]['windows'][1]['qwen_text'] = None
    rows[0]['windows'][1]['status']['qwen_text'] = 0
    rows[1]['windows'][1]['qwen_text'] = None
    rows[1]['windows'][1]['status']['qwen_text'] = -1
    rows[2]['windows'][1]['whisper_text'] = None
    rows[2]['windows'][1]['status']['whisper_text'] = 2
    for window in rows[3]['windows']:
        window['whisper_text'] = None
        window['status']['whisper_text'] = 0
    rows[4]['windows'][1]['qwen_text'] = None
    del rows[4]['windows'][1]['status']['qwen_text']
    report = evaluate({'rows': rows})
    main = report['comparisons']['main_matched']
    assert main['coverage']['rows'] == 20
    assert report['comparisons']['direct_audio']['coverage']['rows'] == 24
    assert report['representation_coverage']['qwen_text']['partial_no_text'] == 1
    assert report['representation_coverage']['whisper_text']['all_no_text'] == 1
    assert complete(rows[0], ('qwen_text',))
    partial_X, partial_width = features([rows[0]], 'qwen_text')
    assert partial_width == 3 and partial_X[0, 2] == 0.5
    assert not complete(rows[1], ('qwen_text',))
    assert not complete(rows[2], ('whisper_text',))
    assert not complete(rows[3], ('whisper_text',))
    assert complete(rows[3], ('whisper_text',), allow_no_text=True)
    assert not complete(rows[2], ('whisper_text',), allow_no_text=True)
    empty_X, empty_width = features([rows[3]], 'whisper_text', allow_no_text=True)
    assert empty_width == 3 and empty_X[0, 2] == 0 and np.count_nonzero(empty_X[0, 3:]) == 0
    coverage_X, coverage_width = features([rows[3]], 'whisper_coverage', allow_no_text=True)
    assert coverage_X.shape == (1, 3) and coverage_width == 3
    assert report['comparisons']['whisper_all_completed']['coverage']['rows'] == 23
    assert not complete(rows[4], ('qwen_text',))
    assert main['models']['gemma_audio']['auroc'] > 0.99
    assert main['models']['gemma_qwen']['pair_accuracy'] == 1.0
    assert {result['rows'] for result in main['models'].values()} == {20}
    assert len({tuple(fold['test_rows'] for fold in result['folds']) for result in main['models'].values()}) == 1
    assert select_c(X[:16], np.array([row['y'] for row in rows[:16]]), rows[:16], width)[0] == C_VALUES[0]
    try:
        features(rows, 'qwen_text')
    except ValueError:
        pass
    else:
        raise AssertionError('Missing window silently entered a feature matrix')
    print('PASS: group separation, nested selection, train-only scaling, unchanged embedding scale, matched missing-output filtering, explicit partial no-text coverage')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--self-test', action='store_true')
    arguments = parser.parse_args()
    if arguments.self_test:
        self_test()
    elif arguments.source is None:
        parser.error('source is required unless --self-test is specified')
    else:
        result = evaluate(json.loads(arguments.source.read_text()))
        serialized = json.dumps(result, indent=2, allow_nan=False)
        if arguments.output:
            arguments.output.write_text(serialized + '\n')
        print(serialized)
