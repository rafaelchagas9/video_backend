# Video Collections Proposal

## Problem

Our backend currently stores videos as mostly independent items with metadata and relationships (tags, creators, studios, playlists), but it lacks a first-class way to represent ordered narrative groupings.

This creates a gap for at least two important content patterns:

- Movie sequences (for example: movie 1, movie 2, movie 3)
- Episodic content (for example: season 1 episode 1)

Playlists are user-curated and useful for temporary grouping, but they are not a durable content model for canonical sequence/season structure. Without a dedicated model, frontend clients need workarounds and extra API calls to infer relationships.

## Proposed Solution: `video_collections`

Introduce a first-class content domain for collections and ordered members.

### 1) New Core Tables

#### `video_collections`

Represents a canonical collection/series.

Suggested fields:

- `id`
- `title`
- `kind` (`movie_series`, `tv_series`, `mini_series`, `anthology`, `other`)
- `description` (nullable)
- `release_year` (nullable)
- `external_ids_json` (nullable, optional future use)
- `created_at`, `updated_at`

#### `video_collection_entries`

Represents an ordered membership of a video in a collection.

Suggested fields:

- `collection_id` (FK -> `video_collections.id`)
- `video_id` (FK -> `videos.id`)
- `entry_kind` (`movie`, `episode`, `special`, `extra`)
- `sequence_number` (nullable; for movie/franchise order)
- `season_number` (nullable)
- `episode_number` (nullable)
- `episode_part` (nullable; split episodes/parts)
- `absolute_number` (nullable; optional alternate ordering support)
- `display_title_override` (nullable)
- `created_at`, `updated_at`

Suggested constraints:

- Unique membership: one row per (`collection_id`, `video_id`)
- Unique sequence per collection when `sequence_number` is present
- Unique episode coordinate per collection for (`season_number`, `episode_number`, `episode_part`) when applicable

## API Direction

Provide endpoints that let frontend manage this manually (human-curated), with no automatic filename inference.

### Collection management

- `POST /api/video-collections`
- `GET /api/video-collections/:id`
- `PATCH /api/video-collections/:id`
- `DELETE /api/video-collections/:id`

### Entry management

- `GET /api/video-collections/:id/entries` (ordered)
- `POST /api/video-collections/:id/entries`
- `PATCH /api/video-collections/:id/entries/reorder`
- `DELETE /api/video-collections/:id/entries/:video_id`

### Video payload integration

Allow include-based enrichment in existing video endpoints to avoid frontend N+1 request patterns:

- `GET /api/videos/:id?include=collection,collection_neighbors`
- `GET /api/videos?include=collection`

Optional list filters/sorts for later:

- `collectionId`, `collectionKind`, `season`, `episode`, `sequenceNumber`, `hasCollection`

## Non-Goals (Current Decision)

- No filename/path auto-matching for now.
- No background inference pipeline for sequence/episode detection.

Reason: current filenames are too unreliable (often random alphanumeric strings), so automatic parsing would consume resources with negligible value. Initial curation should be manual in frontend and persisted via API.

## Why this is the best path

- Adds a normalized, explicit model instead of overloading playlists or free-form metadata.
- Supports both sequels and episodic structures in one consistent backend design.
- Gives frontend complete, typed data for rendering and navigation without fragile client-side heuristics.
- Keeps implementation future-proof for external metadata provider integration later.

## Suggested Implementation Phases

1. Add schema + relations + migration for `video_collections` and `video_collection_entries`.
2. Add CRUD endpoints for collections and ordered entry management.
3. Add include support in video endpoints to return collection context in one request.
4. Add filters/sorts for collection-aware browsing.
5. Later (optional): integrate external IDs/providers (TMDB/TVDB) without changing the core model.
