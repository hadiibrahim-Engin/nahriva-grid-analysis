"""Phase 4: weekly incremental sync.

Exercises run_weekly_sync against a staged DuckDB that already contains
a bootstrap-shaped baseline. We assert it pulls only the *new* data,
rebuilds only the hours that changed, prunes rows older than the
retention cutoff, and writes sync_status / coverage.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable, Sequence

import pytest

duckdb = pytest.importorskip("duckdb")

from app.duckdb.etl import (
    WeeklySyncStats,
    rebuild_hourly_from_raw,
    run_bootstrap,
    run_weekly_sync,
)


def _make_15min_series(start: datetime, count: int) -> list[tuple]:
    rows = []
    for i in range(count):
        ts = start + timedelta(minutes=15 * i)
        rows.append((ts, float(i % 10), float(i % 5), float(i % 7), 230.0, 50.0))
    return rows


class FakeReader:
    def __init__(self) -> None:
        self.facilities = [("A1", "Werk Nord")]
        self.components = [("A1", "F1", "Trafo 1", "Werk Nord", "MS")]
        self.measurements: dict[tuple[str, str], list[tuple]] = {}

    def list_facilities(self) -> Sequence[tuple]:
        return list(self.facilities)

    def list_components(self) -> Sequence[tuple]:
        return list(self.components)

    def fetch_measurements(
        self, anr: str, fnr: str, start: datetime, end: datetime,
    ) -> Iterable[tuple]:
        for row in self.measurements.get((anr, fnr), []):
            if start <= row[0] < end:
                yield row


# -- happy path ------------------------------------------------------


def test_weekly_sync_only_pulls_new_data(tmp_path) -> None:
    path = str(tmp_path / "sync.duckdb")
    con = duckdb.connect(path)

    # Bootstrap with 7 days of data
    reader = FakeReader()
    base = datetime(2024, 1, 1)
    reader.measurements[("A1", "F1")] = _make_15min_series(base, 4 * 24 * 7)
    run_bootstrap(reader, con, retention_years=3, now=base + timedelta(days=7))

    raw_before = con.execute(
        "SELECT COUNT(*) FROM measurements_15min_recent"
    ).fetchone()[0]
    assert raw_before == 4 * 24 * 7

    # Now extend Oracle with another 2 days of data; sync should only
    # ingest the new 192 rows.
    new_base = base + timedelta(days=7)
    reader.measurements[("A1", "F1")] = (
        _make_15min_series(base, 4 * 24 * 7)
        + _make_15min_series(new_base, 4 * 24 * 2)
    )
    stats = run_weekly_sync(
        reader, con,
        retention_years=3,
        now=base + timedelta(days=9),
    )
    assert isinstance(stats, WeeklySyncStats)
    assert stats.new_raw_rows == 4 * 24 * 2
    assert stats.rebuilt_hourly_rows >= 1
    con.close()


def test_weekly_sync_on_empty_db_falls_back_to_bootstrap(tmp_path) -> None:
    path = str(tmp_path / "fresh.duckdb")
    con = duckdb.connect(path)

    reader = FakeReader()
    base = datetime(2024, 1, 1)
    reader.measurements[("A1", "F1")] = _make_15min_series(base, 96)
    stats = run_weekly_sync(
        reader, con,
        retention_years=3,
        now=base + timedelta(days=1),
    )
    # Bootstrap-flavoured stats: lots of new data, no prune.
    assert stats.new_raw_rows == 96
    assert stats.rebuilt_hourly_rows == 24
    assert stats.pruned_rows == 0
    con.close()


# -- retention ------------------------------------------------------


def test_weekly_sync_prunes_old_aggregates(tmp_path) -> None:
    path = str(tmp_path / "prune.duckdb")
    con = duckdb.connect(path)

    reader = FakeReader()
    # 5 years of data, but retention_years=2 → 3 years must be pruned.
    base = datetime(2020, 1, 1)
    now = datetime(2025, 1, 1)
    # Use only hourly data — the test exercises the prune path, not bulk-loading
    # of 5 years of 15-min raw (which would be unnecessarily slow here).
    run_bootstrap(reader, con, retention_years=5, now=now)

    # Inject some old hourly rows to simulate a long-running DB
    rows = []
    for d in range(0, 365 * 5, 30):
        ts = base + timedelta(days=d)
        rows.append((
            ts, "A1", "F1",
            1.0, 1.0, 1.0,  1.0, 1.0, 1.0,  1.0, 1.0, 1.0,
            230.0, 230.0, 230.0,  50.0, 50.0, 50.0, 4,
        ))
    con.executemany(
        "INSERT INTO measurements_hourly"
        "(ts, anr, fnr,"
        " p_avg, p_min, p_max, q_avg, q_min, q_max,"
        " s_avg, s_min, s_max, u_avg, u_min, u_max,"
        " i_avg, i_min, i_max, sample_count)"
        " VALUES (?, ?, ?, ?,?,?, ?,?,?, ?,?,?, ?,?,?, ?,?,?, ?)",
        rows,
    )
    before = con.execute(
        "SELECT COUNT(*) FROM measurements_hourly"
    ).fetchone()[0]
    assert before > 0

    stats = run_weekly_sync(
        reader, con,
        retention_years=2,
        now=now,
    )
    assert stats.pruned_rows > 0

    surviving = con.execute(
        "SELECT MIN(ts) FROM measurements_hourly"
    ).fetchone()
    if surviving and surviving[0] is not None:
        cutoff = now - timedelta(days=365 * 2)
        assert surviving[0] >= cutoff
    con.close()


# -- coverage / sync_status reflect the new window ------------------


def test_weekly_sync_updates_metadata(tmp_path) -> None:
    path = str(tmp_path / "meta.duckdb")
    con = duckdb.connect(path)

    reader = FakeReader()
    base = datetime(2024, 1, 1)
    reader.measurements[("A1", "F1")] = _make_15min_series(base, 4 * 24 * 7)
    run_bootstrap(reader, con, retention_years=3, now=base + timedelta(days=7))

    new_base = base + timedelta(days=7)
    reader.measurements[("A1", "F1")] = (
        _make_15min_series(base, 4 * 24 * 7)
        + _make_15min_series(new_base, 4 * 24 * 2)
    )
    sync_now = base + timedelta(days=9)
    run_weekly_sync(reader, con, retention_years=3, now=sync_now)

    status = con.execute(
        "SELECT status, source_max_ts FROM sync_status WHERE id = 1"
    ).fetchone()
    assert status[0] == "ok"
    assert status[1] >= sync_now - timedelta(seconds=2)

    cov = {
        r[0]: r for r in con.execute(
            "SELECT table_name, max_ts, row_count FROM duckdb_coverage"
        ).fetchall()
    }
    # max_ts on the raw table reflects the last ingested 15-min slot,
    # which is sync_now - 15min (last full bucket inside the window).
    assert cov["measurements_15min_recent"][1] == new_base + timedelta(
        minutes=15 * (4 * 24 * 2 - 1)
    )
    con.close()
