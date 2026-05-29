# API Route Inventory

This document is the Phase 1 inventory for the API normalization effort.

Snapshot date: 2026-05-29

Current route count identified in `src/modules/*/*.routes.ts`: `221`

## Classification labels

- `canonical`: primary resource endpoint shape we want to preserve
- `convenience`: acceptable helper/scoped endpoint that should share a canonical contract
- `action`: command-style endpoint that likely needs normalization or explicit justification
- `duplicate`: overlapping endpoint shape that appears to model the same concept in more than one place
- `legacy`: endpoint shape that should likely be deprecated after replacement exists

## Registration map

Visible resource roots in `src/server.ts`:

- `/auth`
- `/directories`
- `/videos`
- `/creators`
- `/studios`
- `/tags`
- `/ratings`
- `/thumbnails`
- `/playlists`
- `/video-collections`
- `/favorites`
- `/bookmarks`
- `/backup`
- `/conversions`
- `/triage`
- `/users`
- `/settings`
- `/stats`
- `/events`
- `/tagging-rules`
- `/multiplayer-remote`

Root-mounted modules with hidden public routes:

- `faceRecognitionRoutes`

This module is still mounted at `"/"` and exposes routes under other public roots, which obscures ownership and makes the route surface harder to audit.

Legacy roots still present for compatibility:

- `/users` for deprecated triage aliases

## Inventory by canonical resource root

## Auth

Paths:

- `POST /auth/register` -> `canonical`
- `POST /auth/login` -> `canonical`
- `POST /auth/logout` -> `canonical`
- `GET /auth/me` -> `canonical`
- `GET|POST /auth/*` -> `legacy`

Notes:

- The explicit auth endpoints are clean.
- The catch-all Better Auth passthrough is functional but should be treated as infrastructure, not a public product surface.

## Directories

Paths:

- `POST /directories`
- `GET /directories`
- `GET /directories/:id`
- `PATCH /directories/:id`
- `DELETE /directories/:id`
  Classification: `canonical`
- `POST /directories/:id/scan` -> `action`
- `GET /directories/:id/stats` -> `convenience`

Notes:

- Mostly consistent CRUD plus one operational action endpoint.

## Videos

Paths:

- `GET /videos` -> `canonical`
- `GET /videos/:id` -> `canonical`
- `PATCH /videos/:id` -> `canonical`
- `DELETE /videos/:id` -> `canonical`
- `GET /videos/:id/creators` -> `canonical`
- `POST /videos/:id/creators` -> `canonical`
- `DELETE /videos/:id/creators/:creator_id` -> `canonical`
- `GET /videos/:id/tags` -> `canonical`
- `POST /videos/:id/tags` -> `canonical`
- `DELETE /videos/:id/tags/:tag_id` -> `canonical`
- `GET /videos/:id/studios` -> `canonical`
- `POST /videos/:id/studios/:studio_id` -> `canonical`
- `DELETE /videos/:id/studios/:studio_id` -> `canonical`
- `GET /videos/:id/metadata` -> `canonical`
- `POST /videos/:id/metadata` -> `canonical`
- `DELETE /videos/:id/metadata/:key` -> `canonical`
- `GET /videos/:id/ratings` -> `canonical`
- `POST /videos/:id/ratings` -> `canonical`
- `GET /videos/:id/bookmarks` -> `canonical`
- `POST /videos/:id/bookmarks` -> `canonical`

Specialized but valid helpers:

- `GET /videos/random` -> `convenience`
- `GET /videos/:id/related` -> `convenience`
- `GET /videos/compression-suggestions` -> `convenience`
- `GET /videos/duplicates` -> `convenience`
- `GET /videos/:id/stream` -> `convenience`

Action-heavy endpoints to normalize or justify:

- `GET /videos/next` -> `action`
- `GET /videos/triage-queue` -> `action`
- `POST /videos/bulk/delete` -> `action`
- `POST /videos/bulk/creators` -> `action`
- `POST /videos/bulk/tags` -> `action`
- `POST /videos/bulk/studios` -> `action`
- `POST /videos/bulk/favorites` -> `action`
- `POST /videos/bulk/conditional-apply` -> `action`
- `POST /videos/:id/verify` -> `action`
- `POST /videos/:id/refresh` -> `action`

Notes:

- `/videos` is the canonical video collection contract.
- This root contains many workflow helpers that are useful but make the surface feel RPC-heavy.

## Creators

Paths:

- `GET /creators`
- `GET /creators/:id`
- `POST /creators`
- `PATCH /creators/:id`
- `DELETE /creators/:id`
  Classification: `canonical`

Relationship/scoped endpoints:

- `GET /creators/:id/videos` -> `convenience`
- `GET /creators/:id/platforms` -> `canonical`
- `POST /creators/:id/platforms` -> `canonical`
- `PATCH /creators/:id/platforms/:platformId` -> `canonical`
- `DELETE /creators/:id/platforms/:platformId` -> `canonical`
- `GET /creators/:id/social-links` -> `canonical`
- `POST /creators/:id/social-links` -> `canonical`
- `PATCH /creators/:id/social-links/:linkId` -> `canonical`
- `DELETE /creators/:id/social-links/:linkId` -> `canonical`
- `GET /creators/:id/studios` -> `canonical`
- `POST /creators/:id/studios/:studioId` -> `canonical`
- `DELETE /creators/:id/studios/:studioId` -> `canonical`

Action-style endpoints:

- `POST /creators/bulk` -> `action`
- `POST /creators/:id/platforms/bulk` -> `action`
- `POST /creators/:id/social-links/bulk` -> `action`
- `POST /creators/:id/picture` -> `action`
- `DELETE /creators/:id/picture` -> `action`
- `POST /creators/:id/picture-from-url` -> `action`
- `GET /creators/autocomplete` -> `convenience`
- `GET /creators/recent` -> `convenience`
- `POST /creators/quick-create` -> `action`

Notes:

- `GET /creators/:id/videos` overlaps conceptually with filtered `GET /videos`.
- This endpoint family should remain but must use the same video contract as `/videos`.

## Studios

Paths:

- `GET /studios`
- `GET /studios/:id`
- `POST /studios`
- `PATCH /studios/:id`
- `DELETE /studios/:id`
  Classification: `canonical`

Relationship/scoped endpoints:

- `GET /studios/:id/videos` -> `convenience`
- `POST /studios/:id/videos/:videoId` -> `canonical`
- `DELETE /studios/:id/videos/:videoId` -> `canonical`
- `GET /studios/:id/creators` -> `canonical`
- `POST /studios/:id/creators/:creatorId` -> `canonical`
- `DELETE /studios/:id/creators/:creatorId` -> `canonical`
- `GET /studios/:id/social-links` -> `canonical`
- `POST /studios/:id/social-links` -> `canonical`
- `PATCH /studios/:id/social-links/:linkId` -> `canonical`
- `DELETE /studios/:id/social-links/:linkId` -> `canonical`

Action-style endpoints:

- `POST /studios/bulk` -> `action`
- `POST /studios/:id/creators/bulk` -> `action`
- `POST /studios/:id/social-links/bulk` -> `action`
- `POST /studios/:id/picture` -> `action`
- `DELETE /studios/:id/picture` -> `action`
- `POST /studios/:id/picture-from-url` -> `action`
- `GET /studios/autocomplete` -> `convenience`
- `GET /studios/recent` -> `convenience`
- `POST /studios/quick-create` -> `action`

Notes:

- `GET /studios/:id/videos` is another relationship-scoped video list that should share the `/videos` contract.

## Tags

Paths:

- `GET /tags`
- `GET /tags/:id`
- `POST /tags`
- `PATCH /tags/:id`
- `DELETE /tags/:id`
  Classification: `canonical`

Relationship/scoped endpoints:

- `GET /tags/:id/children` -> `canonical`
- `GET /tags/:id/videos` -> `convenience`

Notes:

- `GET /tags/:id/videos` is the third scoped video list variant that needs contract parity with `/videos`.

## Tagging rules

Paths:

- `GET /tagging-rules`
- `GET /tagging-rules/:id`
- `POST /tagging-rules`
- `PATCH /tagging-rules/:id`
- `DELETE /tagging-rules/:id`
  Classification: `canonical`

Action-style endpoints:

- `POST /tagging-rules/bulk/delete` -> `action`
- `POST /tagging-rules/:id/test` -> `action`
- `POST /tagging-rules/apply` -> `action`

## Ratings

Paths:

- `PATCH /ratings/:id` -> `duplicate`
- `DELETE /ratings/:id` -> `duplicate`

Notes:

- Ratings are created under `/videos/:id/ratings` and mutated under `/ratings/:id`.
- This split is acceptable if documented, but it is still a cross-root resource lifecycle that clients must remember.

## Bookmarks

Paths:

- `PATCH /bookmarks/:id` -> `duplicate`
- `DELETE /bookmarks/:id` -> `duplicate`

Notes:

- Bookmarks are created/listed under `/videos/:id/bookmarks` and mutated under `/bookmarks/:id`.
- Same fragmentation pattern as ratings.

## Favorites

Paths:

- `GET /favorites` -> `canonical`
- `POST /favorites` -> `canonical`
- `DELETE /favorites/:video_id` -> `canonical`
- `GET /favorites/:video_id/check` -> `convenience`

Notes:

- `check` is a helper endpoint that could be replaced by richer favorite representations if desired.

## Playlists

Paths:

- `POST /playlists`
- `GET /playlists`
- `GET /playlists/:id`
- `PATCH /playlists/:id`
- `DELETE /playlists/:id`
  Classification: `canonical`

Relationship/scoped endpoints:

- `GET /playlists/:id/videos` -> `canonical`
- `POST /playlists/:id/videos` -> `canonical`
- `DELETE /playlists/:id/videos/:video_id` -> `canonical`

Action-style endpoints:

- `POST /playlists/:id/videos/bulk` -> `action`
- `PATCH /playlists/:id/videos/reorder` -> `action`

## Video collections

Paths:

- `GET /video-collections`
- `POST /video-collections`
- `GET /video-collections/:id`
- `PATCH /video-collections/:id`
- `DELETE /video-collections/:id`
  Classification: `canonical`

Relationship/scoped endpoints:

- `GET /video-collections/:id/entries` -> `canonical`
- `POST /video-collections/:id/entries` -> `canonical`
- `DELETE /video-collections/:id/entries/:video_id` -> `canonical`

Action-style endpoints:

- `PATCH /video-collections/:id/entries/reorder` -> `action`

## Backup

Paths:

- `POST /backup` -> `action`
- `GET /backup` -> `canonical`
- `GET /backup/export` -> `action`
- `POST /backup/:filename/restore` -> `action`
- `DELETE /backup/:filename` -> `canonical`

Notes:

- This module is intentionally operational rather than REST-pure.

## Conversions

Paths:

- `GET /videos/:id/conversions` -> `canonical`
- `GET /conversions/:id` -> `canonical`
- `DELETE /conversions/:id` -> `canonical`
- `GET /conversions/:id/download` -> `convenience`
- `GET /conversions/history` -> `convenience`
- `GET /conversions/history/overview` -> `convenience`
- `GET /conversions/active` -> `convenience`

Fragmented/legacy action shapes:

- `POST /videos/:id/convert` -> `legacy`
- `POST /videos/convert/bulk` -> `legacy`
- `GET /videos/convert/queue` -> `legacy`
- `GET /conversion/status` -> `legacy`
- `POST /conversions/:id/cancel` -> `legacy`
- `POST /conversions/queue/clear` -> `legacy`
- `GET /presets` -> `legacy`

Notes:

- This is the most fragmented feature group in the API.
- It mixes `/videos/*`, `/conversions/*`, `/conversion/*`, and `/presets`.

## Triage

Paths:

- `POST /users/triage-progress` -> `legacy`
- `GET /users/triage-progress` -> `legacy`
- `POST /users/triage/bulk-actions` -> `action`
- `GET /users/triage/statistics` -> `legacy`

Notes:

- The `/users` prefix is misleading because there is no user id in the path and all work is implicitly scoped to `request.user`.

## Video stats

Paths:

- `POST /videos/:id/watch` -> `action`
- `GET /videos/:id/stats` -> `convenience`

Notes:

- This module is semantically coherent, but it is still more command-oriented than pure CRUD.

## Stats

Paths:

- `GET /stats/storage` -> `canonical`
- `GET /stats/storage/history` -> `convenience`
- `POST /stats/storage/snapshot` -> `duplicate`
- `GET /stats/library` -> `canonical`
- `GET /stats/library/history` -> `convenience`
- `POST /stats/library/snapshot` -> `duplicate`
- `GET /stats/content` -> `canonical`
- `GET /stats/content/history` -> `convenience`
- `POST /stats/content/snapshot` -> `duplicate`
- `GET /stats/usage` -> `canonical`
- `GET /stats/usage/history` -> `convenience`
- `POST /stats/usage/snapshot` -> `duplicate`
- `POST /stats/snapshot` -> `duplicate`

Notes:

- Snapshot creation is exposed in five overlapping shapes.

## Thumbnails

Paths:

- `POST /videos/:id/thumbnails` -> `canonical`
- `GET /videos/:id/thumbnails` -> `canonical`
- `GET /thumbnails/:id/image` -> `legacy`
- `DELETE /thumbnails/:id` -> `canonical`

Notes:

- This module splits metadata/listing under `/videos/:id/thumbnails` from file serving under `/thumbnails/:id/image`.

## Storyboards

Paths:

- `GET /videos/:id/storyboard` -> `canonical`
- `POST /videos/:id/storyboard` -> `action`
- `DELETE /videos/:id/storyboard` -> `canonical`
- `GET /videos/:id/thumbnails.vtt` -> `legacy`
- `GET /videos/:id/storyboard.jpg` -> `legacy`
- `GET /videos/:id/storyboard.webp` -> `legacy`

Notes:

- Binary assets are exposed as file-like routes rather than through canonical resource links.

## Face recognition

Paths:

- `POST /creators/:id/face-embeddings` -> `canonical`
- `POST /creators/:id/face-embeddings/base64` -> `action`
- `GET /creators/:id/face-embeddings` -> `canonical`
- `PUT /creators/:id/face-embeddings/:eid/primary` -> `action`
- `DELETE /creators/:id/face-embeddings/:eid` -> `canonical`
- `GET /videos/:id/faces` -> `canonical`
- `POST /videos/:id/faces/extract` -> `action`
- `PUT /videos/:id/faces/:did/confirm` -> `action`
- `PUT /videos/:id/faces/:did/reject` -> `action`
- `GET /videos/:id/faces/status` -> `convenience`
- `GET /creators/:id/videos-by-face` -> `convenience`
- `POST /faces/search` -> `action`
- `DELETE /faces/queue` -> `action`
- `GET /faces/health` -> `convenience`

Notes:

- This module is operationally coherent but heavily action-oriented.

## Edits

Paths:

- `GET /videos/:id/editing-metadata` -> `convenience`
- `POST /videos/:id/edits` -> `canonical`
- `GET /edits/jobs/:id` -> `canonical`
- `POST /edits/jobs/:id/cancel` -> `legacy`

Notes:

- Job cancellation should likely align with the same pattern chosen for conversions.

## Events

Paths:

- `GET /events/stream` -> `canonical`

## Multiplayer remote

Paths:

- `POST /multiplayer-remote/display-devices`
- `POST /multiplayer-remote/sessions`
- `GET /multiplayer-remote/sessions/:id`
- `POST /multiplayer-remote/sessions/:id/close`
- `POST /multiplayer-remote/pair`
- `POST /multiplayer-remote/trusted-devices/discover`
- `POST /multiplayer-remote/sessions/:id/trusted-connect`
- `GET /multiplayer-remote/sessions/:id/join-requests/pending`
- `POST /multiplayer-remote/sessions/:id/join-requests/:requestId/approve`
- `POST /multiplayer-remote/sessions/:id/join-requests/:requestId/reject`
  Classification: mostly `action`

Notes:

- This module is workflow-oriented and may remain intentionally command-heavy.

## Settings

Paths:

- `GET /settings` -> `canonical`
- `PATCH /settings` -> `canonical`

## Key Phase 1 findings

### Root-mounted ownership problems

The following modules expose public routes that are not obvious from registration:

- face recognition

### Video list fragmentation

These endpoints all return videos and should share one contract:

- `GET /videos`
- `GET /creators/:id/videos`
- `GET /tags/:id/videos`
- `GET /studios/:id/videos`

Current issue:

- they do not clearly behave as one contract family, and at least one scoped endpoint is known to miss fields such as thumbnail URLs

### Query-based canonical collection candidates

These routes overlap strongly with queryable canonical collections:

- `GET /creators/:id/videos` -> candidate alias over `GET /videos`
- `GET /tags/:id/videos` -> candidate alias over `GET /videos`
- `GET /studios/:id/videos` -> candidate alias over `GET /videos`
- `GET /favorites/:video_id/check` -> candidate for removal if favorite state is always present in standard video/favorite responses

### Highest-fragmentation feature groups

- conversions
- triage
- stats snapshot creation
- thumbnail/storyboard asset delivery
- ratings/bookmarks split-lifecycle endpoints
