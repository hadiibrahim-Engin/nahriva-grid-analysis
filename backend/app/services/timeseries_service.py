"""Timeseries use cases.

Two strictly separated read paths:

* ``get_raw`` — native-resolution measurements. It calls only the raw
  repository query; there is **no** code path from here to any aggregate
  query, so a raw request can never be silently downsampled. Oversized
  unpaginated ranges are refused (``RawRangeTooLargeError``) rather than
  quietly verdichtet.
* ``get_aggregated`` — user-requested aggregation. Requires an explicit,
  allow-listed bucket and an aggregation method.

Every response carries a ``MeasurementMeta`` stating plainly which mode it
is, so the dashboard never has to guess.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from app.core.cache import analytics_cache, cached as _cached
from app.core.constants import (
    ALLOWED_AGGREGATION_BUCKETS,
    LIVE_WINDOW_SECONDS,
    NATIVE_RESOLUTION_SECONDS,
    RAW_PAGE_LIMIT_DEFAULT,
    RAW_PAGE_LIMIT_MAX,
    RAW_RANGE_MAX_POINTS,
)
from app.core.errors import (
    InvalidDateRangeError,
    RawRangeTooLargeError,
    ResourceNotFoundError,
    UnsupportedAggregationError,
)
from app.core.logging import request_id_var
from app.models.models import fdwh_unit
from app.models.schemas import (
    AggregatedTimeseriesResponse,
    AggregationMethod,
    MeasurementMeta,
    RawTimeseriesResponse,
    StatisticsResponse,
    TimeseriesPoint,
)
from app.repositories.fdwh_repository import FDWHRepository
from app.services.common import (
    component_window_params,
    normalize_measurement_type,
    split_component_id,
)


def _is_live_window(end: datetime | None) -> bool:
    """True when the window touches "now" and must not be cached.

    Open-ended (``end is None``) or ending within ``LIVE_WINDOW_SECONDS``
    of the present is "live": freshly-arrived measurements must surface
    immediately instead of being served from a stale cache entry.
    """
    if end is None:
        return True
    now = datetime.now(end.tzinfo) if end.tzinfo else datetime.now()
    return (now - end).total_seconds() < LIVE_WINDOW_SECONDS


def _require_range(start: datetime | None, end: datetime | None) -> None:
    if start is None or end is None:
        raise InvalidDateRangeError("start und end sind erforderlich.")
    if start >= end:
        raise InvalidDateRangeError("start muss vor end liegen.")


class TimeseriesService:
    def __init__(self, repository: FDWHRepository) -> None:
        self._repository = repository

    @_cached
    def get_date_range(self, component_id: str) -> dict[str, str | None]:
        anr, fnr = split_component_id(component_id)
        row = self._repository.date_range(anr, fnr)
        if not row or row[0] is None:
            return {"min_date": None, "max_date": None}
        return {"min_date": str(row[0])[:10], "max_date": str(row[1])[:10]}

    @_cached
    def get_point_count(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
    ) -> dict[str, int]:
        normalized_type = normalize_measurement_type(measurement_type)
        params = component_window_params(component_id, start, end)
        return {"count": self._repository.count_points(normalized_type, params)}

    # -- Raw: native resolution, never downsampled ------------------------

    def get_raw(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
        limit: int = RAW_PAGE_LIMIT_DEFAULT,
        cursor: Optional[str] = None,
    ) -> RawTimeseriesResponse:
        normalized_type = normalize_measurement_type(measurement_type)
        _require_range(start, end)
        limit = max(1, min(limit, RAW_PAGE_LIMIT_MAX))

        # Guardrail: refuse an unpaginated firehose instead of aggregating.
        if cursor is None:
            estimated = int((end - start).total_seconds() / NATIVE_RESOLUTION_SECONDS)
            if estimated > RAW_RANGE_MAX_POINTS:
                raise RawRangeTooLargeError(
                    estimated_points=estimated, max_points=RAW_RANGE_MAX_POINTS
                )

        # Cache only closed historical windows; live windows always hit Oracle.
        if _is_live_window(end):
            return self._compute_raw(
                component_id, normalized_type, start, end, limit, cursor
            )
        key = ("raw", component_id, normalized_type, str(start), str(end), limit, cursor)
        return analytics_cache.get_or_compute(
            key,
            lambda: self._compute_raw(
                component_id, normalized_type, start, end, limit, cursor
            ),
        )

    def _compute_raw(
        self,
        component_id: str,
        normalized_type: str,
        start: datetime | None,
        end: datetime | None,
        limit: int,
        cursor: Optional[str],
    ) -> RawTimeseriesResponse:
        anr, fnr = split_component_id(component_id)
        params = component_window_params(component_id, start, end)
        params["cursor"] = cursor
        # Fetch one extra row to detect whether another page follows.
        params["limit"] = limit + 1
        rows = self._repository.timeseries_raw_paginated(normalized_type, params)

        has_more = len(rows) > limit
        rows = rows[:limit]

        if not rows and cursor is None:
            raise ResourceNotFoundError("Keine Rohdaten für diesen Zeitraum.")

        data = [TimeseriesPoint(timestamp=row[0], value=row[1]) for row in rows]
        # Emit the cursor in the exact format the keyset query parses with
        # (TO_DATE 'YYYY-MM-DD HH24:MI:SS'). A bare str(datetime) would append
        # fractional seconds (".500000") for any sub-second timestamp, which
        # that mask rejects (ORA-01830), breaking every page after the first.
        next_cursor = None
        if has_more and rows:
            last_ts = rows[-1][0]
            next_cursor = (
                last_ts.strftime("%Y-%m-%d %H:%M:%S")
                if hasattr(last_ts, "strftime")
                else str(last_ts)
            )

        return RawTimeseriesResponse(
            component_id=component_id,
            component_name=self._repository.component_name(anr, fnr),
            measurement_type=normalized_type,
            unit=fdwh_unit(normalized_type),
            data=data,
            next_cursor=next_cursor,
            meta=MeasurementMeta(
                is_raw=True,
                downsampled=False,
                aggregation_method=None,
                bucket_seconds=None,
                native_resolution_seconds=NATIVE_RESOLUTION_SECONDS,
                point_count=len(data),
                source="oracle",
                start=start,
                end=end,
                request_id=request_id_var.get(""),
            ),
        )

    # -- Aggregated: explicit bucket + method only ------------------------

    def get_aggregated(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
        bucket_seconds: int,
        aggregation_method: AggregationMethod = AggregationMethod.AVG,
    ) -> AggregatedTimeseriesResponse:
        normalized_type = normalize_measurement_type(measurement_type)
        _require_range(start, end)
        if bucket_seconds not in ALLOWED_AGGREGATION_BUCKETS:
            allowed = ", ".join(str(b) for b in sorted(ALLOWED_AGGREGATION_BUCKETS))
            raise UnsupportedAggregationError(
                f"bucket={bucket_seconds}s wird nicht unterstützt.",
                details={"allowed_bucket_seconds": sorted(ALLOWED_AGGREGATION_BUCKETS)},
                suggested_action=f"Erlaubte Werte (Sekunden): {allowed}.",
            )
        method = AggregationMethod(aggregation_method)

        if _is_live_window(end):
            return self._compute_aggregated(
                component_id, normalized_type, start, end, bucket_seconds, method
            )
        key = (
            "agg", component_id, normalized_type, str(start), str(end),
            bucket_seconds, method.value,
        )
        return analytics_cache.get_or_compute(
            key,
            lambda: self._compute_aggregated(
                component_id, normalized_type, start, end, bucket_seconds, method
            ),
        )

    def _compute_aggregated(
        self,
        component_id: str,
        normalized_type: str,
        start: datetime | None,
        end: datetime | None,
        bucket_seconds: int,
        method: AggregationMethod,
    ) -> AggregatedTimeseriesResponse:
        anr, fnr = split_component_id(component_id)
        params = component_window_params(component_id, start, end)
        params["bucket"] = bucket_seconds
        rows = self._repository.timeseries_downsampled(
            normalized_type, params, method.value
        )
        if not rows:
            raise ResourceNotFoundError("Keine Daten für diesen Zeitraum.")

        data = [
            TimeseriesPoint(timestamp=row[0], value=round(row[1], 3))
            for row in rows
        ]
        return AggregatedTimeseriesResponse(
            component_id=component_id,
            component_name=self._repository.component_name(anr, fnr),
            measurement_type=normalized_type,
            unit=fdwh_unit(normalized_type),
            data=data,
            meta=MeasurementMeta(
                is_raw=False,
                downsampled=True,
                aggregation_method=method,
                bucket_seconds=bucket_seconds,
                native_resolution_seconds=NATIVE_RESOLUTION_SECONDS,
                point_count=len(data),
                source="oracle",
                start=start,
                end=end,
                request_id=request_id_var.get(""),
            ),
        )

    @_cached
    def get_statistics(
        self,
        component_id: str,
        measurement_type: str,
        start: datetime | None,
        end: datetime | None,
    ) -> StatisticsResponse:
        normalized_type = normalize_measurement_type(measurement_type)
        anr, fnr = split_component_id(component_id)
        params = component_window_params(component_id, start, end)
        row = self._repository.statistics(normalized_type, params)
        component_name = self._repository.component_name(anr, fnr)
        unit = fdwh_unit(normalized_type)

        if not row or row[0] is None or row[0] == 0:
            return StatisticsResponse(
                component_name=component_name,
                measurement_type=normalized_type,
                unit=unit,
                count=0,
                mean=0,
                min=0,
                max=0,
                std_dev=None,
            )

        count, mean_value, min_value, max_value, std_value = row
        return StatisticsResponse(
            component_name=component_name,
            measurement_type=normalized_type,
            unit=unit,
            count=count,
            mean=round(mean_value, 3) if mean_value else 0,
            min=round(min_value, 3) if min_value is not None else 0,
            max=round(max_value, 3) if max_value is not None else 0,
            std_dev=round(std_value, 3) if std_value else None,
        )
