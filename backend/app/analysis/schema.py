"""The results schema, set up once per database file by the web app and by the PowerFactory script.

Set-up runs only when `PRAGMA user_version` is below the layout version of the caller, so opening a
database that is already set up never asks for the write lock: the dashboard keeps answering while the
PowerFactory script saves a scenario.
"""

import sqlite3
from pathlib import Path

SCHEMA_FILE = Path(__file__).resolve().parent / "migrations" / "002_analysis.sql"
SCHEMA_VERSION = 2  # schema_migrations.version written by SCHEMA_FILE
# Messages SQLite gives for SQL it cannot parse; anything else (locked, read-only, disk full) is no
# fault of the schema file and is raised as it is.
_PARSE_ERRORS = ("syntax error", "unrecognized token", "incomplete input")


class OutdatedDatabaseError(RuntimeError):
    """The file was written by another schema version; it is never read with the wrong layout."""


def stored_version(db):
    """schema_migrations.version of the file, None for a new (empty) file."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone():
        return None
    return db.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]


def check_version(db):
    version = stored_version(db)
    if version is None or version == SCHEMA_VERSION:
        return version
    if version < SCHEMA_VERSION:
        raise OutdatedDatabaseError(
            "This results database was written by an earlier version (schema {}) and is not read. "
            "Delete it (stop-dashboard.cmd -DeleteDatabase) and run the assessment again.".format(version)
        )
    raise OutdatedDatabaseError(
        "This results database was written by a newer version (schema {}). Update this installation.".format(version)
    )


def needs_setup(db, version):
    return db.execute("PRAGMA user_version").fetchone()[0] < version


def mark_set_up(db, version):
    db.execute("PRAGMA user_version = {:d}".format(version))


def apply(db):
    """Create the analysis tables if missing. Only a damaged schema file is reported as one."""
    try:
        sql = SCHEMA_FILE.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise RuntimeError(_damaged(exc)) from None
    try:
        db.executescript(sql)
    except sqlite3.OperationalError as exc:
        if any(text in str(exc) for text in _PARSE_ERRORS):
            raise RuntimeError(_damaged(exc)) from None
        raise


def _damaged(exc):
    return (
        "The schema file is not valid SQL (" + str(exc) + "): " + str(SCHEMA_FILE)
        + ". Replace it with the file from the repository."
    )
