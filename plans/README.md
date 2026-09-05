# Remaining work

Completed implementation plans are kept in Git history. Current behavior belongs
in the module schemas, services, and tests; these notes retain only unfinished
work and decisions that code cannot establish.

| Work | Status |
| --- | --- |
| [Fingerprint scene matching](006-fingerprint-scene-matching-spike.md) | BLOCKED: provider permission for fingerprint submission is unproven |
| [Vision analysis acceptance](007-vision-service-nudity-analysis-bookmarks.md) | Implementation delivered; owner/browser and accuracy acceptance still unconfirmed |
| [Collection and artwork follow-ups](../docs/collections-playlists-api-request.md) | Optional product decisions; no implementation commitment |

Previously completed plans covered selectable delegated covers, reusable edit
recipes, scan history, enrichment taxonomy navigation, and explicit studio
assignment state. Their implementations are in `video-collections`/`playlists`,
`edits`, `directories`, `tags`/`studios`, and `studios/studio-assignment.service.ts`.

Previously deferred directions remain unplanned: uploaded/composed covers,
source-revision checks for edit recipes, scan SSE/per-file progress and move-aware
reconciliation, recursive taxonomy navigation, and production fingerprint wiring.
Do not infer authorization to implement them from this index.
