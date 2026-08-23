# Plan 006: Prove fingerprint-led scene matching before production implementation

> **Executor instructions**: This is a bounded research/prototype plan, not a
> production feature implementation. Do not add catalog tables, public routes,
> background jobs, or automatic metadata application. Record evidence and stop
> at the go/no-go decision. Run every verification and update `plans/README.md`
> when complete unless a reviewer owns the index.
>
> **Drift check (run first)**:
> ```bash
> git diff --stat 9a00ff3..HEAD -- enrichment-service/api-reference enrichment-service/src enrichment-service/scripts enrichment-service/test_stashbox_exact.py src/modules/enrichment src/database/schema/videos.schema.ts docs
> git diff --stat -- enrichment-service/api-reference enrichment-service/src enrichment-service/scripts enrichment-service/test_stashbox_exact.py src/modules/enrichment src/database/schema/videos.schema.ts docs
> ```
> This plan is authored against uncommitted exact-enrichment work. Preserve it.

## Status

- **Priority**: P3
- **Effort**: L (time-boxed spike)
- **Risk**: MED
- **Depends on**: none; any production follow-up depends on `plans/005-explicit-studio-assignment-state.md`
- **Category**: direction
- **Planned at**: backend `9a00ff3` plus current enrichment work, 2026-08-23

## Why this matters

Text matching performs poorly for opaque filenames and near-identical scene
titles. Provider fingerprints could identify a scene more reliably and feed the
existing manual suggestion workflow, but the repository does not prove lookup
algorithms, endpoint behavior, duration tolerance, licensing, or rate limits.
This spike produces the evidence and design needed for a safe implementation
decision without scanning the owner's library or wiring unverified behavior into
production.

## Current state

- `enrichment-service/api-reference/README.md:109-116` records that provider
  scene objects expose `fingerprints[]` with hash, algorithm, and duration, but
  labels lookup as future work.
- Local introspection files include
  `api-reference/schemas/stashdb/Fingerprint.schema.json` and both providers'
  `Scene.schema.json`; they prove response fields, not a search input/endpoint.
- `enrichment-service/src/enrichment_service/models.py:49-58` accepts scene
  title, filename, duration, sources, and limit, but no fingerprint.
- `enrichment-service/src/enrichment_service/sources/stashbox.py:687-707`
  currently falls back to text search unless an exact external ID is supplied.
- `src/database/schema/videos.schema.ts:147-168` already stores accepted scene
  identities separately from the catalog's partial dedup `file_hash`.
- `src/modules/enrichment/enrichment.service.ts:707-815` applies accepted scene
  candidates to title/metadata, performers, studio, tags, artwork metadata, and
  external identity through explicit review. Fingerprint matches must reuse this
  inbox, never auto-apply.
- Python uses `uv`; the current regression is
  `enrichment-service/test_stashbox_exact.py` with `unittest` and
  `httpx.MockTransport`. No fingerprint/hash dependency is currently declared.

## Questions the spike must answer

1. Which configured providers accept lookup by `oshash`, `phash`, or another
   named algorithm, and through which exact REST/GraphQL request?
2. What byte/string encoding, duration unit, and tolerance does each require?
3. Are client-side computation and submission permitted by provider terms and
   algorithm/library licenses?
4. What authentication scope, rate limit, payload limit, and error semantics
   apply?
5. Can a synthetic known fixture produce a deterministic candidate without
   using personal library media?
6. How should multiple/no matches rank and appear in the existing review inbox?

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Existing Python tests | `cd enrichment-service && uv run python -m unittest test_stashbox_exact.py` | all tests pass |
| Prototype tests | `cd enrichment-service && uv run python -m unittest test_scene_fingerprint_probe.py` | all tests pass using synthetic bytes and mocked HTTP |
| Lint | `cd enrichment-service && uvx ruff check src scripts test_stashbox_exact.py test_scene_fingerprint_probe.py` | exit 0 |
| Backend safety check | `bunx tsc --noEmit && bun test tests/integration/enrichment.integration.test.ts` | unchanged production integration passes |
| Scope audit | `git diff --name-only 9a00ff3 --` | only allowed spike files plus pre-existing dirty work; no new production schema/route files |

## Scope

**In scope**:

- Read-only inspection of local API references and provider primary
  documentation/schema introspection.
- Optional authenticated provider probes using credentials already configured in
  ignored environment files; never print tokens or headers.
- A non-production CLI probe in
  `enrichment-service/scripts/probe_scene_fingerprints.py`, a mocked unittest,
  and `docs/spikes/scene-fingerprint-matching.md`.
- Synthetic media/bytes created in a temporary directory and removed after the
  run. Commit no binary fixture.

**Out of scope**:

- Any production DB/demo migration, Fastify route, model/request change,
  processing queue, Kura change, automatic acceptance, or library-wide scan.
- Reading, hashing, uploading, or naming personal media files.
- Persisting provider responses containing private data or credentials.
- Adding a third-party hashing dependency before license/maintenance review.

## Git workflow

- Backend branch: `codex/006-fingerprint-scene-spike`.
- Preserve existing enrichment dirt and stage only spike files/hunks.
- Suggested commit: `docs(enrichment): evaluate scene fingerprint matching`.
- Do not push/open a PR without instruction.

## Steps

### Step 1: Establish the evidence ledger

Create `docs/spikes/scene-fingerprint-matching.md` with sections: date/commit,
providers/configured dialects, evidence table, algorithms, exact request shapes,
duration rules, auth/rate limits, licensing/privacy, experiment results,
proposed architecture, risks, and go/no-go. Label every claim **Observed** or
**Inferred** and link/path-cite its primary source. Explicitly record unknowns;
do not turn the current response schema into assumed lookup support.

Inspect local schema samples first. Then inspect official provider docs or live
GraphQL introspection only if network access is available. Never copy secret
values into commands, logs, fixtures, or the document.

**Verify**: `rg -n "Observed|Inferred|Unknown|Go/no-go" docs/spikes/scene-fingerprint-matching.md` -> each required evidence label/section is present.

### Step 2: Time-box provider lookup discovery

For each configured provider, perform at most these three checks:

1. Search the checked-in introspection/schema for fingerprint input/filter/query.
2. Check the provider's official primary documentation/schema.
3. If credentials already work, run one bounded introspection or synthetic
   lookup request with redacted logging.

Record the exact request/response schema or record that lookup could not be
determined. Do not use community guesses as proof. If neither provider exposes a
supported lookup after the three checks, skip the computational prototype and
write a NO-GO/blocked result.

**Verify**: the evidence table has one row per provider with source, algorithm,
lookup request or `not determined`, auth, rate-limit knowledge, and confidence.

### Step 3: Build a non-production deterministic probe only after support is proven

If at least one provider lookup is documented, create
`scripts/probe_scene_fingerprints.py`. It must:

- Require an explicit `--input` path and `--algorithm`; never discover files.
- Default to local hash output only; require an explicit `--lookup --source X`
  for network access.
- Print algorithm, duration, and redacted result counts only—not input path,
  filename, token, raw response, or full provider metadata.
- Implement only the documented algorithm. Prefer a small standard-library
  implementation for OpenSubtitles hash if and only if the provider definition
  matches; otherwise stop for dependency/license review.
- Reject unsupported algorithms, too-small inputs, and duration mismatch.

Use a temporary synthetic file in tests and `httpx.MockTransport` for the exact
provider request. Do not commit media.

**Verify**: prototype unittest and Ruff commands pass; a `rg` check confirms no
credential literals or user media paths appear in new files.

### Step 4: Run one synthetic end-to-end experiment if possible

Use a provider-documented public/synthetic test vector if one exists. If none
exists, do not substitute personal media; mark end-to-end accuracy unverified.
Capture only request shape, HTTP outcome, candidate count, duration behavior,
and whether repeated calls are deterministic. Do not save raw responses.

Test: correct hash, one altered byte, incorrect duration within/outside documented
tolerance, unknown hash, authentication failure, and rate-limit response where a
mock is required. Text search remains the fallback in the proposed design.

**Verify**: the spike document contains a result row for every case and clearly
separates live-observed from mocked behavior.

### Step 5: Specify—but do not implement—the production follow-up

Document a proposed normalized table such as
`video_fingerprints(video_id, algorithm, algorithm_version, value,
duration_seconds, source_file_hash, computed_at)` with a unique key and source
revision invalidation. Specify opt-in computation, bounded concurrency/I/O,
provider lookup adapters, ranking (`fingerprint exact` above text), and manual
review through existing enrichment suggestions.

The design must include: no lookup for videos with accepted external scene ID;
no automatic metadata application; demo uses seeded synthetic candidates and no
network/media processing; source replacement invalidates fingerprints; values
are distinct from current partial dedup `file_hash`; and accepted studio links
must use the invariant introduced by plan 005.

Estimate a follow-up implementation as separate backend processing, provider,
API/review, demo, and Kura slices. Do not create that implementation plan unless
the operator accepts GO.

**Verify**: the document contains schema, lifecycle, privacy, demo, review,
fallback, invalidation, and rollout sections, each with a concrete decision.

### Step 6: Issue the go/no-go decision and restore a clean prototype boundary

Choose exactly one:

- **GO**: exact provider lookup, algorithm definition, allowed use, and at least
  mocked request compatibility are proven; remaining live limitations are named.
- **NO-GO**: lookup is absent/incompatible, licensing/privacy is unacceptable,
  or accuracy/tolerance fails.
- **BLOCKED**: a specific external fact or credential is unavailable after the
  three bounded checks; name what would unblock it.

Run existing Python and backend safety checks. Confirm no production file was
changed by this plan.

**Verify**: all commands in the table pass (or the document records why the
conditional prototype command was correctly skipped), and the decision is one
unambiguous heading.

## Test plan

- Pure deterministic hash vectors, boundary-size rejection, repeatability, and
  no path/token output.
- Exact mocked HTTP request and response mapping for each proven provider.
- Unknown hash, altered bytes, duration boundary, auth failure, rate limit, and
  malformed response.
- Existing exact external-ID and backend enrichment tests remain unchanged and pass.

## Done criteria

- [ ] Every provider has an evidence-backed lookup-support result.
- [ ] Algorithm, duration, auth, rate-limit, licensing, and privacy unknowns are explicit.
- [ ] Any probe is opt-in, path-safe, synthetic-tested, and production-disconnected.
- [ ] Live vs mocked evidence is unmistakable.
- [ ] A single GO/NO-GO/BLOCKED decision and follow-up architecture are documented.
- [ ] No production schema, route, queue, Kura, or demo behavior changed.
- [ ] Existing enrichment tests pass and `plans/README.md` is updated.

## STOP conditions

Stop the prototype and report if official/provider schemas do not prove a lookup
operation after three checks, credentials are unavailable, a personal media file
would be required, terms/license are incompatible or unclear, the algorithm
definition cannot be reproduced exactly, or network probing risks a broad scan.
Also stop if any step starts requiring production wiring or after two failed
verification attempts.

## Maintenance notes

Provider schemas and terms can drift; date every observation and retain the
exact primary-source reference. A GO authorizes a follow-up plan, not automatic
implementation. Reviewers should reject any design that treats response-side
fingerprints as proof of lookup support or bypasses manual suggestion review.
