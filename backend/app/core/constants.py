"""Named operational constants for the dashboard backend."""

from __future__ import annotations

from typing import Final


DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES: Final[int] = 480
DEFAULT_DB_HOST: Final[str] = "localhost"
DEFAULT_DB_PORT: Final[str] = "1521"
ORACLE_PING_SQL: Final[str] = "SELECT 1 FROM DUAL"

DB_POOL_SIZE: Final[int] = 10
DB_MAX_OVERFLOW: Final[int] = 20
DB_POOL_RECYCLE_SECONDS: Final[int] = 3_600
# Per-statement timeout. Long enough for a legitimate year-wide aggregation
# on a warm cache; short enough that a runaway query (missing index, bad
# bind plan) fails fast with a clean error instead of holding a connection.
DB_CALL_TIMEOUT_MS: Final[int] = 90_000

# Login rate limiting (per source IP). Targets brute-force protection on
# /api/auth/login, which is the one path that bypasses the SQLAlchemy pool
# and opens a fresh Oracle session per request.
LOGIN_RATE_LIMIT_ATTEMPTS: Final[int] = 5
LOGIN_RATE_LIMIT_WINDOW_SECONDS: Final[int] = 60

# Global per-IP rate limit on /api/*. The default is generous enough that
# a real dashboard user with rapid tab switching stays well under it; the
# point is to cap a single abusive client from saturating the DB pool.
API_RATE_LIMIT_REQUESTS: Final[int] = 240
API_RATE_LIMIT_WINDOW_SECONDS: Final[int] = 60

DEFAULT_MAX_POINTS: Final[int] = 4_000
RAW_BUCKET_SECONDS: Final[int] = 0
FIFTEEN_MINUTES_SECONDS: Final[int] = 15 * 60
ONE_HOUR_SECONDS: Final[int] = 60 * 60
FOUR_HOURS_SECONDS: Final[int] = 4 * ONE_HOUR_SECONDS
ONE_DAY_SECONDS: Final[int] = 24 * ONE_HOUR_SECONDS

# FDWH delivers measurements at a fixed 15-minute cadence. This is the
# "native resolution" reported in every measurement response so the
# dashboard can state plainly that raw data is un-resampled.
NATIVE_RESOLUTION_SECONDS: Final[int] = FIFTEEN_MINUTES_SECONDS

# Raw endpoint guardrails. Raw NEVER downsamples — instead, oversized
# unpaginated ranges are refused with a clear 422 (RAW_RANGE_TOO_LARGE)
# and the caller paginates with a cursor, exports, or explicitly opts
# into the /aggregate endpoint.
RAW_PAGE_LIMIT_DEFAULT: Final[int] = 50_000
RAW_PAGE_LIMIT_MAX: Final[int] = 50_000
# ~25 months at the native cadence: refuse an unpaginated firehose.
RAW_RANGE_MAX_POINTS: Final[int] = 200_000

# Allowed aggregation bucket sizes (seconds) for the /aggregate endpoint.
ALLOWED_AGGREGATION_BUCKETS: Final[frozenset[int]] = frozenset(
    {FIFTEEN_MINUTES_SECONDS, ONE_HOUR_SECONDS, FOUR_HOURS_SECONDS, ONE_DAY_SECONDS}
)

# Don't cache windows that touch "now": freshly-arrived measurements must
# surface immediately. A request whose end is None or within this many
# seconds of the present is considered "live" and bypasses the cache.
LIVE_WINDOW_SECONDS: Final[int] = ONE_HOUR_SECONDS

DURATION_CURVE_MAX_POINTS: Final[int] = 500
CORRELATION_SAMPLE_POINTS: Final[int] = 1_000

DEFAULT_POWER_FACTOR_DOWNSAMPLE_MINUTES: Final[int] = 60
POWER_FACTOR_HISTOGRAM_BINS: Final[int] = 20
POWER_FACTOR_EPSILON: Final[float] = 0.001

DEFAULT_EXPECTED_POINTS_PER_DAY: Final[int] = 96
DEFAULT_EXCEEDANCE_THRESHOLD: Final[float] = 80.0
EXCEEDANCE_INTERVAL_MINUTES: Final[int] = 15
TOP_EXCEEDANCE_DAYS: Final[int] = 20

EXPORT_DEFAULT_DAYS: Final[int] = 7
EXCEL_MAX_DATA_ROWS: Final[int] = 50_000

VOLTAGE_BAND_REFERENCE_DATE: Final[str] = "2000-01-01"

SEASON_MONTH_LABELS: Final[list[str]] = [
    "Jan",
    "Feb",
    "Mär",
    "Apr",
    "Mai",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Okt",
    "Nov",
    "Dez",
]

# Index 0=Sunday..6=Saturday — matches the `dow` convention used throughout
# app/db/queries.py (TO_NUMBER(TO_CHAR(date,'D')) - 1).
WEEKDAY_LABELS: Final[list[str]] = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]

BOXPLOT_GROUP_BY_OPTIONS: Final[list[str]] = ["hour", "weekday", "month", "weekday_weekend"]

SEASON_MEASUREMENT_TYPES: Final[tuple[str, ...]] = ("P", "Q", "S")
QUALITY_MEASUREMENT_TYPES: Final[list[str]] = ["P", "Q", "S", "U", "I"]