#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir/backend"
.venv/bin/ruff check app scripts tests
.venv/bin/python -m pytest -q
cd "$project_dir/frontend"
npm run check
npm audit --audit-level=moderate
