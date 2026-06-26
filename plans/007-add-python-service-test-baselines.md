# Plan 007: Add Python service test baselines for face-service and enrichment-service

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat ff97b6a..HEAD -- face-service enrichment-service`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against live code before proceeding. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `ff97b6a`, 2026-06-12

## Why this matters

The TypeScript backend has a working verification baseline, but the two Python microservices are now runtime-critical: `face-service` handles detection/embeddings and `enrichment-service` discovers metadata candidates. I found no Python test files or pytest config under either service. A small test baseline will catch schema/config/source-mapping regressions without loading heavy models or making external network calls.

## Current state

Relevant files:

- `face-service/pyproject.toml` - service dependencies and Ruff config.
- `face-service/src/face_service/` - FastAPI app, config, face engine.
- `enrichment-service/pyproject.toml` - service dependencies and Ruff config.
- `enrichment-service/src/enrichment_service/` - FastAPI app, models, routes, sources.

Current excerpts:

```toml
# enrichment-service/pyproject.toml:7
dependencies = [
    "httpx>=0.28.0",
    "fastapi>=0.115.0",
    "pydantic>=2.9.0",
]
```

```toml
# face-service/pyproject.toml:7
dependencies = [
    "fastapi>=0.115.0",
    "insightface>=0.7.3",
    "onnxruntime-migraphx>=1.23.0",
]
```

No files matched this audit command:

```bash
find face-service enrichment-service -maxdepth 3 -type f \( -name '*test*' -o -name 'pytest.ini' -o -name 'ruff.toml' -o -name 'mypy.ini' \) -not -path '*/.venv/*'
```

Repo constraint: do not run installers unless the operator approves. Prefer using existing service virtualenvs if present.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Enrichment tests | `cd enrichment-service && uv run pytest` | exit 0 |
| Face tests | `cd face-service && uv run pytest` | exit 0 |
| Enrichment lint | `cd enrichment-service && uv run ruff check .` | exit 0 |
| Face lint | `cd face-service && uv run ruff check .` | exit 0 |

If `uv` is unavailable in the executor environment, use the service `.venv/bin/python -m pytest` only if pytest is installed. If neither exists, STOP and report the missing tooling rather than installing without approval.

## Scope

**In scope**:

- `face-service/pyproject.toml`
- `face-service/tests/`
- `enrichment-service/pyproject.toml`
- `enrichment-service/tests/`
- Minimal test-friendly seams in `face-service/src/face_service/` or `enrichment-service/src/enrichment_service/`

**Out of scope**:

- Loading real InsightFace models in tests.
- Calling ThePornDB/StashDB/Google or any external network.
- Changing TypeScript backend code.
- Building full E2E tests across Node and Python services.

## Git workflow

- Branch suggestion: `advisor/007-python-test-baseline`
- Commit message style: conventional commits.
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Add pytest/httpx test dependencies

In each service `pyproject.toml`, add a dev dependency group or optional dependency for:

- `pytest`
- `pytest-asyncio` if async tests need it
- `httpx` is already present in enrichment; add only if needed for FastAPI ASGI tests

Use the service's existing package manager conventions. Do not remove existing dependencies.

**Verify**: `cd enrichment-service && uv run python -c "import pytest"` and `cd face-service && uv run python -c "import pytest"` -> exit 0, or STOP if dependency installation is required and not approved.

### Step 2: Add enrichment-service tests without network

Create `enrichment-service/tests/`.

Add tests for:

- `models.EnrichRequest` defaults and validation.
- `sources.stashbox._as_list()` handling `None`, list, single object, and wrapped `{ performers: [...] }`.
- `sources.build_sources()` only enables configured sources with API keys.
- `/health` route returns healthy.

For source query behavior, use `httpx.MockTransport` or a small fake client object. Do not call external URLs.

**Verify**: `cd enrichment-service && uv run pytest` -> all pass.

### Step 3: Add face-service tests without loading heavy models

Create `face-service/tests/`.

Add tests for:

- `config.Settings.get_onnx_providers()` parses comma-separated providers.
- `/health` route returns a response without requiring a model load, or monkeypatch the engine readiness function if health currently loads the model.
- Request/response model validation if models exist.

Do not instantiate InsightFace or require GPU/ROCm/ONNX providers in tests.

**Verify**: `cd face-service && uv run pytest` -> all pass.

### Step 4: Add README or pyproject scripts if missing

If there is no documented command, add a short test command note to each service README or pyproject scripts if the tooling supports it. Keep it minimal:

- `uv run pytest`
- `uv run ruff check .`

**Verify**: `rg -n "pytest|ruff check" enrichment-service/README.md face-service/README.md enrichment-service/pyproject.toml face-service/pyproject.toml` -> shows the commands.

### Step 5: Run final gates

**Verify**:

- `cd enrichment-service && uv run pytest` -> exit 0
- `cd face-service && uv run pytest` -> exit 0
- `cd enrichment-service && uv run ruff check .` -> exit 0
- `cd face-service && uv run ruff check .` -> exit 0

## Test plan

The new tests should be small unit/API tests that avoid network and model loading. They should prove config parsing, schema validation, route health, and source-mapping helpers.

## Done criteria

- [ ] Both Python services have a `tests/` directory.
- [ ] Both services can run a one-command pytest suite.
- [ ] Tests do not require external network, GPUs, or real model downloads.
- [ ] Ruff still passes for both services.
- [ ] `plans/README.md` row for this plan is updated.

## STOP conditions

Stop and report if:

- The service package manager is unclear and adding pytest would require unapproved dependency installation.
- Importing face-service always loads heavyweight models before tests can monkeypatch.
- Existing virtualenvs are stale or broken and cannot run Python commands.
- A test would require real upstream API credentials.

## Maintenance notes

Keep these tests fast. Future tests for actual face detection should be opt-in integration tests with explicit fixtures, not part of the default baseline.
