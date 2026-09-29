"""DuckDB twin of ``FDWHRepository``.

Surface area: every method on ``FDWHRepository`` has a same-name twin
here so ``RoutingRepository`` (Phase 5) can dispatch by call. Until
Phase 6 wires the actual DuckDB SQL, each method returns the empty
result of the right shape. Real queries land table-by-table behind a
``Coverage.pick_granularity()`` gate, so an unimplemented method
simply means "fall back to Oracle".

This module is only imported when ``DUCKDB_ENABLED=true``.
"""

from __future__ import annotations

from typing import Any, Sequence

from app.duckdb.connection import DuckDBHandle
from app.duckdb.coverage import Coverage
from app.duckdb.queries import (
    count_points_hourly_sql,
    daily_profile_hourly_sql,
    duration_curve_hourly_sql,
    heatmap_hourly_sql,
    statistics_hourly_sql,
    timeseries_hourly_sql,
    voltage_band_combined_sql,
)


class DuckDBRepository:
    """Read-only DuckDB-backed implementation of the dashboard repository.

    The shape of each method mirrors ``FDWHRepository``:
    - tuple / row sequences for ``_all`` queries
    - a single tuple (or ``None``) for ``_one`` queries
    """

    def __init__(self, handle: DuckDBHandle) -> None:
        self._handle = handle
        self._coverage = Coverage(handle)

    # -- coverage gate (exposed for the router) ---------------------

    @property
    def coverage(self) -> Coverage:
        return self._coverage

    # -- dimensions -------------------------------------------------

    def list_facilities(self) -> Sequence[tuple]:
        return self._handle.fetchall(
            "SELECT anr, anlagenname FROM dim_anlage ORDER BY anlagenname"
        )

    def list_components_by_facility(self, facility_id: str) -> Sequence[tuple]:
        return self._handle.fetchall(
            "SELECT fnr, feldname_kurz, spannungsebene "
            "FROM dim_betriebsmittel WHERE anr = ? ORDER BY fnr",
            [facility_id],
        )

    def list_all_components(self) -> Sequence[tuple]:
        return self._handle.fetchall(
            """
            SELECT b.anr, b.fnr, b.feldname_kurz, a.anlagenname, b.spannungsebene
            FROM dim_betriebsmittel b
            JOIN dim_anlage a ON a.anr = b.anr
            ORDER BY a.anlagenname, b.fnr
            """
        )

    def component_name(self, anr: str, fnr: str) -> str:
        row = self._handle.fetchone(
            "SELECT feldname_kurz FROM dim_betriebsmittel WHERE anr = ? AND fnr = ?",
            [anr, fnr],
        )
        return row[0] if row else ""

    def date_range(self, anr: str, fnr: str) -> tuple | None:
        # Pick from the most granular table available.
        return self._handle.fetchone(
            """
            SELECT MIN(ts), MAX(ts) FROM (
                SELECT ts FROM measurements_15min_recent WHERE anr = ? AND fnr = ?
                UNION ALL
                SELECT ts FROM measurements_hourly       WHERE anr = ? AND fnr = ?
            )
            """,
            [anr, fnr, anr, fnr],
        )

    # -- fact queries: Phase 6 implementations ----------------------
    #
    # Each method binds ``$anr``, ``$fnr``, ``$start``, ``$end`` from
    # the service-shaped params dict (same keys as the Oracle SQL).
    # Returned row shape matches the Oracle counterpart byte-for-byte
    # so service-layer parsing doesn't have to change.

    def _bind(self, params: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
        b: dict[str, Any] = {
            "anr": params.get("anr"),
            "fnr": params.get("fnr"),
            "start": params.get("start"),
            "end": params.get("end"),
        }
        if extra:
            b.update(extra)
        return b

    def count_points(self, measurement_type: str, params: dict[str, Any]) -> int:
        sql = count_points_hourly_sql(measurement_type)
        row = self._handle.execute(sql, self._bind(params)).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    def timeseries_raw(self, _measurement_type: str, _params: dict[str, Any]) -> Sequence[tuple]:
        # Phase 6 routes raw timeseries through the downsampled path
        # (hourly aggregates). True 15-min data lookups will land when
        # the bootstrap covers recent_raw - until then this falls back
        # via the router by returning an empty sequence.
        return []

    def timeseries_downsampled(
        self,
        measurement_type: str,
        params: dict[str, Any],
        agg: str = "AVG",
    ) -> Sequence[tuple]:
        # The dashboard supplies the bucket in seconds via the params
        # dict for Oracle. The DuckDB twin treats it as a SQL literal
        # (DuckDB doesn't bind interval values).
        bucket = int(params.get("bucket", 3600))
        sql = timeseries_hourly_sql(measurement_type, agg, bucket_seconds=bucket)
        return self._handle.fetchall(sql, self._bind(params))

    def statistics(self, measurement_type: str, params: dict[str, Any]) -> tuple | None:
        sql = statistics_hourly_sql(measurement_type)
        return self._handle.fetchone(sql, self._bind(params))

    def heatmap(self, measurement_type: str, params: dict[str, Any]) -> Sequence[tuple]:
        sql = heatmap_hourly_sql(measurement_type)
        return self._handle.fetchall(sql, self._bind(params))

    def voltage_band_combined(self, params: dict[str, Any]) -> Sequence[tuple]:
        sql = voltage_band_combined_sql()
        return self._handle.fetchall(sql, self._bind(params))

    def duration_curve(self, measurement_type: str, params: dict[str, Any]) -> Sequence[tuple]:
        sql = duration_curve_hourly_sql(measurement_type)
        return self._handle.fetchall(sql, self._bind(params))

    def daily_profile_combined(
        self, measurement_type: str, params: dict[str, Any],
    ) -> Sequence[tuple]:
        sql = daily_profile_hourly_sql(measurement_type)
        return self._handle.fetchall(sql, self._bind(params))

    def correlation_scatter(
        self, _type_x: str, _type_y: str, _params: dict[str, Any],
    ) -> Sequence[tuple]:
        return []

    def correlation_matrix_corr(self, _params: dict[str, Any]) -> tuple | None:
        return None

    def boxplot_hourly(
        self, _measurement_type: str, _params: dict[str, Any],
    ) -> Sequence[tuple]:
        return []

    def power_factor_timeseries(self, _params: dict[str, Any]) -> Sequence[tuple]:
        return []

    def power_factor_downsampled(self, _params: dict[str, Any]) -> Sequence[tuple]:
        return []

    def quality_combined(self, _params: dict[str, Any]) -> Sequence[tuple]:
        return []

    def dst_hourly_counts(self, _params: dict[str, Any]) -> Sequence[tuple]:
        return []

    def season_monthly_values(self, _params: dict[str, Any]) -> Sequence[tuple]:
        return []

    def exceedance_timeline(
        self, _measurement_type: str, _params: dict[str, Any],
    ) -> Sequence[tuple]:
        return []
