"""Phase 6: numeric correctness of the DuckDB query twins.

Each test seeds a tiny DuckDB, runs the twin SQL, and asserts both
the row shape AND the numeric agreement against a hand-computed
expected value. The goal is to pin the contract that DuckDB twins
return rows in the *same shape* as Oracle so service-layer parsing
doesn't have to change.

Service-layer integration (and Oracle-vs-DuckDB benchmarking against
real data) lands in Phase 7.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

import pytest

duckdb = pytest.importorskip("duckdb")

from app.duckdb.queries import hourly_cols, raw_col
from app.duckdb.repository import DuckDBRepository
from app.duckdb.schema import init_schema
from app.duckdb.connection import DuckDBHandle


# -- helpers ---------------------------------------------------------


def _seed_hourly(con, anr="A1", fnr="F1", base=None, hours=24, p_value=10.0):
    """Insert ``hours`` hourly rows with deterministic P values."""
    if base is None:
        base = datetime(2024, 6, 1, 0, 0, 0)
    rows = []
    for h in range(hours):
        rows.append((
            base + timedelta(hours=h), anr, fnr,
            p_value + h, p_value, p_value + h,  # P avg/min/max
            1.0, 1.0, 1.0,
            1.0, 1.0, 1.0,
            230.0, 229.0, 231.0,
            50.0, 50.0, 50.0,
            4,  # sample_count (4 fifteen-min rows / hour)
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


@pytest.fixture
def repo(tmp_path):
    path = str(tmp_path / "q.duckdb")
    con = duckdb.connect(path)
    init_schema(con)
    _seed_hourly(con, hours=24)
    con.close()
    h = DuckDBHandle(path)
    return DuckDBRepository(h)


# -- column mappers --------------------------------------------------


def test_raw_and_hourly_column_maps() -> None:
    assert raw_col("P") == "p_mw"
    assert raw_col("u") == "u_kv"  # case-insensitive
    avg, mn, mx = hourly_cols("Q")
    assert (avg, mn, mx) == ("q_avg", "q_min", "q_max")
    with pytest.raises(ValueError):
        raw_col("XYZ")


# -- count_points ----------------------------------------------------


def test_count_points_sums_sample_counts(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None}
    # 24 hourly rows × sample_count 4 = 96.
    assert repo.count_points("P", params) == 96


# -- statistics ------------------------------------------------------


def test_statistics_returns_count_mean_min_max_std(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None}
    row = repo.statistics("P", params)
    assert row is not None
    cnt, mean_val, min_val, max_val, std_val = row
    # 24 rows with sample_count 4 each:
    assert cnt == 96
    # Weighted mean = sum(p_avg * 4) / 96 = mean(p_avg) for constant counts
    # p_avg = 10..33 → mean = 21.5
    assert mean_val == pytest.approx(21.5, abs=1e-6)
    # min/max come from p_min/p_max columns
    assert min_val == pytest.approx(10.0)
    assert max_val == pytest.approx(33.0)
    # STDDEV_POP of 10..33 = sqrt(sum((x-mean)^2) / 24)
    expected_std = math.sqrt(sum((x - 21.5) ** 2 for x in range(10, 34)) / 24)
    assert std_val == pytest.approx(expected_std, rel=1e-6)


# -- heatmap ---------------------------------------------------------


def test_heatmap_groups_by_dow_and_hour(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None}
    rows = repo.heatmap("P", params)
    # 24 hourly rows on a single day → 24 cells.
    assert len(rows) == 24
    # Each row is (dow, hour, avg).
    for dow, hour, avg in rows:
        assert isinstance(dow, int)
        assert isinstance(hour, int)
        assert 0 <= dow <= 6
        assert 0 <= hour <= 23


# -- timeseries_downsampled -----------------------------------------


def test_timeseries_downsampled_hourly_bucket(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None, "bucket": 3600}
    rows = repo.timeseries_downsampled("P", params, agg="AVG")
    # 1-hour buckets → 24 rows.
    assert len(rows) == 24


def test_timeseries_downsampled_daily_bucket(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None, "bucket": 86400}
    rows = repo.timeseries_downsampled("P", params, agg="AVG")
    # All 24 hours in one day → 1 row.
    assert len(rows) == 1
    bucket_time, value = rows[0]
    # The bucket value is the mean of p_avg = 10..33 → 21.5
    assert value == pytest.approx(21.5)


def test_timeseries_downsampled_min_max(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None, "bucket": 86400}
    min_rows = repo.timeseries_downsampled("P", params, agg="MIN")
    max_rows = repo.timeseries_downsampled("P", params, agg="MAX")
    assert min_rows[0][1] == pytest.approx(10.0)
    assert max_rows[0][1] == pytest.approx(33.0)


# -- duration_curve --------------------------------------------------


def test_duration_curve_descending(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None}
    rows = repo.duration_curve("P", params)
    assert len(rows) == 24
    values = [r[0] for r in rows]
    assert values == sorted(values, reverse=True)
    assert values[0] == 33.0
    assert values[-1] == 10.0


# -- daily_profile_combined ------------------------------------------


def test_daily_profile_groups_by_weekend_and_hour(repo) -> None:
    # Seed includes only 2024-06-01 → Saturday → is_weekend = 1
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None}
    rows = repo.daily_profile_combined("P", params)
    # 24 distinct (weekend, hour) buckets all on the same day.
    assert len(rows) == 24
    weekends = {r[0] for r in rows}
    assert weekends == {1}  # Saturday


# -- voltage_band_combined -------------------------------------------


def test_voltage_band_groups_by_weekend_and_slot(repo) -> None:
    params = {"anr": "A1", "fnr": "F1", "start": None, "end": None}
    rows = repo.voltage_band_combined(params)
    # 24 hourly rows, one slot per hour ('00:00' .. '23:00')
    assert len(rows) == 24
    weekends = {r[0] for r in rows}
    assert weekends == {1}
    slots = {r[1] for r in rows}
    assert "00:00" in slots
    assert "23:00" in slots
    # avg / min / max columns
    for is_weekend, slot, mn, avg, mx in rows:
        assert mn <= avg <= mx


# -- empty result (no data in window) -------------------------------


def test_empty_window_returns_empty_rows(repo) -> None:
    params = {
        "anr": "A1", "fnr": "F1",
        "start": "2020-01-01 00:00:00",
        "end": "2020-02-01 00:00:00",
    }
    assert repo.count_points("P", params) == 0
    assert list(repo.heatmap("P", params)) == []
    row = repo.statistics("P", params)
    # statistics still returns a row (with NULL aggregates) — the service
    # layer already handles that branch via `if not row or row[0] == 0`.
    assert row is not None
    assert row[0] == 0
