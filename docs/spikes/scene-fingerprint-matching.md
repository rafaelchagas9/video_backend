# Scene fingerprint matching spike

## Decision: BLOCKED pending provider data-use permission

Date: 2026-08-23
Repository baseline: `9a00ff3`

This is a bounded research result. It does not add a production table, route,
queue, catalog scan, Kura behavior, or automatic metadata application. The
technical compatibility result covers staged read-only adapters using `oshash`,
but production work is blocked until authoritative provider terms or permission
explicitly allow submitting stable content fingerprints.

## Evidence ledger

| Provider or concern | Evidence | Result | Confidence |
|---|---|---|---|
| StashDB lookup | **Observed** in the official StashBox GraphQL schema: `findScenesBySceneFingerprints(fingerprints: [[FingerprintQueryInput!]!]!): [[Scene]!]!`, protected by the read role. The official Stash client sends the same query and batches 40 inputs. | Exact read request is supported. | High |
| StashDB algorithms | **Observed** in the official Stash client that lookup values may use `MD5`, `OSHASH`, and `PHASH`. Official Stash documentation defines OSHash as the OpenSubtitles hash over the first and last 64 KiB and describes pHash as 25 fixed frames. | This prototype implements only standard-library OSHash. | High |
| StashDB duration | **Observed** that `FingerprintQueryInput` contains algorithm and hash, not duration. **Unknown**: provider-side duration tolerance and whether duration participates in later candidate ranking. | Do not reject candidates by an invented tolerance. Keep local duration as review context. | High for request shape; unknown for tolerance |
| StashDB authentication | **Observed** in current repository configuration and the official client: API key authentication is sent in the `ApiKey` header. | The probe loads the ignored environment setting and never prints it. | High |
| StashDB rate limits | **Unknown**: no numeric public limit was found in the checked official schema or docs. | Treat `429` as retryable in a future bounded worker; do not retry in this probe. | Low |
| StashBox implementation license | **Observed**: `stashapp/stash-box` is published under the MIT license. **Inferred**: reproducing the documented OpenSubtitles hash with Python's standard library adds no third-party runtime dependency. | Dependency/license risk is low for the prototype. Provider data terms still require normal product review before public distribution. | Medium |
| ThePornDB lookup | **Observed** locally that its scene response schema exposes fingerprints. **Observed live** on 2026-08-23: its configured GraphQL endpoint accepted the same `findScenesBySceneFingerprints` request with `OSHASH` and Bearer authentication, returning an empty candidate batch without GraphQL errors. | Exact read request compatibility is supported for the tested algorithm. | High for request compatibility; unknown for match accuracy |
| Existing catalog hash | **Observed** in `src/database/schema/videos.schema.ts`: `file_hash` is catalog/dedup state, not a provider fingerprint with algorithm/version semantics. | Never overload it. | High |
| Review workflow | **Observed** in `src/modules/enrichment/enrichment.service.ts`: accepted scene suggestions already pass through explicit review and can apply related metadata. | Fingerprint lookup must feed suggestions and must never auto-apply. | High |

Primary sources:

- [Official StashBox GraphQL schema](https://github.com/stashapp/stash-box/blob/master/graphql/schema/schema.graphql)
- [Official Stash scene lookup client](https://github.com/stashapp/stash/blob/develop/pkg/stashbox/scene.go)
- [Official generated GraphQL client](https://github.com/stashapp/stash/blob/develop/pkg/stashbox/graphql/generated_client.go)
- [Stash hashing configuration](https://docs.stashapp.cc/in-app-manual/configuration/#hashing-algorithms)
- [Stash scene tagger](https://docs.stashapp.cc/in-app-manual/tagger/)
- [Stash duplicate detection](https://docs.stashapp.cc/in-app-manual/deduplication/)
- [StashBox source and MIT license](https://github.com/stashapp/stash-box)

## Exact request shape

**Observed** StashDB request:

```graphql
query FindScenesBySceneFingerprints(
  $fingerprints: [[FingerprintQueryInput!]!]!
) {
  findScenesBySceneFingerprints(fingerprints: $fingerprints) {
    id
    title
    duration
  }
}
```

One video with one OSHash is encoded as:

```json
{
  "fingerprints": [
    [{ "algorithm": "OSHASH", "hash": "0123456789abcdef" }]
  ]
}
```

The outer result position corresponds to the outer input position and may
contain zero, one, or multiple scenes. Multiple scenes are therefore a normal
review condition, not an error. The prototype sends `ApiKey` for StashDB and
`Authorization: Bearer` for the configured ThePornDB dialect. It logs neither
headers nor raw responses.

## Algorithm and duration rules

**Observed** OSHash is a 64-bit unsigned sum of the file size and little-endian
64-bit words from the first and last 65,536 bytes, rendered as 16 lowercase hex
characters. Inputs smaller than 131,072 bytes are rejected. The local probe is
deterministic and changes when a covered boundary byte changes.

**Observed** the lookup input has no duration field. **Unknown** provider-side
duration tolerance means the requested within/outside-tolerance experiment is
not applicable to this API. The optional CLI duration is printed only as local
review context. A production follow-up must not invent a threshold; it may rank
provider-returned duration differences for human review after measuring real
data.

PHASH and MD5 are intentionally excluded from this prototype. PHASH would add
video decoding, sampling, CPU cost, and a library/license decision; MD5 requires
reading the entire file and duplicates neither the current partial catalog hash
nor OSHash's bounded I/O characteristics.

## Privacy and operational boundary

**Observed** a lookup sends a stable content-derived identifier to an external
metadata service. Although it is not the video or its path, it can reveal that
the caller possesses matching content. Production computation and lookup must
therefore be explicit opt-ins, documented per provider, limited to selected
videos, and disabled in demo mode.

The probe requires an explicit `--input`; it never discovers directories. It
defaults to local hashing and needs both `--lookup` and `--source` for network
access. It prints only algorithm, hash, optional duration, provider name, and
candidate count. No path, title, API key, header, raw body, or candidate data is
persisted.

## Experiment results

| Case | Evidence mode | Result |
|---|---|---|
| Repeat the same synthetic bytes | Local unittest | **Observed** deterministic 16-character OSHash. |
| Change one covered byte | Local unittest | **Observed** hash changes. |
| Input below 128 KiB | Local unittest | **Observed** rejected before lookup. |
| Exact GraphQL variables and auth header | `httpx.MockTransport` | **Observed** nested input and uppercase `OSHASH`; first result batch is returned. |
| Unknown hash | `httpx.MockTransport` | **Observed** empty candidate list. |
| GraphQL error | `httpx.MockTransport` | **Observed** safe `RuntimeError`; raw errors are not printed. |
| HTTP 401 | `httpx.MockTransport` | **Observed** surfaced as `HTTPStatusError`. |
| HTTP 429 | `httpx.MockTransport` | **Observed** surfaced without an implicit retry. |
| Malformed response | `httpx.MockTransport` | **Observed** rejected instead of being mistaken for no match. |
| Duration within/outside tolerance | Provider input inspection | **Unknown/not applicable** because the lookup accepts no duration. |
| Public known-match fixture | Official docs search | **Unknown**: no provider-documented fixture was found. Personal media was not substituted. |
| Live StashDB lookup | Authorized bounded request, 2026-08-23 | **Observed** HTTP success and `candidate_count=0` for one explicitly approved storyboard-derived OSHash. No raw response or credential was retained. |
| Live ThePornDB lookup | Authorized bounded request, 2026-08-23 | **Observed** HTTP success and `candidate_count=0` for the same OSHash using Bearer authentication. No raw response or credential was retained. |

Both calls were repeated only once per provider. They prove request
compatibility, not match accuracy, positive-result mapping, duration behavior,
rate limits, or provider-specific transient-error behavior.

## Proposed production architecture

### Persistence

Add a dedicated normalized table in a follow-up migration:

```text
video_fingerprints(
  video_id,
  algorithm,
  algorithm_version,
  value,
  duration_seconds,
  source_file_hash,
  computed_at,
  UNIQUE(video_id, algorithm, algorithm_version)
)
```

`source_file_hash` is an invalidation marker for the exact catalog source
revision, not the provider fingerprint itself. Replacing or materially changing
the source invalidates all derived fingerprints before any further lookup.

### Lifecycle and I/O

1. The user explicitly selects videos and enables one provider.
2. A worker reads only the OSHash boundary blocks with bounded concurrency and
   storage-aware throttling.
3. It stores algorithm/version provenance, then submits the selected
   fingerprints in one batched provider lookup. It never submits unselected or
   library-wide fingerprints and never applies returned metadata automatically.
4. Videos with an already accepted external scene ID are skipped.
5. Failed/unknown lookups retain text search as the fallback.

Cancellation, per-provider backoff, `429` handling, and a visible job summary
are required before production. No library-wide implicit scan is acceptable.

### Ranking and review

An exact fingerprint result ranks above text candidates but creates ordinary
enrichment suggestions. Zero matches fall back to text. Multiple matches remain
separate candidates with duration differences and provider provenance visible.
Nothing is applied automatically. Accepted studio relationships must go through
the canonical assignment invariant delivered by Plan 005 rather than writing a
legacy scalar independently.

### Demo behavior

Demo mode seeds synthetic fingerprints and deterministic zero/one/multiple
candidate examples. It performs no filesystem reads, hashing, provider calls,
background media work, or credential access. Reset restores the same synthetic
state.

### Follow-up slices

1. Backend persistence and source-revision invalidation migration.
2. Opt-in bounded OSHash worker with cancellation and observability.
3. StashDB and ThePornDB lookup adapters, batching, error/backoff policy, and
   fixture-backed contract tests.
4. API and existing enrichment-inbox integration with exact/manual ranking.
5. Demo-only deterministic repository and reset coverage.
6. Kura selection, progress, results, and review UI.
7. Recheck both live schemas and usage policies immediately before rollout.

## Risks and open questions

- **Unknown** numeric rate limits, retention policy, and provider-side duration
  matching behavior.
- **Unknown** live accuracy without a provider-documented public fixture.
- **Unknown** positive-match accuracy for both providers; the authorized probe
  intentionally used a non-video artifact and returned no candidate.
- OSHash collisions and multiple provider candidates require manual review.
- Boundary reads can still pressure remote/network storage without throttling.
- Stable fingerprints are sensitive metadata even though they are not paths or
  media bytes.
- Provider schemas and policies can drift; contract checks must be dated and
  rerun before implementation.

## Blocked rationale

**BLOCKED** for production implementation. The official StashBox schema proves
a read-only exact lookup, the official Stash client proves the algorithm names
and request behavior, the hash definition is reproducible without a dependency,
mocked compatibility is deterministic, and both configured endpoints accepted
one authorized bounded request. Those results prove technical compatibility,
not permission to submit or retain stable content fingerprints. Unblock only
after authoritative provider terms or explicit provider permission cover that
data use; then retain manual review, bounded I/O, no automatic application,
privacy disclosure, and a fresh rate-limit review.
