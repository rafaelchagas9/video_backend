# Metadata API Reference (ThePornDB + StashDB)

Captured from live introspection + sample queries on 2026-06-02. This folder is the
source of truth for designing the source plugins **and** the DB schema expansion.

- `schemas/<endpoint>/<Type>.schema.json` — raw GraphQL introspection per type.
- `samples/*.json` — real response bodies for the query "Riley Reid".
- Regenerate with:
  ```bash
  uv run python scripts/introspect_schema.py --endpoint stashdb --save
  uv run python scripts/introspect_schema.py --endpoint tpdb --save
  uv run python scripts/explore_apis.py "Riley Reid" --introspect --save
  ```

## Headline finding: both are the same schema (StashBox)

ThePornDB's GraphQL (`https://theporndb.net/graphql`) and StashDB
(`https://stashdb.org/graphql`) both implement the **StashBox** schema — same root
queries (`searchPerformer`, `findStudio`, `queryScenes`, `findSite`, …), same core
types (`Performer`, `Studio`, `Scene`, `Tag`, `Site`, `Image`, `URL`).

**Implication:** we can write **one** GraphQL source plugin, parameterised by
endpoint + auth, and reuse it for both. Differences are minor (nullability, a couple
of TPDB-only convenience fields, enums vs free strings — see below).

### Auth

| Endpoint | URL | Auth header |
|---|---|---|
| StashDB | `https://stashdb.org/graphql` | `ApiKey: <key>` |
| ThePornDB (GraphQL) | `https://theporndb.net/graphql` | `Authorization: Bearer <key>` |
| ThePornDB (REST) | `https://api.theporndb.net` | `Authorization: Bearer <key>` |

### Image download notes

- TPDB CDN images download directly (`image/png|webp`, 200).
- StashDB images **reject `HEAD` (405)** but `GET` works (`image/jpeg`, 200). The
  Phase-1 downloader must use GET, not HEAD probes.

## Performer — field comparison

| Field | StashDB | ThePornDB (GraphQL) | Notes |
|---|---|---|---|
| `id` | `ID!` (uuid) | `ID!` (uuid) | **external id — must store per source** |
| `name` | `String!` | `String` | |
| `disambiguation` | `String` | `String` | distinguishes same-name performers |
| `aliases` | `[String!]!` | `[String]` | maps to our `creator_aliases` |
| `gender` | `GenderEnum` | `String` | enum on StashDB, free string on TPDB |
| `urls` | `[URL!]!` | `[URL]` | typed `{ url, site{ name,url } }` → socials/platforms |
| `birth_date` | `String` | `String` (+ `birthdate: FuzzyDate`) | TPDB also has fuzzy `{date, accuracy}` |
| `death_date` | `String` | `String` | |
| `age` | `Int` | `Int` | derived |
| `ethnicity` | `EthnicityEnum` | `String` | |
| `country` | `String` | `String` | ISO-ish (`US`) |
| `eye_color` | `EyeColorEnum` | `String` | |
| `hair_color` | `HairColorEnum` | `String` | |
| `height` | `Int` (cm) | `Int` | |
| `cup_size` | `String` | `String` (+ `measurements: Measurements`) | |
| `band_size` | `Int` | `Int` | |
| `waist_size` | `Int` | `Int` | |
| `hip_size` | `Int` | `Int` | |
| `breast_type` | `BreastTypeEnum` | `String` | NATURAL / FAKE / NA |
| `career_start_year` | `Int` | `Int` | |
| `career_end_year` | `Int` | `Int` | |
| `tattoos` | `[BodyModification!]` | `[BodyModification]` | `{ location, description }` |
| `piercings` | `[BodyModification!]` | `[BodyModification]` | `{ location, description }` |
| `images` | `[Image!]!` | `[Image]` | `{ id, url, width, height }` |
| `studios` | `[PerformerStudio!]!` | `[Studio]` | studios performer worked with |
| `scene_count` / `scenes` | yes | yes | |
| `merged_ids` | `[ID!]!` | `[ID]` | **upstream merge tracking** |
| `merged_into_id` | `ID` | `ID` | **redirect to canonical performer** |
| `created` / `updated` | `Time!` | `DateTime` | |

TPDB-only convenience: `birthdate: FuzzyDate { date, accuracy }`,
`measurements: Measurements { cup_size, band_size, hip, waist }`.

### Enums (StashDB; TPDB returns equivalent free strings)

- `GenderEnum`: MALE, FEMALE, TRANSGENDER_MALE, TRANSGENDER_FEMALE, INTERSEX, NON_BINARY
- `EthnicityEnum`: CAUCASIAN, BLACK, ASIAN, INDIAN, LATIN, MIDDLE_EASTERN, MIXED, OTHER
- `EyeColorEnum`: BLUE, BROWN, GREY, GREEN, HAZEL, RED
- `HairColorEnum`: BLONDE, BRUNETTE, BLACK, RED, AUBURN, GREY, BALD, VARIOUS, WHITE, OTHER
- `BreastTypeEnum`: NATURAL, FAKE, NA

### TPDB REST extras (richer than GraphQL for links)

The REST `/performers?q=` response (`samples/theporndb_search.json`) adds:
- `image`, `thumbnail`, `face` (pre-cropped 500×500 smart-crop) + `posters[]` (133 for
  Riley Reid).
- `extras.links` — a **flat map of ~50 external sites** (OnlyFans, Twitter, Instagram,
  Pornhub, Wikipedia, IAFD, the StashDB uuid, official site, …). This is the easiest
  social/platform harvest for known performers.
- `extras.birthplace`, `extras.measurements`, `extras.astrology`, `extras.nationality`, etc.
- `site_performers[]` — per-site appearances with site logo/network.

## Studio — field comparison

| Field | StashDB | ThePornDB | Notes |
|---|---|---|---|
| `id` | `ID!` | `ID!` | external id |
| `name` | `String!` | `String!` | |
| `aliases` | `[String!]!` | `[String!]` | we don't store studio aliases yet |
| `urls` | `[URL!]!` | `[URL]` | studio socials/site |
| `parent` | `Studio` | `Studio` | **hierarchy (network → studio)** |
| `sub_studios` / `child_studios` | `QueryStudiosResultType!` | `[Studio]` | children |
| `images` | `[Image!]!` | `[Image]` | studio logos/posters |
| `performers` | `QueryPerformersResultType!` | — | |
| `created`/`updated` | yes | yes | |

## Scene — field comparison (for future scene/video matching)

`id, title, details, release_date, production_date, urls, studio, tags[], images[],`
`performers[PerformerAppearance], fingerprints[], duration, director, code`.
- `PerformerAppearance { performer, as }` — credited-as alias per scene.
- `Fingerprint { hash, algorithm, duration, … }` — **phash/oshash matching**: could
  later identify a video file against StashDB/TPDB and auto-suggest its performers,
  studio, title, tags. (Out of current scope, but the data is here.)

## Tag / Site

- `Tag { id, name, description, aliases[], category{ id,name,group,description } }` —
  richer than our flat `tags` (categories/groups).
- `Site { id, name, description, url, regex, valid_types[], icon }` (StashDB). TPDB's
  `Site` is minimal (`id, name`). `URL.site` references this — gives us a clean
  platform/site name for every link.

---

## Gap analysis vs our current DB

Our `creators` table today: `name, description, profile/main/face picture paths,
timestamps`. The APIs expose far more. Proposed additions (to be detailed in the
schema-expansion plan, not yet implemented):

### `creators` — new optional columns
`gender, birth_date, death_date, ethnicity, country, birthplace, eye_color,
hair_color, height_cm, cup_size, band_size, waist_size, hip_size, breast_type,
career_start_year, career_end_year`. (All nullable; enrichment fills them, user
confirms.)

### New child tables
- `creator_body_modifications` — `{ creator_id, type: tattoo|piercing, location,
  description }`.
- `creator_external_ids` — `{ creator_id, source: theporndb|stashdb, external_id,
  external_url, last_synced_at }`. **Critical**: lets us re-fetch, dedup, and skip
  re-querying. Unique on `(source, external_id)`.

### Studios
- `studios.parent_studio_id` (self-ref) for network → studio hierarchy.
- `studio_aliases`, `studio_external_ids` (mirror creators).

### Tags
- Optional `tag_categories` + `tags.category_id` if we want their taxonomy later.

## Merge handling (needed before bulk-applying enrichment)

Two pressures create duplicates:
1. **Upstream merges** — StashBox exposes `merged_ids` / `merged_into_id`; a performer
   we linked may be merged upstream. On re-sync, follow `merged_into_id` and update our
   `creator_external_ids`.
2. **Our own duplicates** — enrichment may reveal two of our creators are the same
   person (shared external id, or alias overlap).

Proposed approach:
- A **`creator_merges`** audit table `{ from_id, into_id, merged_at, reason }`.
- A `mergeCreators(fromId, intoId)` service that reassigns `video_creators`,
  `creator_platforms`, `social_links`, `aliases` (the old name becomes an alias),
  `gallery_media`, `external_ids`, face embeddings → `into`, then soft-deletes `from`.
- Enrichment **never auto-merges**; it raises a "possible duplicate" suggestion
  (same external id / strong face match / alias collision) for manual confirmation —
  consistent with the manual-review principle.

## Recommended next step

Insert a **Phase 0.5 — Schema expansion & external identity/merge** before Phase 0
build: add the columns/tables above + the merge service + `creator_external_ids`, so
that when enrichment starts writing accepted suggestions, there's somewhere to put the
rich fields and a way to keep identities stable.
