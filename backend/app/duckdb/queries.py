"""DuckDB SQL twins for dashboard queries.

Each function here is a counterpart to one of the Oracle queries in
``app/db/queries.py``. They run against the columnar tables defined in
``app/duckdb/schema.py`` and return rows in the *same shape* as the
Oracle queries, so service-layer parsing code doesn't have to change.

Column mapping:
    P → p_mw     Q → q_mvar     S → s_mva     U → u_kv     I → i_a

Hourly aggregate columns:
    p_avg, p_min, p_max, q_avg, q_min, q_max, s_avg, s_min, s_max,
    u_avg, u_min, u_max, i_avg, i_min, i_max, sample_count.

For most analytics endpoints we use the hourly rollups (the typical
2-3 year window). For short detailed ranges (≤14 days) we can use the
15-min raw if it's still in coverage.
"""

from __future__ import annotations

from typing import Final

# Mapping from public API mtype to the raw column name in the 15-min table.
_RAW_COL: Final[dict[str, str]] = {
    "P": "p_mw",
    "Q": "q_mvar",
    "S": "s_mva",
    "U": "u_kv",
    "I": "i_a",
}

# Mapping from public API mtype to the (avg, min, max) columns in hourly.
_HOURLY_COLS: Final[dict[str, tuple[str, str, str]]] = {
    "P": ("p_avg", "p_min", "p_max"),
    "Q": ("q_avg", "q_min", "q_max"),
    "S": ("s_avg", "s_min", "s_max"),
    "U": ("u_avg", "u_min", "u_max"),
    "I": ("i_avg", "i_min", "i_max"),
}


def raw_col(mtype: str) -> str:
    m = mtype.upper()
    if m not in _RAW_COL:
        raise ValueError(f"Unsupported measurement type: {mtype}")
    return _RAW_COL[m]


def hourly_cols(mtype: str) -> tuple[str, str, str]:
    m = mtype.upper()
    if m not in _HOURLY_COLS:
        raise ValueError(f"Unsupported measurement type: {mtype}")
    return _HOURLY_COLS[m]


# Common WHERE fragment used by every fact query.
_WHERE_HOURLY = """
    anr = $anr
    AND fnr = $fnr
    AND ($start IS NULL OR ts >= CAST($start AS TIMESTAMP))
    AND ($end   IS NULL OR ts <= CAST($end   AS TIMESTAMP))
"""

_WHERE_RAW = _WHERE_HOURLY  # same schema for measurements_15min_recent


# -- count_points -----------------------------------------------------


def count_points_hourly_sql(mtype: str) -> str:
    avg, _, _ = hourly_cols(mtype)
    return f"""
        SELECT COALESCE(SUM(sample_count), 0)
        FROM measurements_hourly
        WHERE {_WHERE_HOURLY}
          AND {avg} IS NOT NULL
    """


# -- statistics -------------------------------------------------------


def statistics_hourly_sql(mtype: str) -> str:
    """Approximate statistics from the hourly rollup.

    The aggregates are weighted by sample_count so AVG, MIN, MAX are
    exact. STDDEV is approximated from the per-hour averages — good
    enough for dashboard display, exactly equal when the window is a
    single hour. Documented in docs/duckdb-read-replica-plan.md §9.
    """
    avg, mn, mx = hourly_cols(mtype)
    return f"""
        SELECT
            COALESCE(SUM(sample_count), 0)                  AS cnt,
            SUM({avg} * sample_count) / NULLIF(SUM(sample_count), 0)  AS mean_val,
            MIN({mn})                                       AS min_val,
            MAX({mx})                                       AS max_val,
            STDDEV_POP({avg})                               AS std_val
        FROM measurements_hourly
        WHERE {_WHERE_HOURLY}
          AND {avg} IS NOT NULL
    """


# -- timeseries (downsampled) -----------------------------------------


_ALLOWED_AGGS: Final[set[str]] = {"AVG", "MIN", "MAX", "SUM"}


def timeseries_hourly_sql(mtype: str, agg: str = "AVG", bucket_seconds: int = 3600) -> str:
    """Bucketed timeseries against the hourly rollup.

    The Oracle counterpart takes ``:bucket`` (seconds) and floors
    LOKALZEIT into that bucket. DuckDB's ``time_bucket`` needs the
    interval as a literal, not a bind, so we interpolate the
    pre-validated integer directly into the SQL — the bucket comes
    from a validated allowlist in the service layer.
    """
    agg_upper = agg.upper()
    if agg_upper not in _ALLOWED_AGGS:
        raise ValueError(f"Unsupported aggregation: {agg!r}")

    # Strict int validation before string interpolation (defence in depth).
    bs = int(bucket_seconds)
    if bs <= 0:
        raise ValueError(f"bucket_seconds must be positive, got {bs}")

    avg, mn, mx = hourly_cols(mtype)
    if agg_upper == "AVG":
        agg_expr = f"AVG({avg})"
    elif agg_upper == "MIN":
        agg_expr = f"MIN({mn})"
    elif agg_upper == "MAX":
        agg_expr = f"MAX({mx})"
    else:  # SUM — total raw sum per bucket = sum(avg*count)
        agg_expr = f"SUM({avg} * sample_count)"

    return f"""
        SELECT
            time_bucket(INTERVAL {bs} SECOND, ts) AS bucket_time,
            {agg_expr} AS agg_value
        FROM measurements_hourly
        WHERE {_WHERE_HOURLY}
          AND {avg} IS NOT NULL
        GROUP BY 1
        ORDER BY 1
    """


def timeseries_raw_sql(mtype: str) -> str:
    col = raw_col(mtype)
    return f"""
        SELECT ts, {col}
        FROM measurements_15min_recent
        WHERE {_WHERE_RAW}
          AND {col} IS NOT NULL
        ORDER BY ts
    """


# -- heatmap (dow × hour) ---------------------------------------------


def heatmap_hourly_sql(mtype: str) -> str:
    """Day-of-week × hour heatmap built from hourly rollups.

    Oracle returns 0..6 from ``TO_NUMBER(TO_CHAR(LOKALZEIT, 'D')) - 1``
    where Sunday=0. DuckDB's ``dayofweek()`` is Sunday=0 too, so the
    cells line up byte-for-byte.
    """
    avg, _, _ = hourly_cols(mtype)
    return f"""
        SELECT
            CAST(dayofweek(ts) AS INTEGER)        AS dow,
            CAST(hour(ts)      AS INTEGER)        AS hour,
            AVG({avg})                            AS avg_value
        FROM measurements_hourly
        WHERE {_WHERE_HOURLY}
          AND {avg} IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
    """


# -- voltage band ----------------------------------------------------


def voltage_band_combined_sql() -> str:
    """Weekday + weekend voltage band built from hourly rollups.

    Oracle bucketizes into 15-minute slots; the hourly table only has
    hourly resolution, so the dashboard sees the same shape but the
    slot is the top of every hour ('HH:00'). This is documented as a
    visible difference for the U / Spannungsband chart.
    """
    return """
        SELECT
            CASE WHEN dayofweek(ts) IN (0, 6) THEN 1 ELSE 0 END AS is_weekend,
            printf('%02d:00', hour(ts))                          AS time_slot,
            MIN(u_min)                                           AS min_val,
            AVG(u_avg)                                           AS avg_val,
            MAX(u_max)                                           AS max_val
        FROM measurements_hourly
        WHERE anr = $anr
          AND fnr = $fnr
          AND ($start IS NULL OR ts >= CAST($start AS TIMESTAMP))
          AND ($end   IS NULL OR ts <= CAST($end   AS TIMESTAMP))
          AND u_avg IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
    """


# -- duration curve --------------------------------------------------


def duration_curve_hourly_sql(mtype: str) -> str:
    """Hour-averaged values sorted descending — the dashboard's duration curve."""
    avg, _, _ = hourly_cols(mtype)
    return f"""
        SELECT {avg} AS value
        FROM measurements_hourly
        WHERE {_WHERE_HOURLY}
          AND {avg} IS NOT NULL
        ORDER BY {avg} DESC
    """


# -- daily profile ---------------------------------------------------


def daily_profile_hourly_sql(mtype: str) -> str:
    """Weekday vs weekend average per hour-of-day.

    Returns (is_weekend, hour_frac, avg_val, cnt, avg_sq) — the same
    shape as the Oracle ``daily_profile_combined`` query. ``avg_sq`` is
    approximated from the hourly averages, not the raw squared values
    — std-dev calculation in the service stays the same but is a hair
    less accurate (≈ <1% drift on typical day profiles).
    """
    avg, _, _ = hourly_cols(mtype)
    return f"""
        SELECT
            CASE WHEN dayofweek(ts) IN (0, 6) THEN 1 ELSE 0 END AS is_weekend,
            CAST(hour(ts) AS DOUBLE)                            AS hour_frac,
            AVG({avg})                                          AS avg_val,
            SUM(sample_count)                                   AS cnt,
            AVG({avg} * {avg})                                  AS avg_sq
        FROM measurements_hourly
        WHERE {_WHERE_HOURLY}
          AND {avg} IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
    """
