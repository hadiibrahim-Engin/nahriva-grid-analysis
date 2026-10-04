#!/usr/bin/env bash
# Lint, test and build everything. Needs backend/.venv (uv sync --frozen --extra dev) and frontend/node_modules (npm ci).
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir/backend"
.venv/bin/ruff check app tests ../scripts ../powerfactory
.venv/bin/python -m pytest -q
cd "$project_dir/frontend"
npm run check
npm audit --audit-level=moderate
