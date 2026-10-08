#!/usr/bin/env bash
# Boot the demo backend in an offline environment (e.g. Claude cloud sessions).
# Usage: scripts/cloud-demo.sh [setup|start|stop|status]
#   setup  install deps and generate synthetic demo media if missing (idempotent)
#   start  setup, then run the backend in the background on $PORT (default 3000)
# Demo mode needs no PostgreSQL; the env vars below are placeholders only.
set -euo pipefail
cd "$(dirname "$0")/.."

export DEMO_MODE=true
export DEMO_MEDIA_SOURCE=synthetic
export POSTGRES_USER="${POSTGRES_USER:-demo}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-demo}"
export SESSION_SECRET="${SESSION_SECRET:-demo-session-secret-0123456789abcdef0123}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173}"
LOG="${DEMO_LOG:-/tmp/video_backend-demo.log}"
PIDFILE="${DEMO_PIDFILE:-/tmp/video_backend-demo.pid}"

setup() {
  command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
  [ -d node_modules ] || bun install --frozen-lockfile
  if [ ! -s demo_mode/demo.sqlite.baseline ] || [ -z "$(ls demo_mode/video 2>/dev/null)" ]; then
    DEMO_SYNTHETIC_SECONDS="${DEMO_SYNTHETIC_SECONDS:-6}" bun run demo:download
  fi
}

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  setup) setup ;;
  start)
    setup
    if running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    nohup bun src/index.ts >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    for _ in $(seq 1 30); do
      curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 && { echo "demo backend up on :$PORT (log: $LOG)"; exit 0; }
      sleep 1
    done
    echo "backend did not become healthy; see $LOG" >&2; exit 1 ;;
  stop) running && kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" || echo "not running" ;;
  status) running && curl -fsS "http://localhost:$PORT/health" || echo "not running" ;;
  *) echo "usage: $0 [setup|start|stop|status]" >&2; exit 2 ;;
esac
