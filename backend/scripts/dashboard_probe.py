#!/usr/bin/env python3
"""Run the dashboard data flow without frontend or FastAPI.

This script uses the same backend query layer as the API routes, but executes it
directly from Python. It is meant for debugging Oracle connectivity, table/view
access, component ids, date ranges, and measurement queries.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _json_default(value: Any) -> str:
    return str(value)


def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False, default=_json_default))


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


def _format_datetime(value: datetime | None) -> str | None:
    if not value:
        return None
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _check(name: str, func: Callable[[], Any], *, trace: bool) -> tuple[bool, Any]:
    print(f"\n== {name} ==", flush=True)
    started = time.perf_counter()
    try:
        data = func()
        elapsed = round((time.perf_counter() - started) * 1000)
        print(f"[OK] {name} ({elapsed} ms)")
        if data is not None:
            _print_json(data)
        return True, data
    except Exception as exc:
        # Broad on purpose: each check must report failure and let the
        # remaining checks run, regardless of the underlying error type.
        elapsed = round((time.perf_counter() - started) * 1000)
        print(f"[FAIL] {name} ({elapsed} ms)")
        print(f"{type(exc).__name__}: {exc}")
        if trace:
            traceback.print_exc(file=sys.stdout)
        return False, {"error": f"{type(exc).__name__}: {exc}"}


def _params(
    component_id: str, start: datetime | None, end: datetime | None
) -> dict[str, Any]:
    from app.models.models import parse_component_id

    anr, fnr = parse_component_id(component_id)
    return {
        "anr": anr,
        "fnr": fnr,
        "start": _format_datetime(start),
        "end": _format_datetime(end),
    }


def _fetch_facilities(db, limit: int) -> list[dict[str, Any]]:
    from app.repositories.fdwh_repository import FDWHRepository

    rows = FDWHRepository(db).list_facilities()[:limit]
    return [{"id": str(row[0]), "name": row[1]} for row in rows]


def _fetch_components(db, facility_id: str, limit: int) -> list[dict[str, Any]]:
    from app.repositories.fdwh_repository import FDWHRepository

    rows = FDWHRepository(db).list_components_by_facility(facility_id)[:limit]
    return [
        {
            "id": f"{facility_id}_{row[0]}",
            "facility_id": facility_id,
            "field_number": str(row[0]),
            "name": row[1] or "",
            "spannungsebene": row[2],
        }
        for row in rows
    ]


def _component_name(db, component_id: str) -> str:
    from app.repositories.fdwh_repository import FDWHRepository
    from app.models.models import parse_component_id

    anr, fnr = parse_component_id(component_id)
    return FDWHRepository(db).component_name(anr, fnr)


def _measurement_types() -> list[dict[str, str]]:
    from app.models.models import FDWH_MEASUREMENT_TYPES, fdwh_unit

    return [
        {"type": mtype, "unit": fdwh_unit(mtype)} for mtype in FDWH_MEASUREMENT_TYPES
    ]


def _date_range(db, component_id: str) -> dict[str, Any]:
    from app.repositories.fdwh_repository import FDWHRepository
    from app.models.models import parse_component_id

    anr, fnr = parse_component_id(component_id)
    row = FDWHRepository(db).date_range(anr, fnr)
    return {
        "min": row[0] if row else None,
        "max": row[1] if row else None,
    }


def _count_and_stats(
    db,
    component_id: str,
    measurement_type: str,
    start: datetime | None,
    end: datetime | None,
) -> dict[str, Any]:
    from app.models.models import fdwh_unit
    from app.repositories.fdwh_repository import FDWHRepository

    bind = _params(component_id, start, end)
    repository = FDWHRepository(db)
    count = repository.count_points(measurement_type, bind)
    stats_row = repository.statistics(measurement_type, bind)
    return {
        "component_name": _component_name(db, component_id),
        "measurement_type": measurement_type,
        "unit": fdwh_unit(measurement_type),
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


def _timeseries_sample(
    db,
    component_id: str,
    measurement_type: str,
    start: datetime | None,
    end: datetime | None,
    limit: int,
) -> dict[str, Any]:
    from app.repositories.fdwh_repository import FDWHRepository

    rows = FDWHRepository(db).timeseries_raw(
        measurement_type, _params(component_id, start, end)
    )[:limit]
    return {
        "sample_size": len(rows),
        "rows": [{"timestamp": row[0], "value": row[1]} for row in rows],
    }


def _analytics_samples(
    db,
    component_id: str,
    measurement_type: str,
    start: datetime | None,
    end: datetime | None,
    limit: int,
) -> dict[str, Any]:
    from app.repositories.fdwh_repository import FDWHRepository

    bind = _params(component_id, start, end)
    repository = FDWHRepository(db)
    heatmap_rows = repository.heatmap(measurement_type, bind)[:limit]
    duration_rows = repository.duration_curve(measurement_type, bind)[:limit]
    daily_profile_rows = repository.daily_profile(
        measurement_type, is_weekend=False, params=bind
    )[:limit]

    return {
        "heatmap_sample": [
            {"day_of_week": int(row[0]), "hour": int(row[1]), "value": row[2]}
            for row in heatmap_rows
        ],
        "duration_curve_top_values": [row[0] for row in duration_rows],
        "weekday_daily_profile_sample": [
            {"hour": row[0], "avg": row[1], "count": row[2]}
            for row in daily_profile_rows
        ],
    }


def _correlation_sample(
    db,
    component_id: str,
    start: datetime | None,
    end: datetime | None,
    limit: int,
) -> dict[str, Any]:
    from app.repositories.fdwh_repository import FDWHRepository

    rows = FDWHRepository(db).correlation_scatter(
        "P", "Q", _params(component_id, start, end)
    )[:limit]
    return {
        "type_x": "P",
        "type_y": "Q",
        "sample_size": len(rows),
        "rows": [{"p": row[0], "q": row[1]} for row in rows],
    }


def _resolve_credentials(args: argparse.Namespace) -> tuple[str | None, str | None]:
    username = args.username or os.getenv("DASHBOARD_PROBE_USERNAME")
    password = args.password or os.getenv("DASHBOARD_PROBE_PASSWORD")
    if username and not password and not args.no_prompt:
        password = getpass.getpass(f"Oracle password for {username}: ")
    return username, password


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe the Oracle dashboard data flow without frontend/FastAPI.",
    )
    parser.add_argument("--username", help="Oracle username to test login.")
    parser.add_argument("--password", help="Oracle password to test login.")
    parser.add_argument(
        "--no-auth", action="store_true", help="Skip Oracle credential login test."
    )
    parser.add_argument(
        "--no-prompt", action="store_true", help="Do not prompt for missing password."
    )
    parser.add_argument(
        "--facility-id", help="ANLAGENNUMMER to test. Defaults to the first facility."
    )
    parser.add_argument(
        "--component-id",
        help="ANLAGENNUMMER_FELDNUMMER. Defaults to the first component.",
    )
    parser.add_argument(
        "--measurement-type", default="P", choices=["P", "Q", "S", "U", "I"]
    )
    parser.add_argument("--start", help="ISO datetime, for example 2024-01-01T00:00:00")
    parser.add_argument("--end", help="ISO datetime, for example 2024-01-31T23:59:59")
    parser.add_argument(
        "--limit", type=int, default=5, help="Rows to show per sample query."
    )
    parser.add_argument(
        "--traceback",
        action="store_true",
        help="Show full tracebacks for failed checks.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    measurement_type = args.measurement_type.upper()
    start = _parse_datetime(args.start)
    end = _parse_datetime(args.end)
    ok = True
    state: dict[str, Any] = {}

    def config_check() -> Any:
        from app.config import safe_summary

        return safe_summary()

    step_ok, _ = _check("config", config_check, trace=args.traceback)
    ok = step_ok and ok

    if not args.no_auth:
        username, password = _resolve_credentials(args)
        if username and password:

            def auth_check() -> Any:
                from app.auth.auth import verify_oracle_credentials

                auth_ok = verify_oracle_credentials(username, password)
                if not auth_ok:
                    raise RuntimeError("Oracle rejected username/password")
                return {"username": username, "authenticated": True}

            step_ok, _ = _check("oracle-login", auth_check, trace=args.traceback)
            ok = step_ok and ok
        else:
            print("\n== oracle-login ==")
            print("[SKIP] Provide --username and --password, or use --no-auth.")

    def db_ping() -> Any:
        from sqlalchemy import text
        from app.core.constants import ORACLE_PING_SQL
        from app.db.database import get_engine

        with get_engine().connect() as conn:
            return {
                "select_1_from_dual": conn.execute(text(ORACLE_PING_SQL)).scalar_one()
            }

    step_ok, _ = _check("db-ping", db_ping, trace=args.traceback)
    ok = step_ok and ok
    if not step_ok:
        print("\nDB ping failed, so data queries cannot run yet.")
        return 1

    from app.db.database import SessionLocal

    with SessionLocal() as db:
        step_ok, facilities = _check(
            "facilities (/api/facilities)",
            lambda: _fetch_facilities(db, max(args.limit, 1)),
            trace=args.traceback,
        )
        ok = step_ok and ok
        if not step_ok or not facilities:
            print("\nNo facilities available, cannot continue dashboard flow.")
            return 1

        state["facility_id"] = args.facility_id or facilities[0]["id"]

        step_ok, components = _check(
            f"components (/api/facilities/{state['facility_id']}/components)",
            lambda: _fetch_components(db, state["facility_id"], max(args.limit, 1)),
            trace=args.traceback,
        )
        ok = step_ok and ok
        if not step_ok or not components:
            print("\nNo components available, cannot continue dashboard flow.")
            return 1

        state["component_id"] = args.component_id or components[0]["id"]

        step_ok, _ = _check(
            "measurement-types (/api/components/{component_id}/measurement-types)",
            _measurement_types,
            trace=args.traceback,
        )
        ok = step_ok and ok

        step_ok, _ = _check(
            "date-range (/api/timeseries/{component_id}/{measurement_type}/range)",
            lambda: _date_range(db, state["component_id"]),
            trace=args.traceback,
        )
        ok = step_ok and ok

        step_ok, _ = _check(
            "count-and-statistics",
            lambda: _count_and_stats(
                db, state["component_id"], measurement_type, start, end
            ),
            trace=args.traceback,
        )
        ok = step_ok and ok

        step_ok, _ = _check(
            "timeseries-sample",
            lambda: _timeseries_sample(
                db,
                state["component_id"],
                measurement_type,
                start,
                end,
                args.limit,
            ),
            trace=args.traceback,
        )
        ok = step_ok and ok

        step_ok, _ = _check(
            "analytics-samples",
            lambda: _analytics_samples(
                db,
                state["component_id"],
                measurement_type,
                start,
                end,
                args.limit,
            ),
            trace=args.traceback,
        )
        ok = step_ok and ok

        step_ok, _ = _check(
            "correlation-sample P/Q",
            lambda: _correlation_sample(
                db, state["component_id"], start, end, args.limit
            ),
            trace=args.traceback,
        )
        ok = step_ok and ok

    print("\n== summary ==")
    _print_json(
        {
            "ok": ok,
            "facility_id": state.get("facility_id"),
            "component_id": state.get("component_id"),
            "measurement_type": measurement_type,
            "start": start,
            "end": end,
        }
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
