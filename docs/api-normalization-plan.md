# API Normalization Plan

This document turns the endpoint review into an implementation plan. The goal is to reduce route sprawl, make resource ownership obvious, and standardize response shapes without forcing a flag day rewrite.

## Core decisions

## Working rules

These rules apply throughout the normalization effort.

### Rule 1: Checklists must be kept current

- Every phase checklist in this document is a live progress tracker.
- As soon as work starts on an item, update its status.
- As soon as work completes, update its status.
- Do not leave completed implementation work undocumented in the checklist.

### Rule 2: Every endpoint change must be recorded for frontend handoff

- Every endpoint change must be documented in `docs/api-normalization-frontend-handoff.md`.
- This includes path changes, method changes, query parameter changes, request body changes, response body changes, field renames, nullability changes, auth changes, and deprecations.
- If an endpoint stops existing, the handoff must state which endpoint replaces it.
- The handoff file should stay brief and frontend-oriented: what changed, why it changed, and what the frontend must update.

### 1. Keep nested relationship endpoints, but standardize their contract

Endpoints like `GET /videos`, `GET /creators/:id/videos`, `GET /tags/:id/videos`, and `GET /studios/:id/videos` are allowed to coexist.

That split makes sense when:

- `/videos` is the canonical search/listing endpoint for the `video` resource.
- `/creators/:id/videos` means "videos related to this creator" and saves clients from having to know filter syntax.
- Nested endpoints are thin convenience views over the same underlying video listing contract.

That split does not make sense when:

- Nested endpoints return a materially different video shape.
- Pagination, sorting, includes, and derived fields differ arbitrarily.
- One endpoint gets important fields like thumbnail URLs while the other does not.

Decision:

- `GET /videos` becomes the canonical video collection contract.
- Nested `*/videos` endpoints remain in the API as supported convenience endpoints.
- Nested `*/videos` endpoints must internally delegate to the same listing/query layer as `GET /videos`.
- Nested `*/videos` endpoints must return the same base video DTO, pagination envelope, field names, derived fields, nullability semantics, and `include` behavior as `GET /videos`.
- Relationship-scoped endpoints may apply opinionated default filters, but they must not invent alternate response schemas.

Supported examples:

- `GET /creators/:id/videos`
- `GET /tags/:id/videos`
- `GET /studios/:id/videos`

Non-negotiable rule:

- A `video` returned from one endpoint must mean the same thing everywhere in the API.
- A field present on one video list response must not disappear or be renamed on another video list response unless the endpoint is explicitly documented as a different projection.

### 2. Prefer resource nouns over action verbs in paths

Examples:

- Prefer `POST /videos/:id/conversions` over `POST /videos/:id/convert`
- Prefer `GET /conversions/queue` over `GET /videos/convert/queue`
- Prefer `DELETE /conversions/:id` or `PATCH /conversions/:id` with status change over `POST /conversions/:id/cancel`

### 3. Route ownership must be visible from server registration

Modules mounted at `"/"` and then defining routes under unrelated roots hide the actual API surface and make collisions easier.

Decision:

- Each module should own one obvious top-level prefix.
- Cross-resource behavior should be exposed through nested resources under the owning root, not through root-mounted hidden routes.

### 4. Standardize envelopes and query capabilities

For list endpoints, standardize:

- pagination keys
- sorting keys
- filter naming
- `include` behavior
- derived fields such as thumbnail/storyboard URLs

For item endpoints, standardize:

- base DTO shape
- relationship expansion semantics

## Target conventions

### Canonical video list contract

`GET /videos` is the source of truth for any endpoint that returns a list of videos.

Minimum standard video fields for all video list endpoints:

- `id`
- `file_path`
- `file_name`
- `directory_id`
- `file_size_bytes`
- `file_hash`
- `duration_seconds`
- `width`
- `height`
- `codec`
- `bitrate`
- `fps`
- `audio_codec`
- `title`
- `description`
- `themes`
- `is_available`
- `last_verified_at`
- `indexed_at`
- `created_at`
- `updated_at`
- `thumbnail_id`
- `thumbnail_url`
- `thumbnail_base64` only when explicitly requested or already part of the canonical contract
- `is_favorite`

Optional include-driven fields, with the same names everywhere they appear:

- `collection`
- `collection_neighbors`
- `creators`
- `tags`
- `studios`

Rules:

- Nested `*/videos` endpoints must not rename fields.
- Nested `*/videos` endpoints must not omit standard fields that are present in `GET /videos`.
- Nullability must match the canonical contract.
- Any intentionally smaller projection must be documented as a separate projection, not as a silent divergence.

### Standard list envelope

Canonical list endpoints should return:

- `{ success: true, data: T[], pagination: { page, limit, total, totalPages } }`

Allowed optional top-level additions:

- `meta` for endpoint-specific context
- `summary` for aggregate values

Rules:

- Relationship-scoped video lists should use the same `data` and `pagination` structure as `GET /videos`.
- Alternate list envelopes such as `{ success, ids, total }` are allowed only for intentionally specialized endpoints like queue helpers, not for general resource lists.

### Include semantics

Rules:

- `include` semantics should be shared across all endpoints returning the same resource family.
- If `GET /videos` supports `include=creators,tags,studios,collection`, nested `*/videos` endpoints should support the same contract unless explicitly documented otherwise.
- Unsupported includes must fail or be documented clearly; they must not silently disappear in one endpoint while working in another.

### Deprecation policy

Rules:

- No endpoint should be removed without a documented replacement path or justification.
- Deprecated endpoints must be marked in docs and OpenAPI descriptions.
- Deprecated endpoints should remain available during migration whenever feasible.
- The frontend handoff file must record the old endpoint, the replacement endpoint, and the frontend action required.
- Compatibility aliases should be removed only after frontend migration is complete.

### Canonical collection endpoints

- `GET /videos`
- `GET /creators`
- `GET /studios`
- `GET /tags`
- `GET /playlists`
- `GET /video-collections`
- `GET /conversions`

### Canonical nested relationship endpoints

Allowed when they reflect ownership or relationship traversal:

- `GET /videos/:id/creators`
- `GET /videos/:id/tags`
- `GET /videos/:id/studios`
- `GET /playlists/:id/videos`

Allowed as convenience endpoints only if they reuse the canonical contract:

- `GET /creators/:id/videos`
- `GET /tags/:id/videos`
- `GET /studios/:id/videos`

### Action endpoint guidance

Prefer one of:

- create a sub-resource
- update a resource state
- delete a resource

Use action-style endpoints only when there is no stable resource model and the operation is truly command-like.

## Phases

## Phase 0: Freeze the target rules

Checklist:

- [x] Agree that `GET /videos` is the canonical video list contract.
- [x] Confirm that nested `*/videos` endpoints remain as supported convenience endpoints.
- [x] Define the standard video DTO fields required in all list contexts.
- [x] Define list envelope rules: `data`, pagination metadata, sorting metadata, optional summary blocks.
- [x] Define `include` semantics and whether nested endpoints support them.
- [x] Define the mandatory parity rule for all video list endpoints:
  - [x] identical field names
  - [x] identical derived asset fields
  - [x] identical nullability semantics
  - [x] identical pagination structure
- [x] Define a deprecation policy: warning headers, docs labels, changelog, and sunset dates.

Deliverables:

- written API conventions section in docs
- short deprecation policy for frontend/backend use
- current route inventory and classification in `docs/api-route-inventory.md`

## Phase 1: Inventory and classify the existing surface

Checklist:

- [x] Create a route inventory grouped by canonical resource root.
- [x] Mark each endpoint as one of: canonical, convenience, action, duplicate, legacy.
- [x] Identify root-mounted modules whose public routes are not visible from `src/server.ts`.
- [x] Identify list endpoints that return incompatible representations of the same resource.
- [x] Identify endpoints that should become query-based variants of a canonical collection.

Initial hotspots from the current API:

- [x] conversion routes
- [x] triage routes
- [x] stats snapshot routes
- [x] thumbnails/storyboards asset routes
- [x] favorites/rating/bookmark convenience routes
- [x] creator/tag/studio video listing fragmentation

## Phase 2: Standardize the video listing contract first

This is the highest leverage step because many other routes return videos.

Checklist:

- [x] Extract a shared video list serializer/DTO builder used by all video list endpoints.
- [x] Ensure thumbnail URL and other derived asset URLs are part of the standard contract.
- [x] Standardize pagination for all video list endpoints.
- [x] Standardize sorting/filter names across video list endpoints.
- [x] Standardize field naming and nullability across all video list endpoints.
- [x] Ensure nested `*/videos` endpoints expose the same includes and expansion options as `GET /videos`, or clearly document any intentionally unsupported options.
- [ ] Add support for relationship filters on `GET /videos`:
  - [ ] `creatorId`
  - [ ] `tagId`
  - [ ] `studioId`
  - [x] any existing nested-list filter equivalents
- [x] Make `GET /creators/:id/videos` reuse the same service/query/serializer as `GET /videos`.
- [x] Make `GET /tags/:id/videos` reuse the same service/query/serializer as `GET /videos`.
- [x] Make `GET /studios/:id/videos` reuse the same service/query/serializer as `GET /videos`.
- [ ] Add integration tests proving those endpoints return the same core fields, naming, nullability, derived URLs, and pagination shape.

Decision gate:

- [ ] After standardization, document nested `*/videos` endpoints as first-class convenience routes backed by the canonical video list contract.

## Phase 3: Normalize route ownership and prefixes

Checklist:

- [ ] Stop introducing new root-mounted modules that self-declare unrelated prefixes.
- [x] Move conversion routes behind explicit prefixes in registration.
- [x] Move storyboard routes behind explicit prefixes in registration.
- [x] Move thumbnail routes behind explicit prefixes in registration.
- [x] Move edits routes behind explicit prefixes in registration.
- [ ] Move face-recognition routes behind explicit prefixes in registration.
- [ ] Make the route root visible from `src/server.ts` for each module.

Refactor target examples:

- `conversionRoutes` registered under `/conversions` plus nested `/videos/:id/conversions`
- `thumbnailsRoutes` registered under `/videos` and `/thumbnails` via clearer split modules if needed
- `storyboardsRoutes` registered under a visible root, even if public asset paths remain compatible during transition

## Phase 4: Normalize the most fragmented feature groups

### Conversion

Checklist:

- [x] Replace `POST /videos/:id/convert` with `POST /videos/:id/conversions`
- [x] Replace `POST /videos/convert/bulk` with either:
  - [x] `POST /conversions`
  - [ ] or `POST /videos/conversions` if batch creation is modeled there
- [x] Replace `GET /videos/convert/queue` with `GET /conversions/queue`
- [x] Replace `GET /conversion/status` with `GET /conversions/queue/status` or fold into queue response
- [x] Replace `POST /conversions/:id/cancel` with `PATCH /conversions/:id`
- [x] Review whether `/presets` should become `/conversions/presets`
- [x] Keep compatibility aliases during migration

### Triage

Checklist:

- [x] Move current-user triage progress away from `/users/...`
- [x] Prefer `/me/triage-progress` or `/triage/progress`
- [x] Align triage batch operations with video bulk operations or clearly separate them as a triage workflow API
- [x] Decide whether triage stats belong under `/triage/stats` or `/stats/triage`

### Stats

Checklist:

- [x] Decide whether snapshots are resources or commands
- [x] If resources, prefer `POST /stats/storage-snapshots`, etc.
- [x] If commands, keep them grouped consistently and reduce one-off duplication
- [x] Reevaluate whether `POST /stats/snapshot` and the four type-specific snapshot endpoints all need to exist

### Thumbnails and storyboards

Checklist:

- [x] Define canonical metadata endpoints versus binary asset endpoints
- [x] Standardize asset URL fields in DTOs instead of forcing clients to build file-like URLs
- [x] Review whether `/thumbnails/:id/image` should become the thumbnail resource URL itself
- [x] Review whether storyboard asset URLs should be surfaced as links from `/videos/:id/storyboard`

Phase 4 decisions implemented:

- Conversions now use canonical resource-style routes:
  - `POST /api/videos/:id/conversions`
  - `POST /api/conversions`
  - `GET /api/conversions/queue`
  - `GET /api/conversions/queue/status`
  - `PATCH /api/conversions/:id`
  - `GET /api/conversions/presets`
- Deprecated conversion aliases remain live with deprecation headers:
  - `POST /api/videos/:id/convert`
  - `POST /api/videos/convert/bulk`
  - `GET /api/videos/convert/queue`
  - `GET /api/conversion/status`
  - `POST /api/conversions/:id/cancel`
  - `GET /api/presets`
- Triage now has an explicit owning root:
  - `POST /api/triage/progress`
  - `GET /api/triage/progress`
  - `POST /api/triage/bulk-actions`
  - `GET /api/triage/stats`
- Deprecated triage aliases remain under `/api/users/...` with deprecation headers.
- Stats snapshots are modeled as resources:
  - `POST /api/stats/storage-snapshots`
  - `POST /api/stats/library-snapshots`
  - `POST /api/stats/content-snapshots`
  - `POST /api/stats/usage-snapshots`
  - `POST /api/stats/snapshots`
- Deprecated stats aliases remain live:
  - `POST /api/stats/storage/snapshot`
  - `POST /api/stats/library/snapshot`
  - `POST /api/stats/content/snapshot`
  - `POST /api/stats/usage/snapshot`
  - `POST /api/stats/snapshot`
- Thumbnail/storyboard metadata now carries canonical asset links:
  - `GET /api/thumbnails/:id` returns thumbnail metadata with `asset_url`
  - `GET /api/videos/:id/storyboard` returns storyboard metadata with `sprite_url` and `vtt_url`
- Decision: keep `/api/thumbnails/:id/image` as the stable binary asset URL for now; do not force a flag-day asset path change.

## Phase 5: Deprecate or keep convenience endpoints deliberately

Checklist:

- [x] For each convenience endpoint, document why it exists.
- [x] For each deprecated endpoint, add migration guidance to the replacement route.
- [x] Add deprecation markers in docs and OpenAPI descriptions.
- [x] If possible, add response headers for deprecated routes.
- [ ] Update frontend callers incrementally, starting with video-related endpoints.

Candidate convenience endpoints to review:

- [x] `GET /favorites/:video_id/check`
- [x] `GET /creators/:id/videos`
- [x] `GET /tags/:id/videos`
- [x] `GET /studios/:id/videos`
- [x] `GET /videos/random`
- [x] `GET /videos/next`

Phase 5 decisions:

- Keep `GET /favorites/:video_id/check` as a convenience endpoint because it answers a narrow boolean question without forcing callers to fetch a full video or favorites collection.
- Keep `GET /creators/:id/videos`, `GET /tags/:id/videos`, and `GET /studios/:id/videos` as convenience relationship traversals backed by the canonical `GET /videos` contract.
- Keep `GET /videos/random` as a specialized discovery endpoint because its semantics are selection-oriented rather than collection pagination.
- Keep `GET /videos/next` as a triage/navigation workflow endpoint because it encodes wraparound neighbor selection rather than generic listing.
- Deprecate route shapes that changed in phase 4, not these convenience endpoints.

## Phase 6: Verification and rollout

Checklist:

- [x] Add integration tests for canonical vs convenience endpoint parity.
- [x] Add route-level API contract tests for pagination and DTO shape.
- [x] Update frontend handoff docs.
- [x] Update Swagger summaries and descriptions to reflect canonical/deprecated status.
- [x] Announce migration phases to frontend consumers.
- [ ] Remove deprecated aliases only after callers are migrated.

Phase 6 backend verification delivered:

- Added route-contract coverage in `src/api-normalization.phase6.test.ts`.
- Verified canonical and deprecated conversion route behavior, including deprecation headers.
- Verified canonical and deprecated triage route behavior.
- Verified canonical and deprecated stats snapshot route behavior.
- Verified thumbnail/storyboard metadata includes canonical asset URLs.
- Verified `GET /videos` and convenience `GET /creators/:id/videos`, `GET /tags/:id/videos`, and `GET /studios/:id/videos` return the same list envelope and DTO shape.

Phase 6 note:

- These tests are mocked route-contract tests, not full database-backed integration tests.
- The current repository does not contain an existing Postgres test harness, so phase 6 verifies API contracts at the routing layer without requiring external services.

## Recommended implementation order

1. Standardize video list/result shapes.
2. Normalize conversion routes.
3. Fix triage route semantics.
4. Normalize stats snapshots.
5. Normalize media asset endpoints.
6. Deprecate remaining convenience or legacy endpoints.

## Notes for the `*/videos` fragmentation question

Short answer: splitting can be fine, but only if the split is semantic, not structural.

Good split:

- `GET /videos` is the canonical search/list endpoint.
- `GET /creators/:id/videos` is a convenience endpoint for "videos for this creator".
- Both return the same video representation and mostly the same query features.

Bad split:

- `GET /videos` returns rich cards with thumbnail URLs, includes, pagination, and summaries.
- `GET /creators/:id/videos` returns a reduced shape with missing fields and different pagination semantics.

Recommendation:

- Standardize on one shared video list DTO and one shared list envelope.
- Reuse it everywhere videos are listed.
- Keep nested relationship endpoints as thin aliases with optional opinionated defaults.
- Treat `/videos` as the source of truth for behavior and schema.
- Do not allow drift in field presence, field names, nullability, or derived URL fields between video list endpoints.
