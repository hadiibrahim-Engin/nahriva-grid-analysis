"""
SQL query layer - Oracle FDWH (TIFAB_V$FDWH_MESSWERTE / _STAMMDATEN).

All queries use :anr (ANLAGENNUMMER) and :fnr (FELDNUMMER) to identify a component.
The measurement value column is injected via Python string formatting (not user input).
"""

from app.models.models import fdwh_column

# Table aliases
_S = 'FDWH.TIFAB_ODB_STAMMDATEN'
_T = 'FDWH.TIFAB_ODB_MESSWERTE'

# Common WHERE fragment for component + time range
# _WHERE = f"""
#     "ANLAGENNUMMER" = :anr
#     AND "FELDNUMMER" = :fnr
#     AND (:start IS NULL OR "LOKALZEIT" >= TO_DATE(:start, 'YYYY-MM-DD HH24:MI:SS'))
#     AND (:end   IS NULL OR "LOKALZEIT" <= TO_DATE(:end,   'YYYY-MM-DD HH24:MI:SS'))
# """
_WHERE = f"""
    "ANLAGENNUMMER" = :anr
    AND "FELDNUMMER" = :fnr
    AND (:start IS NULL OR "LOKALZEIT" >= TO_DATE(REPLACE(:start, 'T', ' '), 'YYYY-MM-DD HH24:MI:SS'))
    AND (:end   IS NULL OR "LOKALZEIT" <= TO_DATE(REPLACE(:end,   'T', ' '), 'YYYY-MM-DD HH24:MI:SS'))
"""


def _val(mtype: str) -> str:
    """Return FDWH column expression for measurement type (safe - not user input)."""
    return fdwh_column(mtype)


# =============================================================================
# Facilities / Components from STAMMDATEN
# =============================================================================

def list_facilities() -> str:
    return f"""
        SELECT DISTINCT "ANLAGENNUMMER", "ANLAGENNAME"
        FROM {_S}
        ORDER BY "ANLAGENNAME"
    """


def list_components_by_facility() -> str:
    return f"""
        SELECT "FELDNUMMER", "FELDNAME_KURZ", "SPANNUNGSEBENE"
        FROM {_S}
        WHERE "ANLAGENNUMMER" = :anr
        ORDER BY "FELDNUMMER"
    """


def list_all_components() -> str:
    return f"""
        SELECT "ANLAGENNUMMER", "FELDNUMMER", "FELDNAME_KURZ",
               "ANLAGENNAME", "SPANNUNGSEBENE"
        FROM {_S}
        ORDER BY "ANLAGENNAME", "FELDNUMMER"
    """


def component_name() -> str:
    """Get FELDNAME_KURZ for a specific component."""
    return f"""
        SELECT "FELDNAME_KURZ" FROM {_S}
        WHERE "ANLAGENNUMMER" = :anr AND "FELDNUMMER" = :fnr
        FETCH FIRST 1 ROWS ONLY
    """


# =============================================================================
# Point count
# =============================================================================

def count_points(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT COUNT(*) FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
    """


# =============================================================================
# Time-bucket downsampling
# =============================================================================

_ALLOWED_AGGS = {"AVG", "MIN", "MAX", "SUM"}


def timeseries_downsampled(mtype: str, agg: str = "AVG") -> str:
    """Bucketed timeseries with a selectable aggregate.

    `agg` must be one of AVG/MIN/MAX/SUM (validated against an allow-list
    so it's safe to interpolate into SQL).
    """
    agg_upper = agg.upper()
    if agg_upper not in _ALLOWED_AGGS:
        raise ValueError(f"Unsupported aggregation: {agg!r}")
    col = _val(mtype)
    return f"""
        SELECT
            TRUNC("LOKALZEIT") + FLOOR(
                (EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 3600
                 + EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 60)
                / :bucket
            ) * :bucket / 86400 AS bucket_time,
            {agg_upper}({col}) AS agg_value
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        GROUP BY TRUNC("LOKALZEIT") + FLOOR(
                (EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 3600
                 + EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 60)
                / :bucket
            ) * :bucket / 86400
        ORDER BY bucket_time
    """


def timeseries_raw(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT "LOKALZEIT", {col}
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        ORDER BY "LOKALZEIT"
    """


def timeseries_raw_paginated(mtype: str) -> str:
    """Keyset-paginated raw read — never aggregates.

    Pages by ``LOKALZEIT`` so the access path stays index-friendly (no
    OFFSET). ``:cursor`` is the last LOKALZEIT returned on the previous
    page (NULL on the first page). ``:limit`` is fetched + 1 by the
    caller to detect whether another page exists.
    """
    col = _val(mtype)
    return f"""
        SELECT "LOKALZEIT", {col}
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
          AND (:cursor IS NULL
               OR "LOKALZEIT" > TO_DATE(REPLACE(:cursor, 'T', ' '), 'YYYY-MM-DD HH24:MI:SS'))
        ORDER BY "LOKALZEIT"
        FETCH FIRST :limit ROWS ONLY
    """


# =============================================================================
# Statistics
# =============================================================================

def statistics(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT
            COUNT({col}) AS cnt,
            AVG({col})   AS mean_val,
            MIN({col})   AS min_val,
            MAX({col})   AS max_val,
            STDDEV({col}) AS std_val
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
    """


# =============================================================================
# Date range
# =============================================================================

def date_range() -> str:
    return f"""
        SELECT MIN("LOKALZEIT"), MAX("LOKALZEIT")
        FROM {_T}
        WHERE "ANLAGENNUMMER" = :anr AND "FELDNUMMER" = :fnr
    """


# =============================================================================
# Heatmap: day-of-week x hour
# =============================================================================

def heatmap_aggregation(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT
            TO_NUMBER(TO_CHAR("LOKALZEIT", 'D')) - 1 AS dow,
            EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) AS hour,
            AVG({col}) AS avg_value
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        GROUP BY TO_NUMBER(TO_CHAR("LOKALZEIT", 'D')) - 1,
                 EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP))
        ORDER BY dow, hour
    """


# =============================================================================
# Voltage band (UUW only)
# =============================================================================

def voltage_band_combined() -> str:
    """Weekday+weekend in one scan. Returns (is_weekend, time_slot, min, avg, max)."""
    slot_expr = """TO_CHAR("LOKALZEIT", 'HH24') || ':' ||
            CASE
                WHEN EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) < 15 THEN '00'
                WHEN EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) < 30 THEN '15'
                WHEN EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) < 45 THEN '30'
                ELSE '45'
            END"""
    weekend_expr = """CASE WHEN TO_NUMBER(TO_CHAR("LOKALZEIT", 'D')) IN (1, 7) THEN 1 ELSE 0 END"""
    return f"""
        SELECT
            {weekend_expr} AS is_weekend,
            {slot_expr} AS time_slot,
            MIN("UUW") AS min_val,
            AVG("UUW") AS avg_val,
            MAX("UUW") AS max_val
        FROM {_T}
        WHERE {_WHERE}
          AND "UUW" IS NOT NULL
        GROUP BY {weekend_expr}, {slot_expr}
        ORDER BY is_weekend, time_slot
    """


# =============================================================================
# Duration curve
# =============================================================================

def duration_curve(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT {col} AS value
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        ORDER BY {col} DESC
    """


# =============================================================================
# Daily profile
# =============================================================================

def daily_profile_combined(mtype: str) -> str:
    """Weekday+weekend in one scan. Returns (is_weekend, hour_frac, avg, cnt, avg_sq)."""
    col = _val(mtype)
    weekend_expr = """CASE WHEN TO_NUMBER(TO_CHAR("LOKALZEIT", 'D')) IN (1, 7) THEN 1 ELSE 0 END"""
    hour_expr = """EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) +
            EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) / 60.0"""
    return f"""
        SELECT
            {weekend_expr} AS is_weekend,
            {hour_expr} AS hour_frac,
            AVG({col}) AS avg_val,
            COUNT({col}) AS cnt,
            AVG({col} * {col}) AS avg_sq
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        GROUP BY {weekend_expr}, {hour_expr}
        ORDER BY is_weekend, hour_frac
    """


# =============================================================================
# Box-plot
# =============================================================================

def boxplot_hourly(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT
            EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) AS hour,
            {col} AS value
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        ORDER BY hour, value
    """


# `bucket` expressions for each supported grouping. 'hour' is intentionally
# NOT here — it's served by `boxplot_hourly` above, which has a DuckDB
# fast-path twin; these three are Oracle-only (no DuckDB implementation yet).
_BOXPLOT_BUCKET_EXPR = {
    # 0=Sunday..6=Saturday, matching the `dow` convention already used by
    # heatmap_aggregation/voltage_band_combined elsewhere in this file.
    "weekday": """TO_NUMBER(TO_CHAR("LOKALZEIT", 'D')) - 1""",
    "month": """EXTRACT(MONTH FROM CAST("LOKALZEIT" AS TIMESTAMP))""",
    "weekday_weekend": """CASE WHEN TO_NUMBER(TO_CHAR("LOKALZEIT", 'D')) IN (1, 7) THEN 1 ELSE 0 END""",
}


def boxplot_grouped(mtype: str, group_by: str) -> str:
    """Boxplot bucketed by weekday / month / weekday-vs-weekend.

    `group_by` must be one of the keys in `_BOXPLOT_BUCKET_EXPR` — callers
    (the service layer) validate this before building the query.
    """
    col = _val(mtype)
    bucket = _BOXPLOT_BUCKET_EXPR[group_by]
    return f"""
        SELECT
            {bucket} AS bucket,
            {col} AS value
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        ORDER BY bucket, value
    """


# =============================================================================
# Correlation - no self-join needed (all values in one row)
# =============================================================================

def correlation_scatter(mtype_x: str, mtype_y: str) -> str:
    col_x = _val(mtype_x)
    col_y = _val(mtype_y)
    return f"""
        SELECT {col_x} AS x_val, {col_y} AS y_val
        FROM {_T}
        WHERE {_WHERE}
          AND {col_x} IS NOT NULL
          AND {col_y} IS NOT NULL
        ORDER BY "LOKALZEIT"
    """


def correlation_matrix_corr() -> str:
    """One-shot Pearson correlation for every pair among (P, Q, S, U, I).

    Returns a single row with 10 CORR values in this fixed order:
        P_Q, P_S, P_U, P_I, Q_S, Q_U, Q_I, S_U, S_I, U_I
    Each CORR ignores rows where either input is NULL.
    """
    return f"""
        SELECT
            CORR("MW",  "BMW") AS p_q,
            CORR("MW",  "S")   AS p_s,
            CORR("MW",  "UUW") AS p_u,
            CORR("MW",  TO_NUMBER("STROMWERT")) AS p_i,
            CORR("BMW", "S")   AS q_s,
            CORR("BMW", "UUW") AS q_u,
            CORR("BMW", TO_NUMBER("STROMWERT")) AS q_i,
            CORR("S",   "UUW") AS s_u,
            CORR("S",   TO_NUMBER("STROMWERT")) AS s_i,
            CORR("UUW", TO_NUMBER("STROMWERT")) AS u_i
        FROM {_T}
        WHERE {_WHERE}
    """


# =============================================================================
# Variance
# =============================================================================

def variance(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT VARIANCE({col}) AS variance
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
    """


# =============================================================================
# Power factor - no self-join (P, Q, S in same row)
# =============================================================================

def power_factor_timeseries() -> str:
    return f"""
        SELECT "LOKALZEIT",
               "MW"  AS p_val,
               "BMW" AS q_val,
               "S"   AS s_val
        FROM {_T}
        WHERE {_WHERE}
          AND "MW" IS NOT NULL
          AND "BMW" IS NOT NULL
          AND "S" IS NOT NULL
        ORDER BY "LOKALZEIT"
    """


def power_factor_downsampled() -> str:
    return f"""
        SELECT
            TRUNC("LOKALZEIT") + FLOOR(
                (EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 3600
                 + EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 60)
                / :bucket
            ) * :bucket / 86400 AS bucket_time,
            AVG("MW")  AS avg_p,
            AVG("BMW") AS avg_q,
            AVG("S")   AS avg_s
        FROM {_T}
        WHERE {_WHERE}
          AND "MW" IS NOT NULL AND "BMW" IS NOT NULL AND "S" IS NOT NULL
        GROUP BY TRUNC("LOKALZEIT") + FLOOR(
                (EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 3600
                 + EXTRACT(MINUTE FROM CAST("LOKALZEIT" AS TIMESTAMP)) * 60)
                / :bucket
            ) * :bucket / 86400
        ORDER BY bucket_time
    """


# =============================================================================
# Quality view
# =============================================================================

def quality_combined() -> str:
    """Daily totals + per-hour gap heatmap in one scan via GROUPING SETS.

    Returns rows of (day, hour, cnt). Hour is NULL on the daily rollup
    rows, non-NULL on the per-hour rows.
    """
    return f"""
        SELECT
            TO_CHAR(TRUNC("LOKALZEIT"), 'YYYY-MM-DD') AS day,
            EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) AS hour,
            COUNT(*) AS cnt
        FROM {_T}
        WHERE {_WHERE}
        GROUP BY GROUPING SETS (
            (TRUNC("LOKALZEIT")),
            (TRUNC("LOKALZEIT"), EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)))
        )
        ORDER BY day, hour NULLS FIRST
    """


# =============================================================================
# DST double-hour detection
# =============================================================================

def dst_hourly_counts() -> str:
    return f"""
        SELECT
            TO_CHAR(TRUNC("LOKALZEIT"), 'YYYY-MM-DD') AS day,
            EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP)) AS hour,
            COUNT(*) AS cnt
        FROM {_T}
        WHERE {_WHERE}
          AND "MW" IS NOT NULL
        GROUP BY TRUNC("LOKALZEIT"),
                 EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP))
        ORDER BY TRUNC("LOKALZEIT"),
                 EXTRACT(HOUR FROM CAST("LOKALZEIT" AS TIMESTAMP))
    """


# =============================================================================
# Season radar
# =============================================================================

def season_monthly_values() -> str:
    return f"""
        SELECT
            EXTRACT(MONTH FROM "LOKALZEIT") AS month,
            "MW"  AS p_val,
            "BMW" AS q_val,
            "S"   AS s_val
        FROM {_T}
        WHERE {_WHERE}
          AND "MW" IS NOT NULL
        ORDER BY month
    """


# =============================================================================
# Exceedance analysis
# =============================================================================

def exceedance_timeline(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT
            TO_CHAR(TRUNC("LOKALZEIT"), 'YYYY-MM-DD') AS day,
            "LOKALZEIT",
            {col} AS value
        FROM {_T}
        WHERE {_WHERE}
          AND {col} IS NOT NULL
        ORDER BY "LOKALZEIT"
    """


# =============================================================================
# Export
# =============================================================================

def export_timeseries() -> str:
    return f"""
        SELECT "LOKALZEIT",
               "MW", "BMW", "S", "UUW",
               TO_NUMBER("STROMWERT") AS strom
        FROM {_T}
        WHERE "ANLAGENNUMMER" = :anr AND "FELDNUMMER" = :fnr
          AND "LOKALZEIT" >= TO_DATE(:s, 'YYYY-MM-DD HH24:MI:SS')
          AND "LOKALZEIT" <= TO_DATE(:e, 'YYYY-MM-DD HH24:MI:SS')
        ORDER BY "LOKALZEIT"
    """


def export_variance(mtype: str) -> str:
    col = _val(mtype)
    return f"""
        SELECT VARIANCE({col})
        FROM {_T}
        WHERE "ANLAGENNUMMER" = :anr AND "FELDNUMMER" = :fnr
          AND "LOKALZEIT" >= TO_DATE(:s, 'YYYY-MM-DD HH24:MI:SS')
          AND "LOKALZEIT" <= TO_DATE(:e, 'YYYY-MM-DD HH24:MI:SS')
          AND {col} IS NOT NULL
    """