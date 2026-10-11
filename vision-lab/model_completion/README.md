# Recording model operations

Run from the backend checkout. Artifacts and evaluations are local; raw media is never uploaded. Requests use stored numeric vectors only. Decisions, edits and original ranges are not changed by classification.

## Active artifacts and rollback

| Artifact | Version | SHA256 |
| --- | --- | --- |
| `data/models/recordings-highlight-probe.json` | `stage1-candidate-20261010` | `da968dbf33bc6308f64e67749aea6efcec167305ce8fe3fe569f353c2b0201f4` |
| `data/models/recordings-model.json` | `recording-model-20261010-v1` | `bf23ace5457954b123ef07b70b5c27d25dd6883fa894e4e19a068e9cff047f6d` |

Stage 1 rollback is the byte-for-byte file `data/models/recordings-highlight-probe.backup-20261010T034020Z-850dfe2d4995.json`, SHA256 `850dfe2d4995e52cb7bdbd14f6a3589a24bfe12f5bb8f3f8e8089c797bc813cb`. Verify its hash before atomically replacing the active probe. Stage 2 had no predecessor: renaming its active file disables its assessments and retains the existing baseline order. Do not delete caches, snapshots or saved reviews to roll back. Promotion manifests and actual Bun runtime proofs live alongside these files.

## Enabled behavior and limits

- Stage 1 passed the matched unseen-channel gate: 83/85 known keeps retained, proposals 229→211; Python/Bun parity passed at the actual threshold 0.45.
- Numeric and pinned audio classifiers display **Keep potential**, meaning coarse triage. Whole-channel audio AUROC was 0.844 versus matched numeric 0.796. These probabilities do not automatically select or discard clips.
- New ranking, learned cuts, whole-recording verdicts and automatic pruning remain disabled. Failed candidates retain baseline order and original detected ranges; no four-minute cap is applied.
- The user clarified that **A/B keeps both clips as current candidates** and selects the stronger one; the loser may be replaced when better same-channel material arrives. The verified cohort has **40 current decisions: 36 candidates and 4 rejects, plus 8 strict comparisons and 28 saved cuts**. Both supplies no strict ordering; neither rejects both. No replacement time, threshold or permanent-storage verdict is inferred.
- Shared `fine_labels.py` policy `current-acceptability-versus-v2` freezes that meaning and validates answer/range/channel provenance. Current acceptability, relative quality and saved cuts are separate targets. Historical mistaken loser-negative and conservative `absolute-explicit-both-neither-v1` reports remain archived; new outputs use policy suffixes. Rare negatives across only two channels limit validation.
- As of `audio/production_coverage.json`, 57/61 eligible unsaved original proposals have validated production audio. Three have a missing source and one failed complete decoding; all four use numeric fallback. One additional proposal is shorter than 20 seconds. There are no remaining accessible missing caches.
- Audio is `google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b`: two uniform 20-second windows inside original ranges, averaged and unit-normalized to 768 values. Generation, source fingerprint, index, range, pin, sample coverage and vector norm must match. Stale/incomplete/missing inputs use numeric fallback.

## Bounded reproduction

These commands export candidates/reports, never promote them or change review answers. Use a separate checkout/data copy to retain historical reports. `prepare.py` preserves an existing immutable cohort; deleting it silently changes the experiment. Stage 1 reads current saved labels and compares against the currently active probe, so a rerun after promotion is a new comparison, not a reproduction of the old baseline gate.

```bash
export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2
# CPU: freeze original-proposal cohort and fit/evaluate/export numeric heads.
timeout 180s vision-lab/.venv/bin/python vision-lab/model_completion/prepare.py
timeout 600s vision-lab/.venv/bin/python vision-lab/model_completion/rank.py
timeout 300s vision-lab/.venv/bin/python vision-lab/model_completion/cut_and_whole.py \
  --cohort vision-lab/data/model-completion-20261010/cohort.json \
  --output vision-lab/data/model-completion-20261010/artifacts
# Stage 1 uses existing indexed/archived numeric frames, with no GPU/media decode.
timeout 600s vision-lab/.venv/bin/python vision-lab/model_completion/stage1_complete.py
timeout 180s vision-lab/.venv/bin/python vision-lab/model_completion/stage1_parity.py
# Reevaluate cached original-range audio, then export the gated bundle (CPU only).
timeout 900s vision-lab/.venv/bin/python vision-lab/model_completion/audio_complete.py evaluate
timeout 180s vision-lab/.venv/bin/python vision-lab/model_completion/export_bundle.py
```

Extraction is optional when numeric checkpoints already exist. It uses the cached model locally, waits for media/GPU jobs, and checkpoints progress. Neither command allocates Colab credits or uploads anything:

```bash
# Original-range training audio: one local run, including waiting, capped at 20 minutes.
nice -n 10 ionice -c 3 timeout 1220s vision-lab/colab_audio_pilot/.venv-v2/bin/python \
  vision-lab/model_completion/audio_complete.py run --minutes 20
# Resume a specific EXISTING private generation job, with the same finite bound.
JOB=data/models/recording-audio-jobs/<existing-generation-hash>.json
nice -n 10 ionice -c 3 timeout 1220s vision-lab/colab_audio_pilot/.venv-v2/bin/python \
  vision-lab/model_completion/audio_cache_worker.py "$JOB" \
  --cache-root data/models/recording-audio-cache --seconds 1200
```

Successful new analysis enqueues one bounded local worker. Explicit processing **Resume/Start** also launches one 300-second drain of existing valid private audio jobs; boot and watcher kicks do not. Busy/deferred jobs retain numeric fallback and checkpoints for the next explicit bounded resume. There is no permanent retry timer. Jobs contain local source paths: keep them private; published caches contain only pseudonymous IDs/numbers.

## Training survives reviewed-source deletion

Save/render/delete preflight freezes decisions, original proposals and existing visual vectors under `data/recording-training-snapshots/`. Validated available audio is frozen separately, at most 1 MiB per generation. Source media and model inference are unnecessary. Deletion stops if a reviewed archive cannot be preserved; never-reviewed analyses do not require an archive.

`archived_audio.py` restores exact frozen proposal vectors into `audio_complete.py` checkpoints after source/catalog deletion. It verifies generation, full pin, original ranges, source/index identity, both file hashes and finite unit vectors. Added/trimmed ranges cannot reuse an unrelated vector. Older archives lacking audio use the available numeric inputs.

```bash
vision-lab/.venv/bin/python -m unittest discover -s vision-lab/model_completion -p archived_audio_test.py
bun scripts/run-test-files.ts tests/recordings-deletion-preflight.test.ts \
  tests/recordings-snapshots.test.ts tests/recordings-snapshot-lifecycle.test.ts \
  tests/recordings-model.test.ts tests/recordings-audio-cache.test.ts \
  tests/recordings-audio-resume.test.ts tests/recordings-processing-audio-resume.test.ts
bunx tsc --noEmit
```

The archive tests use disposable numeric fixtures with no source/catalog present. No real recording is deleted during verification.

Feature completion uses the existing authenticated SSE connection to update advisory assessments in an open web/native review. One finite worker emits only changed numeric video IDs; idle waits and reused caches stay silent. Same-generation drafts, clip edges, ordering and playback remain intact.

Full-original model evidence: continuous original-range audio, joint image/audio, timestamped speech and a held-channel-safe coarse-audio prior have been evaluated against the saved final cuts. Selected precise-cut heads remain disabled; coarse Keep potential classification is deployed. The final speech implementation audit found no concrete defect; transcript accuracy and silence calibration are unverified. The current-candidate meaning of one-sided versus answers is now fixed by the user; whole-review semantics are now explicit: 3 whole-positive recordings across only 2 channels, 39 all-skipped whole-negative recordings, and 96 mixed recordings remain unknown. Near-full kept coverage refers only to edited clips. The whole classifier remains unavailable because the existing minimum of five positive recordings is not met. See `data/model-completion-20261010/artifacts/precision_completion_summary.json`, `joint-gemma/dense-original-speech/evaluation/` and `coarse-prior/evaluation/` within that data directory for the final matched reports.

A fixed C1 pixel-temporal check on the same 21 full originals added four grayscale change/Laplacian texture proxies from 197 verified SSD storyboard pages. It completed in 11.47 seconds including the failed preflight; one window has an explicit five-second initial pixel gap and uses three existing tiles. IoU was 0.51975 versus identity 0.51738, with 99.09% retained selected duration; gain confidence intervals versus identity and the matched zero-pixel control both cross zero. The cut envelope remains disabled. Receipts, preregistration, predictions and the report are in `data/model-completion-20261010/pixel-temporal/`; this is a five-second pixel proxy, not optical flow.

The paired final-range audit used 24 explicit both/neither sides: 19 saved spans changed, while five retained the offered edges. With each fine channel excluded from coarse training, audio AUROC changed from 0.975 to 0.9625 (offered to final), numeric13 from 0.7625 to 0.9375, and length plus score from 0.8875 to 1.0. It reused 11 exact windows and embedded 37 new 20-second windows from validated SSD FLAC caches in 22.31 seconds. Only two channels supply negative examples, and coarse scores are not calibrated final-worth probabilities. No final classifier was trained or promoted. Preregistration, checkpoints and paired predictions are in `data/model-completion-20261010/final-worth-matched/absolute-explicit-both-neither-v1/`; no original/HDD reads or cloud credits were used.

A fixed edited-coarse temporal prior also tested the previously unused retained-interior occupancy signal from 74 recoverable genuinely trimmed spans, excluding 46 unchanged keeps and every held fine channel. Its C0.1 prior added one scalar to a fixed C1 fine head on all 26 original fine targets. IoU was 0.51024 versus identity 0.53121 and the matched control 0.52151, with 95.31% retained selected duration; both paired gain intervals cross zero. The 9.83-second CPU run leaves the envelope disabled. This coarse occupancy is weak choice evidence rather than final worth. Preregistration, exact channel/fold/cache receipts and predictions are in `data/model-completion-20261010/edited-coarse-temporal/`.

## Clarified current-candidate validation

On the same 40 offered sides (36 current candidates, four rejects, 15 channels), the fixed coarse audio recipe had AUROC 0.9236 versus its matched numeric control 0.8333. Both agreed with seven of eight strict choices. All evaluated probabilities had worse Brier score than the constant 90% acceptance baseline; this does not validate current-acceptance calibration or permanent storage. Exact offered vectors were reused on CPU, with no media or cloud work. The v2 report and predictions are under `data/model-completion-20261010/fine-audio-matched/`.

A fixed pooled-span preference experiment used 21 originals, 10 channels and 1,149 existing audio windows. Training selected intervals outranked fixed alternatives without labeling outside frames bad. Its raw suggestions lost selected material during inner validation; every fold therefore retained the original. It failed the unchanged cut gate and remains disabled. This one CPU evaluation took 1.63 seconds; `data/model-completion-20261010/structured-span-preference/evaluation/` contains its report and predictions.

Future corpus preparation writes a separate `task_generation_inputs.json` (8 MiB maximum), retaining both sides’ exact feedback generations and task context without changing the latest coarse cohort. Offered/final/cut consumers verify the archived generation, source/index identity, SigLIP pin, original proposal range, checksums and frame coverage; cut inputs use generation-keyed frames and omit cheap audio without a matching generation receipt. Missing exact offered audio stays explicit: original-proposal means and bare video-ID checkpoints are never substituted. Existing immutable corpora keep their audited legacy path; `task_generation_inputs_test.py` verifies this with disposable numeric fixtures, without media, fitting or database writes.

A fixed weak coarse span-preference prior reused 74 genuinely edited coarse spans across 30 channels, without labeling omitted frames bad. On the same 21 full originals, every inner selection retained the original; held-out IoU stayed 0.51738 with no meaningful cuts. The 7.39-second CPU run failed the cut gate; its independently checked report is `data/model-completion-20261010/coarse-span-preference/coarse_span_report.json`.

## Prepared human refinement round — 2026-10-10

Eight existing-recording versus tasks are live in batch `versus-targeted-20261010-1`; no new recordings or cloud uploads. The immutable private manifest and delivery receipt are under `data/model-completion-20261010/targeted-label-round/`. Positions 0–3 supply training labels; positions 4–7 reserve four new channels for untouched fine evaluation. Roles were frozen before insertion or answers. Shared default fit helpers reject reserved holdout rows/tasks; future fits must explicitly select training tasks, and evaluate reserved labels only after freezing model/family/threshold choices. This round supplies current preference and selected precise cuts, not whole-recording or permanent-storage labels. Android 0.1.6/code7 is installed with data preserved; the real web app shows the eight open tasks and retains the comparison while confirming a cut. Further model experiments are held until these judgments are available; all phases remain incomplete.

Read the new answers with the finite intake below. It checks the final reviewed manifest/source and frozen role receipts, reads only these eight tasks, and returns waiting counts without files while any answer is pending. Once all eight are answered with the required selected-side cuts, it writes a private content-addressed answer snapshot; reanswers create a separate revision. It performs no fitting, media work or production writes. Existing `prepare.py` deliberately preserves the old immutable cohort and will not ingest this round by itself.

```sh
env PYTHONDONTWRITEBYTECODE=1 vision-lab/colab_audio_pilot/.venv-v2/bin/python -B vision-lab/model_completion/targeted_answer_intake.py
```

Consume `training_rows` for future fitting. Keep `holdout_rows` separate until model choices are frozen; shared fit guards reject them. `confirmed_cut_gold` includes only explicitly selected sides, while current candidate labels retain both A/B sides as accepted. The verified first intake returned 0/8 answered, with no snapshot written.


## Connected comparison round — 2026-10-10

Batch `versus-connected-20261010-1` adds 20 finite training comparisons: 12 cross-creator links and eight same-creator comparisons across recordings, connecting eight creators through 16 confirmed clips. Each anchor appears four times at most, including earlier tasks. Original detected bounds remain available; previews use bounded 15-second midpoint snippets. All four reserved holdout creators from the earlier eight-task round are excluded. Manifest SHA: `1d9fe39191cc0478b4710bc8d48b5997e28f4776f6421d7b0d1d8a698505cd43`. Migration `0058` makes versus identity the batch position so anchors can recur, while retaining the original item uniqueness for other task kinds. Android 0.1.8/code9 is installed; no new recordings were started.

```sh
env PYTHONDONTWRITEBYTECODE=1 vision-lab/colab_audio_pilot/.venv-v2/bin/python -B vision-lab/model_completion/connected_answer_intake.py
```

This reads only the 20-task batch and returns waiting counts without writing labels until every task has a valid answer and selected cuts. Complete or revised answers become separate private immutable snapshots under `data/model-completion-20261010/connected-label-round/answer-snapshots/`. They contain exact per-side creator identities, current-candidate labels, strict preference and selected cut gold separately. Before any training-fold transform or fit, use `training_pairs_excluding_creators(rows, held_creators)` to exclude the entire pair if **either** creator is held out; never assign both cross-creator sides a fake shared group. Use this module’s `strict_pair_metrics(rows, scores)` for complete paired evaluation: it keeps both creators and reports cross/same strict preferences separately. The earlier eight-task training/holdout split and immutable corpus remain unchanged. Neither intake fits a model or changes production answers.
