"""Phase 2: DuckDB infrastructure smoke tests.

These exercise the schema DDL, the file-mtime-aware connection wrapper,
the coverage map, and the empty-stub repository. All run against tiny
on-disk DuckDB files in ``tmp_path`` so the suite remains hermetic.

The whole suite is skipped if ``duckdb`` isn't installed — the package
is optional per the read-replica plan.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta

import pytest

duckdb = pytest.importorskip("duckdb")

from app.duckdb.connection import DuckDBHandle, get_duckdb_handle, reset_duckdb_handle
from app.duckdb.coverage import Coverage, CoverageRow
from app.duckdb.repository import DuckDBRepository
from app.duckdb.schema import (
    DIM_MEASUREMENT_TYPE_SEED,
    SCHEMA_VERSION,
    init_schema,
)


# -- helpers ---------------------------------------------------------


def _build_fresh_db(path: str) -> None:
    """Build an empty DuckDB with the dashboard schema, then close it."""
    con = duckdb.connect(path)
    init_schema(con)
    con.close()


def _seed_minimal(path: str) -> None:
    """Bootstrap a tiny coverage scenario for routing tests."""
    con = duckdb.connect(path)
    init_schema(con)

    con.executemany(
        "INSERT OR REPLACE INTO dim_anlage(anr, anlagenname) VALUES (?, ?)",
        [("A1", "Werk Nord"), ("A2", "Werk Süd")],
    )
    con.executemany(
        "INSERT OR REPLACE INTO dim_betriebsmittel"
        "(anr, fnr, feldname_kurz, spannungsebene) VALUES (?, ?, ?, ?)",
        [
            ("A1", "F1", "Trafo 1", "MS"),
            ("A1", "F2", "Einspeisung A", "MS"),
            ("A2", "F1", "Trafo 2", "NS"),
        ],
    )

    # measurements_hourly with one row to anchor a coverage range
    base = datetime(2024, 1, 1, 0, 0, 0)
    con.execute(
        "INSERT INTO measurements_hourly"
        "(ts, anr, fnr, p_avg, p_min, p_max, q_avg, q_min, q_max,"
        " s_avg, s_min, s_max, u_avg, u_min, u_max,"
        " i_avg, i_min, i_max, sample_count) VALUES "
        "(?, 'A1', 'F1', 1,1,1, 1,1,1, 1,1,1, 1,1,1, 1,1,1, 4)",
        [base],
    )
    con.execute(
        "INSERT INTO duckdb_coverage(table_name, min_ts, max_ts, row_count, granularity) "
        "VALUES (?, ?, ?, ?, ?)",
        ["measurements_hourly", base, base + timedelta(days=365 * 2), 17_520, "hourly"],
    )
    con.close()


# -- schema ----------------------------------------------------------


def test_init_schema_idempotent(tmp_path) -> None:
    path = str(tmp_path / "init.duckdb")
    _build_fresh_db(path)

    # Calling again must not error or duplicate seed rows.
    con = duckdb.connect(path)
    init_schema(con)
    seed_count = con.execute(
        "SELECT COUNT(*) FROM dim_measurement_type"
    ).fetchone()[0]
    assert seed_count == len(DIM_MEASUREMENT_TYPE_SEED)
    sync_count = con.execute("SELECT COUNT(*) FROM sync_status").fetchone()[0]
    assert sync_count == 1
    version = con.execute(
        "SELECT schema_version FROM sync_status WHERE id = 1"
    ).fetchone()[0]
    assert version == SCHEMA_VERSION
    con.close()


def test_init_schema_creates_all_tables(tmp_path) -> None:
    path = str(tmp_path / "init2.duckdb")
    _build_fresh_db(path)
    con = duckdb.connect(path, read_only=True)
    tables = {r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'main'"
    ).fetchall()}
    con.close()
    expected = {
        "dim_anlage",
        "dim_betriebsmittel",
        "dim_measurement_type",
        "measurements_15min_recent",
        "measurements_hourly",
        "measurements_daily",
        "sync_status",
        "duckdb_coverage",
    }
    assert expected.issubset(tables)


# -- connection / mtime swap -----------------------------------------


def test_handle_opens_lazily(tmp_path) -> None:
    path = str(tmp_path / "lazy.duckdb")
    _build_fresh_db(path)
    h = DuckDBHandle(path)
    assert h._con is None  # type: ignore[attr-defined]
    rows = h.fetchall("SELECT 1")
    assert rows == [(1,)]
    assert h._con is not None  # type: ignore[attr-defined]


def test_handle_missing_file_raises(tmp_path) -> None:
    h = DuckDBHandle(str(tmp_path / "missing.duckdb"))
    with pytest.raises(FileNotFoundError):
        h.fetchall("SELECT 1")


def test_handle_reopens_after_mtime_change(tmp_path) -> None:
    """Bump the file's mtime and assert the handle re-opens.

    We don't try to verify *content* swap here — that's brittle across
    filesystems (WAL files, OS caches, …). The behaviour we care about
    is that ``_ensure_fresh()`` detects mtime drift and opens a fresh
    DuckDB connection, which is what the weekly sync depends on.
    """
    path = str(tmp_path / "swap.duckdb")
    _seed_minimal(path)
    h = DuckDBHandle(path)
    h.fetchall("SELECT 1")  # forces _open
    first_con = h._con  # type: ignore[attr-defined]
    first_mtime_ns = h._mtime_ns  # type: ignore[attr-defined]
    assert first_con is not None

    # Bump the mtime as if a sync just landed.
    new_mtime = time.time() + 60
    os.utime(path, (new_mtime, new_mtime))

    h.fetchall("SELECT 1")
    second_con = h._con  # type: ignore[attr-defined]
    second_mtime_ns = h._mtime_ns  # type: ignore[attr-defined]

    assert second_mtime_ns != first_mtime_ns
    # Different DuckDB connection object → we really did re-open.
    assert second_con is not first_con


def test_handle_does_not_reopen_when_mtime_unchanged(tmp_path) -> None:
    """The fast path must not reopen on every call — only on swap."""
    path = str(tmp_path / "stable.duckdb")
    _seed_minimal(path)
    h = DuckDBHandle(path)
    h.fetchall("SELECT 1")
    first_con = h._con  # type: ignore[attr-defined]

    h.fetchall("SELECT 1")
    h.fetchall("SELECT 1")
    assert h._con is first_con  # type: ignore[attr-defined]


def test_get_duckdb_handle_caches_and_resets(tmp_path) -> None:
    path = str(tmp_path / "singleton.duckdb")
    _build_fresh_db(path)
    a = get_duckdb_handle(path)
    b = get_duckdb_handle(path)
    assert a is b
    reset_duckdb_handle()
    c = get_duckdb_handle(path)
    assert c is not a


# -- coverage --------------------------------------------------------


def test_coverage_row_covers() -> None:
    r = CoverageRow(
        "measurements_hourly",
        datetime(2023, 1, 1),
        datetime(2026, 1, 1),
        100_000,
        "hourly",
    )
    assert r.covers(datetime(2024, 6, 1), datetime(2024, 12, 1))
    assert not r.covers(datetime(2022, 1, 1), datetime(2024, 1, 1))
    assert not r.covers(datetime(2024, 1, 1), datetime(2027, 1, 1))


def test_coverage_picks_granularity(tmp_path) -> None:
    path = str(tmp_path / "cov.duckdb")
    _seed_minimal(path)
    h = DuckDBHandle(path)
    cov = Coverage(h)

    # 1 month inside the hourly window → preferred 15min, only hourly available.
    start = datetime(2024, 6, 1)
    end = datetime(2024, 7, 1)
    assert cov.preferred_granularity(start, end) == "hourly"
    assert cov.pick_granularity(start, end) == "hourly"

    # Window outside coverage → no answer.
    far_start = datetime(2020, 1, 1)
    far_end = datetime(2020, 6, 1)
    assert cov.pick_granularity(far_start, far_end) is None


def test_coverage_empty_db_returns_none(tmp_path) -> None:
    path = str(tmp_path / "empty.duckdb")
    _build_fresh_db(path)
    h = DuckDBHandle(path)
    cov = Coverage(h)
    assert cov.all() == {}
    assert cov.pick_granularity(datetime(2024, 1, 1), datetime(2024, 12, 1)) is None


# -- repository stubs ------------------------------------------------


def test_repository_dims_round_trip(tmp_path) -> None:
    path = str(tmp_path / "repo.duckdb")
    _seed_minimal(path)
    h = DuckDBHandle(path)
    repo = DuckDBRepository(h)

    facilities = repo.list_facilities()
    assert any(row[0] == "A1" for row in facilities)
    components = repo.list_components_by_facility("A1")
    assert len(components) == 2
    name = repo.component_name("A1", "F1")
    assert name == "Trafo 1"
    rng = repo.date_range("A1", "F1")
    assert rng is not None and rng[0] is not None


def test_repository_returns_empty_on_empty_db(tmp_path) -> None:
    """With no measurement rows, every fact method returns the
    empty-but-correctly-shaped result.

    Phase 6 implementations replace what used to be stubs. The router
    still treats an empty result as 'DuckDB has nothing useful' and
    falls back to Oracle via the coverage gate — the gate is checked
    *before* the SQL runs, so this test just pins the shape contract.
    """
    path = str(tmp_path / "stubs.duckdb")
    _build_fresh_db(path)
    h = DuckDBHandle(path)
    repo = DuckDBRepository(h)

    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None}
    assert repo.count_points("P", params) == 0
    assert list(repo.heatmap("P", params)) == []
    # statistics() now returns a row of NULLs/zeros — matches Oracle's
    # behaviour for the same window with no rows. The service layer
    # already handles this via `if not row or row[0] == 0`.
    row = repo.statistics("P", params)
    assert row is not None and row[0] == 0
    # correlation_matrix_corr is still a Phase 7 TODO — empty None still holds.
    assert repo.correlation_matrix_corr(params) is None
