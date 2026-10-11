# Private audio pilot — 2026-10-09

**Decision:** keep the cheap audio features available for the next evaluation; do not promote an embedding ranker or spend A100 time based on this pilot.

Saved keep/skip decisions measure initial triage, not final storage preference. All comparisons held out whole channels and fitted normalization inside training folds. No new classification was requested.

## Broad cheap-audio comparison

Same 283 proposals across 52 channels; 180 keep/skip pairs within recordings.

| Inputs | AUROC | Pair ordering accuracy |
|---|---:|---:|
| Duration + detector score | 0.799 | 81.7% |
| Baseline + cheap audio | 0.813 | 80.6% |

The classification improvement is small; ordering did not improve. This does not establish the best representation for sound quality, speech or personality.

## Four-way embedding comparison

Same 21 proposals across 16 channels; only 5 within-recording pairs.

| Inputs | AUROC | Pair ordering accuracy |
|---|---:|---:|
| Baseline | 0.750 | 80% |
| Baseline + cheap audio | 0.852 | 80% |
| Baseline + EmbeddingGemma 2 audio | 0.750 | 80% |
| Baseline + both | 0.861 | 80% |

**Embedding result is inconclusive.** Of 96 selected proposals, 46 checkpoints were produced and only 24 passed decoded-window validation; 21 also had usable cheap features. This small, availability-biased cohort cannot support a model decision. The separately evaluated 24-proposal cohort had AUROC 0.721 for baseline and 0.707 with embeddings.

## Extraction findings relevant to implementation

- Reuse the NVMe audio sidecars. Claude completed 206 cheap-feature caches and 76 compact audio tracks.
- `-threads 1` alone did not constrain every FFmpeg worker. Under the 768 MiB address-space limit, filter/output thread allocation failed. Explicit filter and output thread caps fixed a bounded diagnostic on a previously failing source.
- Some decoded windows were shorter than the requested duration. Legacy checkpoints that failed window validation were excluded. Diagnose timestamps/seek behavior before a future extraction; do not treat these exclusions as proof of corrupt recordings.
- Missing source files and incomplete cache coverage were also excluded. No further embedding retry was launched after the one bounded continuation.
- Export now checks window lengths and requires an audited file hash for legacy checkpoints without recorded sample counts.

Raw media and the private manifest stayed local. Nothing was uploaded to Drive. The final evaluation used local CPU; the earlier feature-only Colab CPU test had already passed and released its runtime. No A100 was allocated. No production model, review or source file was changed.

Detailed numeric report: `../data/colab-audio-pilot-20261009/report.json`.
