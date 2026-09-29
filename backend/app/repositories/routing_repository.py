"""Routes dashboard reads between DuckDB and Oracle.

This is the runtime equivalent of the plan's §5: per-call decision
between the local DuckDB replica and the authoritative Oracle FDWH.

Used **only** when ``DUCKDB_ENABLED=true``. The dependency factory
returns a plain ``FDWHRepository`` otherwise, so the
``DUCKDB_ENABLED=false`` path never touches this module.

Routing decision (per method call):

1. If the method has no DuckDB twin yet → Oracle.
2. If DuckDB has no coverage for the requested time window → Oracle
   (when fallback is on) or raise ``DataNotAvailableError``.
3. Else → DuckDB.

Every call emits one log line:

    query.source=duckdb method=heatmap range_days=30 granularity=hourly ms=42

…so production runs can attribute load to the right backend.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any, Sequence

from app.core.errors import InvalidRequestError
from app.duckdb.repository import DuckDBRepository
from app.repositories.fdwh_repository import FDWHRepository

log = logging.getLogger(__name__)


class DataNotAvailableError(InvalidRequestError):
    """Raised when DuckDB cannot serve a query and fallback is disabled."""


# Methods that have a real DuckDB twin today. Anything not in here
# routes straight to Oracle. Phase 6 fills in the measurement queries
# below; the remaining methods (correlation, power_factor, quality,
# dst, season, exceedance) keep going to Oracle until they have twins
# of their own — that's the documented graceful-degradation contract.
_DUCKDB_IMPLEMENTED: frozenset[str] = frozenset(
    {
        # Dimensions (Phase 2)
        "list_facilities",
        "list_components_by_facility",
        "list_all_components",
        "component_name",
        "date_range",
        # Phase 6 measurement queries
        "count_points",
        "timeseries_downsampled",
        "statistics",
        "heatmap",
        "voltage_band_combined",
        "duration_curve",
        "daily_profile_combined",
    }
)

# Methods that don't take a time window — they're safe to route to
# DuckDB whenever the dimension is populated.
_NO_WINDOW_METHODS: frozenset[str] = frozenset(
    {
        "list_facilities",
        "list_components_by_facility",
        "list_all_components",
        "component_name",
        "date_range",
    }
)


def _parse_params_window(params: dict[str, Any] | None) -> tuple[datetime | None, datetime | None]:
    """Extract (start, end) datetimes from a service-shaped params dict.

    Returns ``(None, None)`` when either bound is missing — that's the
    signal that we can't bound the query, so DuckDB shouldn't try.
    """
    if not params:
        return None, None
    s, e = params.get("start"), params.get("end")
    if not s or not e:
        return None, None
    try:
        # The dashboard uses 'YYYY-MM-DD HH:MM:SS' (see services/common.py).
        sd = datetime.strptime(str(s), "%Y-%m-%d %H:%M:%S")
        ed = datetime.strptime(str(e), "%Y-%m-%d %H:%M:%S")
        return sd, ed
    except (ValueError, TypeError):
        return None, None


class RoutingRepository:
    """Same interface as ``FDWHRepository``, dispatches per call."""

    def __init__(
        self,
        duckdb_repo: DuckDBRepository,
        oracle_repo: FDWHRepository,
        *,
        fallback_to_oracle: bool = True,
    ) -> None:
        self._duck = duckdb_repo
        self._oracle = oracle_repo
        self._fallback = fallback_to_oracle

    # -- decision helpers -------------------------------------------

    def _can_serve(
        self, method_name: str, params: dict[str, Any] | None
    ) -> tuple[bool, str | None, int | None]:
        """Decide if DuckDB can handle this call.

        Returns ``(can_serve, granularity, range_days)`` so callers can
        log the routing decision uniformly.
        """
        if method_name not in _DUCKDB_IMPLEMENTED:
            return False, None, None

        if method_name in _NO_WINDOW_METHODS:
            return True, None, None

        start, end = _parse_params_window(params)
        if start is None or end is None:
            return False, None, None
        granularity = self._duck.coverage.pick_granularity(start, end)
        if granularity is None:
            return False, None, (end - start).days
        return True, granularity, (end - start).days

    def _call(
        self,
        method_name: str,
        repo: Any,
        args: tuple,
        kwargs: dict,
        *,
        source: str,
        granularity: str | None,
        range_days: int | None,
    ) -> Any:
        """Invoke a repository method and log the routing decision."""
        method = getattr(repo, method_name)
        t0 = time.monotonic()
        result = method(*args, **kwargs)
        ms = int((time.monotonic() - t0) * 1000)
        log.info(
            "query.source=%s method=%s range_days=%s granularity=%s ms=%d",
            source,
            method_name,
            range_days if range_days is not None else "-",
            granularity or "-",
            ms,
        )
        return result

    def _route(self, method_name: str, *args, **kwargs) -> Any:
        # First positional dict-typed arg, if any, is the params dict
        # for window-bearing methods. The remaining positional args (mtype,
        # type_x, type_y, etc.) ride along untouched.
        params: dict[str, Any] | None = None
        for a in args:
            if isinstance(a, dict):
                params = a
                break

        can, granularity, range_days = self._can_serve(method_name, params)

        if can:
            try:
                return self._call(
                    method_name, self._duck, args, kwargs,
                    source="duckdb", granularity=granularity, range_days=range_days,
                )
            except Exception as exc:
                if not self._fallback:
                    raise
                log.warning(
                    "duckdb call failed; falling back to Oracle: %s.%s: %s",
                    type(self._duck).__name__, method_name, exc,
                )
                return self._call(
                    method_name, self._oracle, args, kwargs,
                    source="oracle-fallback", granularity=granularity, range_days=range_days,
                )

        if not self._fallback and method_name not in _NO_WINDOW_METHODS:
            raise DataNotAvailableError(
                f"Requested data not in DuckDB replica for method {method_name!r} "
                "and DUCKDB_FALLBACK_TO_ORACLE is disabled."
            )

        return self._call(
            method_name, self._oracle, args, kwargs,
            source="oracle", granularity=granularity, range_days=range_days,
        )

    # -- delegated repository surface (matches FDWHRepository) -----

    # Dimensions
    def list_facilities(self):
        return self._route("list_facilities")

    def list_components_by_facility(self, facility_id: str):
        return self._route("list_components_by_facility", facility_id)

    def list_all_components(self):
        return self._route("list_all_components")

    def component_name(self, anr: str, fnr: str) -> str:
        return self._route("component_name", anr, fnr)

    def date_range(self, anr: str, fnr: str):
        return self._route("date_range", anr, fnr)

    # Measurement-bearing methods (route is currently always Oracle until
    # Phase 6 fills DuckDB twins in; the routing surface is wired up so
    # we don't have to touch services again later).
    def count_points(self, measurement_type: str, params: dict[str, Any]) -> int:
        return self._route("count_points", measurement_type, params)

    def timeseries_raw(self, measurement_type: str, params: dict[str, Any]):
        return self._route("timeseries_raw", measurement_type, params)

    def timeseries_raw_paginated(self, measurement_type: str, params: dict[str, Any]):
        # Not in _DUCKDB_IMPLEMENTED → always routed to Oracle, the system
        # of record. Raw fidelity should never come from the replica.
        return self._route("timeseries_raw_paginated", measurement_type, params)

    def timeseries_downsampled(
        self, measurement_type: str, params: dict[str, Any], agg: str = "AVG",
    ):
        return self._route("timeseries_downsampled", measurement_type, params, agg)

    def statistics(self, measurement_type: str, params: dict[str, Any]):
        return self._route("statistics", measurement_type, params)

    def heatmap(self, measurement_type: str, params: dict[str, Any]):
        return self._route("heatmap", measurement_type, params)

    def voltage_band_combined(self, params: dict[str, Any]):
        return self._route("voltage_band_combined", params)

    def duration_curve(self, measurement_type: str, params: dict[str, Any]):
        return self._route("duration_curve", measurement_type, params)

    def daily_profile_combined(self, measurement_type: str, params: dict[str, Any]):
        return self._route("daily_profile_combined", measurement_type, params)

    def correlation_scatter(self, type_x: str, type_y: str, params: dict[str, Any]):
        return self._route("correlation_scatter", type_x, type_y, params)

    def correlation_matrix_corr(self, params: dict[str, Any]):
        return self._route("correlation_matrix_corr", params)

    def boxplot_hourly(self, measurement_type: str, params: dict[str, Any]):
        return self._route("boxplot_hourly", measurement_type, params)

    def boxplot_grouped(self, measurement_type: str, group_by: str, params: dict[str, Any]):
        # No DuckDB twin yet (not in _DUCKDB_IMPLEMENTED) — always Oracle.
        return self._route("boxplot_grouped", measurement_type, group_by, params)

    def power_factor_timeseries(self, params: dict[str, Any]):
        return self._route("power_factor_timeseries", params)

    def power_factor_downsampled(self, params: dict[str, Any]):
        return self._route("power_factor_downsampled", params)

    def quality_combined(self, params: dict[str, Any]):
        return self._route("quality_combined", params)

    def dst_hourly_counts(self, params: dict[str, Any]):
        return self._route("dst_hourly_counts", params)

    def season_monthly_values(self, params: dict[str, Any]):
        return self._route("season_monthly_values", params)

    def exceedance_timeline(self, measurement_type: str, params: dict[str, Any]):
        return self._route("exceedance_timeline", measurement_type, params)
