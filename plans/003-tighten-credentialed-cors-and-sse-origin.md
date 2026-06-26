# Plan 003: Tighten credentialed CORS and SSE Origin handling

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ff97b6a..HEAD -- src/server.ts src/modules/events tests`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ff97b6a`, 2026-06-12

## Why this matters

The API uses cookie-backed auth and `credentials: true` CORS. Production CORS currently accepts not only configured origins but any hostname sharing a suffix derived from configured origins, and the SSE endpoint manually reflects any request `Origin` while allowing credentials. Credentialed CORS should be exact and centralized.

## Current state

Relevant files:

- `src/server.ts` - registers global CORS.
- `src/modules/events/events.routes.ts` - manually sets SSE CORS headers.
- Tests under `tests/` - add focused coverage for allowed and blocked origins.

Current excerpts:

```ts
// src/server.ts:157
const allowedOrigins = new Set([env.BASE_URL, "http://localhost:5173", ...env.CORS_ORIGINS.split(",")]);
```

```ts
// src/server.ts:180
const allowedHostnameSuffixes = new Set<string>();
...
originHostname.endsWith(`.${suffix}`)
```

```ts
// src/modules/events/events.routes.ts:35
const originHeader = request.headers.origin;
if (typeof originHeader === "string" && originHeader.length > 0) {
  reply.raw.setHeader("Access-Control-Allow-Origin", originHeader);
  reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
}
```

Repo conventions:

- `buildServer()` is the Fastify inject entrypoint.
- Test helpers live under `tests/helpers/`.
- Protected routes use `authenticateUser`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |
| Focused tests | `bun test tests/integration/core-crud.integration.test.ts` or a new focused CORS test | all pass |

## Scope

**In scope**:

- `src/server.ts`
- `src/modules/events/events.routes.ts`
- `tests/integration/core-crud.integration.test.ts` or new focused integration test

**Out of scope**:

- Changing auth/session cookie implementation.
- Changing `BASE_URL` or `.env.example` unless a test requires documenting a variable.
- Adding wildcard CORS support.

## Git workflow

- Branch suggestion: `advisor/003-tighten-cors`
- Commit message style: conventional commits.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Extract exact Origin allowlist helper

In `src/server.ts`, create a helper near `buildServer()` such as `getAllowedCorsOrigins()` and `isAllowedCorsOrigin(origin: string)`.

Rules:

- In development, preserving `origin: true` is acceptable if that is required for LAN dev.
- In production/test, allow only exact origins from `env.BASE_URL`, `http://localhost:5173` if intentionally kept, and `env.CORS_ORIGINS`.
- Normalize by trimming trailing slashes and whitespace.
- Remove suffix matching. Do not allow `evil.<allowed-domain>` merely because it shares a suffix.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 2: Reuse the same check for SSE

In `src/modules/events/events.routes.ts`, stop reflecting any `Origin`. Either:

- Remove manual CORS headers and rely on the global CORS plugin, if Fastify applies it correctly to hijacked SSE responses; or
- Import/reuse a shared allowlist helper and set `Access-Control-Allow-Origin` only when the origin is allowed.

Do not set `Access-Control-Allow-Credentials: true` for disallowed origins.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 3: Add regression coverage

Add a focused test that boots the app through `createTestApp()` and sends requests with:

- An exact allowed origin -> response includes `access-control-allow-origin` equal to that origin.
- A sibling/subdomain origin that only shares suffix -> response does not include credentialed allow headers.
- SSE `/api/events/stream` with disallowed origin -> does not reflect that origin.

If authenticating the SSE route through inject is difficult because the route hijacks the response, cover the helper directly in a unit test and add one non-SSE HTTP route CORS test.

**Verify**: chosen focused test command -> all tests pass.

### Step 4: Run final gates

**Verify**:

- `bunx tsc --noEmit` -> exit 0
- `bunx eslint .` -> exit 0
- Focused CORS tests -> all pass

## Test plan

Prefer a small focused test for the allowlist helper plus one inject-level CORS assertion. Avoid brittle assertions against every CORS header; assert the security property: disallowed origins are not reflected with credentials.

## Done criteria

- [ ] Production/test CORS uses exact origin matching.
- [ ] SSE no longer reflects arbitrary `Origin` with credentials.
- [ ] At least one regression test proves suffix-only origins are blocked.
- [ ] Typecheck, lint, and focused tests pass.
- [ ] `plans/README.md` row for this plan is updated.

## STOP conditions

Stop and report if:

- Existing clients depend on suffix wildcard CORS and no replacement allowlist is provided.
- Fastify hijacked SSE responses cannot be tested without hanging the test runner.
- The fix requires changing auth cookies.

## Maintenance notes

If future LAN deployments need wildcard subdomains, add an explicit config option with tests, not implicit suffix matching. Reviewers should look for credentialed CORS reflection.
