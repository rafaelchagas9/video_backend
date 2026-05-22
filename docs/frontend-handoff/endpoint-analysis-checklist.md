# Endpoint Analysis Checklist

Use this checklist as the single progress tracker while we document each endpoint in detail. Mark items as completed as soon as the endpoint artifact is done.

## How to use

- Pick one endpoint at a time.
- Create/update its dedicated doc artifact (request, response, errors, edge cases, UI notes).
- Mark that endpoint as done in this file.
- Add date/owner/notes when useful so work can resume easily.

Suggested status format:

- `[ ]` Not started
- `[-]` In progress
- `[x]` Completed

---

## Progress metadata

- Last updated: 2026-05-16
- Current owner: frontend/backend docs team
- Current focus endpoint: documentation sweep complete
- Notes for next session: Endpoint coverage complete. Optional next work is a cross-cutting frontend API client conventions/refactor guide.

---

## Global standards checklist (apply to every endpoint)

- [ ] Request contract documented (params, query, body, headers)
- [ ] Response contract documented (success + all relevant errors)
- [ ] Auth requirements documented (public/authenticated)
- [ ] Content type documented (JSON, stream, file download, multipart, SSE)
- [ ] Frontend UX behavior documented (loading/empty/retry/error states)
- [ ] Realtime impacts documented (SSE events and state updates)
- [ ] Edge cases and constraints documented
- [ ] Example request/response added

---

## Auth

- [x] POST /api/auth/register
- [x] POST /api/auth/login
- [x] POST /api/auth/logout
- [x] GET /api/auth/me

## Events (SSE)

- [x] GET /api/events/stream

## Directories

- [x] POST /api/directories
- [x] GET /api/directories
- [x] GET /api/directories/:id
- [x] PATCH /api/directories/:id
- [x] DELETE /api/directories/:id
- [x] POST /api/directories/:id/scan
- [x] GET /api/directories/:id/stats

## Settings

- [x] GET /api/settings
- [x] PATCH /api/settings

## Videos

- [x] GET /api/videos
- [x] GET /api/videos/compression-suggestions
- [x] GET /api/videos/next
- [x] GET /api/videos/triage-queue
- [x] POST /api/videos/bulk/delete
- [x] POST /api/videos/bulk/creators
- [x] POST /api/videos/bulk/tags
- [x] POST /api/videos/bulk/studios
- [x] POST /api/videos/bulk/favorites
- [x] POST /api/videos/bulk/conditional-apply
- [x] GET /api/videos/random
- [x] GET /api/videos/duplicates
- [x] GET /api/videos/:id
- [x] PATCH /api/videos/:id
- [x] DELETE /api/videos/:id
- [x] POST /api/videos/:id/verify
- [x] POST /api/videos/:id/refresh
- [x] GET /api/videos/:id/stream
- [x] GET /api/videos/:id/creators
- [x] POST /api/videos/:id/creators
- [x] DELETE /api/videos/:id/creators/:creator_id
- [x] GET /api/videos/:id/tags
- [x] POST /api/videos/:id/tags
- [x] DELETE /api/videos/:id/tags/:tag_id
- [x] GET /api/videos/:id/metadata
- [x] POST /api/videos/:id/metadata
- [x] DELETE /api/videos/:id/metadata/:key
- [x] GET /api/videos/:id/ratings
- [x] POST /api/videos/:id/ratings
- [x] GET /api/videos/:id/bookmarks
- [x] POST /api/videos/:id/bookmarks
- [x] GET /api/videos/:id/studios
- [x] POST /api/videos/:id/studios/:studio_id
- [x] DELETE /api/videos/:id/studios/:studio_id

## Creators

- [x] GET /api/creators
- [x] GET /api/creators/:id
- [x] POST /api/creators
- [x] POST /api/creators/bulk
- [x] PATCH /api/creators/:id
- [x] DELETE /api/creators/:id
- [x] GET /api/creators/:id/videos
- [x] POST /api/creators/:id/picture
- [x] GET /api/creators/:id/picture
- [x] DELETE /api/creators/:id/picture
- [x] POST /api/creators/:id/platforms
- [x] GET /api/creators/:id/platforms
- [x] PATCH /api/creators/:id/platforms/:platformId
- [x] DELETE /api/creators/:id/platforms/:platformId
- [x] POST /api/creators/:id/social-links
- [x] POST /api/creators/:id/platforms/bulk
- [x] POST /api/creators/:id/social-links/bulk
- [x] POST /api/creators/:id/picture-from-url
- [x] GET /api/creators/:id/social-links
- [x] PATCH /api/creators/:id/social-links/:linkId
- [x] DELETE /api/creators/:id/social-links/:linkId
- [x] POST /api/creators/:id/studios/:studioId
- [x] GET /api/creators/:id/studios
- [x] DELETE /api/creators/:id/studios/:studioId
- [x] GET /api/creators/autocomplete
- [x] GET /api/creators/recent
- [x] POST /api/creators/quick-create

## Studios

- [x] GET /api/studios
- [x] GET /api/studios/:id
- [x] POST /api/studios
- [x] POST /api/studios/bulk
- [x] PATCH /api/studios/:id
- [x] DELETE /api/studios/:id
- [x] POST /api/studios/:id/picture
- [x] GET /api/studios/:id/picture
- [x] DELETE /api/studios/:id/picture
- [x] POST /api/studios/:id/social-links
- [x] POST /api/studios/:id/social-links/bulk
- [x] POST /api/studios/:id/picture-from-url
- [x] GET /api/studios/:id/social-links
- [x] PATCH /api/studios/:id/social-links/:linkId
- [x] DELETE /api/studios/:id/social-links/:linkId
- [x] POST /api/studios/:id/creators/bulk
- [x] POST /api/studios/:id/creators/:creatorId
- [x] GET /api/studios/:id/creators
- [x] DELETE /api/studios/:id/creators/:creatorId
- [x] POST /api/studios/:id/videos/:videoId
- [x] GET /api/studios/:id/videos
- [x] DELETE /api/studios/:id/videos/:videoId
- [x] GET /api/studios/autocomplete
- [x] GET /api/studios/recent
- [x] POST /api/studios/quick-create

## Tags

- [x] GET /api/tags
- [x] GET /api/tags/:id
- [x] POST /api/tags
- [x] PATCH /api/tags/:id
- [x] DELETE /api/tags/:id
- [x] GET /api/tags/:id/children
- [x] GET /api/tags/:id/videos

## Tagging Rules

- [x] GET /api/tagging-rules
- [x] GET /api/tagging-rules/:id
- [x] POST /api/tagging-rules
- [x] PATCH /api/tagging-rules/:id
- [x] DELETE /api/tagging-rules/:id
- [x] POST /api/tagging-rules/bulk/delete
- [x] POST /api/tagging-rules/:id/test
- [x] POST /api/tagging-rules/apply

## Ratings

- [x] PATCH /api/ratings/:id
- [x] DELETE /api/ratings/:id

## Bookmarks

- [x] PATCH /api/bookmarks/:id
- [x] DELETE /api/bookmarks/:id

## Favorites

- [x] GET /api/favorites
- [x] POST /api/favorites
- [x] DELETE /api/favorites/:video_id
- [x] GET /api/favorites/:video_id/check

## Playlists

- [x] POST /api/playlists
- [x] GET /api/playlists
- [x] GET /api/playlists/:id
- [x] PATCH /api/playlists/:id
- [x] DELETE /api/playlists/:id
- [x] GET /api/playlists/:id/videos
- [x] POST /api/playlists/:id/videos/bulk
- [x] POST /api/playlists/:id/videos
- [x] DELETE /api/playlists/:id/videos/:video_id
- [x] PATCH /api/playlists/:id/videos/reorder

## Thumbnails

- [x] POST /api/videos/:id/thumbnails
- [x] GET /api/videos/:id/thumbnails
- [x] GET /api/thumbnails/:id/image
- [x] DELETE /api/thumbnails/:id

## Storyboards

- [x] GET /api/videos/:id/thumbnails.vtt
- [x] GET /api/videos/:id/storyboard.jpg
- [x] GET /api/videos/:id/storyboard.webp
- [x] POST /api/videos/:id/storyboard
- [x] DELETE /api/videos/:id/storyboard
- [x] GET /api/videos/:id/storyboard

## Face Recognition

- [x] GET /api/faces/health
- [x] POST /api/creators/:id/face-embeddings
- [x] POST /api/creators/:id/face-embeddings/base64
- [x] GET /api/creators/:id/face-embeddings
- [x] PUT /api/creators/:id/face-embeddings/:eid/primary
- [x] DELETE /api/creators/:id/face-embeddings/:eid
- [x] GET /api/creators/:id/face-embeddings/:eid/thumbnail
- [x] GET /api/videos/:id/faces
- [x] GET /api/faces/:id/image
- [x] POST /api/videos/:id/faces/extract
- [x] PUT /api/videos/:id/faces/:did/confirm
- [x] PUT /api/videos/:id/faces/:did/reject
- [x] GET /api/creators/:id/videos-by-face
- [x] POST /api/faces/search
- [x] GET /api/videos/:id/faces/status
- [x] DELETE /api/faces/queue

## Conversion

- [x] POST /api/videos/:id/convert
- [x] POST /api/videos/convert/bulk
- [x] GET /api/videos/convert/queue
- [x] GET /api/videos/:id/conversions
- [x] GET /api/conversions/history
- [x] GET /api/conversions/history/overview
- [x] GET /api/conversions/:id
- [x] POST /api/conversions/:id/cancel
- [x] DELETE /api/conversions/:id
- [x] GET /api/conversions/:id/download
- [x] GET /api/presets
- [x] GET /api/conversion/status
- [x] GET /api/conversions/active
- [x] POST /api/conversions/queue/clear

## Edits

- [x] GET /api/videos/:id/editing-metadata
- [x] POST /api/videos/:id/edits
- [x] GET /api/edits/jobs/:id
- [x] POST /api/edits/jobs/:id/cancel

## Backup

- [x] POST /api/backup
- [x] GET /api/backup
- [x] GET /api/backup/export
- [x] POST /api/backup/:filename/restore
- [x] DELETE /api/backup/:filename

## Stats

- [x] GET /api/stats/storage
- [x] GET /api/stats/storage/history
- [x] POST /api/stats/storage/snapshot
- [x] GET /api/stats/library
- [x] GET /api/stats/library/history
- [x] POST /api/stats/library/snapshot
- [x] GET /api/stats/content
- [x] GET /api/stats/content/history
- [x] POST /api/stats/content/snapshot
- [x] GET /api/stats/usage
- [x] GET /api/stats/usage/history
- [x] POST /api/stats/usage/snapshot
- [x] POST /api/stats/snapshot

## Video Stats

- [x] POST /api/videos/:id/watch
- [x] GET /api/videos/:id/stats

## Triage

- [x] POST /api/users/triage-progress
- [x] GET /api/users/triage-progress
- [x] POST /api/users/triage/bulk-actions
- [x] GET /api/users/triage/statistics
