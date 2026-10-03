#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")" && pwd)"
exec bash "$project_dir/scripts/start_demo.sh" "$@"
