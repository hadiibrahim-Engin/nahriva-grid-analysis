"""Integration test for the SQL → API → chart diagnostic script.

The script imports backend code that talks to Oracle and uses `requests`
for HTTP. Here we patch both: `get_engine` returns a FakeEngine that
yields configurable row tuples, and `requests.get` / `requests.post`
return canned responses. Each scenario exercises a different failing
layer to verify the diagnostic identifies it correctly.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
from datetime import datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest


# -- Fakes for the Oracle layer ---------------------------------------


class FakeResult:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple]:
        return self._rows


class FakeConnection:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, _sql: Any, _params: dict[str, Any]) -> FakeResult:
        return FakeResult(self._rows)


class FakeEngine:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def connect(self) -> FakeConnection:
        return FakeConnection(self._rows)


# -- Fake requests responses ------------------------------------------


class FakeResponse:
    def __init__(self, status_code: int, payload: Any, text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = text or (json.dumps(payload) if payload is not None else "")
        self.headers = {"content-type": "application/json"}

    def json(self) -> Any:
        return self._payload


# -- Helpers ----------------------------------------------------------


CLI_ARGS = [
    "--anr", "A1",
    "--fnr", "F2",
    "--mtype", "P",
    "--start", "2025-01-01T00:00:00",
    "--end", "2025-01-31T23:59:59",
    "--base-url", "http://test-host",
    "--username", "u",
    "--password", "p",
]


def _run_script(*, sql_rows: list[tuple], api_payload: Any,
                api_status: int = 200, login_status: int = 200,
                extra_args: list[str] | None = None) -> dict[str, Any]:
    """Run main() with patched Oracle + HTTP and return the parsed JSON output."""
    import app.db.database as db_module
    import requests

    def fake_post(url: str, **_kwargs: Any) -> FakeResponse:
        assert "/api/auth/login" in url
        if login_status != 200:
            return FakeResponse(login_status, {"detail": "no"})
        return FakeResponse(200, {"access_token": "tok", "token_type": "bearer"})

    def fake_get(url: str, **_kwargs: Any) -> FakeResponse:
        assert "/api/timeseries/" in url
        return FakeResponse(api_status, api_payload)

    from scripts import diagnose_timeseries

    stdout = io.StringIO()
    with patch.object(db_module, "get_engine", lambda: FakeEngine(sql_rows)), \
         patch.object(requests, "post", fake_post), \
         patch.object(requests, "get", fake_get), \
         contextlib.redirect_stdout(stdout):
        try:
            diagnose_timeseries.main(CLI_ARGS + (extra_args or []))
        except SystemExit:
            pass

    # The script writes one JSON document to stdout; everything else goes
    # to stderr. Parse the whole stdout buffer as JSON.
    return json.loads(stdout.getvalue())


def _layer(result: dict[str, Any], name: str) -> dict[str, Any]:
    matches = [l for l in result["layers"] if l["layer"] == name]
    assert matches, f"no layer {name!r} recorded: {[l['layer'] for l in result['layers']]}"
    return matches[0]


# -- Tests ------------------------------------------------------------


SAMPLE_ROWS = [
    (datetime(2025, 1, 1, 0, 0), 1.0),
    (datetime(2025, 1, 1, 1, 0), 1.5),
]

SAMPLE_PAYLOAD = {
    "component_id": "A1_F2",
    "component_name": "Trafo",
    "measurement_type": "P",
    "unit": "kW",
    "data": [
        {"timestamp": "2025-01-01T00:00:00Z", "value": 1.0},
        {"timestamp": "2025-01-01T01:00:00Z", "value": 1.5},
    ],
    "total_raw_count": 2,
    "downsampled": False,
    "bucket_seconds": None,
}


def test_all_layers_pass():
    result = _run_script(sql_rows=SAMPLE_ROWS, api_payload=SAMPLE_PAYLOAD)
    assert result["ok"] is True
    assert result["first_failure"] is None
    assert _layer(result, "sql.has_data")["ok"]
    assert _layer(result, "api.contract")["ok"]
    assert _layer(result, "chart.dataset")["ok"]


def test_empty_sql_fails_at_has_data():
    result = _run_script(sql_rows=[], api_payload=SAMPLE_PAYLOAD)
    assert result["ok"] is False
    assert result["first_failure"] == "sql.has_data"


def test_sql_ok_but_api_empty_fails_at_row_count():
    """SQL has rows; the API returns zero. The diagnostic should pin
    the loss to the api.row_count layer."""
    empty_payload = {**SAMPLE_PAYLOAD, "data": []}
    result = _run_script(sql_rows=SAMPLE_ROWS, api_payload=empty_payload)
    assert result["ok"] is False
    assert result["first_failure"] == "api.row_count"


def test_api_missing_required_fields_fails_at_contract():
    bad_payload = {"data": SAMPLE_PAYLOAD["data"]}  # missing component_id etc.
    result = _run_script(sql_rows=SAMPLE_ROWS, api_payload=bad_payload)
    assert result["ok"] is False
    assert result["first_failure"] == "api.contract"


def test_api_http_error_fails_at_request():
    result = _run_script(sql_rows=SAMPLE_ROWS, api_payload={"detail": "boom"}, api_status=500)
    assert result["ok"] is False
    assert result["first_failure"] == "api.request"


def test_login_failure_short_circuits():
    result = _run_script(sql_rows=SAMPLE_ROWS, api_payload=SAMPLE_PAYLOAD, login_status=401)
    assert result["ok"] is False
    assert result["first_failure"] == "api.auth"


def test_mapping_fails_on_null_timestamps():
    """API returns rows but each timestamp is null — the frontend chart
    couldn't plot them, and the diagnostic must say so."""
    payload = {**SAMPLE_PAYLOAD, "data": [
        {"timestamp": None, "value": 1.0},
        {"timestamp": None, "value": 2.0},
    ]}
    result = _run_script(sql_rows=SAMPLE_ROWS, api_payload=payload)
    assert result["ok"] is False
    assert result["first_failure"] == "frontend.mapping"


def test_mapping_fails_on_non_numeric_values():
    payload = {**SAMPLE_PAYLOAD, "data": [
        {"timestamp": "2025-01-01T00:00:00", "value": "not-a-number"},
        {"timestamp": "2025-01-01T01:00:00", "value": "nope"},
    ]}
    result = _run_script(sql_rows=SAMPLE_ROWS, api_payload=payload)
    assert result["ok"] is False
    assert result["first_failure"] == "frontend.mapping"


def test_skip_api_runs_only_sql_layer():
    """--skip-api keeps the diagnostic local when the backend is down."""
    result = _run_script(
        sql_rows=SAMPLE_ROWS,
        api_payload=None,
        extra_args=["--skip-api"],
    )
    layer_names = [l["layer"] for l in result["layers"]]
    assert "sql.has_data" in layer_names
    assert "api.request" not in layer_names


def test_downsampled_response_does_not_fail_row_count():
    payload = {**SAMPLE_PAYLOAD, "downsampled": True,
               "data": [SAMPLE_PAYLOAD["data"][0]]}  # 1 downsampled point
    # 100 raw 15-min samples > 1 downsampled bucket should NOT fail the
    # row-count layer because the downsampled flag is set.
    rows = [
        (datetime(2025, 1, 1) + timedelta(minutes=15 * i), float(i))
        for i in range(100)
    ]
    result = _run_script(sql_rows=rows, api_payload=payload)
    assert _layer(result, "api.row_count")["ok"], result
