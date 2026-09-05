# Metadata API Reference (ThePornDB + StashDB)

Captured from live introspection + sample queries on 2026-06-02. These are historical provider observations,
not a live contract. Recheck the provider before relying on an old field. Current
local mapping lives in [the adapter](../src/enrichment_service/sources/stashbox.py).

- `schemas/<endpoint>/<Type>.schema.json` — raw GraphQL introspection per type.
- `samples/*.json` — real response bodies for the query "Riley Reid".
- Regenerate with:
  ```bash
  uv run python scripts/introspect_schema.py --endpoint stashdb --save
  uv run python scripts/introspect_schema.py --endpoint tpdb --save
  uv run python scripts/explore_apis.py "Riley Reid" --introspect --save
  ```

## Captured schema family: StashBox

ThePornDB's GraphQL (`https://theporndb.net/graphql`) and StashDB
(`https://stashdb.org/graphql`) both implement the **StashBox** schema — same root
queries (`searchPerformer`, `findStudio`, `queryScenes`, `findSite`, …), same core
types (`Performer`, `Studio`, `Scene`, `Tag`, `Site`, `Image`, `URL`).

The current shared adapter is parameterized by endpoint, authentication, and
dialect. The captured differences include nullability, TPDB convenience fields,
and enums versus free strings, as listed below.

### Auth

| Endpoint | URL | Auth header |
|---|---|---|
| StashDB | `https://stashdb.org/graphql` | `ApiKey: <key>` |
| ThePornDB (GraphQL) | `https://theporndb.net/graphql` | `Authorization: Bearer <key>` |
| ThePornDB (REST) | `https://api.theporndb.net` | `Authorization: Bearer <key>` |

### Image download notes

- TPDB CDN images download directly (`image/png|webp`, 200).
- StashDB images rejected `HEAD` (405) while `GET` worked (`image/jpeg`, 200).

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
| `aliases` | `[String!]!` | `[String!]` | |
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

## Local implementation

The former schema-expansion proposal is implemented in the backend's
[organization schema](../../src/database/schema/organization.schema.ts) and
[enrichment module](../../src/modules/enrichment). Keep field mappings there.
The [creator module](../../src/modules/creators) owns local merge behavior.

Provider `merged_ids`/`merged_into_id` remain relevant when reconciling upstream
identities; a dated introspection snapshot is not proof that every upstream merge
case is handled. Fingerprint production work remains
[blocked](../../plans/006-fingerprint-scene-matching-spike.md).
