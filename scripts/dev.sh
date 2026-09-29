#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
api_port="${API_PORT:-8016}"
frontend_port="${FRONTEND_PORT:-5186}"
if [[ ! -x "$project_dir/backend/.venv/bin/python" || ! -d "$project_dir/frontend/node_modules" ]]; then
  echo "Run the setup commands in README.md first." >&2
  exit 1
fi
cd "$project_dir/backend"
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "$api_port" &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT INT TERM
cd "$project_dir/frontend"
VITE_API_PROXY_TARGET="http://127.0.0.1:$api_port" npm run dev -- --port "$frontend_port" --strictPort
