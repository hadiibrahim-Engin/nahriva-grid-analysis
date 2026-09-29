"""Oracle → DuckDB extraction / load primitives.

Both the bootstrap (``scripts/duckdb_bootstrap.py``) and the weekly
sync (Phase 4) share these helpers. They're deliberately split out of
the scripts so unit tests can drive them with a mock Oracle reader.

Design rules:

- The Oracle side is hidden behind a tiny ``OracleReader`` Protocol so
  tests can inject deterministic fixtures (no Oracle, no SQLAlchemy).
- Every batch insert into DuckDB goes through ``executemany`` — never
  one-row-at-a-time — and is wrapped in a transaction for atomicity.
- Date windows are explicit ``(start, end)`` arguments; the caller
  controls chunking. The default chunk size is monthly (≈ 100 k rows
  per asset at 15-min cadence).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterable, Iterator, Protocol, Sequence

from app.duckdb.schema import SCHEMA_VERSION, init_schema

log = logging.getLogger(__name__)


# -- Oracle-side abstraction (so tests don't need Oracle) ------------


class OracleReader(Protocol):
    """Minimal interface the ETL needs from the Oracle side."""

    def list_facilities(self) -> Sequence[tuple]: ...
    def list_components(self) -> Sequence[tuple]: ...
    def fetch_measurements(
        self,
        anr: str,
        fnr: str,
        start: datetime,
        end: datetime,
    ) -> Iterable[tuple]:
        """Yield raw 15-minute measurements as (ts, p, q, s, u, i) tuples."""


# -- ETL data container (a single bootstrap pass) --------------------


@dataclass
class BootstrapStats:
    facilities_loaded: int = 0
    components_loaded: int = 0
    raw_rows_loaded: int = 0
    hourly_rows_built: int = 0
    chunks_processed: int = 0
    errors: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []


# -- helpers ---------------------------------------------------------


def _month_chunks(start: datetime, end: datetime) -> Iterator[tuple[datetime, datetime]]:
    """Yield (chunk_start, chunk_end) tuples spanning [start, end].

    Chunks are roughly one calendar month wide. The last chunk's
    ``chunk_end`` is exactly ``end`` so the tail is included.
    """
    cur = start
    while cur < end:
        # Roughly one month: jump 30 days. Calendar exactness doesn't
        # matter — we just want bounded chunks.
        nxt = min(cur + timedelta(days=30), end)
        yield cur, nxt
        cur = nxt


def load_dimensions(reader: OracleReader, con: Any) -> tuple[int, int]:
    """Pull dim_anlage + dim_betriebsmittel rows from Oracle into DuckDB."""

    # dim_anlage
    facility_rows: list[tuple[str, str]] = []
    for row in reader.list_facilities():
        # Tolerate None and stringify ANR like the existing FDWH service does.
        anr = row[0]
        if anr is None:
            continue
        facility_rows.append((str(anr), row[1] if len(row) > 1 else None))

    if facility_rows:
        con.executemany(
            "INSERT OR REPLACE INTO dim_anlage(anr, anlagenname) VALUES (?, ?)",
            facility_rows,
        )

    # dim_betriebsmittel
    comp_rows: list[tuple[str, str, str | None, str | None]] = []
    for row in reader.list_components():
        anr, fnr = row[0], row[1]
        if anr is None or fnr is None:
            continue
        name = row[2] if len(row) > 2 else None
        # NB: list_all_components returns (anr, fnr, name, anlagenname, spannungsebene)
        spannung = row[4] if len(row) >= 5 else (row[3] if len(row) > 3 else None)
        comp_rows.append((str(anr), str(fnr), name, spannung))

    if comp_rows:
        con.executemany(
            "INSERT OR REPLACE INTO dim_betriebsmittel"
            "(anr, fnr, feldname_kurz, spannungsebene) VALUES (?, ?, ?, ?)",
            comp_rows,
        )

    return len(facility_rows), len(comp_rows)


def load_raw_chunk(
    reader: OracleReader,
    con: Any,
    anr: str,
    fnr: str,
    chunk_start: datetime,
    chunk_end: datetime,
) -> int:
    """Pull a single (asset, time-window) chunk and insert into DuckDB.

    Returns the row count actually inserted.
    """
    # Materialise the chunk so we can hand it to executemany in one shot.
    rows: list[tuple] = []
    for raw in reader.fetch_measurements(anr, fnr, chunk_start, chunk_end):
        ts, p, q, s, u, i = raw
        rows.append((ts, anr, fnr, p, q, s, u, i))

    if not rows:
        return 0

    con.execute("BEGIN TRANSACTION")
    try:
        con.executemany(
            "INSERT OR REPLACE INTO measurements_15min_recent"
            "(ts, anr, fnr, p_mw, q_mvar, s_mva, u_kv, i_a)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise

    return len(rows)


def rebuild_hourly_from_raw(con: Any, since: datetime | None = None) -> int:
    """(Re)build measurements_hourly from measurements_15min_recent.

    If ``since`` is given, only hours at/after that timestamp are
    rebuilt — keeps the weekly incremental update fast.

    Returns the number of hourly rows written.
    """
    if since is None:
        con.execute("DELETE FROM measurements_hourly")
    else:
        con.execute(
            "DELETE FROM measurements_hourly WHERE ts >= ?",
            [since.replace(minute=0, second=0, microsecond=0)],
        )

    where = ""
    params: list[Any] = []
    if since is not None:
        where = "WHERE ts >= ?"
        params = [since.replace(minute=0, second=0, microsecond=0)]

    con.execute(
        f"""
        INSERT INTO measurements_hourly
        SELECT
            date_trunc('hour', ts) AS ts,
            anr,
            fnr,
            AVG(p_mw)   AS p_avg, MIN(p_mw)   AS p_min, MAX(p_mw)   AS p_max,
            AVG(q_mvar) AS q_avg, MIN(q_mvar) AS q_min, MAX(q_mvar) AS q_max,
            AVG(s_mva)  AS s_avg, MIN(s_mva)  AS s_min, MAX(s_mva)  AS s_max,
            AVG(u_kv)   AS u_avg, MIN(u_kv)   AS u_min, MAX(u_kv)   AS u_max,
            AVG(i_a)    AS i_avg, MIN(i_a)    AS i_min, MAX(i_a)    AS i_max,
            COUNT(*)
        FROM measurements_15min_recent
        {where}
        GROUP BY date_trunc('hour', ts), anr, fnr
        """,
        params,
    )
    row = con.execute("SELECT COUNT(*) FROM measurements_hourly").fetchone()
    return int(row[0]) if row else 0


def update_coverage(con: Any) -> None:
    """Refresh the duckdb_coverage table from current row counts."""
    con.execute("DELETE FROM duckdb_coverage")
    con.execute(
        """
        INSERT INTO duckdb_coverage(table_name, min_ts, max_ts, row_count, granularity)
        SELECT 'measurements_15min_recent', MIN(ts), MAX(ts), COUNT(*), '15min'
        FROM measurements_15min_recent
        """
    )
    con.execute(
        """
        INSERT INTO duckdb_coverage(table_name, min_ts, max_ts, row_count, granularity)
        SELECT 'measurements_hourly', MIN(ts), MAX(ts), COUNT(*), 'hourly'
        FROM measurements_hourly
        """
    )
    con.execute(
        """
        INSERT INTO duckdb_coverage(table_name, min_ts, max_ts, row_count, granularity)
        SELECT 'measurements_daily', CAST(MIN(day) AS TIMESTAMP),
               CAST(MAX(day) AS TIMESTAMP), COUNT(*), 'daily'
        FROM measurements_daily
        """
    )


def update_sync_status(
    con: Any,
    *,
    status: str,
    source_min_ts: datetime | None,
    source_max_ts: datetime | None,
    retained_min_ts: datetime | None,
    retained_max_ts: datetime | None,
    last_prune_ts: datetime | None,
    error_message: str | None = None,
) -> None:
    now = datetime.utcnow()
    con.execute(
        """
        UPDATE sync_status
        SET last_sync_ts    = ?,
            source_min_ts   = ?,
            source_max_ts   = ?,
            retained_min_ts = ?,
            retained_max_ts = ?,
            last_prune_ts   = ?,
            status          = ?,
            error_message   = ?,
            schema_version  = ?
        WHERE id = 1
        """,
        [
            now,
            source_min_ts,
            source_max_ts,
            retained_min_ts,
            retained_max_ts,
            last_prune_ts,
            status,
            error_message,
            SCHEMA_VERSION,
        ],
    )


def prune_older_than(con: Any, cutoff: datetime) -> int:
    """Delete measurement rows older than the retention cutoff.

    Returns the number of rows removed across all measurement tables.
    Uses count-before / count-after rather than the DuckDB cursor's
    ``rowcount`` (which is not reliable for ``DELETE``).
    """
    removed = 0
    for table, ts_col in [
        ("measurements_15min_recent", "ts"),
        ("measurements_hourly", "ts"),
        ("measurements_daily", "day"),
    ]:
        before = con.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {ts_col} < ?", [cutoff]
        ).fetchone()
        n = int(before[0]) if before else 0
        if n == 0:
            continue
        con.execute(f"DELETE FROM {table} WHERE {ts_col} < ?", [cutoff])
        removed += n
    return removed


# -- Top-level bootstrap pass ----------------------------------------


def run_bootstrap(
    reader: OracleReader,
    con: Any,
    *,
    retention_years: int,
    now: datetime | None = None,
) -> BootstrapStats:
    """Run the initial Oracle → DuckDB load.

    The caller is responsible for opening the DuckDB connection in
    *write* mode and closing it afterwards. ``con`` must have a fresh
    schema applied (``init_schema()``) or this function will apply it.
    """
    if now is None:
        now = datetime.utcnow()

    stats = BootstrapStats()
    init_schema(con)

    log.info("bootstrap: loading dimensions")
    f, c = load_dimensions(reader, con)
    stats.facilities_loaded = f
    stats.components_loaded = c

    retention_start = now - timedelta(days=365 * retention_years)
    log.info(
        "bootstrap: pulling raw measurements from %s to %s",
        retention_start, now,
    )

    components = [(r[0], r[1]) for r in reader.list_components() if r[0] and r[1]]
    for anr, fnr in components:
        for chunk_start, chunk_end in _month_chunks(retention_start, now):
            n = load_raw_chunk(reader, con, str(anr), str(fnr), chunk_start, chunk_end)
            stats.raw_rows_loaded += n
            stats.chunks_processed += 1

    log.info("bootstrap: building hourly rollups")
    stats.hourly_rows_built = rebuild_hourly_from_raw(con)

    update_coverage(con)
    update_sync_status(
        con,
        status="ok",
        source_min_ts=retention_start,
        source_max_ts=now,
        retained_min_ts=retention_start,
        retained_max_ts=now,
        last_prune_ts=None,
    )
    log.info(
        "bootstrap: done. facilities=%d components=%d raw=%d hourly=%d",
        stats.facilities_loaded, stats.components_loaded,
        stats.raw_rows_loaded, stats.hourly_rows_built,
    )
    return stats


# -- Weekly incremental sync -----------------------------------------


@dataclass
class WeeklySyncStats:
    new_raw_rows: int = 0
    rebuilt_hourly_rows: int = 0
    pruned_rows: int = 0
    chunks_processed: int = 0
    status: str = "ok"
    error_message: str | None = None


def _read_source_max_ts(con: Any) -> datetime | None:
    row = con.execute("SELECT source_max_ts FROM sync_status WHERE id = 1").fetchone()
    return row[0] if row else None


def run_weekly_sync(
    reader: OracleReader,
    con: Any,
    *,
    retention_years: int,
    now: datetime | None = None,
    recent_raw_months: int | None = None,
) -> WeeklySyncStats:
    """Pull new data since the last sync, rebuild affected aggregates, prune old.

    Run this against the *staging* DuckDB file (``dashboard.next.duckdb``).
    The caller is responsible for the atomic ``os.replace`` swap into the
    active path after a successful sync. See ``scripts/duckdb_weekly_sync.py``.
    """
    if now is None:
        now = datetime.utcnow()

    stats = WeeklySyncStats()
    init_schema(con)

    # Always refresh dimensions — they're tiny and rarely change.
    load_dimensions(reader, con)

    last_max = _read_source_max_ts(con)
    if last_max is None:
        # Empty staging file → behave like a bootstrap from scratch.
        log.info("weekly_sync: empty DB, falling back to full bootstrap path")
        bs = run_bootstrap(reader, con, retention_years=retention_years, now=now)
        stats.new_raw_rows = bs.raw_rows_loaded
        stats.rebuilt_hourly_rows = bs.hourly_rows_built
        stats.chunks_processed = bs.chunks_processed
        return stats

    log.info("weekly_sync: incremental pull from %s to %s", last_max, now)

    components = [(r[0], r[1]) for r in reader.list_components() if r[0] and r[1]]
    for anr, fnr in components:
        for chunk_start, chunk_end in _month_chunks(last_max, now):
            n = load_raw_chunk(reader, con, str(anr), str(fnr), chunk_start, chunk_end)
            stats.new_raw_rows += n
            stats.chunks_processed += 1

    # Rebuild only the hours touched by the new data.
    stats.rebuilt_hourly_rows = rebuild_hourly_from_raw(con, since=last_max)

    # Prune both raw (older than DUCKDB_RECENT_RAW_MONTHS) and
    # aggregates (older than retention_years).
    retention_cutoff = now - timedelta(days=365 * retention_years)
    pruned = prune_older_than(con, retention_cutoff)
    stats.pruned_rows = pruned

    if recent_raw_months is not None and recent_raw_months > 0:
        raw_cutoff = now - timedelta(days=30 * recent_raw_months)
        if raw_cutoff > retention_cutoff:
            con.execute(
                "DELETE FROM measurements_15min_recent WHERE ts < ?",
                [raw_cutoff],
            )

    update_coverage(con)
    update_sync_status(
        con,
        status="ok",
        source_min_ts=retention_cutoff,
        source_max_ts=now,
        retained_min_ts=retention_cutoff,
        retained_max_ts=now,
        last_prune_ts=now,
    )
    log.info(
        "weekly_sync: done. raw=%d hourly=%d pruned=%d chunks=%d",
        stats.new_raw_rows, stats.rebuilt_hourly_rows,
        stats.pruned_rows, stats.chunks_processed,
    )
    return stats
