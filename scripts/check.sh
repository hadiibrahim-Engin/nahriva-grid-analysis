#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir/backend"
.venv/bin/ruff check app scripts tests ../scripts/dashboard_launcher.py ../scripts/run_dashboard.py ../scripts/smoke_production.py ../powerfactory/start_assessment.py
.venv/bin/python -m pytest -q
cd "$project_dir/frontend"
npm run check
npm audit --audit-level=moderate
