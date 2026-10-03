#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
command -v uv >/dev/null || { echo 'uv fehlt. Bitte zuerst uv installieren.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Node.js >=22.13 mit npm fehlt.' >&2; exit 1; }
node -e 'if (process.versions.node.split(".").map(Number)[0] < 22 || (process.versions.node.startsWith("22.") && Number(process.versions.node.split(".")[1]) < 13)) process.exit(1)' || { echo 'Node.js >=22.13 erforderlich.' >&2; exit 1; }
cd "$project_dir/backend"
uv sync --frozen --extra dev --python 3.12
cd "$project_dir/frontend"
lock_hash="$(shasum -a 256 package-lock.json | cut -d ' ' -f 1)"
marker='node_modules/.outage-assessment-lock-hash'
if [[ ! -f "$marker" ]] || [[ "$(cat "$marker")" != "$lock_hash" ]]; then
  npm ci
  printf '%s\n' "$lock_hash" > "$marker"
fi
npm run build
cd "$project_dir"
exec backend/.venv/bin/python scripts/run_demo.py "$@"
