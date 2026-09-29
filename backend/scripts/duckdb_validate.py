"""Run a side-by-side Oracle vs DuckDB validation pass.

Output is a JSON report (``validation_report.json`` by default) and
a short human summary on stdout. Exit code:

    0   every case matched within tolerance
    1   at least one case failed
    2   configuration error

Usage:
    DUCKDB_PATH=/var/dashb/dashboard.duckdb \\
    python -m scripts.duckdb_validate \\
        --anr A1 --fnr F1 \\
        --start 2023-01-01 --end 2026-01-01 \\
        --out validation_report.json
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

log = logging.getLogger("scripts.duckdb_validate")


def _parse_date(s: str) -> datetime:
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise SystemExit(f"unrecognised date: {s!r}")


def main() -> int:
    from app.config import DUCKDB_PATH, duckdb_config_errors

    parser = argparse.ArgumentParser(description="Validate DuckDB twin queries vs Oracle.")
    parser.add_argument("--anr", required=True)
    parser.add_argument("--fnr", required=True)
    parser.add_argument("--start", required=True, help="YYYY-MM-DD or full ISO")
    parser.add_argument("--end", required=True)
    parser.add_argument("--out", default="validation_report.json")
    args = parser.parse_args()

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    errors = duckdb_config_errors()
    if errors:
        for e in errors:
            log.error("config error: %s", e)
        return 2

    if not DUCKDB_PATH:
        log.error("DUCKDB_PATH must be set.")
        return 2

    import importlib.util

    if importlib.util.find_spec("duckdb") is None:
        log.error("duckdb package not installed; install with: pip install -e .[duckdb]")
        return 2

    from app.db.database import SessionLocal
    from app.duckdb.connection import DuckDBHandle
    from app.duckdb.repository import DuckDBRepository
    from app.duckdb.validation import default_cases, run_validation
    from app.repositories.fdwh_repository import FDWHRepository

    start = _parse_date(args.start)
    end = _parse_date(args.end)

    session = SessionLocal()
    duck_handle = DuckDBHandle(DUCKDB_PATH)
    try:
        oracle_repo = FDWHRepository(session)
        duck_repo = DuckDBRepository(duck_handle)
        report = run_validation(
            oracle_repo=oracle_repo,
            duckdb_repo=duck_repo,
            cases=default_cases(args.anr, args.fnr, start, end),
        )
    finally:
        session.close()
        duck_handle.close()

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(report.to_json())

    summary = report.summary()
    print(json.dumps(summary, indent=2))
    return 0 if summary["all_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
