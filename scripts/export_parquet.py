"""Archive one analysis of a results database as immutable Parquet files (ZSTD, manifest, SHA-256), or verify one.

    backend/.venv/Scripts/python.exe scripts/export_parquet.py --out D:/archive              (newest analysis)
    backend/.venv/Scripts/python.exe scripts/export_parquet.py --db x.sqlite3 --analysis <id> --out D:/archive
    backend/.venv/Scripts/python.exe scripts/export_parquet.py --verify D:/archive/<id>

Needs pyarrow: backend/.venv/Scripts/python.exe -m pip install "./backend[archive]". Reads the database only.
"""

import argparse
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))
import appconfig  # noqa: E402
from app.archive.parquet import ArchiveError, export_analysis, import_analysis, verify_archive  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, help="results database (otherwise from the configuration)")
    parser.add_argument("--analysis", help="analysis id (otherwise the newest complete analysis)")
    parser.add_argument("--out", type=Path, help="archive folder; the analysis is written to <out>/<analysis id>")
    parser.add_argument("--verify", type=Path, metavar="ARCHIVE", help="check an archive instead of writing one")
    parser.add_argument("--restore", type=Path, metavar="ARCHIVE", help="restore an archive into a new --db file")
    args = parser.parse_args(argv)
    if args.restore:
        if not args.db or args.verify or args.out:
            parser.error("--restore requires --db NEW_DATABASE, without --out or --verify")
        try:
            result = import_analysis(args.restore, args.db)
            print("Archive restored:", result["path"])
            return 0
        except ArchiveError as error:
            print("ERROR:", error)
            return 1

    if args.verify:
        try:
            problems = verify_archive(args.verify)
        except ArchiveError as error:
            print("ERROR:", error)
            return 1
        for problem in problems:
            print("PROBLEM:", problem)
        print("Archive verified: complete and unchanged." if not problems else f"{len(problems)} problem(s).")
        return 1 if problems else 0
    if not args.out:
        parser.error("--out is required to write an archive")
    database = args.db or Path(appconfig.load(ROOT)["database"])
    analysis = args.analysis or _newest(database)
    if analysis is None:
        print("No complete analysis in", database)
        return 1
    started = time.monotonic()
    try:
        target = export_analysis(database, analysis, args.out,
                                 on_file=lambda name, rows: print(f"  {name:<24} {rows:>12,} rows  {time.monotonic() - started:7.1f} s",
                                                                  flush=True))
    except ArchiveError as error:
        print("ERROR:", error)
        return 1
    size = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
    print(f"Archive written and verified: {target} ({size / 1e6:,.1f} MB, {time.monotonic() - started:.1f} s)")
    return 0


def _newest(database):
    import sqlite3
    db = sqlite3.connect(f"file:{Path(database).resolve()}?mode=ro", uri=True)
    try:
        row = db.execute("SELECT id FROM gl_assessments WHERE status = 'complete' "
                         "ORDER BY created_at DESC, rowid DESC LIMIT 1").fetchone()
        return row[0] if row else None
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
