"""Contract tests for the split raw/aggregated timeseries service.

Core invariant (hard requirement): a raw request is NEVER downsampled.
``get_raw`` must only ever touch the raw repository query; it must refuse
oversized ranges rather than silently aggregating.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import pytest

from app.core.cache import analytics_cache
from app.core.constants import (
    ONE_HOUR_SECONDS,
    RAW_RANGE_MAX_POINTS,
)
from app.core.errors import (
    InvalidDateRangeError,
    RawRangeTooLargeError,
    ResourceNotFoundError,
    UnsupportedAggregationError,
)
from app.models.schemas import AggregationMethod
from app.services.timeseries_service import TimeseriesService


@pytest.fixture(autouse=True)
def _clear_cache():
    analytics_cache.clear()
    yield
    analytics_cache.clear()


class FakeRepo:
    def __init__(self, *, raw_rows: int = 1) -> None:
        self.raw_calls = 0
        self.downsampled_calls = 0
        self.stats_calls = 0
        self.last_bucket: int | None = None
        self.last_agg: str | None = None
        self.last_raw_params: dict | None = None
        self._raw_rows = raw_rows

    def component_name(self, anr: str, fnr: str) -> str:
        return f"{anr}_{fnr}"

    def statistics(self, _mtype: str, _params: dict[str, Any]):
        self.stats_calls += 1
        return (100, 5.0, 1.0, 10.0, 1.5)

    def timeseries_raw_paginated(self, _mtype: str, params: dict[str, Any]):
        self.raw_calls += 1
        self.last_raw_params = params
        # Honour the caller's limit (which is page_limit + 1).
        n = min(self._raw_rows, params["limit"])
        base = datetime(2025, 1, 1, 0, 0)
        return [(base + timedelta(minutes=15 * i), float(i)) for i in range(n)]

    def timeseries_downsampled(self, _mtype: str, params: dict[str, Any], agg: str = "AVG"):
        self.downsampled_calls += 1
        self.last_bucket = params.get("bucket")
        self.last_agg = agg
        return [(datetime(2025, 1, 1, 0, 0), 1.234567)]


_PAST_START = datetime(2025, 1, 1, 0, 0, 0)
_PAST_END = datetime(2025, 1, 2, 0, 0, 0)


# -- raw -------------------------------------------------------------

def test_raw_never_calls_downsampled():
    repo = FakeRepo(raw_rows=96)
    resp = TimeseriesService(repo).get_raw("A1_F1", "P", _PAST_START, _PAST_END)
    assert repo.downsampled_calls == 0
    assert repo.raw_calls == 1
    assert resp.meta.is_raw is True
    assert resp.meta.downsampled is False
    assert resp.meta.aggregation_method is None
    assert resp.meta.bucket_seconds is None
    assert resp.meta.native_resolution_seconds == 900
    assert resp.meta.point_count == len(resp.data)


def test_raw_oversized_range_raises_not_aggregates():
    repo = FakeRepo()
    # ~15 years >> RAW_RANGE_MAX_POINTS, unpaginated.
    with pytest.raises(RawRangeTooLargeError) as exc:
        TimeseriesService(repo).get_raw("A1_F1", "P", datetime(2010, 1, 1), datetime(2025, 1, 1))
    assert repo.downsampled_calls == 0
    assert repo.raw_calls == 0
    assert exc.value.error_code == "RAW_RANGE_TOO_LARGE"
    assert exc.value.details["max_points"] == RAW_RANGE_MAX_POINTS


def test_raw_pagination_sets_next_cursor():
    # Ask for limit=10 but repo can serve 11 -> there's another page.
    repo = FakeRepo(raw_rows=11)
    resp = TimeseriesService(repo).get_raw("A1_F1", "P", _PAST_START, _PAST_END, limit=10)
    assert len(resp.data) == 10
    assert resp.next_cursor is not None


def test_raw_last_page_has_no_cursor():
    repo = FakeRepo(raw_rows=5)
    resp = TimeseriesService(repo).get_raw("A1_F1", "P", _PAST_START, _PAST_END, limit=10)
    assert len(resp.data) == 5
    assert resp.next_cursor is None


def test_raw_empty_first_page_is_404():
    repo = FakeRepo(raw_rows=0)
    with pytest.raises(ResourceNotFoundError):
        TimeseriesService(repo).get_raw("A1_F1", "P", _PAST_START, _PAST_END)


def test_raw_requires_valid_range():
    repo = FakeRepo()
    with pytest.raises(InvalidDateRangeError):
        TimeseriesService(repo).get_raw("A1_F1", "P", _PAST_END, _PAST_START)
    with pytest.raises(InvalidDateRangeError):
        TimeseriesService(repo).get_raw("A1_F1", "P", None, _PAST_END)


# -- aggregated ------------------------------------------------------

def test_aggregated_sets_explicit_meta_and_bucket():
    repo = FakeRepo()
    resp = TimeseriesService(repo).get_aggregated(
        "A1_F1", "P", _PAST_START, _PAST_END,
        bucket_seconds=ONE_HOUR_SECONDS, aggregation_method=AggregationMethod.MAX,
    )
    assert repo.downsampled_calls == 1
    assert repo.last_bucket == ONE_HOUR_SECONDS
    assert repo.last_agg == "MAX"
    assert resp.meta.is_raw is False
    assert resp.meta.downsampled is True
    assert resp.meta.aggregation_method == AggregationMethod.MAX
    assert resp.meta.bucket_seconds == ONE_HOUR_SECONDS


def test_aggregated_rejects_unsupported_bucket():
    repo = FakeRepo()
    with pytest.raises(UnsupportedAggregationError):
        TimeseriesService(repo).get_aggregated(
            "A1_F1", "P", _PAST_START, _PAST_END, bucket_seconds=137,
        )
    assert repo.downsampled_calls == 0


def test_query_level_agg_allowlist_still_enforced():
    from app.db import queries

    with pytest.raises(ValueError):
        queries.timeseries_downsampled("P", agg="DROP TABLE")


# -- caching ---------------------------------------------------------

def test_closed_window_raw_is_cached():
    repo = FakeRepo(raw_rows=5)
    service = TimeseriesService(repo)
    service.get_raw("A1_F1", "P", _PAST_START, _PAST_END)
    service.get_raw("A1_F1", "P", _PAST_START, _PAST_END)
    assert repo.raw_calls == 1


def test_live_window_raw_bypasses_cache():
    repo = FakeRepo(raw_rows=5)
    service = TimeseriesService(repo)
    end = datetime.now()
    start = end - timedelta(hours=2)
    service.get_raw("A1_F1", "P", start, end)
    service.get_raw("A1_F1", "P", start, end)
    assert repo.raw_calls == 2


def test_get_statistics_is_cached_across_calls():
    repo = FakeRepo()
    service = TimeseriesService(repo)
    service.get_statistics("A1_F1", "P", None, None)
    service.get_statistics("A1_F1", "P", None, None)
    assert repo.stats_calls == 1
