#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")" && pwd)"
if [[ $# -eq 0 ]]; then
  read -r -p 'Absoluter Pfad der Ergebnisdatenbank: ' database_path
  set -- --db "$database_path"
fi
exec bash "$project_dir/scripts/start_demo.sh" --existing "$@"
