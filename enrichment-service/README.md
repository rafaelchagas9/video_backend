# Creator enrichment service

A FastAPI service that returns external creator metadata as candidates for
manual review. The Bun backend owns accepted writes. The shared
[StashBox adapter](src/enrichment_service/sources/stashbox.py) supports ThePornDB
and StashDB; ThePornDB also uses REST for exact URL/slug/ID lookups.

## Setup and run

From this directory:

```bash
uv sync --frozen
cp .env.example .env
# Configure the selected provider's API key.
./run.sh
```

Alternatively run `uv run python -m enrichment_service.main`. The default port
is 8200. `GET /health` reports service status; FastAPI's `/docs` exposes the
request and response models for `POST /enrich`.

Configure provider credentials and switches in [.env.example](.env.example).
The source registry defaults to ThePornDB. An explicit request `sources` list
can select ThePornDB and/or StashDB when the corresponding key is configured;
see [the registry](src/enrichment_service/sources/__init__.py) for selection rules.
A response can contain candidates from one source and errors from another.

## Provider exploration

The [API reference snapshots](api-reference/README.md) are dated investigation
artifacts, not a current upstream contract. Exploration scripts make external
requests and read this directory's `.env`, falling back to the repository root.
Run them deliberately with the intended provider and query:

```bash
uv run python scripts/explore_apis.py "Example Name" --source tpdb
uv run python scripts/explore_apis.py "Example Name" --source stashdb --introspect
```

`--raw` prints full responses; `--save` writes dumps to `tmp/`. Keep personal
query results and credentials out of commits. Automated source tests use mocked
responses:

```bash
uv run python -m unittest discover -s . -p 'test_*.py' -v
```

Image search and social/platform scraping remain possible future sources; they
are not implemented adapters.
