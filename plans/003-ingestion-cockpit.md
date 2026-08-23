# Plan 003: Turn scan logs into an ingestion cockpit

> **Executor instructions**: Follow each step and run its verification. Stop
> rather than expanding this into file-move detection or a generic job system.
> Update the row in `plans/README.md` when complete unless the reviewer owns it.
>
> **Drift check (run first)**:
> ```bash
> git diff --stat 9a00ff3..HEAD -- src/modules/directories src/modules/scheduler src/database/schema/directories.schema.ts src/database/demo src/utils/telemetry.ts tests
> git diff --stat -- src/modules/directories src/modules/scheduler src/database/schema/directories.schema.ts src/database/demo src/utils/telemetry.ts tests
> git -C /home/rafael/Documentos/projetos/kura diff --stat d71a4f0..HEAD -- packages/types/src/directories.ts packages/validation/src/directories.ts packages/api/src/directories.ts packages/api/src/routes.ts packages/api/src/query-options.ts apps/web/src/pages/DirectoriesPage.tsx
> git -C /home/rafael/Documentos/projetos/kura diff --stat -- packages/types/src/directories.ts packages/validation/src/directories.ts packages/api/src/directories.ts packages/api/src/routes.ts packages/api/src/query-options.ts apps/web/src/pages/DirectoriesPage.tsx
> ```
> The backend working tree contains unrelated uncommitted work. Preserve it.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: backend `9a00ff3`; Kura `d71a4f0`, 2026-08-23

## Why this matters

Scan runs already persist useful aggregate results, but manual scanning returns
only a message and scheduler state is visible only inside the process. A small
read API and a polling UI let the owner distinguish queued/running/completed,
see recent counts and safe error summaries, and diagnose a stalled ingestion
without opening server logs.

## Current state

- `src/database/schema/directories.schema.ts:15-29` stores scan ID, directory,
  found/added/updated/removed counts, errors, start, and completion.
- `src/modules/directories/watcher.service.ts:30-77` uses an in-memory
  `Set<number>` to skip concurrent scans and inserts the scan log only inside the
  long-running call. Lines 187-223 persist aggregate completion/failure data.
- `src/modules/directories/directories.routes.ts:181-225` starts the promise in
  the background and returns HTTP 200 with only `"Directory scan started"`.
- `src/modules/scheduler/scheduler.service.ts:170-190` already returns bounded
  runtime status: running flag, scheduled directories, intervals, and named
  system tasks.
- Demo mode has no scan history; `directories.demo.service.ts:143-174` only
  updates `last_scan_at` and returns deterministic counts.
- `src/utils/telemetry.ts:sanitizeTelemetryProperties` is the existing exported
  sanitizer for secrets, absolute media paths, and media filenames. Use it for
  public error summaries instead of returning raw `scan_logs.errors`.
- Kura's scan mutation is `packages/api/src/directories.ts:34-38` and the button
  is `apps/web/src/pages/DirectoriesPage.tsx:370-420`. It currently shows a
  success toast but has no run to follow.
- Use authenticated Fastify routes, Zod schemas, snake_case JSON, and Pino.

## Contract to implement

- `POST /api/directories/:id/scan` -> HTTP 202, `Location` header pointing to
  the new detail resource, and `{ success: true, data: ScanRun }`.
- `GET /api/directories/:id/scans?page=1&limit=20` -> paginated newest-first
  scan runs for that directory.
- `GET /api/directories/:id/scans/:scanId` -> one run, only when it belongs to
  that directory.
- `GET /api/directories/scheduler/status` -> `{ is_running,
  scheduled_directories, schedules, system_tasks }`. Register the static route
  before `/:id`.

`ScanRun` fields: `id`, `directory_id`, `status: "running" | "completed"`, all
four counts, `error_count`, at most five `error_summaries`, `started_at`, and
`completed_at`. A completed run with errors is still `completed`; the counts
and `error_count` describe the partial result. Never return raw stored errors.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Backend focused | `bun test tests/demo-directories-core-http.test.ts tests/demo-catalog-sqlite.test.ts tests/demo-mode-route-coverage.test.ts tests/integration/core-crud.integration.test.ts` | all pass |
| Backend typecheck/build | `bunx tsc --noEmit && bun run build` | exit 0 |
| Kura typecheck/build/lint | `pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web typecheck && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web build && pnpm --dir /home/rafael/Documentos/projetos/kura --filter @kura/web lint` | exit 0 |

## Scope

**In scope**:

- Directory watcher/service/types/schemas/routes, scheduler status adapter,
  SQLite demo persistence, demo policy/manifest, and focused tests.
- Kura directory types/validation/API/query options and `DirectoriesPage.tsx`.

**Out of scope**:

- Per-file progress, SSE, WebSockets, scan cancellation, durable distributed
  locks, filesystem moves, duplicate reconciliation, or a new queue.
- Raw paths, filenames, stack traces, or unbounded error arrays in responses.
- Changing scan discovery/indexing behavior.
- A PostgreSQL migration; the existing table is sufficient. Demo persistence
  may use `demo_resources` with kind `directory_scan`.

## Git workflow

- Branches: `codex/003-ingestion-cockpit` in both repos.
- Preserve and do not stage pre-existing backend work.
- Suggested commit: `feat(directories): expose scan run status`.
- Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Introduce the scan-run read model

Create directory-local types and Zod schemas for `ScanRun`, pagination, and
scheduler status. Add a service that lists/reads `scan_logs` by directory and
maps storage rows to the public model. Parse `errors` defensively as JSON; an
invalid legacy value becomes one sanitized summary, never a 500. Pass each
summary through `sanitizeTelemetryProperties`, cap each string and the array,
and expose only the derived `error_count` plus five summaries.

Add equivalent demo-resource records and deterministic seeded history. Do not
touch real watched paths in demo mode.

**Verify**: `bun test tests/demo-catalog-sqlite.test.ts` -> read-model and reset persistence cases pass.

### Step 2: Split scan start from scan completion

Refactor `WatcherService` so the manual route can await log creation but not the
scan itself. Reserve the directory in the in-memory guard before the first
await, create the log, then return `{ run, completion }`; the completion promise
performs the existing scan body and releases the guard in `finally`. Scheduled
and initial scans must call the same start primitive and await or detach only as
appropriate.

If a directory is already reserved, throw `ConflictError("Directory scan already in progress")`
instead of returning a fake zero result. Do not create two open log rows. Keep
the existing public `scanDirectory` wrapper if other callers require the final
`ScanResult`, but implement it through the new primitive.

**Verify**: add a watcher unit test that starts two calls before resolving the first; exactly one log is created and the second receives 409/conflict semantics.

### Step 3: Expose authenticated history and scheduler routes

Add the four routes above. Manual start waits only for the run ID, returns 202
and `Location`, then logs any completion rejection via Pino. Ensure detail checks
both `scanId` and `directoryId`; cross-directory lookup is 404. Add the routes to
the demo allowlist and route manifest with identical contracts.

**Verify**: `bun test tests/demo-directories-core-http.test.ts tests/demo-mode-route-coverage.test.ts tests/integration/core-crud.integration.test.ts` -> 202/header, pagination, ownership, scheduler, conflict, and demo cases pass.

### Step 4: Build the Kura cockpit with bounded polling

Add typed Kura clients/query keys. At the top of `DirectoriesPage.tsx`, render a
compact scheduler summary. In each `DirectoryCard`, show the active/latest run,
counts, duration, and an expandable list of safe summaries; provide a small
recent-history dialog/list.

After POST 202, seed/invalidate the run query and poll that one run every two
seconds only while `status === "running"`; stop polling on completion, unmount,
or error. Invalidate directory stats and directory list once completion is
observed. Disable **Scan now** while a run is active. Do not poll every history
row and do not add SSE in this plan.

**Verify**: Kura typecheck, build, and lint commands exit 0.

### Step 5: Run the regression suite

Cover completed-with-zero-changes, completed-with-errors, fatal completion,
invalid legacy error JSON, bounded/redacted summaries, active conflict,
newest-first pagination, cross-directory 404, demo reset determinism, scheduler
status, and Kura polling termination.

**Verify**: focused backend tests, `bun run test:unit`, and all three Kura gates pass.

## Test plan

- Extend `tests/integration/core-crud.integration.test.ts` for real table/route
  semantics and `tests/demo-directories-core-http.test.ts` for demo parity.
- Extend `tests/demo-catalog-sqlite.test.ts` to prove scan history survives
  service re-instantiation and is reset with the demo baseline.
- Assert an error containing `/home/user/private/movie.mkv` exposes neither the
  path nor filename.
- Use fake timers for Kura polling if an existing test harness supports them;
  otherwise verify through the existing directory Playwright flow.

## Done criteria

- [ ] Manual scan returns 202, a stable run ID, and `Location` before completion.
- [ ] Authenticated history/detail/scheduler endpoints match production and demo.
- [ ] Concurrent starts for one directory cannot create duplicate active runs.
- [ ] Public errors are bounded and sanitized.
- [ ] Kura follows only active runs and stops polling deterministically.
- [ ] No PostgreSQL migration or SSE endpoint was added.
- [ ] Focused tests, backend typecheck/build, and Kura typecheck/build/lint pass.
- [ ] `plans/README.md` is updated.

## STOP conditions

Stop if returning a run ID requires waiting for filesystem enumeration, if the
watcher is now multi-process/distributed, if `scan_logs` no longer records a row
per run, if error sanitization would expose private paths, or if UI requirements
demand per-file progress/cancellation. Also stop after two failed verification
attempts or before touching unrelated dirty work.

## Maintenance notes

SSE can later replace polling without changing `ScanRun`. If multi-process scan
workers arrive, replace the in-memory guard with a database-backed claim. Review
the 202 timing, completion cleanup, sanitization, and polling teardown closely.
