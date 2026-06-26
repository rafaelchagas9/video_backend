# Plan 002: Harden remote image ingestion for creators, studios, and enrichment

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ff97b6a..HEAD -- src/modules/creators src/modules/studios src/modules/enrichment src/utils tests`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ff97b6a`, 2026-06-12

## Why this matters

The app intentionally supports "image from URL" workflows and enrichment image suggestions. Today those paths call `fetch(url)` directly and buffer the full response with `arrayBuffer()` before processing. That allows authenticated users or accepted external suggestions to make the server fetch internal network URLs and to allocate large responses before size enforcement.

## Current state

Relevant files:

- `src/modules/creators/creators.social.service.ts` - creator portrait/gallery image download and processing.
- `src/modules/studios/studios.social.service.ts` - studio profile image download and processing.
- `src/modules/enrichment/enrichment.service.ts` - applies accepted `image` suggestions via the creator/studio URL ingestion methods.
- `src/modules/creators/creators.routes.ts` and `src/modules/studios/studios.routes.ts` - public authenticated endpoints.
- `tests/integration/core-crud.integration.test.ts` or a new focused unit test file - regression tests.

Current excerpts:

```ts
// src/modules/creators/creators.social.service.ts:291
async setPictureFromUrl(creatorId: number, url: string, variant = "portrait") {
  const buffer = await this.downloadImage(url);
```

```ts
// src/modules/creators/creators.social.service.ts:623
const response = await fetch(url);
...
return Buffer.from(await response.arrayBuffer());
```

```ts
// src/modules/studios/studios.social.service.ts:93
const response = await fetch(url);
...
return Buffer.from(await response.arrayBuffer());
```

```ts
// src/modules/enrichment/enrichment.service.ts:436
await creatorsSocialService.addGalleryMediaFromUrl(creatorId, s.value, `From ${s.source}`);
```

Design context from `docs/creator-enrichment-overview.md`:

- The system proposes reviewable suggestions and accepting a suggestion reuses existing writers.
- Phase 3 explicitly calls out per-domain rate limiting and politeness hardening.

Repo conventions:

- Throw `BadRequestError`/`ValidationError` for rejected user input.
- Use Pino `logger`; no `console.log` in app code.
- Keep creator/studio service singleton exports and route schemas intact.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0, no TypeScript errors |
| Lint | `bunx eslint .` | exit 0, no lint errors |
| Focused tests | `bun test tests/remote-image-download.test.ts` or chosen focused file | all tests pass |
| Related integration | `bun test tests/integration/enrichment.integration.test.ts` | all tests pass |

## Scope

**In scope**:

- `src/modules/creators/creators.social.service.ts`
- `src/modules/studios/studios.social.service.ts`
- A shared helper under `src/utils/` if it reduces duplication
- Tests under `tests/`

**Out of scope**:

- Replacing the image processor.
- Adding a new image-search provider.
- Changing public response payloads for creator/studio routes.
- Disabling image-from-URL features entirely.

## Git workflow

- Branch suggestion: `advisor/002-remote-image-ingestion`
- Commit message style: conventional commits.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Create one shared safe image downloader

Add `src/utils/remote-image-download.ts` or equivalent. It should export a function such as `downloadRemoteImage(url: string, options?: { maxBytes?: number; timeoutMs?: number }): Promise<Buffer>`.

Required behavior:

- Parse with `new URL(url)`.
- Allow only `http:` and `https:`.
- Resolve DNS and reject private, loopback, link-local, multicast, unspecified, and localhost targets for both IPv4 and IPv6. Use Node/Bun DNS APIs; do not rely only on string matching.
- Re-check redirects: if following redirects manually is practical, validate each redirect target before fetching it. If not, use fetch redirect mode that lets you inspect redirects and STOP if Bun does not support the needed mode.
- Enforce timeout with `AbortController`.
- Check `Content-Type` starts with `image/`.
- Enforce a maximum byte count while reading the stream. Do not call `response.arrayBuffer()` without a cap. Use `Content-Length` as an early reject when present, then enforce while reading chunks.
- Keep the existing `buffer.length < 100` minimum check or equivalent.

Default `maxBytes` should be tied to existing image config. A practical default is 10 MB unless the repo already has a better constant.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 2: Replace direct fetches in creator and studio services

In `creators.social.service.ts`, replace the private `downloadImage()` body with a call to the shared helper inside the existing `imageDownloadRateLimiter.schedule(...)`, or move rate limiting into the helper if both services can reuse it cleanly.

In `studios.social.service.ts`, replace the inline fetch/arrayBuffer code with the same helper. Preserve public method names:

- `setPictureFromUrl()`
- `addGalleryMediaFromUrl()`

Preserve existing downstream calls to `processProfilePicture()` and gallery creation.

**Verify**: `bunx tsc --noEmit` -> exit 0.

### Step 3: Add downloader tests

Create `tests/remote-image-download.test.ts`. Use a local HTTP server if possible, but avoid external network.

Cover:

- Rejects `file:`, `ftp:`, and invalid URLs.
- Rejects localhost/loopback URLs.
- Rejects `Content-Type` that is not image.
- Rejects responses larger than `maxBytes`, including when `Content-Length` is absent.
- Accepts a small image-like response with `Content-Type: image/png` and returns the bytes.

If localhost rejection prevents testing an accepted response against a local server, add an injectable DNS/fetch test seam to the helper rather than weakening production checks.

**Verify**: `bun test tests/remote-image-download.test.ts` -> all tests pass.

### Step 4: Keep enrichment behavior compatible

Run the existing enrichment integration test. It mocks the enrichment client and does not need real network. If image candidates are not accepted in that test, no change may be needed; this step proves the service still compiles and existing enrichment API shape holds.

**Verify**: `bun test tests/integration/enrichment.integration.test.ts` -> exit 0.

### Step 5: Run final gates

**Verify**:

- `bunx tsc --noEmit` -> exit 0
- `bunx eslint .` -> exit 0
- `bun test tests/remote-image-download.test.ts tests/integration/enrichment.integration.test.ts` -> all pass

## Test plan

Primary new coverage belongs in `tests/remote-image-download.test.ts`, modeled after small focused unit files such as `tests/validation.test.ts`. Existing enrichment integration coverage should remain green.

## Done criteria

- [ ] No app code path uses `fetch(url)` plus unrestricted `arrayBuffer()` for remote images.
- [ ] Remote image downloads reject internal/private/loopback hosts.
- [ ] Remote image downloads enforce timeout and max bytes.
- [ ] Existing creator/studio URL endpoints keep their response shape.
- [ ] Focused downloader tests and enrichment integration tests pass.
- [ ] `plans/README.md` row for this plan is updated.

## STOP conditions

Stop and report if:

- Bun's fetch implementation prevents redirect validation without a large rewrite.
- DNS resolution APIs are not available in the runtime used by tests.
- The fix requires changing route response schemas or removing URL ingestion.
- Existing image processing expects remote images larger than the proposed cap and no product owner has approved a cap.

## Maintenance notes

Future image-search/provider work must use this helper before accepting or previewing remote assets. Reviewers should pay special attention to redirect handling and DNS/IP classification.
