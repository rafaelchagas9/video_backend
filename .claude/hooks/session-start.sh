#!/usr/bin/env bash
# Prepare demo mode in Claude cloud sessions. Does not start the server;
# run `scripts/cloud-demo.sh start` when you need it.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
scripts/cloud-demo.sh setup >&2
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  cat >>"$CLAUDE_ENV_FILE" <<'ENV'
export DEMO_MODE=true
export POSTGRES_USER=demo
export POSTGRES_PASSWORD=demo
export SESSION_SECRET=demo-session-secret-0123456789abcdef0123
ENV
fi
