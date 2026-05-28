# Frontend Handoff Index

This directory contains the current backend-to-frontend handoff documentation set for the video application.

## Start here

- Overview: `project-overview.md`
- Progress tracker: `endpoint-analysis-checklist.md`

## Endpoint docs

### Foundation

- Auth: `endpoints/auth.md`
- Events / SSE: `endpoints/events-sse.md`
- Multiplayer Remote: `multiplayer-remote.md`
- Directories: `endpoints/directories.md`
- Settings: `endpoints/settings.md`

### Core content flows

- Videos: `endpoints/videos.md`
- Random Video Filters: `endpoints/videos-random.md`
- Related Videos: `endpoints/related-videos.md`
- Creators: `endpoints/creators.md`
- Studios: `endpoints/studios.md`
- Tags: `endpoints/tags.md`
- Tagging Rules: `endpoints/tagging-rules.md`
- Ratings and Bookmarks: `endpoints/ratings-and-bookmarks.md`
- Favorites: `endpoints/favorites.md`
- Playlists: `endpoints/playlists.md`
- Video Collections: `endpoints/video-collections.md`

### Media and processing

- Thumbnails: `endpoints/thumbnails.md`
- Storyboards: `endpoints/storyboards.md`
- Conversion: `endpoints/conversion.md`
- Edits: `endpoints/edits.md`
- Face Recognition: `endpoints/face-recognition.md`

### Operations and analytics

- Stats: `endpoints/stats.md`
- Video Stats: `endpoints/video-stats.md`
- Backup: `endpoints/backup.md`
- Triage: `endpoints/triage.md`

## Suggested reading order for frontend team

1. `project-overview.md`
2. `endpoints/auth.md`
3. `endpoints/events-sse.md`
4. `multiplayer-remote.md` if implementing the multiplayer remote flow
5. `endpoints/videos.md`
6. `endpoints/creators.md`
7. `endpoints/studios.md`
8. Module docs relevant to the first frontend milestone

## Coverage status

Documented in this handoff set:

- Auth
- Events / SSE
- Multiplayer Remote
- Directories
- Settings
- Videos
- Creators
- Studios
- Tags
- Tagging Rules
- Ratings
- Bookmarks
- Favorites
- Playlists
- Thumbnails
- Storyboards
- Conversion
- Edits
- Face Recognition
- Stats
- Video Stats
- Backup
- Triage

## Sweep summary

- The current documentation set is structurally consistent.
- Route grouping is coherent and aligned with the current backend route registration.
- Endpoint coverage is now complete for the currently documented backend route surface, aside from any future additions.
- Optional future work is a shared frontend API-client conventions pass.
