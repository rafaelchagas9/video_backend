#!/bin/bash
# Startup script for the Creator Enrichment Service.
# Pure I/O service (HTTP + GraphQL) — no GPU dependencies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# Sync deps if the venv is missing, then launch.
if [ ! -d ".venv" ]; then
  uv sync
fi

exec uv run python -m enrichment_service.main
