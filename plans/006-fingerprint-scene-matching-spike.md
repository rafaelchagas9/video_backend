# Fingerprint scene matching: blocked follow-up

Status: **BLOCKED**. The completed spike proved OSHash request compatibility but
not provider permission to submit or retain stable content fingerprints, or
positive-match accuracy. See the dated
[evidence ledger and proposed architecture](../docs/spikes/scene-fingerprint-matching.md).

Before production implementation:

1. Establish authoritative provider data-use terms or explicit permission for
   the intended fingerprint submission and retention.
2. Recheck both provider schemas, authentication, rate limits, and failure modes.
3. Find an approved known-match fixture and measure positive, empty, ambiguous,
   and failed results. Do not infer accuracy from the spike's empty responses.
4. Plan explicit opt-in, selected-video hashing, bounded I/O, cancellation,
   backoff, source-revision invalidation, and manual suggestion review.
5. Route accepted studio links through the existing
   [studio assignment service](../src/modules/studios/studio-assignment.service.ts).
6. Keep demo behavior synthetic with no provider calls, credentials, or personal
   media reads.

The probe remains a research tool, not a production queue or scan hook. Its
historical execution instructions are retained in Git history. No automatic
library-wide fingerprinting or metadata application is authorized by this note.
