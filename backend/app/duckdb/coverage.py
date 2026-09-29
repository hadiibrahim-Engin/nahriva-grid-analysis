"""Coverage check — does the local DuckDB hold the data this query needs?

The dashboard issues queries over a (start, end) window. Each request
maps to a *required granularity*:

- 15-min raw for short detailed ranges (default ≤ 14 days)
- hourly rollups for medium / typical 2-3 year ranges
- daily rollups for long ranges (optional)

A query is "covered" when the relevant DuckDB rollup table fully spans
the requested window. ``Coverage.covers()`` is the single source of
truth for query routing in ``RoutingRepository`` (Phase 5).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from app.duckdb.connection import DuckDBHandle


# Default thresholds — overridable by the routing layer.
SHORT_RANGE_DAYS = 14
DEFAULT_HOURLY_LIMIT_YEARS = 3


@dataclass(frozen=True)
class CoverageRow:
    table_name: str
    min_ts: datetime | None
    max_ts: datetime | None
    row_count: int
    granularity: str

    def covers(self, start: datetime, end: datetime) -> bool:
        if self.min_ts is None or self.max_ts is None or self.row_count == 0:
            return False
        return self.min_ts <= start and self.max_ts >= end


class Coverage:
    """Wrapper around the ``duckdb_coverage`` metadata table.

    Reads the small table on demand (the dashboard hits this once per
    request — sub-millisecond against DuckDB).
    """

    def __init__(self, handle: "DuckDBHandle") -> None:
        self._handle = handle

    def all(self) -> dict[str, CoverageRow]:
        """Return one entry per registered table."""
        try:
            rows = self._handle.fetchall(
                "SELECT table_name, min_ts, max_ts, row_count, granularity "
                "FROM duckdb_coverage"
            )
        except Exception:
            return {}
        return {
            r[0]: CoverageRow(r[0], r[1], r[2], int(r[3] or 0), r[4]) for r in rows
        }

    # -- routing helpers ---------------------------------------------

    def preferred_granularity(self, start: datetime, end: datetime) -> str:
        """Map a query window to the *desired* granularity.

        Coverage might still be insufficient — see ``can_serve`` for the
        actual go/no-go decision.
        """
        span = end - start
        if span <= timedelta(days=SHORT_RANGE_DAYS):
            return "15min"
        if span <= timedelta(days=365 * DEFAULT_HOURLY_LIMIT_YEARS):
            return "hourly"
        return "daily"

    def can_serve(self, start: datetime, end: datetime, granularity: str) -> bool:
        """Does the requested table fully cover this window?"""
        table = _GRANULARITY_TO_TABLE.get(granularity)
        if table is None:
            return False
        rows = self.all()
        row = rows.get(table)
        if row is None:
            return False
        return row.covers(start, end)

    def pick_granularity(self, start: datetime, end: datetime) -> str | None:
        """Pick the best granularity actually available for this window.

        Returns ``None`` when no table covers the window — that's the
        signal to route to Oracle (or 503 if fallback is off).
        """
        # Prefer the lowest-granularity table that satisfies coverage:
        #  short range → try 15-min first, fall through to hourly/daily;
        #  long range  → try hourly, fall through to daily.
        preferred = self.preferred_granularity(start, end)
        order = _PROBE_ORDER[preferred]
        for granularity in order:
            if self.can_serve(start, end, granularity):
                return granularity
        return None


_GRANULARITY_TO_TABLE = {
    "15min": "measurements_15min_recent",
    "hourly": "measurements_hourly",
    "daily": "measurements_daily",
}

# When the preferred granularity isn't covered, fall through in this order.
_PROBE_ORDER = {
    "15min": ["15min", "hourly", "daily"],
    "hourly": ["hourly", "daily"],
    "daily": ["daily"],
}
