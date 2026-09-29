#!/usr/bin/env python3
"""Diagnose where a time-series request loses its data.

When the dashboard fails to render a time series for a selection that
*should* have data, run this script against the same Anlage / Betriebs-
mittel / Messgröße / time window. It walks the pipeline layer by layer
and prints a JSON diagnostic that names the failing stage:

  1. SQL                  — Oracle returns rows for the given selection.
  2. Backend API          — /api/timeseries returns matching rows.
  3. API contract         — response shape matches frontend expectations.
  4. Frontend mapping     — each point has a parseable timestamp and a
                            numeric value (the same checks the chart does
                            before plotting).
  5. Chart readiness      — final dataset is non-empty and renderable.

Each layer either passes or fails with a short reason and a sample.

Usage:
    python -m scripts.diagnose_timeseries \\
        --anr A1 --fnr F2 --mtype P \\
        --start 2025-01-01T00:00:00 --end 2025-01-31T23:59:59 \\
        --base-url http://localhost:8000 \\
        --username myuser --password mypass

If --username/--password are omitted, the script tries the
DASHBOARD_USER / DASHBOARD_PASSWORD env vars, then DB_USER / DB_PASSWORD.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


# -- Result accumulator -----------------------------------------------


class Diagnostic:
    """Collects pass/fail per layer plus a free-form context blob."""

    def __init__(self) -> None:
        self.layers: list[dict[str, Any]] = []
        self.context: dict[str, Any] = {}

    def record(self, name: str, ok: bool, *, reason: str = "", sample: Any = None, extra: Any = None) -> None:
        entry: dict[str, Any] = {"layer": name, "ok": ok}
        if reason:
            entry["reason"] = reason
        if sample is not None:
            entry["sample"] = sample
        if extra is not None:
            entry["extra"] = extra
        self.layers.append(entry)
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {name}{(': ' + reason) if reason else ''}", file=sys.stderr)

    def to_dict(self) -> dict[str, Any]:
        first_failure = next((l for l in self.layers if not l["ok"]), None)
        return {
            "ok": all(l["ok"] for l in self.layers),
            "first_failure": first_failure["layer"] if first_failure else None,
            "context": self.context,
            "layers": self.layers,
        }


# -- Layer 1: SQL baseline --------------------------------------------


def check_sql(diag: Diagnostic, args: argparse.Namespace) -> list[tuple] | None:
    """Run the same raw-timeseries query the API would use, directly."""
    try:
        from sqlalchemy import text
        from app.db.database import get_engine
        from app.db.queries import timeseries_raw
    except Exception as exc:
        diag.record("sql.import", False, reason=f"could not import backend DB layer: {exc}")
        return None

    sql = timeseries_raw(args.mtype)
    params = {
        "anr": args.anr,
        "fnr": args.fnr,
        "start": args.start.strftime("%Y-%m-%d %H:%M:%S"),
        "end": args.end.strftime("%Y-%m-%d %H:%M:%S"),
    }

    try:
        engine = get_engine()
        with engine.connect() as conn:
            t0 = time.perf_counter()
            rows = list(conn.execute(text(sql), params).fetchall())
            elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
    except Exception as exc:
        diag.record("sql.query", False, reason=f"Oracle query failed: {exc}")
        return None

    sample = [
        {"timestamp": str(r[0]), "value": r[1]}
        for r in rows[:3]
    ]
    diag.record(
        "sql.query",
        ok=True,
        reason=f"{len(rows)} rows, {elapsed_ms} ms",
        sample=sample,
        extra={"sql_params": params},
    )
    if not rows:
        diag.record(
            "sql.has_data",
            False,
            reason="Oracle returned 0 rows for this selection. Either the DB has no data, "
                   "the (anr, fnr, mtype) is wrong, or the time window misses the data.",
        )
        return None

    diag.record("sql.has_data", True, reason=f"{len(rows)} rows in window")
    return rows


# -- Layer 2: API call ------------------------------------------------


def check_api(diag: Diagnostic, args: argparse.Namespace, token: str | None) -> dict[str, Any] | None:
    import requests

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    component_id = f"{args.anr}_{args.fnr}"
    url = f"{args.base_url.rstrip('/')}/api/timeseries/{component_id}/{args.mtype}"
    params = {
        "start": args.start.isoformat(timespec="seconds"),
        "end": args.end.isoformat(timespec="seconds"),
    }

    try:
        t0 = time.perf_counter()
        response = requests.get(url, params=params, headers=headers, timeout=30)
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
    except Exception as exc:
        diag.record("api.request", False, reason=f"HTTP request failed: {exc}",
                    extra={"url": url, "params": params})
        return None

    if response.status_code != 200:
        diag.record(
            "api.request",
            False,
            reason=f"HTTP {response.status_code}: {response.text[:200]}",
            extra={"url": url, "params": params},
        )
        return None

    try:
        payload = response.json()
    except Exception:
        diag.record(
            "api.json",
            False,
            reason=f"API did not return JSON (content-type: {response.headers.get('content-type')})",
        )
        return None

    diag.record("api.request", True, reason=f"HTTP 200, {elapsed_ms} ms",
                extra={"url": url, "params": params})
    return payload


# -- Layer 3: contract check ------------------------------------------


def check_contract(diag: Diagnostic, payload: dict[str, Any]) -> list[dict[str, Any]] | None:
    required = ("component_id", "component_name", "measurement_type", "unit", "data")
    missing = [field for field in required if field not in payload]
    if missing:
        diag.record(
            "api.contract",
            False,
            reason=f"API response missing required fields: {missing}",
            sample=list(payload.keys())[:20],
        )
        return None

    data = payload.get("data")
    if not isinstance(data, list):
        diag.record("api.contract", False,
                    reason=f"'data' field is {type(data).__name__}, expected list")
        return None

    diag.record("api.contract", True,
                reason=f"all required fields present; data has {len(data)} points")
    return data


# -- Layer 4: frontend mapping ----------------------------------------


def check_mapping(diag: Diagnostic, data: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """Replicate the validity checks the TimeseriesChart does before
    handing points to ECharts."""
    if not data:
        diag.record(
            "frontend.mapping",
            False,
            reason="API returned a response but the data array is empty",
        )
        return None

    mapped: list[dict[str, Any]] = []
    failures: list[str] = []
    for index, raw in enumerate(data):
        if not isinstance(raw, dict):
            failures.append(f"index {index}: not an object ({type(raw).__name__})")
            continue
        ts = raw.get("timestamp")
        value = raw.get("value")
        if ts is None:
            failures.append(f"index {index}: null timestamp")
            continue
        # The chart parses ISO strings to a Date; verify ours parses.
        try:
            datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        except Exception:
            failures.append(f"index {index}: timestamp {ts!r} not parseable as ISO date")
            continue
        if value is None:
            failures.append(f"index {index}: null value")
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            failures.append(f"index {index}: value {value!r} is not numeric")
            continue
        mapped.append({"timestamp": str(ts), "value": numeric})

    if failures:
        diag.record(
            "frontend.mapping",
            False,
            reason=f"{len(failures)} of {len(data)} points dropped by frontend validity checks",
            sample=failures[:5],
        )
        if not mapped:
            return None

    sample = mapped[:3] if mapped else None
    diag.record(
        "frontend.mapping",
        ok=bool(mapped) and not failures,
        reason=f"{len(mapped)} valid points after frontend mapping",
        sample=sample,
    )
    return mapped if mapped else None


# -- Layer 5: chart readiness -----------------------------------------


def check_chart_readiness(diag: Diagnostic, mapped: list[dict[str, Any]]) -> None:
    if not mapped:
        diag.record("chart.dataset", False, reason="No valid points reached the chart layer")
        return
    diag.record("chart.dataset", True, reason=f"chart would receive {len(mapped)} points")


# -- Authentication helper --------------------------------------------


def _resolve_creds(args: argparse.Namespace) -> tuple[str | None, str | None]:
    user = args.username or os.getenv("DASHBOARD_USER") or os.getenv("DB_USER")
    password = args.password or os.getenv("DASHBOARD_PASSWORD") or os.getenv("DB_PASSWORD")
    return user, password


def get_token(args: argparse.Namespace) -> str | None:
    import requests

    user, password = _resolve_creds(args)
    if not user or not password:
        return None

    url = f"{args.base_url.rstrip('/')}/api/auth/login"
    try:
        response = requests.post(url, data={"username": user, "password": password}, timeout=15)
    except Exception:
        return None
    if response.status_code != 200:
        return None
    return response.json().get("access_token")


# -- CLI --------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--anr", required=True, help="ANLAGENNUMMER")
    p.add_argument("--fnr", required=True, help="FELDNUMMER")
    p.add_argument("--mtype", required=True, choices=["P", "Q", "S", "U", "I"], help="Messgröße")
    p.add_argument("--start", required=True, type=datetime.fromisoformat, help="ISO start timestamp")
    p.add_argument("--end", required=True, type=datetime.fromisoformat, help="ISO end timestamp")
    p.add_argument("--base-url", default=os.getenv("DASHBOARD_BASE_URL", "http://localhost:8000"),
                   help="Backend base URL (default: http://localhost:8000)")
    p.add_argument("--username", default=None, help="Optional; falls back to DASHBOARD_USER / DB_USER env vars")
    p.add_argument("--password", default=None, help="Optional; falls back to DASHBOARD_PASSWORD / DB_PASSWORD env vars")
    p.add_argument("--skip-api", action="store_true",
                   help="Skip the HTTP layers and run only the SQL check")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    diag = Diagnostic()
    diag.context = {
        "anr": args.anr,
        "fnr": args.fnr,
        "component_id": f"{args.anr}_{args.fnr}",
        "mtype": args.mtype,
        "start": args.start.isoformat(timespec="seconds"),
        "end": args.end.isoformat(timespec="seconds"),
        "base_url": args.base_url,
    }

    # Layer 1 — SQL
    sql_rows = check_sql(diag, args)

    if args.skip_api:
        print(json.dumps(diag.to_dict(), indent=2, ensure_ascii=False, default=str))
        return 0 if diag.to_dict()["ok"] else 1

    # Layer 2 — API
    token = get_token(args)
    if token is None:
        diag.record("api.auth", False,
                    reason="Login failed or credentials missing; HTTP layers will be skipped")
        print(json.dumps(diag.to_dict(), indent=2, ensure_ascii=False, default=str))
        return 1
    diag.record("api.auth", True, reason="login.success")

    payload = check_api(diag, args, token)
    if payload is None:
        print(json.dumps(diag.to_dict(), indent=2, ensure_ascii=False, default=str))
        return 1

    # Sanity check: the row count gap between SQL and API points at a
    # backend bug (filter mismatch, downsampling).
    if sql_rows is not None:
        api_count = len(payload.get("data") or [])
        sql_count = len(sql_rows)
        if payload.get("downsampled"):
            diag.record(
                "api.row_count",
                True,
                reason=f"API returned {api_count} downsampled points "
                       f"(SQL baseline {sql_count}, downsampled flag set)",
            )
        elif api_count == 0 and sql_count > 0:
            diag.record(
                "api.row_count",
                False,
                reason=f"SQL returned {sql_count} rows but the API returned 0 — "
                       "backend lost the data between query and serialization",
            )
        else:
            ratio = api_count / sql_count if sql_count else 0
            diag.record(
                "api.row_count",
                ok=(0.5 < ratio < 1.5),
                reason=f"API returned {api_count}, SQL baseline {sql_count} (ratio {ratio:.2f})",
            )

    # Layer 3 — contract
    data = check_contract(diag, payload)
    if data is None:
        print(json.dumps(diag.to_dict(), indent=2, ensure_ascii=False, default=str))
        return 1

    # Layer 4 — frontend mapping
    mapped = check_mapping(diag, data)

    # Layer 5 — chart readiness
    check_chart_readiness(diag, mapped or [])

    result = diag.to_dict()
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
