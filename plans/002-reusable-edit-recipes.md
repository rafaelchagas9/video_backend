# Plan 002: Reopen and clone edit jobs as reusable recipes

> **Executor instructions**: Execute in order, run every verification, and stop
> on the conditions below rather than inventing a new editing model. Update the
> row in `plans/README.md` when complete unless a reviewer owns the index.
>
> **Drift check (run first)**:
> ```bash
> git diff --stat 9a00ff3..HEAD -- src/modules/edits src/database/schema/edits.schema.ts src/database/demo tests
> git diff --stat -- src/modules/edits src/database/schema/edits.schema.ts src/database/demo tests
> git -C /home/rafael/Documentos/projetos/kura diff --stat d71a4f0..HEAD -- packages/types/src/media.ts packages/validation/src/media.ts packages/api/src/edits.ts packages/api/src/routes.ts apps/web/src/pages/design-lab/surfaces/editor
> git -C /home/rafael/Documentos/projetos/kura diff --stat -- packages/types/src/media.ts packages/validation/src/media.ts packages/api/src/edits.ts packages/api/src/routes.ts apps/web/src/pages/design-lab/surfaces/editor
> ```
> Backend commit `9a00ff3` is the edit-history fix this plan builds on. Preserve
> all current working-tree changes and compare the excerpts before editing.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: backend `9a00ff3`; Kura `d71a4f0`, 2026-08-23

## Why this matters

Every edit job already stores the source, complete timeline, and output
configuration, but the authenticated API hides most of that data. Users must
reconstruct a cut after a failed render or when producing a variant. A sanitized
recipe and clone operation turns retained job history into a reusable workflow
while keeping the editor single-source and using the existing validation/queue
path.

## Current state

- `src/database/schema/edits.schema.ts:19-35` stores `videoId`, `outputConfig`,
  `timelineConfig`, status, and result linkage.
- `src/modules/edits/edits.routes.ts:37-64` serializes a job without the stored
  configs; routes around lines 228-324 expose list, detail, and cancel only.
- `src/modules/edits/edits.schemas.ts:284-312` has no recipe response or clone
  request.
- `src/modules/edits/edits.service.ts:75-150` is the canonical creation path: it
  normalizes the timeline, checks current duration, validates a safe output
  target, detects conflicts, inserts the job, and enqueues it. Clone must call
  this method rather than duplicating any of those rules.
- Kura types and validation are in `packages/types/src/media.ts:280-421` and
  `packages/validation/src/media.ts:150-180`. The client is
  `packages/api/src/edits.ts`; routes are `packages/api/src/routes.ts:199-206`.
- The real editor/history surface is
  `apps/web/src/pages/design-lab/surfaces/editor/finish.tsx`: `useRenderQueue`
  recovers jobs and polls details; `JobsPanel` begins around line 941. Draft
  shape/conversion helpers are in sibling `engine.ts` and `finish.tsx`.
- Existing tests: `tests/edits-routes.test.ts`,
  `tests/demo-edit-lifecycle.test.ts`,
  `tests/demo-mode-route-coverage.test.ts`, and the edit section of
  `tests/integration/core-crud.integration.test.ts`.

## Contract to implement

Job **detail only** gains:

```ts
recipe: {
  source_video_id: number;
  output_defaults: {
    directory_id: number;
    format: "mkv";
    video_codec: "av1";
    audio_codec: "opus" | "aac";
  };
  timeline: EditTimelineConfig;
}
```

Never expose the historical absolute output path or reuse the old filename.
Add `POST /api/edits/jobs/:id/clone` with body
`{ output: CreateEditJobOutput; timeline?: EditTimelineConfig }`. The endpoint
uses the stored timeline when omitted and the supplied timeline when the user
edited the reopened draft. It infers the source video from the original job and
returns the same 202 shape as ordinary creation.

Only terminal jobs (`completed`, `failed`, `cancelled`) are cloneable. Missing
source is 404; an active source job is 409; invalid current duration or output
conflict uses the existing create errors.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Backend focused | `bun test tests/edits-routes.test.ts tests/demo-edit-lifecycle.test.ts tests/demo-mode-route-coverage.test.ts` | all pass |
| Backend typecheck/build | `bunx tsc --noEmit && bun run build` | exit 0 |
| Kura typecheck/build | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web build` | exit 0 |
| Kura lint | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web lint` | exit 0 |
| Kura editor test | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web test:editor` | all tests pass |

## Scope

**In scope**:

- Backend edit types, schemas, service, routes, demo edit service/repository, and
  existing edit tests.
- Kura edit types/validation/client/routes and the shipped editor state/history
  files under `apps/web/src/pages/design-lab/surfaces/editor/`.

**Out of scope**:

- Multi-source timelines, new codecs/containers, presets, draft autosave, or a
  new edit-jobs table.
- Exposing local absolute paths or internal FFmpeg arguments.
- Detecting byte-for-byte source replacement; the current job row has no source
  revision. This plan revalidates against the current source instead.
- Cloning pending/queued/running jobs.

## Git workflow

- Branches: `codex/002-edit-recipes` in both repositories.
- Preserve unrelated backend dirt; stage only intended hunks.
- Use local commit style, e.g. `feat(edits): reuse completed jobs as recipes`.
- Do not push or open a PR without explicit operator direction.

## Steps

### Step 1: Define a sanitized recipe contract

Add shared backend recipe types and Zod response schemas. Parse the persisted
JSON through the same timeline/output validators used at creation; do not cast
unchecked JSON. Detail responses include `recipe`; list responses remain small
and unchanged. Map only directory/format/codec defaults, never the previous
filename or absolute output path.

Mirror the response and clone-input types in Kura. Add `editRoutes.clone(id)`
and `edits.clone(id, payload)` with Zod validation.

**Verify**: backend and Kura typecheck commands exit 0.

### Step 2: Add one clone service path that delegates to create

Add `EditsService.clone(jobId, input)`:

1. Load the source job through the existing authenticated job lookup.
2. Require a terminal status.
3. Parse stored config; choose `input.timeline ?? storedTimeline`.
4. Call the existing `create(storedJob.videoId, { output: input.output,
   timeline })` and return its result.

Do not copy processor or queue code. Ensure a deleted source returns the same
safe 404 used by ordinary edit metadata. Add the authenticated 202 route and
OpenAPI schema. Implement the identical state transition in demo mode.

**Verify**: `bun test tests/edits-routes.test.ts tests/demo-edit-lifecycle.test.ts` -> clone happy path and error cases pass.

### Step 3: Hydrate the Kura editor from job history

In `finish.tsx`, add **Edit again** for terminal jobs. Fetch job detail on
demand, convert `recipe.timeline` into the existing `Draft`/clip model using a
named pure adapter, retain the recipe's output directory/codecs, and generate a
new editable filename (never silently reuse the old one). Navigate/show the
timeline with all validation problems visible.

Track `sourceJobId` in editor state. When a reopened draft submits, call the
clone endpoint with the current output and current timeline; new drafts keep
using `createJob`. Clear `sourceJobId` after the user explicitly starts a fresh
draft. If the source is missing or current metadata makes the timeline invalid,
show the API error and keep the draft available for correction.

**Verify**: Kura typecheck and build commands exit 0.

### Step 4: Lock down compatibility and privacy

Add tests for detail-vs-list exposure, exact timeline round-trip (including
transform/audio effects), default stored timeline, overridden timeline, new
output target requirement, all three terminal statuses, active-job 409,
missing source, output collision, duration invalidation, ownership/auth, demo
parity, and absence of `output_path`/FFmpeg internals in recipe JSON.

**Verify**: focused tests pass, then `bun run test:unit`, Kura editor test, and Kura lint pass.

## Test plan

- Model HTTP fixtures after `tests/edits-routes.test.ts` and persistence after
  `tests/demo-edit-lifecycle.test.ts`.
- Assert list payloads still omit recipe while authenticated detail includes it.
- Assert clone produces a distinct job and routes through current validation.
- Add pure Kura adapter tests only if the editor already has a colocated test
  convention; otherwise exercise the flow through the existing Playwright
  editor test and do not introduce a runner.

## Done criteria

- [ ] Detail returns a validated, path-safe recipe; list does not.
- [ ] Terminal jobs clone through the existing create/queue path.
- [ ] The Kura history can reopen a recipe, edit it, and submit a distinct job.
- [ ] Old filenames are never silently reused and absolute paths are not exposed.
- [ ] Production and demo behavior match.
- [ ] Focused tests, backend typecheck/build, and Kura typecheck/build/lint pass.
- [ ] No migration was generated.
- [ ] `plans/README.md` is updated.

## STOP conditions

Stop if stored config cannot be parsed by current validators, if the edit-job
lookup is not scoped to the authenticated owner, if cloning requires bypassing
`EditsService.create`, or if the product requires proof that the source bytes
are unchanged. The latter requires a separately approved source-revision
migration. Also stop after two failed verification attempts or if dirty work
would be overwritten.

## Maintenance notes

Version recipes when the timeline contract next changes. A future source
revision/hash can add `ready`, `source_changed`, and `source_missing` states;
do not infer `source_changed` from timestamps. Reviewers should focus on JSON
validation, output-path privacy, auth, and the single queue entry point.
