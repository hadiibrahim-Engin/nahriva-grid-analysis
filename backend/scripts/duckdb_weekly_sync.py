"""Weekly incremental Oracle → DuckDB sync.

Runs against a *staging* DuckDB file alongside the active one:

    /var/dashb/dashboard.duckdb           ← FastAPI reads from this
    /var/dashb/dashboard.next.duckdb      ← this script writes here

If the sync succeeds we ``os.replace`` next → active (POSIX atomic on
the same filesystem). If it fails for any reason, the active file is
untouched — the dashboard keeps running against the previous snapshot.

Usage (cron):

    0 3 * * 1 /usr/bin/python -m scripts.duckdb_weekly_sync >> /var/log/duckdb.log 2>&1
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

# Make `python scripts/duckdb_weekly_sync.py` work from the backend dir.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

log = logging.getLogger("scripts.duckdb_weekly_sync")


def _staging_path(active_path: str) -> str:
    """Sibling path to the active file: foo.duckdb → foo.next.duckdb."""
    p = Path(active_path)
    return str(p.with_name(p.stem + ".next" + p.suffix))


def main() -> int:
    from app.config import (
        DUCKDB_PATH,
        DUCKDB_RECENT_RAW_MONTHS,
        DUCKDB_RETENTION_YEARS,
        duckdb_config_errors,
    )
    from app.db.database import SessionLocal
    from app.duckdb.etl import run_weekly_sync

    # Reuse the same Oracle adapter as the bootstrap script.
    from scripts.duckdb_bootstrap import SqlAlchemyOracleReader

    parser = argparse.ArgumentParser(
        description="Weekly incremental sync from Oracle into DuckDB."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan and exit without opening DuckDB or Oracle.",
    )
    parser.add_argument(
        "--keep-staging",
        action="store_true",
        help="Don't delete the .next file after a successful swap (debugging).",
    )
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

    active = DUCKDB_PATH
    staging = _staging_path(active)
    log.info("active DuckDB:   %s", active)
    log.info("staging DuckDB:  %s", staging)
    log.info("retention years: %d", DUCKDB_RETENTION_YEARS)

    if args.dry_run:
        log.info("dry-run: no Oracle reads, no DuckDB writes")
        return 0

    # Start from the current active DB so the staging copy is incremental.
    if Path(active).exists():
        log.info("copying active → staging")
        shutil.copyfile(active, staging)
    else:
        log.warning(
            "no active DuckDB at %s — staging will be built from scratch",
            active,
        )
        if Path(staging).exists():
            Path(staging).unlink()

    import duckdb

    con = duckdb.connect(staging)
    session = SessionLocal()
    try:
        reader = SqlAlchemyOracleReader(session)
        stats = run_weekly_sync(
            reader,
            con,
            retention_years=DUCKDB_RETENTION_YEARS,
            recent_raw_months=DUCKDB_RECENT_RAW_MONTHS,
            now=datetime.utcnow(),
        )
        con.execute("CHECKPOINT")
    except Exception as exc:
        log.exception("weekly sync failed; leaving active DB untouched")
        con.close()
        return 3
    finally:
        session.close()
    con.close()

    log.info(
        "swap %s → %s (raw=%d hourly=%d pruned=%d chunks=%d)",
        staging, active,
        stats.new_raw_rows, stats.rebuilt_hourly_rows,
        stats.pruned_rows, stats.chunks_processed,
    )
    os.replace(staging, active)

    if args.keep_staging:
        shutil.copyfile(active, staging)

    return 0


if __name__ == "__main__":
    sys.exit(main())
