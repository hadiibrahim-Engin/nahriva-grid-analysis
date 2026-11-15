#!/usr/bin/env bash
# Try the dashboard on this computer: builds the IEEE 39-bus example (synthetic run through the real import path,
# with a network map as Figma exports it) once, then starts the dashboard and opens it in the browser.
#   scripts/try_example.sh            reuse the example if it exists
#   scripts/try_example.sh --fresh    build the example again
# Needs uv and Node.js >= 22.13 (as scripts/start_dashboard.sh). Ctrl+C stops the dashboard.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
example_dir="$project_dir/backend/data/ieee39-example"
db="$example_dir/ieee39.sqlite3"
if [[ "${1:-}" == "--fresh" ]]; then
  rm -rf "$example_dir"
fi
command -v uv >/dev/null || { echo 'uv is missing. Please install uv first.' >&2; exit 1; }
cd "$project_dir/backend"
uv sync --frozen --extra dev --python 3.12
if [[ ! -f "$db" ]]; then
  echo "Building the IEEE 39-bus example (about 20 s) ..."
  .venv/bin/python -m tests.ieee39 --db "$db"
fi
echo "Example: $db"
echo "Network map: $example_dir/maps/ieee39.svg (drag it into Figma to edit it; export it back as SVG with ids)"
exec "$project_dir/scripts/start_dashboard.sh" --db "$db"
