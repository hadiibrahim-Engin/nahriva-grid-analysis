"""Repository for Oracle FDWH views.

The repository is intentionally thin: it owns SQL execution and keeps route and
service code from depending on SQLAlchemy text snippets directly.
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.logging import db_time_ms_var
from app.db import queries


class FDWHRepository:
    """Execute dashboard queries against FDWH Oracle views."""

    def __init__(self, db: Session) -> None:
        self._db = db

    def _execute(self, sql: str, params: dict[str, Any] | None):
        """Run a statement and accumulate its wall time for Server-Timing."""
        t0 = time.perf_counter()
        try:
            return self._db.execute(text(sql), params or {})
        finally:
            elapsed_ms = (time.perf_counter() - t0) * 1000
            db_time_ms_var.set(db_time_ms_var.get() + elapsed_ms)

    def _all(self, sql: str, params: dict[str, Any] | None = None):
        return self._execute(sql, params).fetchall()

    def _one(self, sql: str, params: dict[str, Any] | None = None):
        return self._execute(sql, params).fetchone()

    def list_facilities(self):
        return self._all(queries.list_facilities())

    def list_components_by_facility(self, facility_id: str):
        return self._all(queries.list_components_by_facility(), {"anr": facility_id})

    def list_all_components(self):
        return self._all(queries.list_all_components())

    def component_name(self, anr: str, fnr: str) -> str:
        row = self._one(queries.component_name(), {"anr": anr, "fnr": fnr})
        return row[0] if row else ""

    def date_range(self, anr: str, fnr: str):
        return self._one(queries.date_range(), {"anr": anr, "fnr": fnr})

    def count_points(self, measurement_type: str, params: dict[str, Any]) -> int:
        row = self._one(queries.count_points(measurement_type), params)
        return int(row[0]) if row else 0

    def timeseries_raw(self, measurement_type: str, params: dict[str, Any]):
        return self._all(queries.timeseries_raw(measurement_type), params)

    def timeseries_raw_paginated(self, measurement_type: str, params: dict[str, Any]):
        return self._all(queries.timeseries_raw_paginated(measurement_type), params)

    def timeseries_downsampled(self, measurement_type: str, params: dict[str, Any], agg: str = "AVG"):
        return self._all(queries.timeseries_downsampled(measurement_type, agg), params)

    def statistics(self, measurement_type: str, params: dict[str, Any]):
        return self._one(queries.statistics(measurement_type), params)

    def heatmap(self, measurement_type: str, params: dict[str, Any]):
        return self._all(queries.heatmap_aggregation(measurement_type), params)

    def voltage_band_combined(self, params: dict[str, Any]):
        return self._all(queries.voltage_band_combined(), params)

    def duration_curve(self, measurement_type: str, params: dict[str, Any]):
        return self._all(queries.duration_curve(measurement_type), params)

    def daily_profile_combined(self, measurement_type: str, params: dict[str, Any]):
        return self._all(queries.daily_profile_combined(measurement_type), params)

    def correlation_scatter(
        self,
        type_x: str,
        type_y: str,
        params: dict[str, Any],
    ):
        return self._all(queries.correlation_scatter(type_x, type_y), params)

    def correlation_matrix_corr(self, params: dict[str, Any]):
        return self._one(queries.correlation_matrix_corr(), params)

    def boxplot_hourly(self, measurement_type: str, params: dict[str, Any]):
        return self._all(queries.boxplot_hourly(measurement_type), params)

    def boxplot_grouped(self, measurement_type: str, group_by: str, params: dict[str, Any]):
        return self._all(queries.boxplot_grouped(measurement_type, group_by), params)

    def power_factor_timeseries(self, params: dict[str, Any]):
        return self._all(queries.power_factor_timeseries(), params)

    def power_factor_downsampled(self, params: dict[str, Any]):
        return self._all(queries.power_factor_downsampled(), params)

    def quality_combined(self, params: dict[str, Any]):
        return self._all(queries.quality_combined(), params)

    def dst_hourly_counts(self, params: dict[str, Any]):
        return self._all(queries.dst_hourly_counts(), params)

    def season_monthly_values(self, params: dict[str, Any]):
        return self._all(queries.season_monthly_values(), params)

    def exceedance_timeline(self, measurement_type: str, params: dict[str, Any]):
        return self._all(queries.exceedance_timeline(measurement_type), params)