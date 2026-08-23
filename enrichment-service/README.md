# Creator Enrichment Service

Python microservice (sibling to `face-service`) that discovers candidate metadata for
creators — images, platform profiles, social links, aliases, bios — from external
sources, and returns them as suggestions for **manual review** in the main app.

See `../docs/creator-enrichment-overview.md` for the full problem statement, architecture,
and phased rollout.

## Status

Phase 0 — a working FastAPI service exposing `/health` and `/enrich`, with **ThePornDB**
wired up via GraphQL name search and exact REST lookup by URL slug, numeric ID, or UUID.
The Node backend calls `/enrich` and turns the returned candidates into reviewable
suggestions.

## Setup

```bash
uv sync
cp .env.example .env   # then fill in THEPORNDB_API_KEY
```

## Run the service

```bash
./run.sh
# or
uv run python -m enrichment_service.main
```

Then:

```bash
curl localhost:8200/health
curl -X POST localhost:8200/enrich \
  -H 'content-type: application/json' \
  -d '{"name": "Riley Reid"}'
```

`/enrich` returns normalized `candidates` (`type`, `value`, `source`, `source_url`,
`field_key`, `confidence`, `raw`) plus `sources_used` and `errors`. It is **read-only** —
all writes happen in the Node backend when a suggestion is accepted.

## Explore the metadata-DB APIs

Probes ThePornDB (REST) and StashDB (GraphQL) for a performer and prints what each API
expects and returns. API keys are read from this folder's `.env`, falling back to the
repo root `../.env`.

```bash
# both sources, default sample name
uv run python scripts/explore_apis.py "Riley Reid"

# one source only
uv run python scripts/explore_apis.py "Riley Reid" --source tpdb
uv run python scripts/explore_apis.py "Riley Reid" --source stashdb --introspect

# full JSON / save dumps to tmp/
uv run python scripts/explore_apis.py "Riley Reid" --raw
uv run python scripts/explore_apis.py "Riley Reid" --save
```

## Planned sources

- **ThePornDB / StashDB** — performer metadata for studio/professional content.
- **Image search** (Google CSE initially) — high-res candidate photos.
- **Social/platform scraping** (Playwright) — avatars, bios, links for indie creators.
