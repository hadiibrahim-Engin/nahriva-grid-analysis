"""The results schema, applied the same way by the web app and by the PowerFactory script."""

import sqlite3
from pathlib import Path

SCHEMA_FILE = Path(__file__).resolve().parent / "migrations" / "001_analysis.sql"


def apply(db):
    """Create the tables if missing. A damaged schema file is named, not reported as a bare SQL error."""
    try:
        db.executescript(SCHEMA_FILE.read_text(encoding="utf-8-sig"))
    except (sqlite3.Error, UnicodeDecodeError) as exc:
        raise RuntimeError(
            "The schema file is not valid SQL (" + str(exc) + "): " + str(SCHEMA_FILE)
            + ". Replace it with the file from the repository."
        ) from None
