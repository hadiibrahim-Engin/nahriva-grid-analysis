"""Smoke tests for the Phase 3 SQL refactors.

These mock the repository so no Oracle is required. The point isn't to
test SQL correctness (which can only be verified against the real DB)
but to lock in the row-shape contract between query result and service
parsing, which is the regression risk after the refactor.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable

import pytest

from app.core.errors import ResourceNotFoundError
from app.services.analytics_service import AnalyticsService


class FakeRepo:
    """Minimal stub of FDWHRepository configured per test."""

    def __init__(
        self,
        *,
        voltage_band: Iterable[tuple] = (),
        daily_profile: Iterable[tuple] = (),
        quality: Iterable[tuple] = (),
        correlation_row: tuple | None = None,
        correlation_scatter: Iterable[tuple] = (),
        power_factor: Iterable[tuple] = (),
        exceedance: Iterable[tuple] = (),
        season_monthly: Iterable[tuple] = (),
        boxplot_hourly: Iterable[tuple] = (),
        boxplot_grouped: Iterable[tuple] = (),
    ) -> None:
        self._voltage = list(voltage_band)
        self._daily = list(daily_profile)
        self._quality = list(quality)
        self._corr = correlation_row
        self._corr_scatter = list(correlation_scatter)
        self._power_factor = list(power_factor)
        self._exceedance = list(exceedance)
        self._season = list(season_monthly)
        self._boxplot_hourly = list(boxplot_hourly)
        self._boxplot_grouped = list(boxplot_grouped)

    def component_name(self, anr: str, fnr: str) -> str:
        return f"{anr}_{fnr}"

    def voltage_band_combined(self, _params: dict[str, Any]):
        return self._voltage

    def daily_profile_combined(self, _mtype: str, _params: dict[str, Any]):
        return self._daily

    def quality_combined(self, _params: dict[str, Any]):
        return self._quality

    def correlation_matrix_corr(self, _params: dict[str, Any]):
        return self._corr

    def correlation_scatter(self, _x: str, _y: str, _params: dict[str, Any]):
        return self._corr_scatter

    def power_factor_downsampled(self, _params: dict[str, Any]):
        return self._power_factor

    def power_factor_timeseries(self, _params: dict[str, Any]):
        return self._power_factor

    def exceedance_timeline(self, _mtype: str, _params: dict[str, Any]):
        return self._exceedance

    def season_monthly_values(self, _params: dict[str, Any]):
        return self._season

    def boxplot_hourly(self, _mtype: str, _params: dict[str, Any]):
        return self._boxplot_hourly

    def boxplot_grouped(self, _mtype: str, _group_by: str, _params: dict[str, Any]):
        return self._boxplot_grouped


# -- voltage_band ----------------------------------------------------


def test_voltage_band_partitions_weekday_and_weekend():
    repo = FakeRepo(voltage_band=[
        (0, "08:00", 220.0, 230.0, 240.0),
        (0, "09:00", 221.0, 231.0, 241.0),
        (1, "08:00", 215.0, 225.0, 235.0),
    ])
    response = AnalyticsService(repo).get_voltage_band("A1_F1", None, None)

    assert len(response.weekday) == 2
    assert len(response.weekend) == 1
    assert response.weekday[0].mean == 230.0
    assert response.weekend[0].mean == 225.0
    # Reference date constant + slot, parsed by pydantic into a datetime.
    assert response.weekday[0].timestamp.hour == 8


def test_voltage_band_empty_db_yields_empty_lists():
    response = AnalyticsService(FakeRepo()).get_voltage_band("A1_F1", None, None)
    assert response.weekday == []
    assert response.weekend == []


# -- daily_profile ---------------------------------------------------


def test_daily_profile_partitions_and_computes_std_dev():
    # variance = avg_sq - avg^2 = 25 - 16 = 9 -> std_dev = 3.0
    repo = FakeRepo(daily_profile=[
        (0, 8.0, 4.0, 100, 25.0),
        (1, 8.0, 5.0, 1, 30.0),    # count == 1 -> std_dev=None
    ])
    response = AnalyticsService(repo).get_daily_profile("A1_F1", "P", None, None)

    assert len(response.weekday_avg) == 1
    assert len(response.weekend_avg) == 1
    assert response.weekday_avg[0].std_dev == 3.0
    assert response.weekend_avg[0].std_dev is None


def test_daily_profile_negative_variance_clipped_to_zero():
    """Floating-point drift can give avg_sq < avg^2 by a tiny amount."""
    repo = FakeRepo(daily_profile=[(0, 0.0, 10.0, 50, 99.99)])
    response = AnalyticsService(repo).get_daily_profile("A1_F1", "P", None, None)
    assert response.weekday_avg[0].std_dev == 0.0


# -- quality (GROUPING SETS) -----------------------------------------


def test_quality_separates_rollup_rows_from_hourly():
    # hour IS NULL => daily rollup; non-NULL => per-hour
    repo = FakeRepo(quality=[
        ("2025-01-01", None, 96),     # full day
        ("2025-01-01", 0, 4),
        ("2025-01-01", 1, 4),
        ("2025-01-02", None, 48),     # half day
        ("2025-01-02", 0, 2),
    ])
    response = AnalyticsService(repo).get_quality("A1_F1", None, None, expected_per_day=96)

    assert len(response.daily_counts) == 2
    assert response.daily_counts[0].day == "2025-01-01"
    assert response.daily_counts[0].count == 96
    assert response.daily_counts[0].missing_pct == 0.0
    assert response.daily_counts[1].missing_pct == 50.0

    assert len(response.gap_heatmap) == 3
    assert all(cell.hour is not None for cell in response.gap_heatmap)


def test_quality_missing_pct_floored_at_zero_when_over_expected():
    repo = FakeRepo(quality=[("2025-01-01", None, 120)])
    response = AnalyticsService(repo).get_quality("A1_F1", None, None, expected_per_day=96)
    assert response.daily_counts[0].missing_pct == 0.0


# -- correlation_matrix (Oracle CORR aggregates) ---------------------


def test_correlation_matrix_maps_fixed_pair_order_to_requested_subset():
    # Pair order in the SQL: P_Q, P_S, P_U, P_I, Q_S, Q_U, Q_I, S_U, S_I, U_I
    repo = FakeRepo(correlation_row=(0.9, 0.8, 0.1, 0.2, 0.7, 0.15, 0.25, 0.3, 0.35, 0.05))
    response = AnalyticsService(repo).get_correlation_matrix(
        "A1_F1", "P,Q,S", None, None,
    )
    assert response.types == ["P", "Q", "S"]
    matrix = response.matrix
    # Diagonal is 1.0
    for i in range(3):
        assert matrix[i][i] == 1.0
    # Symmetry across the diagonal
    assert matrix[0][1] == matrix[1][0] == 0.9
    assert matrix[0][2] == matrix[2][0] == 0.8
    assert matrix[1][2] == matrix[2][1] == 0.7


def test_correlation_matrix_handles_null_pairs():
    """Oracle returns NULL when not enough data for a pair.

    A missing pair must stay None (no data), NOT 0.0 — a fabricated "zero
    correlation" is indistinguishable from a real one in the plot.
    """
    repo = FakeRepo(correlation_row=(0.9, None, 0.1, 0.2, 0.7, 0.15, 0.25, 0.3, 0.35, 0.05))
    response = AnalyticsService(repo).get_correlation_matrix("A1_F1", "P,S", None, None)
    assert response.matrix[0][1] is None
    assert response.matrix[1][0] is None
    assert response.matrix[0][0] == 1.0  # diagonal still self-correlation


def test_correlation_matrix_rejects_fewer_than_two_types():
    repo = FakeRepo(correlation_row=(0.9,) * 10)
    with pytest.raises(ResourceNotFoundError):
        AnalyticsService(repo).get_correlation_matrix("A1_F1", "P", None, None)


def test_correlation_matrix_all_null_row_treated_as_no_data():
    repo = FakeRepo(correlation_row=(None,) * 10)
    with pytest.raises(ResourceNotFoundError):
        AnalyticsService(repo).get_correlation_matrix("A1_F1", "P,Q,S", None, None)


# -- Decimal/float boundary regression (Oracle returns decimal.Decimal) --
# Oracle's NUMBER type lands in Python as decimal.Decimal; mixing with float
# literals like `** 0.5` raises TypeError. These tests pin each analytics
# endpoint that does math on Oracle aggregates so the regression cannot
# silently reappear.


def test_daily_profile_accepts_decimal_inputs_for_std_dev():
    """Repro of `TypeError: ... 'decimal.Decimal' and 'float'` at L177."""
    repo = FakeRepo(daily_profile=[
        (0, Decimal("8.0"), Decimal("4.0"), 100, Decimal("25.0")),
    ])
    response = AnalyticsService(repo).get_daily_profile("A1_F1", "P", None, None)
    assert response.weekday_avg[0].std_dev == 3.0  # variance 9.0 → sqrt = 3.0


def test_correlation_scatter_accepts_decimal_inputs_for_pearson():
    """Repro of `TypeError: ... 'decimal.Decimal' and 'float'` in _pearson()."""
    repo = FakeRepo(correlation_scatter=[
        (Decimal("1"), Decimal("2")),
        (Decimal("2"), Decimal("4")),
        (Decimal("3"), Decimal("6")),
        (Decimal("4"), Decimal("8")),
    ])
    response = AnalyticsService(repo).get_correlation("A1_F1", "P", "Q", None, None)
    assert response.correlation == pytest.approx(1.0)
    assert response.lag_minutes == 0


def test_correlation_interpretation_hint_present():
    """Strong P/Q positive correlation should surface the load-coupling hint."""
    repo = FakeRepo(correlation_scatter=[(i, i) for i in range(1, 11)])
    response = AnalyticsService(repo).get_correlation("A1_F1", "P", "Q", None, None)
    assert response.correlation == pytest.approx(1.0)
    assert "Starke Kopplung" in response.interpretation
    assert "induktive Last" in response.interpretation


def test_correlation_lag_shifts_compared_samples():
    """With Y = X shifted by one sample, lag=15 (one 15-min bucket) → r ≈ 1.
    With lag=0, the misaligned series should produce a much weaker r.
    """
    x = list(range(1, 11))
    y = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9]  # Y leads X by one sample
    repo = FakeRepo(correlation_scatter=list(zip(x, y)))
    no_lag = AnalyticsService(repo).get_correlation("A1_F1", "P", "Q", None, None, 0)
    with_lag = AnalyticsService(repo).get_correlation("A1_F1", "P", "Q", None, None, 15)
    assert with_lag.correlation > no_lag.correlation
    assert with_lag.lag_minutes == 15
    assert "Verschiebung" in with_lag.interpretation


def test_power_factor_accepts_decimal_inputs():
    """cos_phi / tan_phi math at L328/L331 mixed Decimal with float literals."""
    repo = FakeRepo(power_factor=[
        (datetime(2025, 1, 1, 10, 0), Decimal("80"), Decimal("60"), Decimal("100")),
        (datetime(2025, 1, 1, 10, 15), Decimal("100"), Decimal("0"), Decimal("100")),
    ])
    response = AnalyticsService(repo).get_power_factor("A1_F1", None, None, downsample_minutes=15)
    # 80/100 = 0.8; tan_phi = 60/80 = 0.75
    assert response.data[0].cos_phi == pytest.approx(0.8)
    assert response.data[0].tan_phi == pytest.approx(0.75)
    # cos_phi = 100/100 = 1.0 (clamped)
    assert response.data[1].cos_phi == pytest.approx(1.0)


def test_exceedance_accepts_decimal_inputs_for_mean_value():
    """`stats["sum"] += value` mixed float dict with Decimal row value."""
    rows = [
        ("2025-01-01", datetime(2025, 1, 1, 0, 0), Decimal("90")),
        ("2025-01-01", datetime(2025, 1, 1, 0, 15), Decimal("95")),
        ("2025-01-02", datetime(2025, 1, 2, 0, 0), Decimal("50")),  # below threshold
    ]
    repo = FakeRepo(exceedance=rows)
    response = AnalyticsService(repo).get_exceedance("A1_F1", "P", threshold=80.0)
    # Two points above threshold on day 1, mean (90 + 95) / 2 = 92.5
    assert response.top_days[0].mean_value == pytest.approx(92.5)
    assert response.top_days[0].max_value == pytest.approx(95.0)


# -- season_radar: only compute the requested measurements -----------

def _season_rows():
    # (month, P, Q, S) for two months
    return [
        (1, 10.0, 5.0, 12.0),
        (2, 20.0, 6.0, 22.0),
    ]


def test_season_radar_returns_only_requested_types():
    repo = FakeRepo(season_monthly=_season_rows())
    response = AnalyticsService(repo).get_season_radar("A1_F1", None, None, types="P")
    assert [s.measurement_type for s in response.series] == ["P"]


def test_season_radar_returns_multiple_requested_types_in_order():
    repo = FakeRepo(season_monthly=_season_rows())
    response = AnalyticsService(repo).get_season_radar("A1_F1", None, None, types="P,S")
    assert [s.measurement_type for s in response.series] == ["P", "S"]


def test_season_radar_without_types_returns_all():
    repo = FakeRepo(season_monthly=_season_rows())
    response = AnalyticsService(repo).get_season_radar("A1_F1", None, None)
    assert [s.measurement_type for s in response.series] == ["P", "Q", "S"]


def test_season_radar_rejects_unsupported_type():
    repo = FakeRepo(season_monthly=_season_rows())
    with pytest.raises(Exception):  # InvalidRequestError → 400
        AnalyticsService(repo).get_season_radar("A1_F1", None, None, types="U")


# -- boxplot -----------------------------------------------------------


def test_boxplot_default_groups_by_hour_via_dedicated_repo_method():
    repo = FakeRepo(boxplot_hourly=[
        (0, 10.0), (0, 20.0), (0, 30.0),
        (1, 40.0), (1, 50.0),
    ])
    response = AnalyticsService(repo).get_boxplot("A1_F1", "P", None, None)

    assert response.group_by == "hour"
    assert [item.label for item in response.items] == ["00:00", "01:00"]
    assert response.items[0].median == 20.0


def test_boxplot_weekday_grouping_uses_weekday_labels():
    # bucket 0=Sunday .. 6=Saturday (matches app/db/queries.py `dow` convention)
    repo = FakeRepo(boxplot_grouped=[
        (0, 5.0), (0, 6.0), (0, 7.0),
        (6, 100.0), (6, 110.0),
    ])
    response = AnalyticsService(repo).get_boxplot("A1_F1", "P", None, None, group_by="weekday")

    assert response.group_by == "weekday"
    assert [item.label for item in response.items] == ["So", "Sa"]
    assert response.items[0].median == 6.0


def test_boxplot_month_grouping_uses_month_labels():
    repo = FakeRepo(boxplot_grouped=[
        (1, 1.0), (1, 2.0),
        (12, 9.0), (12, 10.0),
    ])
    response = AnalyticsService(repo).get_boxplot("A1_F1", "P", None, None, group_by="month")

    assert response.group_by == "month"
    assert [item.label for item in response.items] == ["Jan", "Dez"]


def test_boxplot_weekday_weekend_grouping_uses_two_buckets():
    repo = FakeRepo(boxplot_grouped=[
        (0, 1.0), (0, 2.0),
        (1, 9.0), (1, 10.0),
    ])
    response = AnalyticsService(repo).get_boxplot("A1_F1", "P", None, None, group_by="weekday_weekend")

    assert response.group_by == "weekday_weekend"
    assert [item.label for item in response.items] == ["Werktag", "Wochenende"]


def test_boxplot_rejects_unsupported_group_by():
    repo = FakeRepo(boxplot_hourly=[(0, 1.0)])
    with pytest.raises(Exception):  # InvalidRequestError → 400
        AnalyticsService(repo).get_boxplot("A1_F1", "P", None, None, group_by="year")
