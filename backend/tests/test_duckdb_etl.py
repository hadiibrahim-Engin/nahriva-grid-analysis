"""Phase 3 ETL: bootstrap pulls Oracle data into DuckDB.

Tests drive the ETL via a deterministic ``FakeOracleReader`` so we
never need a real Oracle connection. The end-to-end assertion is that
the resulting DuckDB has the right dim rows, raw rows, hourly
aggregates and coverage metadata.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable, Sequence

import pytest

duckdb = pytest.importorskip("duckdb")

from app.duckdb.etl import (
    BootstrapStats,
    _month_chunks,
    load_dimensions,
    load_raw_chunk,
    prune_older_than,
    rebuild_hourly_from_raw,
    run_bootstrap,
    update_coverage,
    update_sync_status,
)
from app.duckdb.schema import init_schema


class FakeOracleReader:
    """Deterministic Oracle stand-in for ETL tests."""

    def __init__(
        self,
        facilities: Sequence[tuple],
        components: Sequence[tuple],
        measurements: dict[tuple[str, str], list[tuple]],
    ) -> None:
        self._facilities = list(facilities)
        self._components = list(components)
        self._measurements = measurements

    def list_facilities(self) -> Sequence[tuple]:
        return list(self._facilities)

    def list_components(self) -> Sequence[tuple]:
        return list(self._components)

    def fetch_measurements(
        self,
        anr: str,
        fnr: str,
        start: datetime,
        end: datetime,
    ) -> Iterable[tuple]:
        for row in self._measurements.get((anr, fnr), []):
            ts = row[0]
            if start <= ts < end:
                yield row


# -- month chunking --------------------------------------------------


def test_month_chunks_covers_full_range_with_no_gaps() -> None:
    start = datetime(2024, 1, 15)
    end = datetime(2024, 4, 15)
    chunks = list(_month_chunks(start, end))
    assert chunks[0][0] == start
    assert chunks[-1][1] == end
    # No gap, no overlap between adjacent chunks.
    for (s1, e1), (s2, e2) in zip(chunks, chunks[1:]):
        assert e1 == s2


def test_month_chunks_short_range_single_chunk() -> None:
    start = datetime(2024, 1, 1)
    end = datetime(2024, 1, 5)
    assert list(_month_chunks(start, end)) == [(start, end)]


# -- dimensions ------------------------------------------------------


def test_load_dimensions_populates_both_tables(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "dim.duckdb"))
    init_schema(con)

    reader = FakeOracleReader(
        facilities=[("A1", "Werk Nord"), ("A2", "Werk Süd")],
        components=[
            # Shape matches FDWHRepository.list_all_components():
            # (anr, fnr, feldname_kurz, anlagenname, spannungsebene)
            ("A1", "F1", "Trafo 1", "Werk Nord", "MS"),
            ("A1", "F2", "Einspeisung A", "Werk Nord", "MS"),
            ("A2", "F1", "Trafo 2", "Werk Süd", "NS"),
        ],
        measurements={},
    )
    f, c = load_dimensions(reader, con)
    assert f == 2
    assert c == 3
    rows = con.execute(
        "SELECT anr, anlagenname FROM dim_anlage ORDER BY anr"
    ).fetchall()
    assert rows == [("A1", "Werk Nord"), ("A2", "Werk Süd")]
    comps = con.execute(
        "SELECT anr, fnr, feldname_kurz, spannungsebene FROM dim_betriebsmittel ORDER BY anr, fnr"
    ).fetchall()
    assert comps == [
        ("A1", "F1", "Trafo 1", "MS"),
        ("A1", "F2", "Einspeisung A", "MS"),
        ("A2", "F1", "Trafo 2", "NS"),
    ]
    con.close()


def test_load_dimensions_skips_null_ids(tmp_path) -> None:
    """NULL anr/fnr rows in Oracle must not poison the DuckDB tables."""
    con = duckdb.connect(str(tmp_path / "dimnull.duckdb"))
    init_schema(con)
    reader = FakeOracleReader(
        facilities=[(None, "ghost"), ("A1", "Werk Nord")],
        components=[
            (None, "F1", "Trafo orphan", "Werk Nord", "MS"),
            ("A1", None, "fnr orphan", "Werk Nord", "MS"),
            ("A1", "F1", "Trafo 1", "Werk Nord", "MS"),
        ],
        measurements={},
    )
    f, c = load_dimensions(reader, con)
    assert f == 1
    assert c == 1
    con.close()


# -- raw → hourly ----------------------------------------------------


def _make_15min_series(start: datetime, count: int, anr: str, fnr: str) -> list[tuple]:
    rows = []
    for i in range(count):
        ts = start + timedelta(minutes=15 * i)
        # Deterministic, mtype-independent values so we can verify aggregation.
        rows.append((ts, float(i % 10), float(i % 5), float(i % 7), 230.0, 50.0))
    return rows


def test_load_raw_chunk_inserts_rows(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "raw.duckdb"))
    init_schema(con)
    reader = FakeOracleReader(
        facilities=[],
        components=[],
        measurements={
            ("A1", "F1"): _make_15min_series(datetime(2024, 1, 1), 8, "A1", "F1"),
        },
    )
    n = load_raw_chunk(
        reader, con, "A1", "F1",
        datetime(2024, 1, 1), datetime(2024, 1, 2),
    )
    assert n == 8
    total = con.execute(
        "SELECT COUNT(*) FROM measurements_15min_recent"
    ).fetchone()[0]
    assert total == 8


def test_rebuild_hourly_aggregates_correctly(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "hr.duckdb"))
    init_schema(con)
    reader = FakeOracleReader(
        facilities=[],
        components=[],
        measurements={
            # 4 rows per hour × 3 hours = 12 rows
            ("A1", "F1"): _make_15min_series(datetime(2024, 1, 1, 0, 0), 12, "A1", "F1"),
        },
    )
    load_raw_chunk(
        reader, con, "A1", "F1",
        datetime(2024, 1, 1), datetime(2024, 1, 2),
    )
    built = rebuild_hourly_from_raw(con)
    assert built == 3  # 3 hours of data

    # Spot check: first hour's p_avg should be mean of (0,1,2,3) % 10 = 1.5
    rows = con.execute(
        "SELECT ts, p_avg, sample_count FROM measurements_hourly ORDER BY ts"
    ).fetchall()
    assert rows[0][1] == pytest.approx(1.5)
    assert rows[0][2] == 4


def test_rebuild_hourly_since_keeps_old_rows(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "hri.duckdb"))
    init_schema(con)
    reader = FakeOracleReader(
        facilities=[], components=[],
        measurements={
            ("A1", "F1"): _make_15min_series(datetime(2024, 1, 1, 0, 0), 24, "A1", "F1"),
        },
    )
    load_raw_chunk(reader, con, "A1", "F1",
                   datetime(2024, 1, 1), datetime(2024, 1, 2))
    rebuild_hourly_from_raw(con)
    total_before = con.execute(
        "SELECT COUNT(*) FROM measurements_hourly"
    ).fetchone()[0]

    # Re-build only from hour 3 onward — the first 3 hours stay.
    rebuild_hourly_from_raw(con, since=datetime(2024, 1, 1, 3, 0))
    rows = con.execute(
        "SELECT COUNT(*) FROM measurements_hourly"
    ).fetchone()[0]
    assert rows == total_before  # same total: 0..2 kept, 3..5 re-inserted


# -- coverage / sync_status ------------------------------------------


def test_update_coverage_reflects_row_counts(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "cov.duckdb"))
    init_schema(con)
    reader = FakeOracleReader(
        facilities=[], components=[],
        measurements={
            ("A1", "F1"): _make_15min_series(datetime(2024, 1, 1), 8, "A1", "F1"),
        },
    )
    load_raw_chunk(reader, con, "A1", "F1",
                   datetime(2024, 1, 1), datetime(2024, 1, 2))
    rebuild_hourly_from_raw(con)
    update_coverage(con)

    rows = {
        r[0]: r for r in con.execute(
            "SELECT table_name, min_ts, max_ts, row_count FROM duckdb_coverage"
        ).fetchall()
    }
    assert rows["measurements_15min_recent"][3] == 8
    assert rows["measurements_hourly"][3] == 2  # 8 × 15min = 2 hours


def test_update_sync_status_writes_singleton(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "ss.duckdb"))
    init_schema(con)
    now = datetime(2024, 5, 1)
    update_sync_status(
        con,
        status="ok",
        source_min_ts=now - timedelta(days=365 * 3),
        source_max_ts=now,
        retained_min_ts=now - timedelta(days=365 * 3),
        retained_max_ts=now,
        last_prune_ts=now,
        error_message=None,
    )
    rows = con.execute(
        "SELECT status, source_max_ts, schema_version FROM sync_status"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "ok"


# -- pruning ---------------------------------------------------------


def test_prune_older_than_drops_rows(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "pr.duckdb"))
    init_schema(con)
    # 2 hours: one inside retention, one before
    rows = [
        (datetime(2020, 1, 1, 0, 0), "A1", "F1", 1.0, 1.0, 1.0, 230.0, 50.0),
        (datetime(2024, 1, 1, 0, 0), "A1", "F1", 2.0, 2.0, 2.0, 230.0, 50.0),
    ]
    con.executemany(
        "INSERT INTO measurements_15min_recent"
        "(ts, anr, fnr, p_mw, q_mvar, s_mva, u_kv, i_a)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    removed = prune_older_than(con, datetime(2023, 1, 1))
    assert removed == 1
    surviving = con.execute(
        "SELECT COUNT(*) FROM measurements_15min_recent"
    ).fetchone()[0]
    assert surviving == 1


# -- end-to-end bootstrap --------------------------------------------


def test_run_bootstrap_end_to_end(tmp_path) -> None:
    con = duckdb.connect(str(tmp_path / "e2e.duckdb"))

    base = datetime(2024, 1, 1)
    reader = FakeOracleReader(
        facilities=[("A1", "Werk Nord")],
        components=[("A1", "F1", "Trafo 1", "Werk Nord", "MS")],
        measurements={
            ("A1", "F1"): _make_15min_series(base, 100, "A1", "F1"),
        },
    )
    stats = run_bootstrap(
        reader, con, retention_years=3,
        now=base + timedelta(days=30),
    )
    assert isinstance(stats, BootstrapStats)
    assert stats.facilities_loaded == 1
    assert stats.components_loaded == 1
    # 100 raw rows, all within the chunked window.
    assert stats.raw_rows_loaded == 100
    # 100 / 4 = 25 hourly buckets.
    assert stats.hourly_rows_built == 25

    status = con.execute(
        "SELECT status FROM sync_status WHERE id = 1"
    ).fetchone()
    assert status[0] == "ok"

    cov = {
        r[0]: r[3] for r in con.execute(
            "SELECT table_name, min_ts, max_ts, row_count FROM duckdb_coverage"
        ).fetchall()
    }
    assert cov["measurements_15min_recent"] == 100
    assert cov["measurements_hourly"] == 25
    con.close()
