# Creator Enrichment — Problem & Solution Overview

> High-level design doc. Per-phase implementation plans will be written separately
> as we pick each phase up. This file is the shared map, not the construction
> blueprint.

## The Problem

The library holds 3000+ videos and 1200+ creators/models, and ~99.99% of the media
arrives with **no metadata**. Enriching a creator today is fully manual and slow:

1. Pull the list of creators/studios that are missing info.
2. Open a browser, copy a name, search Google, filter by high resolution.
3. If the term gives poor results, rethink the query and search again.
4. Right-click an image, invent a filename, save it locally.
5. Open the creator's page in the app and upload the image.

Repeat per creator across **1200+ creators**. The same pain applies to discovering a
creator's social links, platform profiles (OnlyFans/Fansly/etc.), aliases, and bio.

**Goal:** automate the *discovery* of candidate images, socials, platforms, aliases,
and bios per creator, and surface them in the app as **reviewable suggestions** so the
work collapses to "glance and one-click accept" — with manual search only for the rare
miss.

## Decisions (locked)

- **Autonomy:** manual review only. The system *proposes*; it never auto-writes to a
  creator. Accepting a suggestion is always an explicit user action.
- **Sources:** adult metadata databases (ThePornDB / StashDB) + image search engines +
  social/platform scraping. (Local video frames intentionally out of scope for now.)
- **Names:** a mix of real performer names and platform handles/usernames — discovery
  must try multiple strategies per creator.
- **Budget:** prefer free / self-hosted; small spend (~$10/mo) acceptable.
- **Worker:** a new **Python enrichment microservice**, sibling to the existing
  `face-service`, for robust scraping (Playwright) and source plugins.
- **Image/web search:** a pluggable provider abstraction with **Google Programmable
  Search API** as the initial provider. (SearXNG was considered but dropped for now —
  it's throwing too many errors / 403s from major engines. The provider interface
  stays generic so SearXNG or others can be re-added later without rework.)

## What already exists (reused, not rebuilt)

The write/ingest side is largely solved already:

- Rich data model: `creators`, `creator_gallery_media` (multi-image with
  profile/main roles), `creator_platforms`, `creator_social_links`,
  `creator_aliases`.
- Ingest-from-URL: `setPictureFromUrl()` and `addGalleryMediaFromUrl()` already
  download → process → face-crop → embed.
- Face recognition: stateless Python `face-service` (InsightFace) producing
  512-dim embeddings, stored per creator in Postgres via **pgvector**.
- "Completeness" / "missing" filters on creators (`missing: picture | platform |
  social | linked`) to target the backlog.

Because of this, **accepting a suggestion just reuses existing writers** — no new
write paths are introduced.

## Architecture

```
Frontend review queue
        │  GET suggestions / POST accept|reject
        ▼
Bun/Fastify backend ─── owns: queue, DB, face-match scoring, all accept-writes
  • enrichment module (new)      reuses: addGalleryMediaFromUrl, setPictureFromUrl,
  • enrichment.client → Python          creator_platforms/social writers, pgvector
        │  POST /enrich {name, aliases, handles}
        ▼
Python enrichment-service (NEW, sibling to face-service)
  • source plugins  ──► ThePornDB / StashDB (APIs)
  • search provider ──► Google CSE (pluggable; more providers can be added later)
  • social scraper ──► Playwright (IG / X / OF / Fansly: avatar, bio, links)
        │ returns normalized candidates (URLs + metadata, no writes)
        ▼
Backend downloads top-N candidate images → face-service /detect → cosine vs the
creator embedding → store suggestion with face_match_score + cached preview
```

**Division of labor.** Node stays the brain (queue, DB, scoring orchestration, all
writes). Python is a pure "given a creator, return candidates" service. This keeps
`face-service` stateless and keeps every write going through code that already exists.

### Key design points

1. **Source abstraction (Python).** Each source is a plugin returning normalized
   `Candidate { type: image|platform|social|bio|alias, value, source, source_url,
   confidence, raw }`. Sources are individually toggleable via config. Note: ThePornDB
   and StashDB both implement the **StashBox GraphQL schema**, so a single
   parameterised GraphQL plugin serves both (see `api-reference/README.md`).
2. **Search provider abstraction.** Image search goes through a `SearchProvider`
   interface so the engine is swappable. The initial provider is Google Programmable
   Search (100 queries/day free). SearXNG was dropped for now due to repeated
   errors/403s from major engines, but the abstraction means it (or any other
   provider, or a fallback chain) can be slotted back in later without rework.
3. **Face-match as the review accelerator.** Each candidate image is downloaded,
   embedded via `face-service`, and cosine-compared to the creator's stored
   embedding. Confident matches float to the top of the queue with a badge; creators
   with no existing embedding fall back to source-confidence ranking. Review still
   manual — this just makes the glance instant.
4. **New DB tables (one migration).**
   - `creator_enrichment_suggestions` — creator_id, type, value/url, source,
     source_url, confidence, face_match_score (nullable), cached_preview_path,
     status (pending/accepted/rejected/superseded), dedup_hash, timestamps.
   - `creator_enrichment_runs` — per-creator run log: status, sources_used, counts,
     errors, last_run_at (skip recently-scraped creators; re-run on demand).
5. **Node enrichment module** (`src/modules/enrichment/`, following the existing
   module pattern): routes, service, client, schemas. Accept handlers delegate to the
   existing social/platform/picture writers.
6. **Batch backlog runner.** Reuses the existing queue pattern (cf.
   `face-extraction-queue`) + `node-cron` to grind the 1200 backlog over the existing
   "missing" filters, with per-domain politeness + result caching so nothing gets
   re-hit needlessly. Wake up to a populated review queue.

### Identity safety

Names are mixed (real names + handles), so discovery always requires **name OR alias
OR a known handle** as input, and low-confidence results are ranked at the bottom and
never auto-promoted. Manual review is the final guard.

## Phased rollout

### Phase 0.5 — Schema expansion & external identity / merge handling
The metadata DBs expose far more than our `creators` table can hold (birth date,
ethnicity, birthplace, measurements, tattoos/piercings, typed URLs, upstream merge
pointers). Before enrichment can *write* accepted suggestions, we need somewhere to put
that data and a way to keep identities stable. See the full field-by-field analysis in
`../enrichment-service/api-reference/README.md`.
- New optional `creators` columns (gender, birth_date, ethnicity, country, birthplace,
  eye/hair color, height, measurements, career years, …).
- `creator_body_modifications` (tattoos/piercings) and **`creator_external_ids`**
  (`source` + `external_id`, unique) for re-fetch/dedup/skip-requery.
- Studio hierarchy (`parent_studio_id`), `studio_aliases`, `studio_external_ids`.
- A **merge service** + `creator_merges` audit table; enrichment only *proposes*
  possible duplicates (shared external id / strong face match / alias collision),
  never auto-merges.
- **Exit criteria:** a creator can hold the full external field set; two creators can be
  merged losslessly; an accepted external id is stored and re-fetchable.

### Phase 0 — Skeleton, end-to-end
Prove the whole loop on real performers with the smallest possible surface.
- DB migration: the two new tables.
- Node `enrichment` module + client to the Python service.
- Python enrichment-service scaffold with **ThePornDB only** as the first source.
- Review-queue endpoints: enqueue enrich, list suggestions, accept, reject.
- **Exit criteria:** for a single creator, run enrichment → see suggestions in the
  API → accept one → it lands via the existing writers.

### Phase 1 — Images + face-match
Make image suggestions useful and self-ranking.
- `SearchProvider` abstraction with Google CSE as the initial provider.
- Candidate image download, face-match scoring via `face-service`, cached preview
  thumbnails for a fast review UI.
- Add StashDB as a second metadata source.
- **Exit criteria:** image suggestions appear ranked by face-match confidence.

### Phase 2 — Social / platform scraping
Cover indie / custom-content creators that metadata DBs don't know.
- Playwright-based social source for Instagram / X / OnlyFans / Fansly: avatar, bio,
  links, derived from known handles or discovered profile URLs.
- **Exit criteria:** for a handle-only creator, the queue proposes avatar + socials.

### Phase 3 — Backlog automation
Turn it into a hands-off grinder.
- Batch runner over the "missing picture/platform/social" filters.
- Dedup + result caching, per-domain rate limiting / politeness hardening,
  re-run / skip logic via `creator_enrichment_runs`.
- **Exit criteria:** an overnight batch populates the review queue across the backlog
  without re-hitting sources.

## Configuration (added incrementally per phase)

Environment variables to introduce as phases land:

- `ENRICHMENT_SERVICE_URL` — base URL of the Python enrichment-service.
- `THEPORNDB_API_KEY`, `STASHDB_API_KEY` — metadata DB access.
- `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX` — Google Programmable Search (initial image
  search provider).
- Concurrency / politeness knobs + per-source enable flags.

## Out of scope (for now)

- Auto-accepting suggestions without review.
- Local video-frame face suggestions.
- Studio enrichment (the same pattern can extend to studios later; creators first).
