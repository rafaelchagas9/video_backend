# Audio pilot v2: feedback for implementation

Keep length + detector score for stage 1. This pilot found no consistent ordering improvement from direct EmbeddingGemma 2 audio, Whisper large-v3-turbo transcripts, Qwen3-ASR-1.7B transcripts, or their combinations. It does not justify a full-recording cloud ASR run for coarse triage yet.

Tested 62 saved keep/skip proposals across 29 channels, using four 30-second windows per proposal: three uniform positions and one activity peak. Windows can overlap. Every model received the same audio. Transcripts were encoded with EmbeddingGemma 2; they were not manually checked against reference transcripts.

The common eligible cohort has **38 proposals, 20 channels and only 10 within-recording keep/skip pairs**:

| Features | AUROC | Kept-versus-skipped pairs ordered correctly |
|---|---:|---:|
| Length + detector score | 0.781 | 9/10 |
| + Cheap audio | 0.797 | 7/10 |
| + EmbeddingGemma 2 audio | 0.744 | 9/10 |
| + Whisper turbo transcript embeddings | 0.775 | 9/10 |
| + Qwen3-ASR transcript embeddings | 0.767 | 7/10 |
| + Gemma audio + Whisper text | 0.753 | 9/10 |
| + Gemma audio + Qwen text | 0.758 | 7/10 |

The broader direct-audio comparison retained all 62 proposals: baseline AUROC **0.806**, Gemma audio **0.803**; pair ordering **18/21 → 17/21**. On their own identical eligible cohorts, Whisper had **0.780 → 0.765** AUROC (50 proposals), and Qwen **0.778 → 0.762** (48 proposals, including completed-no-text cases). These cohort-specific numbers cannot rank Whisper against Qwen. Adding cheap features to Gemma also gave no consistent gain.

Validation holds out whole channels, fits numeric scaling only on training folds and selects regularization in inner channel folds. Unit embeddings are not standardized coordinate by coordinate. The initial solver emitted convergence warnings; a primal solve of the same objective removed them, and the corrected run passed with convergence warnings treated as errors. Grouping, scaling and missing-output checks passed.

Coverage: all 248 direct-audio windows succeeded. Output screening rejected 14 Whisper windows and 18 Qwen windows; affected proposals were excluded from those comparisons. Qwen completed 76 windows without text. Completed-no-text is not proof that speech was absent; a separate coverage-only control did not reveal a semantic ranking gain. Failed or pending outputs were never filled with zero vectors.

This is a small, availability-selected **coarse keep/skip** pilot, with no uncertainty intervals. It does not evaluate the later “okay versus nice” preference or establish that audio is unhelpful. Preserve the numeric outputs for that later evaluation; do not promote a model or change saved decisions from these results.

The resumed main inference run finished locally in **11m 41s**, reusing eight verified benchmark windows. No private content was uploaded; **0 Colab credits** were spent. Future transfer packages use opaque names and stripped audio metadata. At the supplied 52.8 Mbps receiver rate, the 105 MB pilot needs approximately 16 seconds and a 2.5 GB audio cache 6–7 minutes before transfer overhead. Keep GPU inference on the local RX 7800 XT. The remote i9-14900KF is a candidate for CPU-heavy decoding and preparation compared with the local Ryzen 5 5600G; no CPU speedup has been measured. Its RTX 4060 Ti is not assumed to outperform the RX 7800 XT. For future CPU-heavy work, stage sanitized audio once on its SSD and benchmark the whole pipeline, including transfer. The existing audio extraction is already complete, so no migration is needed now. Reserve cloud GPUs for a demonstrated speed or memory benefit.
