# Plan 004: Turn enrichment taxonomy into navigable facets

> **Executor instructions**: Follow this plan exactly and keep the new read
> models bounded. Run every verification and update `plans/README.md` when done
> unless a reviewer maintains it. Stop on any condition listed below.
>
> **Drift check (run first)**:
> ```bash
> git diff --stat 9a00ff3..HEAD -- src/database/schema/organization.schema.ts src/database/demo src/modules/tags src/modules/studios src/modules/enrichment tests
> git diff --stat -- src/database/schema/organization.schema.ts src/database/demo src/modules/tags src/modules/studios src/modules/enrichment tests
> git -C /home/rafael/Documentos/projetos/kura diff --stat d71a4f0..HEAD -- packages/types/src/entities.ts packages/validation/src/entities.ts packages/api/src/tags.ts packages/api/src/studios.ts packages/api/src/routes.ts apps/web/src/pages/TagsPage.tsx apps/web/src/pages/StudiosPage.tsx
> git -C /home/rafael/Documentos/projetos/kura diff --stat -- packages/types/src/entities.ts packages/validation/src/entities.ts packages/api/src/tags.ts packages/api/src/studios.ts packages/api/src/routes.ts apps/web/src/pages/TagsPage.tsx apps/web/src/pages/StudiosPage.tsx
> ```
> The taxonomy schema and enrichment writer are currently uncommitted work on
> top of `9a00ff3`. Preserve them; do not regenerate or discard their migration.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: backend `9a00ff3` plus current enrichment/schema work; Kura `d71a4f0`, 2026-08-23

## Why this matters

Accepted enrichment already writes tag categories and aliases plus studio
parentage, but public browsing flattens those facts away. Exposing bounded,
alias-aware read models makes enrichment improve discovery and organization,
not just internal rows. Dedicated facets avoid recursively inflating every tag
or studio response.

## Current state

- `src/database/schema/organization.schema.ts:128-223` defines
  `tag_categories`, `tags.category_id`, `tag_aliases`, and tag external IDs.
- `organization.schema.ts:225-282` defines `studios.parent_studio_id`, aliases,
  and external IDs.
- `src/modules/enrichment/enrichment.service.ts:641-700` writes categories,
  aliases, and studio parents when suggestions are accepted.
- `src/modules/tags/tags.schemas.ts:49-67` and
  `src/modules/tags/tags.types.ts:3-25` expose neither category nor aliases.
  `TagsService.list` searches only name/description.
- `src/modules/studios/studios.types.ts:3-11` and
  `src/modules/studios/studios.schemas.ts:50-75` omit parentage/aliases;
  `StudiosService.list` searches only `s.name`.
- `src/modules/tags/tags.routes.ts:189-217` already provides descendant-aware
  video browsing and must remain the canonical navigation target.
- Demo `demoTagsTable` and `demoStudiosTable` in
  `src/database/demo/schema.ts:23-49` currently lack categories, tag/studio
  aliases, and studio parentage. Follow the repository's generated demo
  migration/baseline workflow; do not hand-edit migration SQL.
- Kura read types and queries live in `packages/types/src/entities.ts`,
  `packages/validation/src/entities.ts`, `packages/api/src/tags.ts`, and
  `packages/api/src/studios.ts`. UI entry points are `TagsPage.tsx` and
  `StudiosPage.tsx`.

## Contract to implement

- `GET /api/tags/categories` -> all categories ordered by `group`, then `name`,
  each with `id`, `name`, `group`, `description`, and `tag_count`.
- Extend tag list query with `category_id?: positive integer` and
  `include?: ("category" | "aliases")[]`. Search always matches tag name,
  description, or alias; includes only control response expansion.
- With includes, a tag gains `category?: TagCategory | null` and
  `aliases?: Array<{ id, name, note }>`.
- Extend studio list query with `include?: ("hierarchy" | "aliases")[]`.
  Search always matches studio name or alias. `hierarchy` adds one-level
  `parent?: StudioSummary | null` and `children?: StudioSummary[]`; `aliases`
  adds the same bounded alias shape.

Do not return raw provider payloads/external IDs and do not recursively embed
children. Detail routes accept the same includes so Kura can request only what
it renders.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate production migration if schema drift requires it | `bun db:generate` | generated SQL only for intended production changes; likely no new production migration |
| Generate demo migration | `bun demo:db:generate` | one additive reviewed SQLite migration |
| Backend focused | `bun test tests/demo-catalog-sqlite.test.ts tests/demo-mode-route-coverage.test.ts tests/integration/enrichment.integration.test.ts tests/integration/core-crud.integration.test.ts` | all pass |
| Backend full gates | `bunx tsc --noEmit && bun run build && bun run test:unit` | all exit 0 |
| Kura gates | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web build && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web lint` | all exit 0 |

## Scope

**In scope**:

- Tag/studio read types, list/detail queries, schemas, routes, and focused tests.
- Additive SQLite demo taxonomy tables/columns, generated migration, baseline,
  seed fixtures, services, and reset tests.
- Kura tag/studio read types, validation, API routes/query options, and the two
  entity pages.

**Out of scope**:

- New public taxonomy mutation endpoints, external IDs/provider payloads,
  recursive studio trees, tag merge, studio merge, or automatic categorization.
- Changing tag descendant semantics or enrichment acceptance behavior.
- Editing existing generated migration SQL manually or using `db:push`.

## Git workflow

- Branches: `codex/004-taxonomy-facets` in each repo.
- Never run `db:push`. Generate then review migrations.
- Preserve the current uncommitted `0032` production and `0003` demo migrations;
  do not regenerate them as if they were absent.
- Suggested commit: `feat(taxonomy): expose categories aliases and hierarchy`.
- Do not push/open a PR unless asked.

## Steps

### Step 1: Characterize and preserve current enrichment writes

Add or extend integration assertions proving accepted tag suggestions populate
one category and aliases, and studio suggestions populate one parent. These are
pre-change characterization tests. Confirm external IDs remain internal.

**Verify**: `bun test tests/integration/enrichment.integration.test.ts` -> characterization cases pass before the read API changes.

### Step 2: Add demo taxonomy persistence and fixtures

Extend demo schema with category, tag-alias, and studio-alias tables plus nullable
`categoryId`/`parentStudioId` columns. Use foreign-key actions matching production.
Generate the SQLite migration, review that it is additive, update named-column
baseline restore compatibility, and seed a small graph: two categories in one
group, one tag alias, one parent studio with two direct children, and one studio
alias. Do not create cycles.

**Verify**: `bun demo:db:generate`, inspect the generated SQL, then
`bun test tests/demo-reset-baseline.test.ts tests/demo-catalog-sqlite.test.ts` -> reset and reads pass.

### Step 3: Implement bounded tag taxonomy reads

Add category list service/route and tag include/category filters. Use joins or
batched secondary queries; never query aliases once per tag. Alias-aware search
must use an `EXISTS` predicate so pagination totals remain tag counts and aliases
do not duplicate rows. With `tree=true`, retain the current root pagination and
attach optional fields without recursively refetching per node.

Register `/categories` before `/:id`. Add identical demo behavior.

**Verify**: focused core CRUD and demo route tests cover category counts, filter,
alias search, include omission/presence, pagination totals, and tree mode.

### Step 4: Implement bounded studio hierarchy reads

Add include parsing to list/detail. Alias search uses `EXISTS`; hierarchy uses a
parent self-join plus one batched children query. Return summaries only and sort
children by name. Add a visited/self guard in mapping so corrupt self/cycle data
cannot recurse; because the response is one level, do not attempt a full tree.
Match production and demo.

**Verify**: focused tests cover parent, children, root, alias search, omitted
includes, a synthetic cycle/corrupt self reference, and pagination without duplicates.

### Step 5: Build category and network facets in Kura

Extend Kura types/validators/clients. In `TagsPage.tsx`, fetch categories,
provide an **All categories** filter, group/display category labels, show aliases
only when requested, and keep clicking a tag routed through the existing
descendant-aware videos endpoint. In `StudiosPage.tsx`, request hierarchy/aliases,
show the parent network and direct children, and make each summary navigable.

Preserve current create/edit/delete controls; this plan adds browsing, not new
taxonomy writes. Use the pages' existing query keys, empty states, skeletons,
and responsive components.

**Verify**: all Kura gates pass.

### Step 6: Run migration and full regression gates

Review `git diff -- src/database/drizzle-migrations src/database/demo/migrations`
and confirm only the intended additive demo migration is new unless live schema
inspection proved a missing production change. Run backend unit/integration
focused gates and Kura gates.

**Verify**: all commands in the table pass; `git status --short` contains only intended files plus preserved pre-existing work.

## Test plan

- Production integration: alias search, category counts/filter, optional include
  omission, bounded hierarchy, and no duplicate pagination rows.
- Demo: same API payloads, seeded graph, migration from prior baseline, reset
  idempotency, and no access to production PostgreSQL.
- Kura: category filter updates query; alias search finds canonical tag/studio;
  parent/child links navigate; empty categories/hierarchies render safely.

## Done criteria

- [ ] Category, alias, and one-level hierarchy contracts are documented in OpenAPI.
- [ ] Alias-aware search and pagination are correct without N+1 queries.
- [ ] Production and demo return equivalent bounded shapes.
- [ ] Kura exposes useful category and network navigation.
- [ ] No external IDs/raw enrichment payloads leak into browsing DTOs.
- [ ] Generated migration SQL is additive and reviewed; `db:push` was not run.
- [ ] Backend and Kura gates pass and the plan index is updated.

## STOP conditions

Stop if the current uncommitted taxonomy schema/migrations are missing or
conflict, if demo migration generation proposes destructive changes, if alias
search changes pagination cardinality, if the requested UI requires recursive
unbounded trees, or if implementing reads requires new public mutations. Stop
after two failed verification attempts and never overwrite dirty work.

## Maintenance notes

Keep includes additive and opt-in as taxonomy grows. If full studio trees are
needed, design cycle policy and pagination separately. Reviewers should inspect
query counts, `EXISTS` search semantics, migration safety, baseline reset, and
absence of provider-internal data.
