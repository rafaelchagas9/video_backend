# Creator Enrichment Service

Python microservice (sibling to `face-service`) that discovers candidate metadata for
creators — images, platform profiles, social links, aliases, bios — from external
sources, and returns them as suggestions for **manual review** in the main app.

See `../docs/creator-enrichment-overview.md` for the full problem statement, architecture,
and phased rollout.

## Status

Early scaffold. Currently contains an **API exploration script** used to design the
metadata-DB source plugins from real request/response shapes.

## Setup

```bash
uv sync
```

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
