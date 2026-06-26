# Plan 006: Paginate enrichment suggestion listing

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ff97b6a..HEAD -- src/modules/enrichment tests/integration/enrichment.integration.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ff97b6a`, 2026-06-12

## Why this matters

Enrichment is designed to process a large creator backlog and surface reviewable suggestions. The suggestions endpoint currently returns every matching row. Once backlog automation lands, this can make the review UI slow and memory-heavy.

## Current state

Relevant files:

- `src/modules/enrichment/enrichment.schemas.ts` - query and response schemas.
- `src/modules/enrichment/enrichment.service.ts` - `listSuggestions()`.
- `src/modules/enrichment/enrichment.routes.ts` - route response.
- `tests/integration/enrichment.integration.test.ts` - existing API coverage.

Current excerpts:

```ts
// src/modules/enrichment/enrichment.schemas.ts:52
export const listSuggestionsQuerySchema = z.object({
  entity_type: entityTypeEnum.optional(),
  entity_id: z.coerce.number().int().positive().optional(),
  status: suggestionStatusEnum.optional(),
  type: suggestionTypeEnum.optional(),
});
```

```ts
// src/modules/enrichment/enrichment.service.ts:314
const rows = await db
  .select()
  .from(enrichmentSuggestionsTable)
  .where(conditions.length > 0 ? and(...conditions) : undefined)
  .orderBy(...);
return rows.map((r) => this.toSuggestionDTO(r));
```

API normalization context from repo memory/docs: canonical list endpoints generally return paginated envelopes. For this plan, do not migrate unrelated enrichment endpoints.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |
| Focused integration | `bun test tests/integration/enrichment.integration.test.ts` | all pass |

## Scope

**In scope**:

- `src/modules/enrichment/enrichment.schemas.ts`
- `src/modules/enrichment/enrichment.types.ts` if DTO types need update
- `src/modules/enrichment/enrichment.service.ts`
- `src/modules/enrichment/enrichment.routes.ts`
- `tests/integration/enrichment.integration.test.ts`

**Out of scope**:

- Paginating enrichment runs.
- Changing non-enrichment endpoints.
- Frontend changes.

## Git workflow

- Branch suggestion: `advisor/006-enrichment-pagination`
- Commit message style: conventional commits.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Add pagination query params

In `listSuggestionsQuerySchema`, add:

- `page`: coerced positive int, default `1`
- `limit`: coerced int, default `50`, min `1`, max `100`

Keep existing filters unchanged.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 2: Return a paginated envelope

Update `listSuggestions()` to return:

```ts
{
  data: SuggestionDTO[],
  pagination: {
    page: number,
    limit: number,
    total: number,
    total_pages: number,
  }
}
```

Implementation details:

- Reuse the existing filter conditions.
- Add a count query with the same `where` condition.
- Apply `.limit(limit).offset((page - 1) * limit)` to the data query.
- Preserve the existing sort order.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 3: Update response schema and route

Update `suggestionListResponseSchema` so the route returns:

```ts
{
  success: true,
  data: SuggestionDTO[],
  pagination: ...
}
```

Update `enrichment.routes.ts` to spread the service result into that shape. Keep the route path and filters stable.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 4: Update integration tests

In `tests/integration/enrichment.integration.test.ts`, update helper expectations:

- Existing `runAndList()` should read `listRes.json().data` as before.
- Add assertions for `pagination.page`, `pagination.limit`, and `pagination.total`.
- Add a new case with `limit=2&page=1` and `page=2` to prove slicing and total count.

**Verify**: `bun test tests/integration/enrichment.integration.test.ts` -> all pass.

### Step 5: Run final gates

**Verify**:

- `bunx tsc --noEmit` -> exit 0
- `bunx eslint .` -> exit 0
- `bun test tests/integration/enrichment.integration.test.ts` -> all pass

## Test plan

Use the existing enrichment integration suite. Add pagination assertions to existing list calls and one explicit multi-page test.

## Done criteria

- [ ] `/api/enrichment/suggestions` accepts `page` and `limit`.
- [ ] Response includes `pagination` with total and total pages.
- [ ] Existing filters still work with pagination.
- [ ] Focused enrichment integration tests pass.
- [ ] `plans/README.md` row for this plan is updated.

## STOP conditions

Stop and report if:

- A frontend contract already depends on a plain array-only response and cannot be migrated.
- Existing API normalization docs specify a different envelope for enrichment.
- Count query cannot be expressed cleanly with current Drizzle version.

## Maintenance notes

When backlog automation lands, use this endpoint with explicit status/type filters and page through results. Reviewers should verify the count and data queries use identical filters.
