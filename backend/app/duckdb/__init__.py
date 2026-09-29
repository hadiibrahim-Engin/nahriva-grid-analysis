"""DuckDB read-replica acceleration layer (optional).

Nothing in this package is imported when ``DUCKDB_ENABLED`` is false.
That keeps the Oracle-only baseline byte-identical to the pre-replica
behaviour — see ``docs/duckdb-read-replica-plan.md`` for the
end-to-end design.
"""
