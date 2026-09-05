# Vision analysis: remaining acceptance

Implementation phases 1–7 were recorded as delivered on 2026-08-28. This note
preserves unfinished acceptance and product decisions; it is not an instruction
to replay the completed migration. The original implementation plan and its
historical command output remain in Git history.

Current code lives in `src/modules/content-analysis`, `src/modules/bookmarks`,
`src/modules/face-recognition`, `src/modules/durable-jobs`, and
`vision-service/src/vision_service`. Configuration and
model provisioning are documented in [the vision runbook](../vision-service/README.md).
Kura is a separate repository and consumer.

## Outstanding proof

The last plan status required Rafael's real-browser/private-media acceptance of
request/progress/cancel, origin/category filters, episode display, and handoff to
the existing editor. Synthetic tests and transport smoke checks do not establish
subjective accuracy on the owner's media. Do not mark this complete from backend
code inspection alone.

Later performance measurements are documented in
[docs/performance.md](../docs/performance.md); they provide sample evidence, not
proof of the entire acceptance matrix below. Reconcile those results before
repeating benchmarks. Historical Kura build failures must be checked again rather
than assumed to persist.

## Product decisions retained from the implementation plan

- This is a private personal project and will not be distributed. License
  review is not an implementation gate.
- Analysis starts on demand; do not add automatic library-wide analysis.
- One bookmark represents one complete condensed episode, not one bookmark per
  positive frame.
- Keep `timestamp_seconds` as the backward-compatible seek/start position and
  add the episode end plus a representative peak timestamp.
- Automatic bookmarks appear in the normal bookmark list immediately.
- The bookmark list accepts an optional origin filter and returns all origins
  when it is omitted.
- Provenance values are `manual` and `automatic`; use an extensible text enum,
  not a boolean.
- The initial detector taxonomy is exactly the following eleven NudeNet labels:

  ```text
  BUTTOCKS_EXPOSED
  FEMALE_BREAST_EXPOSED
  FEMALE_GENITALIA_EXPOSED
  MALE_BREAST_EXPOSED
  ANUS_EXPOSED
  FEET_EXPOSED
  ARMPITS_EXPOSED
  BELLY_EXPOSED
  MALE_GENITALIA_EXPOSED
  ANUS_COVERED
  FEMALE_GENITALIA_COVERED
  ```

- An analysis request may optionally choose a subset of those categories; the
  default is all eleven.
- No extracted frame, crop, or bounding-box image is retained after processing.
- An automatic bookmark edited by the user survives later analyses.
- The current Python deployment should become a generic vision deployment with
  detector modules; do not insert NudeNet logic into `FaceEngine`.
- Remove `age` and `gender` from the face inference contract and persistence;
  the current deployment does not load the `genderage` model and these
  attributes are not part of the desired product.
- Docker/container support is not required in this phase. Remove the current
  Dockerfiles instead of repairing them; keep the native `uv`/MIGraphX workflow
  reproducible and documented.

## Remaining performance, accuracy, and operational validation (phase 8)

1. Benchmark 1h and 3h synthetic/owner-selected videos for all three profiles.
2. Record wall time, sampled/refined frames, requests/batches, CPU/GPU/RAM/VRAM,
   temporary storage high-water mark, false positives, and known misses.
3. Calibrate versioned thresholds/cadences without expanding the public API.
4. Run faces and nudity concurrently to verify backpressure and independent
   readiness.
5. Restart backend and Python during an active disposable analysis and prove
   recovery.
6. Confirm telemetry/logs contain IDs and stages, not sensitive paths, image
   data, labels tied to filenames, or frame bytes.

**Gate**: Rafael accepts the fast/balanced/thorough trade-off and the private
corpus results. A transport smoke test alone is not accuracy proof.

## Cleanup after proven migration (original phase 9)

1. Remove legacy Python face endpoints only after all callers are migrated and
   parity is proven.
2. Remove `FACE_SERVICE_URL` fallback only after current local configuration and
   docs use `VISION_SERVICE_URL`.
3. Remove dead face client/types/tests superseded by the versioned vision API.
4. Do not refactor conversion/edit queues into a generic queue unless separately
   planned; this feature only reuses their proven semantics.
5. Update README architecture and this plan's final proof/status.

## Verification boundary

Use the process-isolated backend test runners documented in [README](../README.md#testing).
Python verification uses `uv run python -m unittest discover -s tests -v` from
`vision-service`. Check Kura's current scripts in its checkout before running
consumer checks. Use disposable media/database fixtures for cancellation,
recovery, and migration tests. Private-media review and destructive operations
require separate owner authorization; this cleanup does not provide it.

## Scope limits

Analysis does not automatically render clips, replace/delete sources, run during
scans, retain frame galleries, or send images to cloud inference. Recognition of
acts, consent, age, or subjective interestingness is outside this feature. Mobile
UI changes and redistribution of model/container artifacts were not included.

## Final acceptance criteria

The plan is complete only when all of the following are proven:

- existing face recognition remains contract-compatible through the generic
  vision deployment;
- NudeNet is an independently ready detector module and supports the exact
  eleven selected categories;
- a long analysis is durable, cancellable, restartable, PTS-accurate, chunked,
  and bounded in temporary storage;
- continuous findings condense into full episode bookmarks with start/end/peak
  and multiple categories;
- automatic bookmarks appear beside manual ones and `origin=manual|automatic`
  filters return the correct subsets;
- manual and user-modified automatic bookmarks survive reanalysis;
- no frames/crops remain after terminal jobs;
- DEMO_MODE is deterministic and cannot reach personal media or Python;
- Kura web proves request/progress/cancel, filters, episode display, and handoff
  to the existing editor in a real browser;
- migrations, focused tests, static checks, builds, runtime smoke tests, and
  owner-reviewed accuracy/performance evidence all pass within their stated
  proof boundaries.
