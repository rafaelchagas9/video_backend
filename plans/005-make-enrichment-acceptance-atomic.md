# Plan 005: Make enrichment suggestion acceptance atomic

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ff97b6a..HEAD -- src/modules/enrichment src/modules/creators src/modules/studios src/modules/tags src/modules/platforms tests/integration/enrichment.integration.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M/L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ff97b6a`, 2026-06-12

## Why this matters

Accepting an enrichment suggestion can write to multiple tables: entity fields, aliases, external IDs, relationships, and auto-enriched related entities. Today the service applies side effects first and marks the suggestion accepted afterward. A failure between those operations leaves a pending suggestion whose retry may duplicate work or produce conflicts.

## Current state

Relevant files:

- `src/modules/enrichment/enrichment.service.ts` - orchestrates suggestion apply/reject/list.
- Existing writer services under `src/modules/creators`, `src/modules/studios`, `src/modules/tags`, and `src/modules/platforms`.
- `src/config/drizzle.ts` - exports `DrizzleTransaction`.
- `tests/integration/enrichment.integration.test.ts` - existing end-to-end enrichment coverage.

Current excerpts:

```ts
// src/modules/enrichment/enrichment.service.ts:348
async acceptSuggestion(id: number): Promise<SuggestionDTO> {
  const suggestion = await this.getSuggestionOrThrow(id);
  ...
  await this.applyCreator(suggestion);
  ...
  const [updated] = await db.update(enrichmentSuggestionsTable)
    .set({ status: "accepted", updatedAt: new Date() })
```

```ts
// src/modules/enrichment/enrichment.service.ts:907
await this.applyAutoAcceptedRelatedSuggestion(suggestion);
await db.update(enrichmentSuggestionsTable)
  .set({ status: "accepted", updatedAt: new Date() })
```

```ts
// src/config/drizzle.ts:15
export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
```

Repo convention: other multi-write services use `db.transaction(...)`, for example `src/modules/creators/creators.merge.service.ts` and `src/modules/multiplayer-remote/multiplayer-remote.service.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |
| Focused integration | `bun test tests/integration/enrichment.integration.test.ts` | all pass |

## Scope

**In scope**:

- `src/modules/enrichment/enrichment.service.ts`
- Minimal signature changes in writer services only if needed to accept a transaction
- `tests/integration/enrichment.integration.test.ts`

**Out of scope**:

- Redesigning the enrichment schema.
- Changing suggestion API response shape.
- Adding background workers or queues.
- Making remote image downloads transactional with filesystem writes; if image filesystem rollback becomes necessary, STOP and report.

## Git workflow

- Branch suggestion: `advisor/005-enrichment-atomic`
- Commit message style: conventional commits.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Identify DB-only and filesystem-writing suggestion types

In `enrichment.service.ts`, categorize `apply*` cases:

- DB-only: fields, aliases, external IDs, relationships, categories, metadata.
- Filesystem/network side effects: creator/studio image suggestions through `addGalleryMediaFromUrl()` or `setPictureFromUrl()`.

For this plan, make DB-only suggestion acceptance atomic. For image suggestions, either keep existing behavior with an explicit comment and test coverage, or implement a safe two-phase flow only if it remains small. Do not pretend filesystem writes are rolled back by DB transactions.

**Verify**: no command; this is a read step.

### Step 2: Thread a transaction through enrichment DB writes

Add a local DB executor type in `enrichment.service.ts`, such as:

```ts
type DbExecutor = typeof db | DrizzleTransaction;
```

Refactor private apply/resolve helpers to accept an optional executor parameter defaulting to `db`, or pass `tx` explicitly from `acceptSuggestion()`. Focus on helpers that directly call `db`:

- `applyCreator`
- `applyStudio`
- `applyTag`
- `applyScene`
- `resolveCreatorId`
- `resolveStudioId`
- `resolveTagId`
- `resolveTagCategoryId`
- `getSuggestionOrThrow` if needed

If existing external services such as `creatorsService.quickCreate()` cannot accept a transaction and the change would cascade broadly, STOP and report with the exact method causing the boundary problem.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 3: Wrap DB-only accept in one transaction

Change `acceptSuggestion()` so it:

1. Reads the pending suggestion inside the transaction or uses a row lock if Drizzle support is already available.
2. Applies the suggestion with the same transaction executor.
3. Updates `enrichmentSuggestionsTable.status = "accepted"` in the same transaction.
4. Returns the updated DTO.

For image suggestions, decide explicitly:

- If not transactional, leave them outside this transaction and document why in code with one succinct comment.
- If you can safely download/process first and then run DB updates transactionally, do that without broad rewrites.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 4: Wrap auto-accepted related suggestions

Update `autoEnrichRelatedEntity()` so the apply-and-mark-accepted pair for each DB-only related suggestion is atomic. Avoid one huge transaction around the remote enrichment service call; remote network calls must stay outside DB transactions.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 5: Add regression tests

Extend `tests/integration/enrichment.integration.test.ts` with a failure-path test for a DB-only suggestion:

- Create or seed an unsupported/invalid DB-only suggestion that will fail during apply, or mock a writer to fail after a partial DB operation if that can be done without brittle global mocks.
- Assert the suggestion remains pending and no partial DB state was committed.

If constructing a reliable failure path is too intrusive, add a test proving a normal accept changes both target state and suggestion status, then document the untestable failure case in final notes.

**Verify**: `bun test tests/integration/enrichment.integration.test.ts` -> all pass.

### Step 6: Run final gates

**Verify**:

- `bunx tsc --noEmit` -> exit 0
- `bunx eslint .` -> exit 0
- `bun test tests/integration/enrichment.integration.test.ts` -> all pass

## Test plan

Use `tests/integration/enrichment.integration.test.ts` because it already covers run -> list -> accept across creator/studio/tag/scene. Add one atomicity regression if feasible and keep all existing cases passing.

## Done criteria

- [ ] DB-only suggestion apply and status update happen in the same transaction.
- [ ] Auto-accepted related DB-only suggestions are apply-and-mark atomic.
- [ ] Remote enrichment calls are not made inside DB transactions.
- [ ] Image suggestion transaction limits are documented or safely handled.
- [ ] Enrichment integration tests pass.
- [ ] `plans/README.md` row for this plan is updated.

## STOP conditions

Stop and report if:

- Making apply helpers transactional requires broad rewrites to unrelated modules.
- Image suggestion rollback becomes necessary to satisfy the plan.
- Drizzle transaction typing blocks a clean implementation after reasonable effort.
- Existing enrichment tests start failing for behavior unrelated to atomicity.

## Maintenance notes

Future enrichment suggestion types should declare whether they are DB-only or involve external side effects. Reviewers should check that remote calls happen outside transactions and DB writes that define one accepted suggestion are atomic.
