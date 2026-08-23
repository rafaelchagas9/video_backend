# Plan 005: Distinguish assigned, confirmed-none, and unknown studio state

> **Executor instructions**: Read this entire plan before editing. This change
> is safe only if every studio/video writer uses the same invariant. Run every
> verification and stop on the listed conditions. Update `plans/README.md` when
> done unless a reviewer owns the index.
>
> **Drift check (run first)**:
> ```bash
> git diff --stat 9a00ff3..HEAD -- src/database/schema/videos.schema.ts src/database/demo src/modules/videos src/modules/studios src/modules/triage src/modules/enrichment src/modules/auto-tagging src/modules/tagging-rules src/modules/stats tests
> git diff --stat -- src/database/schema/videos.schema.ts src/database/demo src/modules/videos src/modules/studios src/modules/triage src/modules/enrichment src/modules/auto-tagging src/modules/tagging-rules src/modules/stats tests
> git -C /home/rafael/Documentos/projetos/kura diff --stat d71a4f0..HEAD -- packages/types/src/videos.ts packages/validation/src/videos.ts packages/api/src/videos.ts packages/api/src/routes.ts apps/web/src/pages/VideosPage.tsx apps/web/src/pages/TriagePage.tsx apps/web/src/components/triage apps/web/src/pages/StatisticsPage.tsx
> git -C /home/rafael/Documentos/projetos/kura diff --stat -- packages/types/src/videos.ts packages/validation/src/videos.ts packages/api/src/videos.ts packages/api/src/routes.ts apps/web/src/pages/VideosPage.tsx apps/web/src/pages/TriagePage.tsx apps/web/src/components/triage apps/web/src/pages/StatisticsPage.tsx
> ```
> Preserve the backend's unrelated dirty work, especially current enrichment and
> demo migrations. Do not reset or regenerate those changes away.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: direction
- **Planned at**: backend `9a00ff3` plus current working tree; Kura `d71a4f0`, 2026-08-23

## Why this matters

No studio link currently means both "not reviewed" and "reviewed; no studio
applies." That makes studio triage impossible to finish. A real three-state
model preserves an auditable negative fact without inventing a `No Studio`
entity that would corrupt relationship browsing and related-video scores.

## Current state

- `src/database/schema/videos.schema.ts:16-52` has no negative-assignment marker;
  `src/database/schema/organization.schema.ts:285-300` stores only positive
  `video_studios` links.
- `src/modules/videos/videos.query-builder.ts:203-210` implements
  `hasStudio=false` as `NOT EXISTS(video_studios)`, conflating both meanings.
- The public video type/schema in `src/modules/videos/videos.types.ts:15-50` and
  `src/modules/videos/videos.schemas.ts:384-420` has no assignment status.
- Direct studio writers exist in:
  - `src/modules/studios/studios.relationships.service.ts:143-197`
  - `src/modules/videos/videos.bulk.service.ts:298-337` and `:629-658`
  - `src/modules/triage/triage.service.ts:285-316`
  - `src/modules/enrichment/enrichment.service.ts:768-785`
  - `src/modules/auto-tagging/auto-tagging.service.ts:323-356`
  - `src/modules/tagging-rules/tagging-rules.service.ts:650-680`
  - `src/modules/studios/studios.demo.service.ts:280-315` and
    `src/modules/videos/videos.demo.service.ts:updateRelationships`.
- Studio deletion also cascades junction rows, so
  `src/modules/studios/studios.service.ts:delete` must invalidate affected video
  caches before deletion.
- `src/modules/videos/videos.related.service.ts:417-434` awards 14 points for
  one shared studio. Cached rows are stored in `video_related_scores` and
  currently deleted only for a recomputed source around lines 230-255.
- Kura maps **Missing studio** to `hasStudio=false` in
  `apps/web/src/components/triage/triage-filters.ts:41` and uses the same broad
  filter in `VideosPage.tsx:704-708`.
- Migration safety: update Drizzle schema, run `bun db:generate`, review SQL,
  then `bun db:migrate` only against an explicitly approved database. Never use
  `db:push`. Demo migrations use `bun demo:db:generate` and named-column
  baseline restore compatibility.

## State model and invariants

Add nullable `studio_absence_confirmed_at` to videos. Derive the response field
`studio_assignment_status` as follows:

| Real `video_studios` links | Confirmation timestamp | Derived state |
|---:|---:|---|
| one or more | any value (repair to null) | `assigned` |
| zero | non-null | `confirmed_none` |
| zero | null | `unknown` |

Invariant operations:

- Linking any real studio clears the marker atomically.
- Removing studios clears the marker; removing the final link therefore yields
  `unknown`, never `confirmed_none`.
- Confirming none is allowed only when zero real links exist.
- Marking unknown clears the marker and does not alter real links; if links
  exist the derived state remains `assigned`.
- Neither `unknown` nor `confirmed_none` creates a studio entity or contributes
  similarity weight.
- Keep `hasStudio` compatibility: true means real link exists; false means no
  real link, regardless of review state. Add precise
  `studioAssignmentStatus=assigned|confirmed_none|unknown` filtering.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate PostgreSQL migration | `bun db:generate` | one additive nullable-column migration; no destructive SQL |
| Generate demo migration | `bun demo:db:generate` | one additive nullable-column migration |
| Focused backend | `bun test tests/videos-schemas.test.ts tests/demo-catalog-sqlite.test.ts tests/demo-mode-route-coverage.test.ts tests/integration/core-crud.integration.test.ts tests/integration/enrichment.integration.test.ts` | all pass |
| Backend full gates | `bunx tsc --noEmit && bun run build && bun run test:unit && bun run test:integration` | all exit 0 |
| Kura gates | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web build && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web lint` | all exit 0 |

## Scope

**In scope**:

- Production/demo video schema, generated additive migrations, baseline/seed,
  DTO mapping, filters, explicit state route, all studio/video mutation callers,
  related-cache invalidation, triage bulk action/statistics, focused tests.
- Kura video types/validation/API, precise browse/triage filters, per-video and
  bulk **Confirm no studio** / **Mark unknown** controls, and truthful labels.

**Out of scope**:

- A synthetic `No Studio` entity, confidence scores, multiple negative reasons,
  automatic confirmation, or using absence in recommendation ranking.
- Reinterpreting/removing `hasStudio` or silently backfilling existing no-link
  videos as confirmed.
- Applying migrations to shared/production databases without explicit approval.
- Changes to creator/tag review state.

## Git workflow

- Branches: `codex/005-studio-assignment-state` in both repositories.
- Never use `db:push`; review every generated migration line.
- Preserve current uncommitted migrations and stage only this plan's migration.
- Suggested commit: `feat(videos): track explicit studio assignment state`.
- Do not push/open a PR without instruction.

## Steps

### Step 1: Add the nullable marker safely

Add `studioAbsenceConfirmedAt` to production and demo video schemas (`timestamp`
in PostgreSQL, ISO text in SQLite). Generate additive migrations. Update demo
baseline named-column restore and seed data with at least one video in each
derived state. Existing rows must remain null/`unknown`; there is no backfill.

Review SQL before any migration execution. Do not run `bun db:migrate` unless
the operator confirms the target database is disposable/local.

**Verify**: migration files contain only additive nullable columns; then
`bun test tests/demo-reset-baseline.test.ts tests/demo-catalog-sqlite.test.ts` -> pass.

### Step 2: Create the single studio-assignment mutation service

Create `src/modules/studios/studio-assignment.service.ts` plus a demo adapter.
Expose transaction-capable `linkMany`, `unlinkMany`, `confirmNone`, and
`markUnknown`. The service must enforce the table above and delete related-score
cache rows where either `source_video_id` or `related_video_id` is in the changed
video set, in the same transaction for production.

Add a public `videosRelatedService.invalidateForVideos(videoIds, executor)`
helper rather than duplicating cache SQL. Deduplicate IDs and safely no-op on an
empty list. `confirmNone` must reject the whole request with `ConflictError` if
any target still has a real link.

**Verify**: new focused service tests cover every transition, mixed bulk input,
idempotence, rollback on conflict, and cache deletion in both directions.

### Step 3: Route every writer through the invariant service

Replace all direct link/unlink writes listed in **Current state**. Keep each
caller's existing entity existence/authorization behavior, but delegate the
actual junction mutation and marker/cache maintenance. For tagging rules and
bulk operations, pass their active transaction to the helper.

Before deleting a studio, capture affected video IDs; after/coupled with the
delete, invalidate both directions. Search again for direct junction mutations:

```bash
rg -n "insert\(videoStudiosTable\)|delete\(videoStudiosTable\)|insert\(demoVideoStudiosTable\)|delete\(demoVideoStudiosTable\)" src/modules --glob '!*.bak'
```

Expected: matches exist only inside the centralized production/demo assignment
services (and read-only schema/query code has no mutation).

**Verify**: focused bulk, triage, enrichment, tagging-rule, auto-tagging,
studio-relationship, demo, and related-video tests pass.

### Step 4: Add derived DTOs, precise filters, and state mutation routes

Add `studio_assignment_status` to every canonical video mapping: detail, list,
next, random, triage queue, related summaries where they use the canonical
video schema, and demo repository. Derive in SQL with `EXISTS` plus marker or in
a shared mapper; do not trust a stale stored enum.

Add `studioAssignmentStatus` to list/next/random/triage query types and the
shared `buildVideoFilters`. Preserve `hasStudio` semantics. Add authenticated
`PATCH /api/videos/:id/studio-assignment` with body
`{ status: "confirmed_none" | "unknown" }`; return the refreshed canonical
video. Extend triage bulk actions with the same optional status, mutually
exclusive with `addStudioIds`/`removeStudioIds` in Zod.

Update demo policy/route manifest and OpenAPI.

**Verify**: query and HTTP tests cover all three states, compatibility filters,
mutual exclusion, conflict with a real link, auth, and demo parity.

### Step 5: Make Kura triage finishable

Extend Kura video types, filters, validators, clients, and query serialization.
Change the triage **Missing studio** filter to
`studioAssignmentStatus="unknown"`; keep the broad library **No studio** filter
mapped to `hasStudio=false`, and add explicit **Needs studio review** and
**Confirmed no studio** choices where the page's filter model permits.

Add **Confirm no studio** to single-card triage and bulk actions, with a clear
confirmation label. On a confirmed-none video, offer **Mark as needing review**.
When a real studio is added, let the backend clear the state and refresh video,
triage queue/progress, stats, and related queries. Never create/select a fake
studio.

Update wording so `unknown` says "Needs studio review" and `confirmed_none`
says "Confirmed: no studio". Existing content statistics may retain
`videos_without_studios` as the broad factual count; do not relabel it as a
review backlog.

**Verify**: Kura gates pass and existing triage E2E covers the state leaving and re-entering the queue.

### Step 6: Validate migration, invariants, and cache freshness

Run the full backend gates. Add an integration test that warms related scores,
links a studio, confirms both score directions are invalidated/recomputed, then
unlinks and confirms the video returns to unknown. Inspect git status and
migration diffs before marking done.

**Verify**: all commands in the table pass.

## Test plan

- Migration: existing rows become unknown; each state survives demo reset.
- Service: unknown -> confirmed-none -> assigned -> unknown; invalid
  confirmed-none while linked; idempotent repeated requests; bulk rollback.
- Writers: manual, bulk, triage, enrichment, auto-tagging, tagging rules, studio
  delete, and demo all uphold the invariant.
- Filters: exact three-state results across list/next/random/triage plus legacy
  `hasStudio` compatibility.
- Cache: affected video as both source and candidate is invalidated.
- UI: unknown exits the triage queue when confirmed, returns when marked unknown,
  and linking a studio shows assigned.

## Done criteria

- [ ] Exactly one invariant service owns studio/video writes in production and demo.
- [ ] Existing no-link rows remain unknown; no synthetic studio exists.
- [ ] Every canonical video response exposes the correct derived state.
- [ ] Precise filters work while `hasStudio` remains compatible.
- [ ] Kura can confirm none, undo that decision, and finish the missing-studio queue.
- [ ] Related-score cache rows are invalidated in both directions after changes.
- [ ] Generated migrations are additive/reviewed and `db:push` was not run.
- [ ] Backend full gates and Kura gates pass; plan index is updated.

## STOP conditions

Stop if any studio writer cannot participate in the central invariant, if a
generated migration drops/rewrites data, if existing rows would be automatically
confirmed, if a requirement introduces a `No Studio` relation, if cache
invalidation cannot be transactional, or if the current dirty migrations
conflict. Stop after two failed verification attempts and do not touch a
shared/prod database without explicit approval.

## Maintenance notes

Any future studio mutation path must call `StudioAssignmentService`; make this
explicit in its module comment and tests. Reviewers should search for direct
junction writes, inspect migration safety, verify bulk rollback, and ensure
confirmed absence never influences similarity.
