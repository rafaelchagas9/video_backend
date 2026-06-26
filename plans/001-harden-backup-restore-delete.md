# Plan 001: Harden backup restore/delete and remove shell-built database commands

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ff97b6a..HEAD -- src/modules/backup tests/integration/core-crud.integration.test.ts tests/helpers/test-app.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ff97b6a`, 2026-06-12

## Why this matters

Backup restore/delete is an authenticated admin surface with destructive effects. Today it accepts any non-empty `filename`, joins it with the backup directory without proving the final path stays inside that directory, and runs `pg_dump`/`psql` through shell strings. This should be boring and auditable: validated backup filenames, resolved path containment, and argument-vector process execution with secrets in `env`, not interpolated shell.

## Current state

Relevant files:

- `src/modules/backup/backup.service.ts` - backup list/create/restore/delete logic.
- `src/modules/backup/backup.schemas.ts` - route parameter schema.
- `src/modules/backup/backup.routes.ts` - authenticated backup routes.
- `tests/helpers/test-app.ts` - broad integration harness currently mocks backup service.
- `tests/integration/core-crud.integration.test.ts` - existing mocked route coverage for backup.

Current excerpts:

```ts
// src/modules/backup/backup.schemas.ts:4
export const filenameParamSchema = z.object({
  filename: z.string().min(1, "Filename is required"),
});
```

```ts
// src/modules/backup/backup.service.ts:48
const pgDumpCommand = `PGPASSWORD='${env.POSTGRES_PASSWORD}' pg_dump -h ${env.POSTGRES_HOST} -p ${env.POSTGRES_PORT} -U ${env.POSTGRES_USER} -F p -d ${env.POSTGRES_DB} -f "${backupPath}"`;
execSync(pgDumpCommand, { stdio: "pipe" });
```

```ts
// src/modules/backup/backup.service.ts:104
async restoreBackup(filename: string): Promise<void> {
  const backupPath = join(BACKUP_DIR, filename);
```

Repo conventions:

- Protected routes use `app.addHook("preHandler", authenticateUser)`.
- Validation uses Zod route schemas and returns the standard `{ success: false, error: { message, statusCode } }` shape.
- Use Pino `logger` from `@/utils/logger`, not `console.log`, in app code.
- Follow module layout from `AGENTS.md`: `*.schemas.ts`, `*.service.ts`, `*.routes.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0, no TypeScript errors |
| Lint | `bunx eslint .` | exit 0, no lint errors |
| Focused tests | `bun test tests/integration/core-crud.integration.test.ts` | exit 0, all tests pass |

## Scope

**In scope**:

- `src/modules/backup/backup.service.ts`
- `src/modules/backup/backup.schemas.ts`
- `src/modules/backup/backup.routes.ts` only if response codes or schema wiring must be adjusted
- `tests/helpers/test-app.ts`
- `tests/integration/core-crud.integration.test.ts`

**Out of scope**:

- Database schema or migrations.
- Changing backup file format.
- Implementing import/export beyond the existing backup endpoints.
- Touching unrelated mocked service setup in `tests/helpers/test-app.ts`.

## Git workflow

- Branch suggestion: `advisor/001-harden-backup`
- Commit message style: conventional commits, matching recent history such as `feat: initialize enrichment service...` or `refactor: improve tagging logic...`.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Restrict accepted backup filenames

In `src/modules/backup/backup.schemas.ts`, replace the loose `z.string().min(1)` with a regex that accepts only generated backup filenames and any intentionally supported legacy suffixes. At minimum allow:

- `backup-<timestamp>.sql` where the timestamp format is the one produced by `new Date().toISOString().replace(/[:.]/g, "-")`
- Existing listed backup files ending in `.sql` or `.db` only if the basename has no slash, backslash, NUL, or traversal segments

Prefer a conservative helper schema, for example a basename-only regex such as `/^[A-Za-z0-9._-]+\\.(sql|db)$/`, plus a `.refine((name) => !name.includes(".."))`. Do not accept path separators.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 2: Add a backup path resolver with containment check

In `src/modules/backup/backup.service.ts`, introduce a private helper near `ensureBackupDir()`:

- Takes a filename string.
- Rejects path separators and `..` defensively, even though the schema should already reject them.
- Resolves `BACKUP_DIR` and the candidate path.
- Verifies the candidate path is equal to or inside `BACKUP_DIR` using `relative()` or equivalent.
- Throws `ValidationError` for invalid filenames.

Use this helper in `restoreBackup()` and `deleteBackup()`. Keep `listBackups()` returning basenames from `readdirSync(BACKUP_DIR)`.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 3: Replace shell strings with argument-vector process execution

Replace `execSync(commandString)` with `spawnSync` or `execFileSync` using an argv array.

For `pg_dump`, call something equivalent to:

```ts
execFileSync("pg_dump", [
  "-h", env.POSTGRES_HOST,
  "-p", String(env.POSTGRES_PORT),
  "-U", env.POSTGRES_USER,
  "-F", "p",
  "-d", env.POSTGRES_DB,
  "-f", backupPath,
], {
  stdio: "pipe",
  env: { ...process.env, PGPASSWORD: env.POSTGRES_PASSWORD },
});
```

Do the same for `psql` restore with `["-h", ..., "-f", backupPath]`. Do not interpolate env values into a shell command. Preserve the existing public method names and error behavior.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 4: Add regression tests for invalid filenames

Extend `tests/integration/core-crud.integration.test.ts` near the existing backup route coverage. Add authenticated requests that prove the route rejects:

- `../backup-test.sql`
- `backup-test.sql/restore` style path separator cases if Fastify routing allows encoding
- an encoded traversal segment such as `%2e%2e%2fbackup-test.sql` if it reaches the param

The existing test harness mocks `backupService`, so also add service-level unit coverage if route encoding is swallowed before schema validation. If adding a new unit test is simpler and less brittle, create `tests/backup-service.test.ts` that instantiates the service and exercises only the filename/path helper through `restoreBackup()`/`deleteBackup()` with mocked filesystem calls if needed. Keep tests focused on rejecting unsafe filenames and accepting a normal `backup-test.sql`.

**Verify**: `bun test tests/integration/core-crud.integration.test.ts` -> exit 0.

### Step 5: Run final gates

Run the repo gates used during audit.

**Verify**:

- `bunx tsc --noEmit` -> exit 0
- `bunx eslint .` -> exit 0
- `bun test tests/integration/core-crud.integration.test.ts` -> exit 0

## Test plan

- Add or extend tests for backup filename validation and path containment.
- Keep the existing mocked backup route coverage passing.
- If service-level tests are added, they should avoid touching a real database and should not invoke real `pg_dump`/`psql`.

## Done criteria

- [ ] Backup route params reject traversal, slash, backslash, and non-backup extensions.
- [ ] `restoreBackup()` and `deleteBackup()` resolve paths through a containment helper.
- [ ] `pg_dump` and `psql` are invoked without shell command strings.
- [ ] `PGPASSWORD` is supplied through child-process environment, not interpolated into a command.
- [ ] `bunx tsc --noEmit`, `bunx eslint .`, and focused tests pass.
- [ ] `plans/README.md` row for this plan is updated.

## STOP conditions

Stop and report if:

- The backup service no longer resembles the excerpts above.
- The fix requires changing how backups are stored or changing DB schema.
- Tests would need a real production/shared database.
- Route-level tests cannot exercise encoded filenames after reasonable attempts; report and keep service-level coverage.

## Maintenance notes

Reviewers should scrutinize the child-process invocation and the path containment helper. Future backup import/export work should reuse the same filename validator and resolver rather than joining route params directly.
