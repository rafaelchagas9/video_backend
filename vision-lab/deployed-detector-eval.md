# Deployed highlight detector: end-to-end evaluation (2026-10-08)

Answers section 2 of the external review of the highlight-detection plan. It scores the detector the
backend actually runs, at the proposal level, against the reviewer's Keep/Skip decisions.

Code: `deployed_clipper.py` (port of the production path), `deployed_data.py` (inputs),
`deployed_eval.py` (folds, fits, judging). Run with `uv run python deployed_eval.py`. Caches go under
`data/deployed_eval/` and `data/emb/eval/`. No re-embedding and no GPU were used. The whole run takes
about 3 minutes on CPU.

## What is being measured

- **Detector.** The detector is export_probe.py's recipe: a 4-state logistic probe on
  `[frame, mean of ±2 neighbours]`, optionally with hard negatives mined from "Detector got it wrong"
  skips (weight 0.2, picked at p(nude+explicit) ≥ 0.44). Scores are smoothed nude+explicit.
- **Production path.** Every score goes through `detectWithProbe`/`shapeClips`: threshold 0.45
  (sensitivity 1.0), 35 s gap merge, 20 s minimum, 10 s padding, overlap merge and the 24-clip cap.
- **Faithfulness check.** Replaying the two stored model files over the indexed frames reproduces the
  backend's detected ranges exactly on 156 of 165 trained-detector analyses. One more differs by ≤ 5 s.
  In the other 8, the backend clamped the last clip to a re-probed file length the catalogue doesn't
  hold, or the reviewer merged clips.
- **Labels.** Each recording contributes only its latest analysis generation, with merged-away rows
  left out. That gives 297 decisions on 104 recordings. Frames exist for 101 of the reviewed
  recordings; 3 have fewer than 4 indexed frames, where the backend proposes nothing.
- **Judging.** Keep means "has potential", so proposals are judged whole, never frame by frame:
  - **keep:** the proposal overlaps a kept clip by at least half of the shorter of the two.
  - **skip:** not a keep, and at least half of it lies on skipped proposals.
  - **unjudged:** everything else, meaning time no earlier detector proposed.

  Precision is reported over judged proposals, and also with unjudged proposals counted as skips
  (a floor).
- **Recall proxies.** These are the only ones the data supports:
  - **Kept clips found:** kept clips that new proposals cover by at least half. Only 1 kept clip was
    added by hand, so this measures recall relative to earlier detectors, not true recall.
  - **Hand-label recall/precision:** the share of nude/explicit hand-labelled frames inside
    proposals, on held-out hand-labelled recordings. This is secondary and comes from 40 recordings.

## Splits and leakage

There are two 5-fold splits, balanced by decision count:

- **Channel-out.** Whole streams are held out, which is what a new channel gets.
- **Recording-out.** Recordings are held out, but other recordings of the same stream stay in
  training. This is what the next recording of a known channel gets.

A held-out fold contributes no hand labels and no mined negatives. Each fold mines its own negatives
with its own base probe, from development decisions only. Tuned thresholds come from inner 3-fold
out-of-fold scores on development folds, maximising F1 of (precision floor, kept clips found). Every
fold is also scored at the production 0.45.

The shipped models are scored as files, only on recordings that never trained them. No hand labels
or stored negatives came from those recordings: 69 recordings, including the 44 the deployed model
itself proposed on.

## Results

| | recs | proposals | keep / skip / unjudged | precision (judged) | precision floor | kept clips found | wrong-skips still proposed | hand-label recall | hand-label precision | min proposed / h |
|---|---|---|---|---|---|---|---|---|---|---|
| **shipped 20261007003939**, live decisions (its own proposals) | 44 | 124 | 42 / 82 / 0 | 34% | 34% | 41/42 | 5/5 | — | — | 42 |
| shipped 20261007003939, all 69 unseen recordings | 69 | 179 | 62 / 106 / 11 | 37% | 35% | 61/67 | 5/5 | — | — | 41 |
| shipped 20261006175059 (previous), same 69 | 69 | 187 | 65 / 106 / 16 | 38% | 35% | 65/67 | 5/5 | — | — | 41 |
| channel-out · base · 0.45 | 101 | 306 | 96 / 133 / 77 | 42% | 31% | 74/91 (81%) | 8/40 | 87% | 78% | 34 |
| channel-out · negatives · 0.45 | 101 | 302 | 93 / 131 / 78 | 42% | 31% | 73/91 (80%) | 7/40 | 86% | 82% | 33 |
| channel-out · base · dev-tuned (0.70–0.85) | 101 | 285 | 117 / 115 / 53 | 50% | 41% | 51/91 (56%) | 5/40 | 56% | 89% | 23 |
| channel-out · negatives · dev-tuned (0.70–0.85) | 101 | 258 | 120 / 100 / 38 | 55% | 47% | 47/91 (52%) | 4/40 | 52% | 90% | 22 |
| recording-out · base · 0.45 | 101 | 291 | 87 / 138 / 66 | 39% | 30% | 85/91 (93%) | 34/40 | 93% | 80% | 41 |
| recording-out · negatives · 0.45 | 101 | 265 | 87 / 121 / 57 | 42% | 33% | 80/91 (88%) | 6/40 | 91% | 80% | 37 |
| recording-out · base · dev-tuned (0.35–0.70) | 101 | 300 | 106 / 147 / 47 | 42% | 35% | 80/91 (88%) | 31/40 | 87% | 82% | 37 |
| recording-out · negatives · dev-tuned (0.50–0.90) | 101 | 273 | 112 / 122 / 39 | 48% | 41% | 68/91 (75%) | 5/40 | 80% | 89% | 29 |

The live row is the cleanest number available. Of the deployed model's real proposals, 45 of 127 were
kept (35%), on 46 recordings it never trained on. The matcher re-derives 42 of 124 on the 44 with
frames. A judged precision of about 40% on about 230 judged proposals carries roughly ±6 points of
binomial noise. The two splits use the same recordings, so their rows are paired.

**Held-out threshold sweep.** This is reporting only and picked nothing. Each cell gives judged
precision, kept clips found, wrong-skips still proposed, and minutes proposed per hour.

| threshold | channel-out base | channel-out negatives | recording-out base | recording-out negatives |
|---|---|---|---|---|
| 0.30 | 38% · 83/91 · 15/40 · 40 | 40% · 80/91 · 13/40 · 38 | 45% · 89/91 · 36/40 · 45 | 45% · 85/91 · 9/40 · 41 |
| **0.45** | 42% · 74/91 · 8/40 · 34 | 42% · 73/91 · 7/40 · 33 | 39% · 85/91 · 34/40 · 41 | 42% · 80/91 · 6/40 · 37 |
| 0.55 | 44% · 70/91 · 6/40 · 32 | 42% · 67/91 · 5/40 · 30 | 40% · 82/91 · 28/40 · 38 | 42% · 78/91 · 6/40 · 34 |
| 0.65 | 45% · 65/91 · 6/40 · 29 | 42% · 61/91 · 5/40 · 27 | 40% · 76/91 · 21/40 · 35 | 44% · 72/91 · 5/40 · 31 |
| 0.75 | 52% · 54/91 · 5/40 · 24 | 51% · 52/91 · 5/40 · 23 | 37% · 70/91 · 13/40 · 31 | 45% · 66/91 · 5/40 · 28 |
| 0.85 | 64% · 40/91 · 5/40 · 19 | 64% · 40/91 · 4/40 · 19 | 46% · 55/91 · 5/40 · 24 | 51% · 51/91 · 2/40 · 22 |

## Hard negatives, redone at proposal level

The earlier "89% of wrong detections vanish" figure measured the share of highlight frames inside old
proposals, and its folds leaked held-out hand labels. Re-running proposal generation with clean folds
shows the following.

- **Recording-out (known channel).** Of the 40 "Detector got it wrong" skips, the clipper still
  proposes 34 without negatives and 6 with them, so 28 of 34 disappear (82%). The cost is 5 of 91
  kept clips (93% → 88% found), and judged precision moves from 39% to 42%. All 5 lost keeps, and
  27 of the 29 wrong skips, belong to **shena_nomy**: her wrong skips go from 27/29 to 0/29 and her
  keeps from 12/13 to 7/13. Outside that channel, the negatives change almost nothing.
- **Channel-out (new channel).** There is nothing to fix: the wrong skips are proposed 8/40 without
  negatives and 7/40 with them. When shena_nomy is held out, the probe never fires on her outfits
  (wrong 1/29).
- **Why.** The skin-tone false positives come mostly from shena_nomy's own hand labels. Her two
  labelled recordings hold 318 explicit, 143 nude, 142 tease and only 2 idle frames. With her in
  training, the probe learns that her look means nude or explicit. Negatives patch this by teaching
  "her look in these scenes = idle/tease", which costs some of her real keeps. Labelling her idle and
  tease scenes would address the cause.
- **sas4a** stays wrong in both splits (4–5 of 5 proposed). Mined negatives from other channels
  don't transfer to it.

## What this means

1. **The deployed detector finds the material, and worth is what limits it.** Against earlier
   detectors' keeps it finds 81–93% (88% with negatives in the known-channel case). Its precision
   is 35–42% and barely moves with the threshold between 0.3 and 0.65. Raising the threshold only
   buys precision by dropping keeps: 0.85 reaches about 64% precision but finds 44% of keeps. Of the
   deployed model's 82 live skips, the reasons are mostly "Nothing happening" (51) and "Boring" (32);
   "Detector got it wrong" appears only 5 times. These are worth judgements that a
   nude/explicit state probe cannot express. Tuning the threshold isn't the lever; Stage 2 ordering
   is.
2. **Keep 0.45.** Dev-tuned thresholds (0.70–0.85 for new channels) lose a third to a half of keeps
   for 8–13 points of precision. That trade only makes sense once Stage 2 ranks proposals and pruning
   has been measured against lost keepers, as the review says.
3. **Keep the hard negatives, but scope the claim.** They help only on channels whose own labels
   caused the problem, and they cost keeps there. The better fix is balanced per-channel labels
   (idle and tease for shena_nomy). The deployed model's drop to 5 wrong skips in 127 comes from
   channel mix: none of its 46 recordings came from shena_nomy or sas4a. It is not evidence that the
   negatives worked.
4. **Recall audit (step 3 of the plan).** These recall numbers only measure agreement with earlier
   detectors. What remains to find out is what none of them proposed. Size the audit for that:
   - About 25% of new-channel proposals land on never-judged time ("unjudged"). That time is a
     natural stratum to sample alongside windows outside all proposals.
   - The audit should include the 12 of 46 live recordings that ended with no keep.
   - It should include clothed and audio-driven moments, which a frame probe cannot see.
5. **Stage 2.** The per-proposal features that already separate keeps on live decisions are:
   - **Length:** under 3 min, 13 of 61 kept; over 20 min, 16 of 22.
   - **Mean score:** AUROC 0.76 for keep vs skip.

   Use them as the ordering baseline that any ranker must beat, on channel-held-out folds with
   independent recordings counted. The decision count here is already the limit on resolution: one
   channel (shena_nomy, 59 decisions) moves the hard-negative result on its own.

## Caveats

- 36 deleted recordings were scored from older caches with timestamps reconstructed as 5 s × index.
  On the 85 recordings still indexed, the caches match the database and all cadences are exactly 5 s.
- Two hand-labelled recordings have no recoverable channel name. Each stands alone in the channel
  split.
- The skip match ("half on skipped proposals") treats a skip of a long proposal as covering all of it.
  New proposals carved out of a long skipped clip therefore count as skips, which is probably slightly
  pessimistic.
- None of the 297 latest-generation decisions has a logged shown default yet. The likely-skip
  default can't be separated here.
