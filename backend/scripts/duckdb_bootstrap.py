"""One-off Oracle → DuckDB bootstrap.

Run this script once per dashboard server, then enable the read replica
with ``DUCKDB_ENABLED=true``. After this, the weekly sync job (Phase 4)
takes over.

Usage:
    DUCKDB_PATH=/var/dashb/dashboard.duckdb \\
    DUCKDB_RETENTION_YEARS=3 \\
    python -m scripts.duckdb_bootstrap [--dry-run]

The Oracle connection comes from the regular ``app.db.database`` engine.
The bootstrap requires the same env vars that the dashboard itself
uses (DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD or
DATABASE_URL).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime
from typing import Iterable, Sequence

from sqlalchemy import text
from sqlalchemy.orm import Session

# Make `python scripts/duckdb_bootstrap.py` work from the backend dir.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from app.config import (
    DUCKDB_PATH,
    DUCKDB_RETENTION_YEARS,
    duckdb_config_errors,
)
from app.db import queries
from app.db.database import SessionLocal
from app.duckdb.etl import OracleReader, run_bootstrap

log = logging.getLogger("scripts.duckdb_bootstrap")


class SqlAlchemyOracleReader:
    """Adapt the Oracle Session to the ETL's OracleReader Protocol."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def list_facilities(self) -> Sequence[tuple]:
        return self._session.execute(text(queries.list_facilities())).fetchall()

    def list_components(self) -> Sequence[tuple]:
        return self._session.execute(text(queries.list_all_components())).fetchall()

    def fetch_measurements(
        self,
        anr: str,
        fnr: str,
        start: datetime,
        end: datetime,
    ) -> Iterable[tuple]:
        """Yield (ts, p_mw, q_mvar, s_mva, u_kv, i_a) tuples in time order."""
        sql = """
        SELECT "LOKALZEIT", "MW", "BMW", "S", "UUW",
               TO_NUMBER("STROMWERT") AS strom
        FROM FDWH.TIFAB_ODB_MESSWERTE
        WHERE "ANLAGENNUMMER" = :anr
          AND "FELDNUMMER"    = :fnr
          AND "LOKALZEIT" >= TO_DATE(:s, 'YYYY-MM-DD HH24:MI:SS')
          AND "LOKALZEIT" <  TO_DATE(:e, 'YYYY-MM-DD HH24:MI:SS')
        ORDER BY "LOKALZEIT"
        """
        result = self._session.execute(
            text(sql),
            {
                "anr": anr,
                "fnr": fnr,
                "s": start.strftime("%Y-%m-%d %H:%M:%S"),
                "e": end.strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
        for row in result:
            yield tuple(row)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bootstrap the DuckDB read replica from Oracle FDWH."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the plan and exit without opening DuckDB.",
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
        log.error("DUCKDB_PATH must be set (and DUCKDB_ENABLED=true).")
        return 2

    log.info("DuckDB path:        %s", DUCKDB_PATH)
    log.info("Retention years:    %d", DUCKDB_RETENTION_YEARS)
    log.info("Dry-run:            %s", args.dry_run)

    if args.dry_run:
        log.info("dry-run: no DuckDB connection opened, no Oracle read attempted.")
        return 0

    import duckdb

    os.makedirs(os.path.dirname(os.path.abspath(DUCKDB_PATH)) or ".", exist_ok=True)
    con = duckdb.connect(DUCKDB_PATH)

    session = SessionLocal()
    try:
        reader = SqlAlchemyOracleReader(session)
        stats = run_bootstrap(reader, con, retention_years=DUCKDB_RETENTION_YEARS)
        log.info(
            "bootstrap finished. facilities=%d components=%d raw=%d hourly=%d chunks=%d",
            stats.facilities_loaded,
            stats.components_loaded,
            stats.raw_rows_loaded,
            stats.hourly_rows_built,
            stats.chunks_processed,
        )
        return 0
    finally:
        session.close()
        con.close()


if __name__ == "__main__":
    sys.exit(main())
