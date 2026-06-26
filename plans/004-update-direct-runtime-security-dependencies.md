# Plan 004: Update direct runtime dependencies with high-severity advisories

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ff97b6a..HEAD -- package.json bun.lock src tests`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S/M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `ff97b6a`, 2026-06-12

## Why this matters

`bun audit` reported high-severity advisories affecting direct runtime dependencies: `drizzle-orm <0.45.2` and `fastify <=5.7.2`. The repo uses both in request handling and database access. This plan updates only the direct runtime packages needed to clear reachable advisories, then runs the existing backend verification gates.

## Current state

Relevant files:

- `package.json` - dependency ranges.
- `bun.lock` - lockfile.
- `src/server.ts` - Fastify plugin setup.
- `src/config/drizzle.ts` and services under `src/modules/` - Drizzle usage.
- `tests/integration/*.integration.test.ts` - DB-backed route coverage.

Current excerpts:

```json
// package.json:38
"drizzle-orm": "^0.45.1",
"fastify": "^5.6.2",
"fastify-type-provider-zod": "^6.1.0"
```

Audit evidence from this run:

- `drizzle-orm <0.45.2` high advisory.
- `fastify <=5.7.2` high advisories.
- Other audit output includes many transitive/dev-tool advisories; do not chase all of them in this plan unless they are resolved by the direct updates.

Repo commands:

- `bunx tsc --noEmit`
- `bunx eslint .`
- `bun test`
- `bun audit`

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Update | `bun update drizzle-orm fastify fastify-type-provider-zod` | exit 0, package and lockfile updated |
| Audit | `bun audit` | no remaining high advisories for direct runtime deps |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |
| Tests | `bun test` | all pass |

## Scope

**In scope**:

- `package.json`
- `bun.lock`
- Minimal source/test adjustments required by Fastify/Drizzle minor updates

**Out of scope**:

- Major framework migrations.
- Updating every dev transitive advisory if it requires unrelated major changes.
- Database schema changes or migrations.
- Changing route contracts.

## Git workflow

- Branch suggestion: `advisor/004-runtime-security-deps`
- Commit message style: conventional commits.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Update direct runtime packages

Run:

```bash
bun update drizzle-orm fastify fastify-type-provider-zod
```

If `fastify-type-provider-zod` already supports the new Fastify minor, keep the update. If Bun tries a breaking major, STOP and report.

**Verify**: `git diff -- package.json bun.lock` -> only dependency/lockfile changes at this point.

### Step 2: Run audit and classify remaining findings

Run `bun audit`.

Expected: no remaining high advisories for direct runtime dependencies `drizzle-orm` or `fastify`. Transitive dev advisories may remain; list them in the final executor note but do not broaden scope without instruction.

**Verify**: `bun audit` -> either exit 0 or only remaining findings outside this plan's direct runtime scope.

### Step 3: Fix compile/test breakage only if caused by the package update

Run typecheck. If minor API changes break compilation, make the smallest local changes needed in source/tests. Do not refactor route registration or database services.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 4: Run final gates

Run:

```bash
bunx eslint .
bun test
```

If full `bun test` is too slow or blocked by Docker, run the integration script that matches repo convention and report the blocker. Do not skip tests silently.

**Verify**:

- `bunx eslint .` -> exit 0
- `bun test` -> all pass, or documented environment blocker

## Test plan

This is a dependency update plan, so existing tests are the safety net. Full `bun test` is preferred. If failures are unrelated to the dependency update, STOP and report rather than fixing unrelated tests.

## Done criteria

- [ ] `package.json` no longer pins vulnerable direct `drizzle-orm`/`fastify` ranges.
- [ ] `bun.lock` is updated consistently.
- [ ] `bun audit` no longer reports high advisories for direct runtime deps in this plan.
- [ ] Typecheck, lint, and tests pass or a real environment blocker is documented.
- [ ] `plans/README.md` row for this plan is updated.

## STOP conditions

Stop and report if:

- Updating Fastify or Drizzle requires a major version migration.
- Drizzle update proposes schema or migration changes.
- Full test failures are unrelated to this dependency update.
- `bun audit` still reports the same direct runtime advisories after the update.

## Maintenance notes

Add a lightweight recurring dependency audit to CI later if this repo gets CI. Keep the scope of this plan narrow: clear the reachable direct runtime advisories first, then decide separately whether dev transitive advisories are worth chasing.
