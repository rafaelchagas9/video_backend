# Plan 007: Generalize vision inference and create condensed nudity bookmarks

> **Executor instructions**: Rafael authorized implementation on 2026-08-28.
> Execute the phases in order, preserve unrelated work, and run
> every gate before advancing. Do not inspect personal video frames or commit
> sensitive media. Stop on any condition in **STOP conditions** rather than
> weakening the contract. Update this plan and its row in `plans/README.md` as
> phases complete.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 51efba0b49f264c96c20c245471403396d82a6e6..HEAD -- face-service src/modules/face-recognition src/modules/frame-extraction src/modules/bookmarks src/database/schema src/database/demo src/utils/demo-mode-policy.ts src/server.ts tests README.md .env.example
> git diff --stat -- face-service src/modules/face-recognition src/modules/frame-extraction src/modules/bookmarks src/database/schema src/database/demo src/utils/demo-mode-policy.ts src/server.ts tests README.md .env.example
> git -C /home/rafael/Documentos/projetos/kura diff --stat eb7f4afae318e8e9e798a9cd7a2b0ba160cf5ca8..HEAD -- packages/types packages/validation packages/api packages/domain apps/web
> git -C /home/rafael/Documentos/projetos/kura diff --stat -- packages/types packages/validation packages/api packages/domain apps/web
> ```
>
> This plan was authored against clean backend commit `51efba0` and clean Kura
> commit `eb7f4af`. If either contract has drifted materially, reconcile the
> plan before editing. Never reset or discard user-owned changes.

## Status

- **Priority**: P1
- **Effort**: XL, phased
- **Risk**: HIGH
- **Depends on**: none
- **Category**: direction
- **Status**: IN PROGRESS — implementation authorized on 2026-08-28
- **Planned at**: backend `51efba0`; Kura `eb7f4af`; 2026-08-28

## Outcome

Turn the current Python `face-service` into a generic vision-inference
deployment, repair its existing face-recognition contracts first, add NudeNet
as an isolated detector module, and expose a durable asynchronous video-analysis
workflow that publishes condensed full episodes as automatic bookmarks.

The TypeScript application remains the owner of videos, jobs, sampling,
condensation, categories, bookmark persistence, authorization, idempotency, and
DEMO_MODE. Python owns only image decoding and model inference.

Kura remains a separate consumer. Its web application can request/cancel an
analysis, show progress, filter bookmarks by origin/category, and pass the
episode interval to the existing editor. Automatic clip rendering is not part
of this plan.

## Product decisions locked by Rafael

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

## Current state and defects that matter

- `src/database/schema/content.schema.ts` stores bookmarks as point-in-time
  records with no interval, category, provenance, analysis link, or review/edit
  marker.
- `src/modules/bookmarks/bookmarks.service.ts` scopes list/update/delete to the
  owning user, but bookmark response schemas are duplicated between the
  bookmarks and videos modules and have already drifted.
- `face-service/src/face_service/main.py` eagerly initializes `FaceEngine`; a
  face-model startup failure prevents every capability from becoming healthy.
- `face-service/src/face_service/routes/detect.py` accepts multipart at
  `/detect`; `FaceRecognitionClient.detectFaces()` sends JSON to that endpoint.
  The currently used file method happens to use multipart correctly.
- The database documents face boxes as normalized while Python emits pixel
  coordinates. The generic contract must make the coordinate space explicit
  and the face path must be repaired before NudeNet uses the same seam.
- Python endpoints are `async` while decoding/inference is synchronous. Current
  Bun concurrency can increase buffering without providing controlled model
  concurrency or backpressure.
- `face-service` has no direct Python contract tests.
- `face-service/uv.lock` is ignored, so native installs are not reproducible.
  Docker profiles are intentionally being removed from the supported surface.
- `Settings` resolves `.env`, model cache, the virtualenv and run script from
  the current working directory. Starting from the repository root can read the
  backend `.env` and fail validation instead of starting the inference process.
- `/health` always reports healthy and available ONNX providers rather than the
  initialized engine, active session provider, or current saturation state.
- The face image and creator embedding thumbnail routes are unauthenticated;
  face mutation routes do not consistently scope nested IDs to the video or
  creator present in the URL.
- Face-only extraction analyzes resized frames but later applies their pixel
  bounding boxes to newly extracted full-resolution frames, producing invalid
  crops.
- Per-frame inference failures are converted to empty detections, allowing a
  run with zero successful inferences to finish as completed.
- Reanalysis deletes the currently published detections before the replacement
  succeeds, and cascading database deletes do not remove physical face crops.
- Face jobs are unique per video, overwrite their history, have no lease or
  cancellation state, and store neither source/config/model revisions nor
  restartable checkpoints.
- Face schemas are split between Drizzle migrations and legacy manual SQL; the
  pgvector migration path is therefore not reproducible from the configured
  Drizzle migration directory alone.
- `FrameExtractionService` materializes all frames, assigns timestamps as
  `index * interval`, and uses `keyframesOnly` for face-only extraction. That is
  not precise or restart-safe enough for clip episodes.
- `FaceExtractionQueueService` persists job counters but holds the real queue,
  frames, and temporary directories in memory. Do not reuse it for long video
  analyses.
- Conversion/edit queues already demonstrate durable Redis claims, database
  reconstruction, conditional processing claims, acknowledgement after work,
  cancellation via `AbortSignal`, and restart recovery. Reuse those semantics.
- Kura treats bookmarks as additive typed data and already has an editor that
  accepts timeline segments. Extending the bookmark response is backward
  compatible if current required fields retain their meaning.
- DEMO_MODE is a fail-closed privacy seam. Every new route, queue, filesystem
  access, and remote adapter must have explicit deterministic demo behavior.

## Target module design

### TypeScript deep module

Create `src/modules/content-analysis/` with a small external Interface:

```ts
interface VideoContentAnalysis {
  start(input: StartContentAnalysisInput): Promise<ContentAnalysisRun>;
  get(runId: number, userId: number): Promise<ContentAnalysisRun>;
  cancel(runId: number, userId: number): Promise<void>;
}

interface StartContentAnalysisInput {
  videoId: number;
  userId: number;
  profile: "fast" | "balanced" | "thorough";
  categories?: NudityCategory[];
  force?: boolean;
  idempotencyKey?: string;
}
```

The Interface must not expose FFmpeg switches, frame cadence, merge gaps,
NudeNet names, model paths, providers, Redis details, or temporary files. Those
belong to the Implementation so callers gain leverage and changes remain local.

Internal state:

```text
queued
  -> running/extracting
  -> running/analyzing
  -> running/refining
  -> running/condensing
  -> running/publishing
  -> completed

any active state -> failed | cancelled
```

### Remote seam to Python

Define a remote-but-owned port inside the TypeScript module:

```ts
interface VisualInferencePort {
  capabilities(signal?: AbortSignal): Promise<VisionCapabilities>;
  analyzeBatch(
    input: VisionBatch,
    signal: AbortSignal
  ): Promise<VisionBatchResult>;
}
```

- Production adapter: authenticated/internal HTTP to the Python deployment.
- Test adapter: deterministic in-memory findings.
- The TypeScript domain only receives normalized taxonomy, score, coordinate
  space, frame ID, and echoed timestamp. It does not import provider-specific
  NudeNet objects.

### Generic Python vision module

Rename the deployment incrementally from `face-service` to `vision-service`:

- directory `face-service/` -> `vision-service/`;
- package `face_service` -> `vision_service`;
- application title/README/health checks reflect generic vision inference;
- introduce `VISION_SERVICE_URL` while temporarily accepting
  `FACE_SERVICE_URL` as a deprecated fallback so local configuration does not
  break mid-migration;
- update backend imports/client naming without changing public face routes;
- remove the fallback only after all callers and docs use the new variable.

Python detector Interface:

```py
class Detector(Protocol):
    capability: str
    model_revision: str
    taxonomy_revision: str

    def analyze_batch(
        self, images: Sequence[DecodedImage]
    ) -> Sequence[Sequence[Finding]]: ...
```

Adapters:

- `InsightFaceDetectorAdapter`;
- `NudeNetDetectorAdapter`;
- fake adapters for direct Python contract tests.

Each capability has independent readiness. NudeNet failure must not make faces
unavailable and vice versa. Model sessions are lazy and guarded by explicit
concurrency/backpressure rather than uncontrolled request concurrency.

### Generic vision HTTP contract

Add versioned endpoints:

- `GET /v1/capabilities` — readiness, active provider, model revision,
  taxonomy revision, batch/byte limits for each capability.
- `POST /v1/analyze` — multipart batch with a versioned manifest, one or more
  files, requested capabilities, stable frame IDs, and timestamps.

Response invariants:

- exactly one item result or item error for every input ID;
- echoed timestamps; Python never derives time from array position;
- finite scores in `[0, 1]`;
- normalized boxes explicitly marked with `space: "normalized"` and clamped to
  `[0, 1]`;
- stable canonical taxonomy; raw provider labels may appear only as diagnostic
  metadata;
- explicit batch item/byte limits and `OVERLOADED`/`BATCH_TOO_LARGE` errors;
- partial bad-frame errors do not silently discard successful item results;
- Python retains no image after the response.

Keep legacy `/detect` and `/extract-embedding` as compatibility adapters during
the face migration. Delete them only after backend/Kura callers use the new
contract and regression tests prove equivalent observable behavior.

## Database and domain contract

### Bookmark extensions

Extend `bookmarks` additively:

```text
end_timestamp_seconds  real null
peak_timestamp_seconds real null
origin                 text not null default 'manual'
analysis_run_id        integer null
user_modified_at       timestamp null
```

Invariants:

- `origin` is `manual|automatic` in this version;
- all existing rows migrate to/default to `manual`;
- manual rows have no `analysis_run_id`;
- automatic rows must link to their generating run;
- `0 <= timestamp_seconds <= peak_timestamp_seconds <= end_timestamp_seconds`
  when the optional interval fields are present;
- all interval values are within the source duration at publication time;
- editing the timestamp, end, peak, name, description, or categories of an
  automatic bookmark sets `user_modified_at`;
- no rerun deletes or overwrites manual or user-modified automatic bookmarks.

Centralize the bookmark Zod response in the bookmarks module and reuse it from
video routes. Remove the existing duplicated response definition.

### Bookmark categories

Add:

```text
bookmark_categories
  id, key, name, kind(system|custom), user_id nullable, created_at, updated_at

bookmark_category_assignments
  bookmark_id, category_id, confidence nullable, provider_label nullable
  primary key(bookmark_id, category_id)
```

- Seed/upsert the exact eleven system categories listed above.
- System category keys are immutable and unique.
- Custom categories are owned by the authenticated user.
- System categories cannot be renamed or deleted through the custom-category
  routes.
- Automatic assignments may store max confidence and the original provider
  label; manual assignments leave confidence/provider null.
- Do not reuse video tag categories because they describe a whole video rather
  than an interval.

Category routes:

- `GET /api/bookmark-categories`;
- `POST /api/bookmark-categories` for a custom category;
- `PATCH /api/bookmark-categories/:id` for an owned custom category;
- `DELETE /api/bookmark-categories/:id` for an owned custom category;
- bookmark create/update accepts `category_ids`.

### Analysis persistence

Add `content_analysis_runs` with:

- video/user/kind/profile/requested categories;
- status, phase, scanned/source seconds, sampled/positive frames;
- source fingerprint and duration captured at start;
- analyzer/model/taxonomy/config revisions;
- idempotency key and semantic generation key;
- result counts, stable error code/message, timestamps and cancellation time.

Add `content_analysis_events` with:

- run, start/end/peak seconds;
- category summary containing counts and max/mean scores;
- stable generation key;
- published bookmark link.

Persist only compact checkpoints/findings required for restart recovery. Delete
frame-level staging rows after successful atomic publication. Never persist
frame image bytes or crops.

## Public HTTP contract

### Start analysis

```http
POST /api/videos/:id/analyses/nudity
Idempotency-Key: optional
Content-Type: application/json

{
  "profile": "balanced",
  "categories": ["FEMALE_BREAST_EXPOSED", "BUTTOCKS_EXPOSED"],
  "force": false
}
```

- `profile` defaults to `balanced`.
- `categories` defaults to all eleven and rejects unsupported values.
- return `202 Accepted` and `Location: /api/content-analysis/jobs/:id`;
- an equivalent active or completed semantic run is returned with
  `reused: true`; `force: true` creates a new run;
- unavailable video, missing duration, invalid category, and analyzer
  unavailability use stable errors.

### Inspect/cancel

- `GET /api/content-analysis/jobs/:id` returns status, phase, progress,
  revisions, requested categories, episode/bookmark counts, and stable error.
- `DELETE /api/content-analysis/jobs/:id` conditionally cancels queued/running
  work and signals active FFmpeg/inference operations through `AbortSignal`.
- Ownership is always checked even though the current deployment is
  single-user.

### List bookmarks

Extend:

```http
GET /api/videos/:id/bookmarks
GET /api/videos/:id/bookmarks?origin=manual
GET /api/videos/:id/bookmarks?origin=automatic
GET /api/videos/:id/bookmarks?category=BUTTOCKS_EXPOSED
```

- omitted filters return all bookmarks;
- `origin` accepts only `manual|automatic`;
- category filter accepts a system/custom category key and may combine with
  origin;
- order remains `timestamp_seconds`, then `id`;
- response adds interval, origin, categories, run link, and user-modified state
  without removing current fields.

### Reanalysis semantics

Semantic idempotency key:

```text
(video_id, user_id, kind, source_fingerprint,
 profile, selected_categories, analyzer_revision, config_revision)
```

- active equivalent request returns the active run;
- completed equivalent request returns the completed run;
- forced run republishes only after validating the source fingerprint again;
- publication replaces only untouched automatic bookmarks from older runs of
  the same analysis kind;
- manual and user-modified automatic bookmarks always survive;
- zero detections is a successful completed run with zero new bookmarks.

## Sampling and episode condensation

### Chunked coarse-to-fine extraction

- Never extract the entire multi-hour video into one temporary directory.
- Decode bounded sequential chunks, initially targeting five-minute source
  windows, and delete each chunk after its batch is acknowledged/checkpointed.
- `balanced` and `thorough` do not use `keyframesOnly`, preserving their
  accuracy-oriented temporal sampling.
- `fast` decodes keyframes only, keeps at most one sample per approximately
  8 seconds, uses bounded 30-minute chunks, and skips the refinement pass. It
  is explicitly approximate and can miss short moments between keyframes.
- Capture actual FFmpeg PTS for every emitted frame. Do not reconstruct time as
  `index * interval` and do not use isolated random seeks for dense windows.
- `balanced` starts with approximately 2-second coarse cadence.
- `thorough` starts with approximately 1-second coarse cadence.
- Any positive or near-threshold coarse hit expands a bounded refinement
  window, initially `±4s`, sampled at approximately 0.5-second cadence.
- Treat these numbers as versioned defaults, not public fine-grained controls.
  Calibrate them with local performance/accuracy evidence before finalizing v1.
- Send bounded batches, initially 16-32 frames, based on the capabilities
  response and measured memory/latency.

### Pure deterministic condensation

Implement condensation as an in-process pure function over timestamped
synthetic findings:

1. Drop labels outside the selected eleven/category subset.
2. Apply configurable per-category entry/exit thresholds.
3. Open a category span after a high-confidence hit or repeated neighboring
   confirmations.
4. Use hysteresis and a short negative tolerance to avoid confidence jitter.
5. Refine the beginning/end from the dense samples.
6. Merge compatible overlapping/adjacent category spans across a short,
   versioned gap.
7. Union simultaneous categories into one episode and retain per-category
   counts and confidence summaries.
8. Add bounded pre-roll/post-roll and clamp to `[0, videoDuration]`.
9. Choose `peak_timestamp_seconds` from the highest-confidence refined sample.
10. Create exactly one automatic bookmark for each final episode.

Long continuous visibility may legitimately create a long episode. Do not
arbitrarily split it into many bookmarks. Store its representative peak so the
UI can preview it, and let the existing editor trim the full interval.

No periodic cadence can guarantee finding an event shorter than that cadence.
Expose this limitation in the UI/help text; do not claim full-frame coverage.

## Implementation phases

### Phase 0 — Baselines and executable fixtures

1. Re-run drift checks and inventory both worktrees.
2. Record current backend, face-route, Python environment, Kura build, and
   DEMO_MODE baselines before changing contracts.
3. Add only synthetic benign images/video fixtures for transport, PTS, queue,
   and negative-path tests. Generate temporary binary fixtures during tests;
   do not commit personal/explicit media.
4. Define a private, owner-run accuracy corpus/annotation procedure outside Git
   for the later accuracy gate. The agent need not view its frames.

**Gate**: baselines are reported accurately; unavailable runtime profiles are
recorded rather than inferred green.

### Phase 1 — Repair current face inference

1. Add direct Python contract tests before reshaping the service.
2. Reconcile JSON/multipart callers and remove or repair the invalid
   `detectFaces()` path.
3. Normalize boxes exactly once and make the coordinate space truthful in both
   Python and TypeScript.
4. Add explicit inference concurrency/backpressure and stable per-item errors.
5. Make health distinguish process liveness, face capability readiness, active
   provider, model revision, and embedding dimension.
6. Remove `age`/`gender` from Python, TypeScript and persisted response shapes.
7. Make configuration/run paths independent of the current working directory
   and track the native `uv.lock`.
8. Remove `Dockerfile` and `Dockerfile.rocm`; Docker is not a supported runtime
   in this phase.
9. Authenticate biometric image routes and scope every nested mutation to all
   IDs in its route.
10. Keep existing public face endpoints and Kura behavior otherwise unchanged.

**Gate**: existing face extraction/matching contracts pass focused backend,
Python, demo, and Kura checks; a live local health check reports the provider
actually used. Stop if face behavior regresses.

### Phase 1.5 — Replace the current in-memory face queue

1. Introduce the PostgreSQL-authoritative durable-jobs schema and adapter with
   atomic claims, expiring leases, heartbeat, checkpoint, retry and
   lease-token-guarded terminal acknowledgement.
2. Add a generic worker that aborts on shutdown/cancellation or lease loss and
   never acknowledges work after ownership changes.
3. Change face requests to persist only durable inputs (video/source/config
   revisions), not extracted-frame paths or in-memory frame arrays.
4. Extract frames inside the claimed handler, checkpoint bounded progress, and
   always clean temporary files after success, failure, cancellation or lease
   loss.
5. Preserve one immutable face-run row per attempt/history entry; use a partial
   uniqueness rule only for equivalent active work.
6. Stage replacement detections under the run and publish them atomically only
   after every required inference succeeds. Keep the prior published
   generation visible until that transaction commits.
7. Start and stop the face worker with the Fastify lifecycle and recover queued,
   due-retry and expired-lease jobs directly from PostgreSQL on startup.

**Gate**: process restart, expired lease, stale worker completion, service
outage/retry, cancellation, reanalysis failure and temporary-file cleanup are
covered without losing the previously published face results.

**Implementation checkpoint (2026-08-28)**: the generic durable-jobs module,
face-run adapter, immutable publication generations and migrations `0035`-`0037`
are implemented. The operator explicitly authorized the service-affecting
cutover and migration: face requests/status/cancellation now use the durable
queue, the worker follows the Fastify lifecycle, the migrations are applied to
the local PostgreSQL database, and the affected systemd services were restarted.
Focused tests, schema verification, readiness checks and clean worker polling
passed. A real-media face-analysis run remains outside this checkpoint.

### Phase 2 — Generalize to vision-service

1. Introduce detector Interface/adapters and generic result types in Python.
2. Implement `/v1/capabilities` and `/v1/analyze` with fake detector tests.
3. Route InsightFace through `InsightFaceDetectorAdapter`.
4. Preserve legacy face routes as adapters to the generic module.
5. Rename directory/package/docs/config incrementally and add the temporary
   environment-variable fallback.
6. Add a TypeScript `VisualInferencePort`, HTTP adapter, in-memory adapter, and
   contract validation.
7. Move existing face callers to the new adapter, then verify legacy parity.

**Gate**: faces work through the generic contract; legacy routes remain
compatible; capability failure is isolated and does not crash the process.

**Implementation checkpoint (2026-08-28)**: completed. The deployment and
Python package are now `vision-service`/`vision_service`; the existing systemd
unit keeps its stable name but points to the renamed deployment and a freshly
locked virtual environment. `/v1/capabilities` and `/v1/analyze` are live, the
backend face client is a compatibility facade over `VisualInferencePort`, and
legacy pixel coordinates are reconstructed from validated normalized findings.
Thirty-two Python tests and twenty-seven focused TypeScript contract/parity
tests, static
checking, readiness probes, and a live synthetic zero-face analysis passed.
No personal media was inspected and no Kura API change was required in this
phase.

### Phase 3 — Add NudeNet detector capability

1. Pin the chosen NudeNet package/model artifact and integrate it behind
   `NudeNetDetectorAdapter` without importing it into face modules.
2. Map the exact eleven selected provider labels to immutable canonical system
   categories; ignore other labels for bookmark generation in v1.
3. Add lazy initialization, independent readiness, bounded batches, and
   provider selection hidden behind the adapter.
4. Provision the official `640m` artifact offline as the accuracy-oriented
   default, pin its SHA-256 and resolution, and retain bundled `320n` as an
   explicit operator-selected fallback.
5. Require MIGraphX for NudeNet and measure face+nude coexistence, latency and
   VRAM before accepting the shared AMD runtime profile.
6. Add synthetic negative transport tests and owner-run private positive
   accuracy tests outside Git.

**Runtime decision (2026-08-28)**: Rafael explicitly selected GPU execution
for NudeNet. The pinned adapter must therefore create its own
`MIGraphXExecutionProvider,CPUExecutionProvider` session and verify that
MIGraphX is actually active; the published NudeNet 3.4.2 wrapper is not trusted
to honor its provider argument. The capability remains lazy and independently
bounded, and the gate includes face+nude coexistence/VRAM smoke evidence before
the GPU profile is considered accepted.

**Model decision (2026-08-28)**: use the official `640m` model at resolution
640 by default, pinned as
`sha256:04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb`.
The service never downloads weights while handling a request. `320n` remains
available through explicit configuration for measured performance comparisons.

**Implementation checkpoint (2026-08-28)**: the pinned `640m` capability is
live through MIGraphX beside InsightFace. Both capabilities report
`MIGraphXExecutionProvider,CPUExecutionProvider`, the systemd unit remained
active with zero restarts, and a synthetic combined request returned independent
successful outcomes. Cold compilation took 52.76 seconds for batch size two and
29.37 seconds when batch size one was first seen; once those dynamic shapes were
compiled, nudity-only took 45 ms, faces-only 55 ms, and the combined request took
131 ms. Resident GPU memory increased by 444,870,656 bytes (about 424 MiB) over
the face-only baseline; process memory peaked at 3.19 GB. Fifty-seven Python
tests, seventy-three focused backend tests, Ruff, TypeScript checking, backend
build, environment validation, and lock checks passed. This proves transport,
lifecycle, GPU residency, and negative-result shape with synthetic images; it
does not claim positive-class accuracy, which remains an owner-run private-media
gate.

**Gate**: the capability reports model/taxonomy revision, returns deterministic
contract shapes, does not destabilize faces, and passes local memory/latency
smoke tests.

### Phase 4 — Migrate bookmarks/categories

1. Update Drizzle PostgreSQL schemas first.
2. Generate migrations with `bun db:generate`; review SQL before execution.
3. Mirror the schema in SQLite and generate demo migrations.
4. Centralize response schemas and extend create/update/list behavior.
5. Add category CRUD/ownership/protection and seed the eleven system entries.
6. Add `origin` and category filters with integration coverage.
7. Update Kura shared types, validation, clients, query keys, and existing
   bookmark views for additive fields before using analysis endpoints.

**Gate**: generated SQL is additive and preserves all existing bookmarks as
`manual`; migration replay, PostgreSQL integration, SQLite reset/baseline, and
Kura type gates pass. Never use `db:push`.

**Implementation checkpoint (2026-08-28)**: completed. PostgreSQL migration
`0038` and demo migration `0006` add interval/provenance fields, the many-to-many
category catalog, ownership and integrity constraints, and the exact eleven
system categories. The local PostgreSQL migration was applied with the backend
stopped: all 21 existing bookmarks were preserved as manual with nullable new
fields, the migration history advanced from 38 to 39 entries, and the backend
restarted healthy. Category CRUD, manual/automatic and category filters,
central response schemas, automatic-bookmark edit protection, SQLite reset
reseeding, and Kura shared contracts, client, query filters, interval validation,
and bookmark display are implemented. A disposable PostgreSQL test applies `0038` to the minimum
pre-migration contract and proves backfill, constraints, ownership, M2M filter,
and transactional category deletion; 26 focused backend/demo/HTTP tests,
TypeScript checking, build, formatting, environment validation, and Kura gates
passed. The unrelated full historical replay still stops at pre-existing
migration `0005` with PostgreSQL `42P16`; this was not bypassed or altered and
does not affect the proven `0038` migration or its successful local application.

### Phase 5 — Durable content-analysis jobs

**Concurrency and source decision (2026-08-28)**: `force=true` bypasses reuse
of an equivalent completed run, but still reuses an equivalent active run so
the system never performs duplicate active work. An explicit idempotency key
takes precedence over `force`: the same key and request digest returns the same
run, while the same key with a different digest is a stable conflict. Starts
are serialized with a PostgreSQL transaction advisory lock derived from the
semantic key. The source snapshot is obtained through a replaceable port using
stat-before, a versioned partial hash, effective duration, and stat-after; it is
captured at start and repeated immediately before publication. The final
publication transaction validates run, source and active lease, replaces the
eligible generation, and acknowledges the durable job atomically, including
the zero-result case.

1. Add run/event/checkpoint schemas and services.
2. Implement semantic idempotency and conditional state transitions.
3. Implement a deep PostgreSQL-authoritative durable-jobs module with
   conditional claims, expiring leases, heartbeat, checkpoints and terminal
   acknowledgement. Redis may wake workers but is never the source of truth.
4. Recover queued/retryable jobs and expired leases directly from PostgreSQL;
   a lost Redis wake-up must add latency only, never lose work.
5. Add cancellation with `AbortSignal`, lease-token guarded publication and
   bounded persisted retry for retryable infrastructure failures.
6. Store a new row per run and keep a partial unique constraint only for
   semantically equivalent active work; preserve run history.
7. Stage results by run and atomically publish only after successful completion,
   retaining the previous published generation until then.
8. Add SSE events: `content-analysis:started|progress|completed|failed|cancelled`.
9. Ensure source fingerprint/duration are checked before and after processing.

**Gate**: restart, crash/replay, cancellation races, Redis outage, duplicate
requests, stale source, and zero-result runs are covered without lost jobs or
duplicate bookmarks.

**Implementation checkpoint (2026-08-28)**: the durable content-analysis core
is complete and its additive PostgreSQL migration `0039` is live locally.
Consumers see only the `start/get/cancel` service seam; lease ownership,
checkpointing, retries, generation staging, bookmark replacement, and the
terminal durable acknowledgement remain inside the handler/store boundary.
PostgreSQL is authoritative and uses its own clock for leases. Expired claims
consume the persisted retry budget, poison jobs terminate, checkpoints are
versioned, bounded and monotonic, and unexpected failures persist a stable
message without media paths. The final transaction serializes publication per
video/user/kind, rechecks source/revisions/lease, preserves manual and
user-modified automatic bookmarks, handles zero results, and rolls back to the
previous generation on any failure.

The focused durable/face/content gate passed 49 tests; the disposable
PostgreSQL schema/store gate passed 15 tests with 59 assertions, including
concurrent semantic/idempotent enqueue, forced reanalysis, stale/expired
leases, mid-publication rollback, post-commit replay, both orders of
cancel-versus-publish, and concurrent generations. TypeScript and formatting
gates passed. The local migration history advanced from 39 to 40 entries, the
backend restarted healthy on `10.30.0.5:3000`, and backend, vision, Kura, and
enrichment services remained active. No personal media was opened.

The concrete `stat -> partial hash -> ffprobe -> stat` resolver and real
processor intentionally join the PTS-aware Phase 6 implementation. Public
routes, user-scoped SSE delivery, lifecycle registration and the fail-closed
demo adapter remain together in Phase 7 so the current global best-effort SSE
transport is not reused for private per-user analysis state.

### Phase 6 — PTS-aware chunked sampling and condensation

1. Implement sequential chunk extraction with real PTS and immediate cleanup.
2. Add coarse/refinement scheduling and checkpoint progress.
3. Call the Python adapter in bounded batches with partial-item error policy.
4. Implement category normalization, thresholds, hysteresis, merge, pre/post
   roll, peak selection, and pure condensation tests.
5. Publish events/categories/bookmarks atomically only after full completion.
6. Implement safe forced reanalysis/preservation semantics.

**Gate**: a generated variable-frame-rate fixture proves timestamp accuracy;
synthetic finding sequences prove sustained episodes condense to one bookmark;
restart resumes by chunk; no temporary frames remain after success, failure, or
cancellation.

**Implementation checkpoint (2026-08-28)**: completed. The backend now resolves
each source through `stat -> versioned partial SHA-256 -> ffprobe -> stat`,
extracts bounded sequential FFmpeg chunks with their real PTS, stages only
media-free observations under the active lease, resumes from the next durable
chunk, and removes every temporary after success, failure, cancellation, and
timeout. Coarse findings only schedule refinement; final episodes are derived
from dense refined findings with deterministic thresholds, hysteresis,
category union, gap merge, bounded roll, and peak selection. Refinement uses
30-second chunks, coalesces more than 1,000 sparse windows, bounds multipart
items/bytes, tolerates a small bounded number of deterministic bad frames, and
requires the persisted analyzer/model/taxonomy/config revisions plus the
MIGraphX GPU provider. Source-duration comparison tolerates PostgreSQL `real`
rounding while the versioned fingerprint remains exact. Focused synthetic tests
passed 57/57 (143 assertions), PostgreSQL migration/store tests passed 18/18
(71 assertions), TypeScript, build, formatting, and diff checks passed. The
additive migration `0040` was reviewed and applied; local migration history is
now 41 entries, the observation table exists, and all eleven categories remain.
Backend, vision, Kura, and enrichment services are active; backend and vision
health are green, and the live nudity capability reports the pinned 640m SHA and
MIGraphX. No browser or personal media was opened.

**Performance remediation checkpoint (2026-08-28)**: after Rafael validated
request, reload/recovery, and cancellation, a real owner-run exposed two
independent bottlenecks without requiring frame inspection. The PTS extractor
was decoding on CPU and encoding PNG, while the face extractor already used
VAAPI and JPEG; the NudeNet processor also sent a cold batch of 16 images whose
MIGraphX shape compilation exceeded the 120-second request timeout. The
extractor now uses VAAPI decoding and high-quality JPEG while preserving full
temporal sampling and absolute PTS (it deliberately does not use keyframe-only
decoding). Coarse chunks are 60 seconds, refinement chunks are 30 seconds, and
the backend batch cap is 4. Neutral synthetic benchmarks measured cold batches
of 1/2/4 at approximately 0.9/28/64 seconds and warm batch-4 throughput at
approximately 0.31 seconds per image; batch 16 is no longer requested. A
checkpoint changes the public phase to `analyzing` immediately after extraction.
The processor/config revision is now `nudity-processor-v2`. The focused module
gate passes 68/68 tests (175 assertions), TypeScript, focused lint, diff checks,
live health, MIGraphX/640m revision discovery, and an out-of-sandbox neutral
VAAPI extraction smoke test. Job 2 was already terminal `failed` when cancellation
was requested; no FFmpeg process, temporary directory, or active analysis run
remains. No real media was opened or newly analyzed by Codex.

A follow-up owner run exposed two correctness defects hidden by neutral
fixtures. First, FFmpeg's chunk `-t` was output-scoped; because the last selected
frame precedes the exact chunk duration, FFmpeg continued decoding the complete
source while the UI correctly remained in `extracting`. The duration bound is
now input-scoped before `-i`, and the VFR regression asserts that ordering while
still proving absolute PTS. Second, positive NudeNet findings serialize the
non-applicable face `embedding` as `null`; the HTTP adapter now accepts that wire
representation and removes it before strict domain validation. Run 3 proved the
extraction correction by reaching a persisted `analyzing` checkpoint, then
failed on the old nullable-embedding contract before this second fix. Both
defects have focused red/green regressions; run 3 is terminal and must be
replaced by a new owner-started run.

**Fast-profile checkpoint (2026-08-29)**: a third public profile, `fast`, now
keeps the same analysis API and durable job model while hiding its execution
strategy inside the content-analysis module. It requests decoder-level
keyframes only, limits samples to an approximately 8-second cadence in bounded
30-minute chunks, skips refinement, and condenses coarse findings with a wider
versioned confirmation/merge window. `balanced` and `thorough` remain unchanged.
The processor/config revision is `nudity-processor-v3`; migration `0041` expands
the database profile constraint without changing existing rows. Focused
backend, queue, route, PTS, demo, and isolated PostgreSQL tests pass 78/78 (204
assertions). The Kura contract and selector expose the new profile with an
explicit warning that it is approximate. No browser or personal media was
opened during implementation or automated verification. Migration `0041` was
reviewed and applied to the local database; its live constraint accepts all
three profiles and migration history now has 42 entries. Backend and Kura web
services were restarted and are active, backend health and the Kura HTTP smoke
check pass, and runtime configuration reports `nudity-processor-v3`. Kura's
focused lint, package typechecks, and direct Vite build pass; the aggregate web
TypeScript build remains blocked by the pre-existing optional-prop error in
`CleanupTab.tsx:441`, unrelated to content analysis.

After the clean backend restart, the latest owner-started balanced run completed
all 1,985.8 source seconds with 993 sampled frames, zero retries, zero errors,
and a successful zero-result publication. This is live metadata proof that the
input-side duration bound, nullable finding normalization, durable completion,
and empty-generation publication paths are active. Private-corpus accuracy
remains an owner acceptance gate.

### Phase 7 — Routes, DEMO_MODE, and Kura web workflow

1. Register authenticated start/get/cancel routes and schemas.
2. Add fail-closed DEMO_MODE policy entries and a deterministic SQLite adapter
   that never opens configured personal media or calls Python.
3. Update the demo route manifest, policy coverage, baseline/seed, and reset
   tests together.
4. Add Kura shared run/event types, validation, API client, query options, and
   SSE notification mapping.
5. In Kura web, add an analysis action with profile/category selection,
   progress/cancel/error state, and query invalidation on completion.
6. Add bookmark filters for all/manual/automatic and category. Display automatic
   provenance, categories, episode duration, and representative peak without
   hiding manual bookmarks.
7. Pass `timestamp_seconds..end_timestamp_seconds` to the existing editor when
   the user chooses to create/trim a clip; do not auto-render clips.

**Gate**: real-browser validation against
`https://video.lan.rafaelm.dev/` proves request, progress, completion, origin
filter, category filter, interval display, and editor handoff. Demo browser
validation proves no production media/service access.

**Implementation checkpoint (2026-08-28)**: the authenticated start/get/cancel
routes, owner-scoped SSE updates, runtime worker lifecycle, schema-readiness
gate, deterministic media-free DEMO_MODE adapter, and updated demo manifest are
implemented. Kura now has shared typed/Zod contracts, a validated idempotent API
client, query keys, SSE parsing/invalidation, profile plus eleven-category
selection, durable job restoration, polling, progress, cancel/error/completion
states, automatic/manual/category bookmark filters, episode metadata, and an
interval handoff that seeds exactly one editable clip without auto-rendering.
Backend Phase 6/7 focused tests passed 83/83 with 2,010 assertions; Kura's four
shared packages pass typecheck, the editor tests pass 8/8, focused lint passes,
and the production Vite bundle builds after transforming 4,002 modules. The
full Kura web TypeScript gate remains blocked only by the pre-existing
`CleanupTab.tsx:441` `exactOptionalPropertyTypes` error outside this plan.
After systemd restart all four services are active, backend health is 200, the
protected job route returns 401 without a session, the frontend shell returns
200, and live nudity capability remains GPU-backed on the pinned 640m SHA. No
analysis endpoint was invoked, no browser was launched, and no personal media
was read. Rafael must perform the real-browser/private-media acceptance gate
below before Phase 7 is accepted and Phase 8 calibration begins.

### Phase 8 — Performance, accuracy, and operational validation

1. Benchmark 1h and 3h synthetic/owner-selected videos for all three profiles.
2. Record wall time, sampled/refined frames, requests/batches, CPU/GPU/RAM/VRAM,
   temporary storage high-water mark, false positives, and known misses.
3. Calibrate versioned thresholds/cadences without expanding the public
   Interface.
4. Run faces and nudity concurrently to verify backpressure and independent
   readiness.
5. Restart backend and Python during an active disposable analysis and prove
   recovery.
6. Confirm telemetry/logs contain IDs and stages, not sensitive paths, image
   data, labels tied to filenames, or frame bytes.

**Gate**: Rafael accepts the fast/balanced/thorough trade-off and the private
corpus results. A transport smoke test alone is not accuracy proof.

### Phase 9 — Cleanup after proven migration

1. Remove legacy Python face endpoints only after all callers are migrated and
   parity is proven.
2. Remove `FACE_SERVICE_URL` fallback only after current local configuration and
   docs use `VISION_SERVICE_URL`.
3. Remove dead face client/types/tests superseded by the generic Interface.
4. Do not refactor conversion/edit queues into a generic queue unless separately
   planned; this feature only reuses their proven semantics.
5. Update README architecture and this plan's final proof/status.

## Verification commands

Exact commands may be adjusted only for real script drift; record substitutions.

| Purpose                       | Command                                                                                                                                                                                                                                                                                                                                        | Expected                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Python tests                  | `cd vision-service && uv run python -m unittest discover -s tests -v`                                                                                                                                                                                                                                                                          | all contract/adapter tests pass                             |
| Python lint                   | `cd vision-service && uvx ruff check src tests && uvx ruff format --check src tests`                                                                                                                                                                                                                                                           | exit 0                                                      |
| Python lock                   | `cd vision-service && uv lock --check`                                                                                                                                                                                                                                                                                                         | tracked lock matches project                                |
| Backend focused               | `bun run test:files -- tests/face-recognition-embedding.test.ts tests/demo-face-multiplayer-sqlite.test.ts tests/demo-content-sqlite.test.ts tests/demo-mode-policy.test.ts tests/demo-mode-route-coverage.test.ts tests/integration/core-crud.integration.test.ts`                                                                            | all selected tests pass                                     |
| New analysis tests            | `bun run test:files -- tests/content-analysis-condensation.test.ts tests/content-analysis-queue.test.ts tests/content-analysis-routes.test.ts tests/bookmarks-origin-categories.test.ts`                                                                                                                                                       | all new focused tests pass                                  |
| Backend static/build          | `bunx tsc --noEmit && bun run build`                                                                                                                                                                                                                                                                                                           | exit 0                                                      |
| Backend full                  | `bun run test:unit && bun run test:integration`                                                                                                                                                                                                                                                                                                | all suites pass or unrelated baseline is reported precisely |
| Generate PostgreSQL migration | `bun db:generate`                                                                                                                                                                                                                                                                                                                              | reviewed additive migration only                            |
| Apply PostgreSQL migration    | `bun db:migrate`                                                                                                                                                                                                                                                                                                                               | only after confirming the disposable/local target           |
| Generate/apply demo migration | `bun demo:db:generate && bun demo:db:migrate`                                                                                                                                                                                                                                                                                                  | SQLite baseline/reset remains valid                         |
| Kura packages                 | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/types typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/validation typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/api typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/domain typecheck` | exit 0                                                      |
| Kura web                      | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web build && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web lint`                                                                                                       | exit 0                                                      |
| Kura editor regression        | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web test:editor`                                                                                                                                                                                                                                                              | existing interval editor tests pass                         |

## STOP conditions

Stop and report before continuing if any of these occurs:

- material drift invalidates the contracts or file paths in this plan;
- generated migration drops/retypes unrelated data or proposes destructive SQL;
- the configured database cannot be proven disposable/local before migration;
- the generic vision migration changes observable face results, embedding
  dimensions, match behavior, or current public face routes unexpectedly;
- NudeNet/runtime installation removes or shadows the ONNX provider required by
  faces, or concurrent sessions are unstable;
- Python cannot report the provider/model actually active per capability;
- exact frame PTS cannot be preserved through extraction and batch correlation;
- restart/cancellation can lose a job, duplicate publication, or leak temporary
  frames;
- a rerun can delete a manual or user-modified automatic bookmark;
- a new demo route/filesystem/queue path can reach production data or Python;
- tests would require committing or visually inspecting sensitive personal
  frames without separate explicit authorization;
- Kura would need a new editing model rather than reusing its existing segment
  editor;
- real-browser validation would require destructive edits to personal videos.

## Out of scope

- Automatic analysis during directory scan or ingestion.
- Automatic clip rendering, concatenation, deletion, or replacement of source
  video files.
- Semantic recognition of acts, consent, age, or subjective “interestingness”.
- Persisted crops, frame galleries, or bounding-box screenshots.
- Cloud inference or uploading frames outside the local environment.
- Supporting NudeNet labels beyond the selected eleven in v1.
- Mobile UI changes unless separately requested after the web flow is proven.
- Migrating conversion/edit queues to the new durable-jobs module. Their
  semantics inform this implementation, but their migration remains separate.
- Publishing, pushing, or distributing model/container artifacts.

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
