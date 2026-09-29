#!/usr/bin/env python3
"""Standalone backend diagnostics.

Run this from the backend directory, for example:

    python debug_backend.py config
    python debug_backend.py db-ping
    python debug_backend.py facilities --limit 5
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Callable

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _print_json(data: object) -> None:
    print(json.dumps(data, indent=2, default=str, ensure_ascii=False))


def _run(name: str, func: Callable[[], None], show_traceback: bool) -> bool:
    print(f"\n== {name} ==", flush=True)
    try:
        func()
    except Exception as exc:
        # Broad on purpose: a diagnostics command must report any failure
        # type rather than crash the runner.
        print(f"[ERROR] {type(exc).__name__}: {exc}")
        if show_traceback:
            traceback.print_exc(file=sys.stdout)
        return False
    return True


def cmd_config(_args: argparse.Namespace) -> None:
    from app.config import safe_summary

    _print_json(safe_summary())


def cmd_import_app(_args: argparse.Namespace) -> None:
    from app.main import app

    routes = []
    for route in app.routes:
        methods = sorted(route.methods) if getattr(route, "methods", None) else []
        routes.append({"path": getattr(route, "path", ""), "methods": methods})
    print(f"Imported FastAPI app with {len(routes)} routes.")
    _print_json(routes)


def cmd_db_ping(_args: argparse.Namespace) -> None:
    from sqlalchemy import text
    from app.core.constants import ORACLE_PING_SQL
    from app.db.database import get_engine

    eng = get_engine()
    print(eng.url)
    with get_engine().connect() as conn:
        value = conn.execute(text(ORACLE_PING_SQL)).scalar_one()
    print(f"Oracle ping ok: {value}")


def cmd_auth(args: argparse.Namespace) -> None:
    from app.auth.auth import verify_oracle_credentials

    ok = verify_oracle_credentials(args.username, args.password)
    print("Authentication ok." if ok else "Authentication failed.")
    if not ok:
        raise SystemExit(1)


def cmd_facilities(args: argparse.Namespace) -> None:
    from app.db.database import SessionLocal
    from app.repositories.fdwh_repository import FDWHRepository

    with SessionLocal() as db:
        rows = FDWHRepository(db).list_facilities()[: args.limit]
    _print_json([{"id": str(row[0]), "name": row[1]} for row in rows])


def _parse_optional_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


def cmd_component(args: argparse.Namespace) -> None:
    from app.db.database import SessionLocal
    from app.repositories.fdwh_repository import FDWHRepository
    from app.models.models import parse_component_id, fdwh_unit

    anr, fnr = parse_component_id(args.component_id)
    start = _parse_optional_datetime(args.start)
    end = _parse_optional_datetime(args.end)
    params = {
        "anr": anr,
        "fnr": fnr,
        "start": start.strftime("%Y-%m-%d %H:%M:%S") if start else None,
        "end": end.strftime("%Y-%m-%d %H:%M:%S") if end else None,
    }

    with SessionLocal() as db:
        repository = FDWHRepository(db)
        component_name = repository.component_name(anr, fnr)
        range_row = repository.date_range(anr, fnr)
        count = repository.count_points(args.measurement_type.upper(), params)
        stats_row = repository.statistics(args.measurement_type.upper(), params)

    _print_json(
        {
            "component_id": args.component_id,
            "component_name": component_name,
            "measurement_type": args.measurement_type.upper(),
            "unit": fdwh_unit(args.measurement_type),
            "database_range": {
                "min": range_row[0] if range_row else None,
                "max": range_row[1] if range_row else None,
            },
            "selected_range": {"start": start, "end": end},
            "count": count,
            "statistics": {
                "count": stats_row[0] if stats_row else 0,
                "mean": stats_row[1] if stats_row else None,
                "min": stats_row[2] if stats_row else None,
                "max": stats_row[3] if stats_row else None,
                "std_dev": stats_row[4] if stats_row else None,
            },
        }
    )


def cmd_all(args: argparse.Namespace) -> None:
    steps: list[tuple[str, Callable[[], None]]] = [
        ("config", lambda: cmd_config(args)),
        ("import-app", lambda: cmd_import_app(args)),
        ("db-ping", lambda: cmd_db_ping(args)),
        ("facilities", lambda: cmd_facilities(args)),
    ]
    ok = True
    for name, func in steps:
        ok = _run(name, func, args.traceback) and ok
    if not ok:
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Debug the FastAPI/Oracle backend.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("config", help="Show safe config summary.").set_defaults(
        func=cmd_config
    )
    sub.add_parser(
        "import-app", help="Import FastAPI app and list routes."
    ).set_defaults(func=cmd_import_app)
    sub.add_parser(
        "db-ping", help="Open SQLAlchemy connection and SELECT 1 FROM DUAL."
    ).set_defaults(func=cmd_db_ping)

    auth = sub.add_parser("auth", help="Test Oracle credential login.")
    auth.add_argument("--username", required=True)
    auth.add_argument("--password", required=True)
    auth.set_defaults(func=cmd_auth)

    facilities = sub.add_parser(
        "facilities", help="List facilities from FDWH stammdaten."
    )
    facilities.add_argument("--limit", type=int, default=10)
    facilities.set_defaults(func=cmd_facilities)

    component = sub.add_parser(
        "component", help="Check one component/measurement query."
    )
    component.add_argument(
        "--component-id", required=True, help="Format: ANLAGENNUMMER_FELDNUMMER"
    )
    component.add_argument(
        "--measurement-type", default="P", choices=["P", "Q", "S", "U", "I"]
    )
    component.add_argument(
        "--start", help="ISO datetime, for example 2024-01-01T00:00:00"
    )
    component.add_argument(
        "--end", help="ISO datetime, for example 2024-01-31T23:59:59"
    )
    component.set_defaults(func=cmd_component)

    all_cmd = sub.add_parser(
        "all", help="Run config, import-app, db-ping, and facilities."
    )
    all_cmd.add_argument("--limit", type=int, default=5)
    all_cmd.set_defaults(func=cmd_all)

    return parser


# def main() -> int:
#     parser = build_parser()
#     argv = sys.argv[1:]
#     show_traceback = "--traceback" in argv
#     argv = [arg for arg in argv if arg != "--traceback"]
#     args = parser.parse_args(argv)
#     args.traceback = show_traceback
#     ok = _run(args.command, lambda: args.func(args), args.traceback)
#     return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    """
    Entry point for the debug script.

    Behavior:
      - If called with no arguments: run `all` with default options.
      - If called with arguments: use subcommands (config, db-ping, etc.).
      - Global flag: --traceback (works in both modes).
    """
    if argv is None:
        argv = sys.argv[1:]

    # Global debug flag
    show_traceback = "--traceback" in argv
    argv = [arg for arg in argv if arg != "--traceback"]

    parser = build_parser()

    if not argv:
        # No args: default to "all"
        args = parser.parse_args(["all"])
    else:
        args = parser.parse_args(argv)

    args.traceback = show_traceback

    ok = _run(args.command, lambda: args.func(args), args.traceback)
    return 0 if ok else 1


if __name__ == "__main__":
    main()
