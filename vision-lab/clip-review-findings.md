# Clip review findings — first read (2026-10-07)

Source: `recording_clip_feedback` (Postgres `video_streaming_db`). 173 decisions across 58 recordings,
163 with at least one reason. 140 come from the trained detector (model `20261006175059`, states
nude + explicit); the rest come from the older prompts detector. Numbers below are trained-detector only.

## Detector quality

- 41 of 140 highlights kept (29%).
- **Skin-tone false positives.** shena_nomy and sas4a: 9 of 59 kept (15%). They account for 34 of the 35
  "Detector got it wrong" skips and 10 of the 15 "Pussy covered" skips. Outfits close to skin colour read
  as nude at thumbnail size. Everyone else: 31 of 80 kept (39%).
- **Score helps.** ≥ 0.9: 17 of 22 kept (77%). < 0.8: 15 of 92 kept (16%). AUROC of score for keep vs skip: 0.79.
- **Length helps more.**

  | Detected length | Kept |
  |---|---|
  | < 1 min | 3 / 26 |
  | 1–3 min | 5 / 42 |
  | 3–10 min | 9 / 32 |
  | 10–20 min | 11 / 21 |
  | 20 min + | 12 / 18 |

- **Length and score combined** (other channels only):

  | | Kept |
  |---|---|
  | High score + long (≥ 10 min) | 12 / 14 |
  | Low score + short | 11 / 48 |

  Dropping short low-score highlights outright would lose about a quarter of keeps, so demote them
  rather than drop them.
- **Edges are too loose.** 28 of 39 kept highlights were trimmed. The start always moved later
  (avg ≈ 3 min) and the end always moved earlier (avg ≈ 1.7 min); neither was ever extended. Average
  detected length was 16 min; average final length was 11 min.
- **Recall looks fine.** Only one highlight was added by hand.

## Why things were kept / skipped

**Keep reasons:**
- Clear view (34), Masturbating (19), Great moment (18).
- Personality (13), Good reaction / sound (11), Nice music (7).
- Close up (6), Intimate (5), Squirt/Pee (5), …
- About a quarter of keep reasons depend on sound or talk (Personality, Good reaction / sound, Nice music,
  Nice talk, Dirty talk). The detector is frames-only, so audio is worth adding later.

**Skip reasons:**
- Nothing happening (45), Detector got it wrong (35), Boring (23), Pussy covered (15).
- Repeat of a better one (8), Dildo Blowjob (4), Bad view (4).

**Meaning of two of the reasons:**
- "Boring" means mild action that isn't worth a clip. It is not the same as "Nothing happening".
  Together they make up 68 of 119 skips. That is the "worth" problem, which a nude/explicit detector
  cannot solve.
- "Dildo Blowjob" was skipped 4 of 4 times. This is a personal preference and suits a simple rule.

## Worth is relative, not absolute

Decisions depend on the rest of the recording and on the channel:

- **"Best part of a samey stream"** (e.g. shesnotuwu, about 14% of each recording kept). A similar scene
  is kept in one recording and called Boring in another when the rest of that recording looks the same,
  or when only a minor detail such as oil or cream differs. Absolute labels across recordings look
  contradictory.
- **"The whole stream is good"** (victoriavenus69: 100% of each recording kept; soficb about 25%,
  with long clips). The verdict is about the recording: good enough overall, or something keeps changing.

What this means for a worth model:

- Don't train an absolute per-clip classifier on clip features alone. Give it context: how the clip
  differs from the rest of its recording, and from what the channel usually does.
- Train on comparisons within a recording (kept beats skipped in the same recording). These pairs stay
  consistent where absolute labels don't, and the existing data already provides them.
- Separate recording-level verdicts. Otherwise "whole stream good" turns into "long clips are good".
  Existing whole-stream keeps can be inferred from kept coverage close to the recording length.
- Variety and change over time is a signal. Try measuring scene change from the stored frame embeddings.

## Next steps

1. **Quick rules in the detector:**
   - Tighten the edges, mostly the start.
   - Sort short low-score highlights last.
   - Remove near-duplicates within a recording.
   - Optionally, an avoid-list rule for unwanted acts.
2. **Retrain the probe** with hard negatives: the shena_nomy and sas4a "Detector got it wrong" and
   "Pussy covered" moments, labelled not-nude in the vision lab.
3. **Review UI additions** (proposed, not built):
   - A "Keep whole recording" action.
   - A preset "Boring (mild, not worth a clip)", separate from "Nothing happening".
   - A preset "Better moment elsewhere in this stream".
4. **Keep reviewing.** The 19 recordings left plus new ones. 54 keeps is too few for a worth model.
5. **Later: a worth model** trained on within-recording comparisons, with context features (contrast with
   the rest of the recording, scene variety) and audio.

## Fixed along the way

Rendering clips from live recordings with stream dropouts failed with "Rendered edit is missing video
frames". The cause was that ffmpeg seeks land up to ~1.6 s late, which shifted the gap check. Fixed in
`src/modules/edits/edits.packet-validation.ts`: the check now measures where each segment really starts.

## Done on 2026-10-07 (second pass)

- **Edge rule: not shipped.** The median trim on kept highlights is 0. The large average comes from
  ~10 long highlights where one part was picked out of 15–45 min, chosen by content (the probe scores
  those parts as highlight too). No fixed tightening matches that.
- **Repeat rule: not shipped.** Mean-embedding similarity between highlights of one recording is ~0.98
  whether or not they were called repeats. Repeats are about content the frame vectors don't separate.
- **Likely-skip rule: shipped.** Trained-detector highlights under 3 min with a score below 0.8 start as
  Skip (`isLikelySkip` in `recordings.highlights.ts`); nothing is dropped. These defaults are not marked
  in the feedback table: recompute the rule from detected edges + score when reading the data.
- **Retrained probe: shipped** (`data/models/recordings-highlight-probe.json`; previous version kept as
  `recordings-highlight-probe.20261006175059.json`).
  - **Extra training data:** 1,572 frames from "Detector got it wrong" highlights, labelled idle/tease
    and weighted 0.2. Stored in `labels.sqlite` → `feedback_negatives`, picked once
    (`hard_negatives.py --store`); `export_probe.py` reads them.
  - **Test method:** leave-recording-out.
  - **Wrong detections:** 89% vanish (was 14%).
  - **Hand-label AUROC:** 0.931 → 0.940.
  - **Cost:** 4 kept shena_nomy highlights also vanish. All four are clothed dancing ("Twerking to funk",
    "Nice dance"), which the old probe only found by mistaking the outfit for nudity. To catch dancing,
    add Tease to the highlight states.
- **Review:**
  - **"Keep whole recording"** button (web + mobile): joins every highlight into one kept clip spanning
    the recording, with the reason "Whole stream is good" (`keep_whole`).
  - **New skip presets:** "Boring" (`skip_boring`) and "Better moment elsewhere in this stream"
    (`skip_elsewhere`).
  - **Existing data:** the 23 typed "Boring" reasons were converted to `skip_boring`.
- **Recorder:** Add channel accepts many links or names at once (one per line, or comma-separated), all
  with the same quality and limits.
