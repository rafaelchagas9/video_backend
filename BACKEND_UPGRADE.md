# Backend and companion-service upgrade — October 2026

## Changes

- Updated compatible backend dependencies and transitive security patches. Removed the retired fluent-ffmpeg wrapper and its types; ffmpeg/ffprobe now run directly without a shell, with timeouts, cancellation, bounded output and child-process cleanup. The existing FFmpeg/FFprobe installation and configured VAAPI behavior are retained.
- Strict single-byte-range parsing rejects malformed, unsafe and multiple ranges, preserves suffix requests and clamps regular ranges to the existing chunk limit and file size.
- Related-video scoring aggregates each relationship before joining candidates, avoiding inflated scores from multiplied rows. Cache replacement is transactional and serialized per source. Empty results use a bounded 60-second user/source cache; forced refresh and candidate invalidation bypass/clear it. A generation check prevents an older in-flight refresh from restoring a negative entry after invalidation. Positive persisted caching retains the existing single-user behavior. Performance benefits are inferred from query structure; they were not benchmarked against the personal database.
- Test files get separate processes and disposable storage, synthetic demo data and blocked default external clients. PostgreSQL integrations use newly created disposable containers. A DEMO request-gate fallthrough was fixed, and production-only recording processing routes are explicitly blocked in demo mode.
- Vision applies payload limits to every inference route, returns a stable invalid-image error, and keeps native work admitted until completion even after repeated cancellation. The new offline test runner blocks network access, real model construction and deployment-file access.
- Enrichment reuses lifespan-owned HTTPX connection pools with bounded timeouts. Routine successful lookup/provider access logs are quiet by default; warnings and errors remain available. Its launcher uses the frozen dependency lock.

## Telemetry

The cloud request-telemetry change was already present locally. Successful request analytics stay disabled by default; failures and meaningful slow non-stream requests remain observable. Fastify routine access logs are disabled, and retained HTTP diagnostics use the application logger once. Exported application logs default to warn. Existing redaction, batching, exception capture, release metadata and opt-in source-map upload are retained.

The local ignored backend configuration had explicitly re-enabled successful request metrics; that one setting is now false. The web disables automatic clicks, page views/leaves, replay and console logging while keeping unexpected exception/rejection capture and sanitized error reporting. See [PostHog JavaScript configuration](https://posthog.com/docs/libraries/js/usage) and [exception capture](https://posthog.com/docs/error-tracking/capture).

No deployed service was restarted. Existing processes can retain their previous settings until the normal rebuild/restart. Production ingestion volume and live provider behavior have not been measured in this pass.

## Verification

- Backend typecheck, lint and production build passed; final `bun audit --json` reports no known vulnerabilities.
- 729 isolated unit tests passed, with one existing optional-fixture skip, across 135 files. The run used a private network namespace and disposable storage.
- A final cache-invalidation race regression passed with the four-test focused cache suite after the full run.
- Three recommendation integration tests passed against disposable PostgreSQL: exact many-relation scores, negative-cache refresh/invalidation, and transactional rollback on insertion failure.
- Synthetic FFmpeg smoke checks cover metadata, frame extraction and both thumbnail paths using generated temporary footage.
- A 1,000-request successful polling burst emitted no request events or logs; a following server error emitted one event and one diagnostic log.
- 103 vision tests passed through the checked-in offline runner, using fake models and synthetic image arrays. 51 enrichment tests passed with mocked transports and isolated networking.

These checks did not read or modify personal media, run personal-library migrations, contact the live database/providers, load real face/CLIP models, or deploy changes. Live GPU, broadcaster/HLS and provider authentication behavior remain outside this evidence. Existing unrelated working changes were preserved; upgrades remain local and uncommitted.
