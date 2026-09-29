"""DuckDB schema for the dashboard read replica.

Schema layout follows the dashboard's actual access patterns, not the
Oracle FDWH source layout. See §3 of the plan for rationale.

The version constant is bumped whenever any DDL below changes. The
bootstrap script writes the active version into ``sync_status`` and
refuses to start incremental syncs against a mismatched DB.
"""

from __future__ import annotations

# Bumped on every breaking DDL change.
SCHEMA_VERSION = 1


# -- Dimension tables -------------------------------------------------

DDL_DIM_ANLAGE = """
CREATE TABLE IF NOT EXISTS dim_anlage (
    anr          VARCHAR PRIMARY KEY,
    anlagenname  VARCHAR
);
"""

DDL_DIM_BETRIEBSMITTEL = """
CREATE TABLE IF NOT EXISTS dim_betriebsmittel (
    anr            VARCHAR NOT NULL,
    fnr            VARCHAR NOT NULL,
    feldname_kurz  VARCHAR,
    spannungsebene VARCHAR,
    PRIMARY KEY (anr, fnr)
);
"""

DDL_DIM_MEASUREMENT_TYPE = """
CREATE TABLE IF NOT EXISTS dim_measurement_type (
    mtype VARCHAR PRIMARY KEY,
    unit  VARCHAR
);
"""

# Seed for dim_measurement_type — kept in sync with models.FDWH_MEASUREMENT_MAP.
DIM_MEASUREMENT_TYPE_SEED: list[tuple[str, str]] = [
    ("P", "MW"),
    ("Q", "Mvar"),
    ("S", "MVA"),
    ("U", "kV"),
    ("I", "A"),
]


# -- Fact tables ------------------------------------------------------

DDL_MEASUREMENTS_15MIN_RECENT = """
CREATE TABLE IF NOT EXISTS measurements_15min_recent (
    ts      TIMESTAMP NOT NULL,
    anr     VARCHAR   NOT NULL,
    fnr     VARCHAR   NOT NULL,
    p_mw    DOUBLE,
    q_mvar  DOUBLE,
    s_mva   DOUBLE,
    u_kv    DOUBLE,
    i_a     DOUBLE,
    PRIMARY KEY (anr, fnr, ts)
);
"""

DDL_MEASUREMENTS_HOURLY = """
CREATE TABLE IF NOT EXISTS measurements_hourly (
    ts            TIMESTAMP NOT NULL,
    anr           VARCHAR   NOT NULL,
    fnr           VARCHAR   NOT NULL,
    p_avg DOUBLE, p_min DOUBLE, p_max DOUBLE,
    q_avg DOUBLE, q_min DOUBLE, q_max DOUBLE,
    s_avg DOUBLE, s_min DOUBLE, s_max DOUBLE,
    u_avg DOUBLE, u_min DOUBLE, u_max DOUBLE,
    i_avg DOUBLE, i_min DOUBLE, i_max DOUBLE,
    sample_count INTEGER,
    PRIMARY KEY (anr, fnr, ts)
);
"""

DDL_MEASUREMENTS_DAILY = """
CREATE TABLE IF NOT EXISTS measurements_daily (
    day           DATE    NOT NULL,
    anr           VARCHAR NOT NULL,
    fnr           VARCHAR NOT NULL,
    p_avg DOUBLE, p_min DOUBLE, p_max DOUBLE,
    q_avg DOUBLE, q_min DOUBLE, q_max DOUBLE,
    s_avg DOUBLE, s_min DOUBLE, s_max DOUBLE,
    u_avg DOUBLE, u_min DOUBLE, u_max DOUBLE,
    i_avg DOUBLE, i_min DOUBLE, i_max DOUBLE,
    sample_count INTEGER,
    PRIMARY KEY (anr, fnr, day)
);
"""


# -- Metadata tables --------------------------------------------------

DDL_SYNC_STATUS = """
CREATE TABLE IF NOT EXISTS sync_status (
    id              INTEGER PRIMARY KEY,
    last_sync_ts    TIMESTAMP,
    source_min_ts   TIMESTAMP,
    source_max_ts   TIMESTAMP,
    retained_min_ts TIMESTAMP,
    retained_max_ts TIMESTAMP,
    last_prune_ts   TIMESTAMP,
    status          VARCHAR,
    error_message   VARCHAR,
    schema_version  INTEGER
);
"""

DDL_DUCKDB_COVERAGE = """
CREATE TABLE IF NOT EXISTS duckdb_coverage (
    table_name   VARCHAR PRIMARY KEY,
    min_ts       TIMESTAMP,
    max_ts       TIMESTAMP,
    row_count    BIGINT,
    granularity  VARCHAR
);
"""


# -- Ordered list applied by init_schema() ---------------------------

ALL_DDL: list[str] = [
    DDL_DIM_ANLAGE,
    DDL_DIM_BETRIEBSMITTEL,
    DDL_DIM_MEASUREMENT_TYPE,
    DDL_MEASUREMENTS_15MIN_RECENT,
    DDL_MEASUREMENTS_HOURLY,
    DDL_MEASUREMENTS_DAILY,
    DDL_SYNC_STATUS,
    DDL_DUCKDB_COVERAGE,
]


def init_schema(con) -> None:
    """Idempotently create every table + seed the small ones.

    ``con`` is a duckdb.DuckDBPyConnection. We deliberately don't
    import duckdb at module scope — this module is also reachable from
    code that runs without duckdb installed, and the type-hint isn't
    worth the import cost.
    """
    for ddl in ALL_DDL:
        con.execute(ddl)

    # Seed dim_measurement_type (idempotent).
    con.executemany(
        "INSERT OR REPLACE INTO dim_measurement_type(mtype, unit) VALUES (?, ?)",
        DIM_MEASUREMENT_TYPE_SEED,
    )

    # Ensure exactly one row in sync_status — the table is a singleton.
    con.execute(
        """
        INSERT INTO sync_status (id, schema_version, status)
        SELECT 1, ?, 'empty'
        WHERE NOT EXISTS (SELECT 1 FROM sync_status WHERE id = 1)
        """,
        [SCHEMA_VERSION],
    )
