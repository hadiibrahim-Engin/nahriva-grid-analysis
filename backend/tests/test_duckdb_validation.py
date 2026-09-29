"""Phase 7: Oracle ↔ DuckDB validation tooling.

The validator runs each case against both backends. Tests use
in-memory fakes so we don't need Oracle or a populated DuckDB file.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import pytest

from app.duckdb.validation import (
    DEFAULT_TOLERANCES,
    _within_tolerance,
    default_cases,
    run_validation,
)


class _ReproRepo:
    """Tiny repo that returns scripted values for the methods we test."""

    def __init__(self, responses: dict[str, Any]) -> None:
        self._responses = responses

    def statistics(self, _mtype: str, _params: dict[str, Any]):
        return self._responses["statistics"]

    def heatmap(self, _mtype: str, _params: dict[str, Any]):
        return self._responses["heatmap"]

    def daily_profile_combined(self, _mtype: str, _params: dict[str, Any]):
        return self._responses.get("daily_profile_combined", [])

    def voltage_band_combined(self, _params: dict[str, Any]):
        return self._responses.get("voltage_band_combined", [])

    def duration_curve(self, _mtype: str, _params: dict[str, Any]):
        return self._responses.get("duration_curve", [])

    def timeseries_downsampled(self, _mtype: str, _params: dict[str, Any], _agg: str = "AVG"):
        return self._responses.get("timeseries_downsampled", [])


# -- tolerance helper -----------------------------------------------


@pytest.mark.parametrize(
    "a,b,tol,expected",
    [
        (None, None, 1e-9, True),
        (1.0, None, 1e-9, False),
        (1.0, 1.0, 1e-9, True),
        (1.0, 1.0 + 1e-12, 1e-9, True),
        (1.0, 2.0, 1e-9, False),
        (0.0, 0.0, 0.0, True),
        (1e-6, 1e-6, 1e-6, True),
    ],
)
def test_within_tolerance(a, b, tol, expected) -> None:
    assert _within_tolerance(a, b, tol) is expected


# -- happy path: numbers match --------------------------------------


def test_run_validation_all_ok_when_responses_agree() -> None:
    same = (100, 5.0, 1.0, 10.0, 2.0)
    oracle = _ReproRepo({"statistics": same, "heatmap": [("a",), ("b",)]})
    duck = _ReproRepo({"statistics": same, "heatmap": [("a",), ("b",)]})
    report = run_validation(
        oracle_repo=oracle,
        duckdb_repo=duck,
        cases=[
            {"name": "stats", "method": "statistics", "args": ["P", {}],
             "comparison": "statistics"},
            {"name": "heat", "method": "heatmap", "args": ["P", {}],
             "comparison": "row_count"},
        ],
    )
    assert report.summary()["all_ok"] is True
    for c in report.cases:
        assert c.ok


# -- drift outside tolerance is reported ----------------------------


def test_run_validation_flags_mean_drift_beyond_tolerance() -> None:
    oracle = _ReproRepo({"statistics": (100, 5.0, 1.0, 10.0, 2.0), "heatmap": []})
    # mean drifts by ~10× the default tolerance → fail.
    duck = _ReproRepo({"statistics": (100, 5.001, 1.0, 10.0, 2.0), "heatmap": []})
    report = run_validation(
        oracle_repo=oracle,
        duckdb_repo=duck,
        cases=[{"name": "stats", "method": "statistics", "args": ["P", {}],
                "comparison": "statistics"}],
    )
    assert report.summary()["all_ok"] is False
    case = report.cases[0]
    assert not case.ok
    assert "mean" in " ".join(case.notes)


def test_run_validation_passes_within_explicit_tolerance() -> None:
    """Loosening tolerance per key turns the same drift into a pass."""
    oracle = _ReproRepo({"statistics": (100, 5.0, 1.0, 10.0, 2.0), "heatmap": []})
    duck = _ReproRepo({"statistics": (100, 5.01, 1.0, 10.0, 2.0), "heatmap": []})
    report = run_validation(
        oracle_repo=oracle, duckdb_repo=duck,
        cases=[{"name": "stats", "method": "statistics", "args": ["P", {}],
                "comparison": "statistics"}],
        tolerances={**DEFAULT_TOLERANCES, "mean": 0.1},
    )
    assert report.cases[0].ok


# -- row count comparison -------------------------------------------


def test_row_count_mismatch_is_reported() -> None:
    oracle = _ReproRepo({"statistics": None, "heatmap": [("a",)] * 100})
    duck = _ReproRepo({"statistics": None, "heatmap": [("a",)] * 80})
    report = run_validation(
        oracle_repo=oracle, duckdb_repo=duck,
        cases=[{"name": "heat", "method": "heatmap", "args": ["P", {}],
                "comparison": "row_count"}],
    )
    assert not report.cases[0].ok
    assert "row count" in report.cases[0].notes[0]


# -- report serialisation -------------------------------------------


def test_report_json_round_trips() -> None:
    oracle = _ReproRepo({"statistics": (1, 1.0, 1.0, 1.0, 1.0), "heatmap": []})
    duck = _ReproRepo({"statistics": (1, 1.0, 1.0, 1.0, 1.0), "heatmap": []})
    report = run_validation(
        oracle_repo=oracle, duckdb_repo=duck,
        cases=[{"name": "stats", "method": "statistics", "args": ["P", {}],
                "comparison": "statistics"}],
    )
    blob = report.to_json()
    parsed = json.loads(blob)
    assert "cases" in parsed
    assert parsed["summary"]["all_ok"] is True


# -- default case set covers the plan's §9 list --------------------


def test_default_cases_covers_expected_queries() -> None:
    cases = default_cases("A1", "F1", datetime(2024, 1, 1), datetime(2024, 12, 31))
    methods = {c["method"] for c in cases}
    assert {"statistics", "heatmap", "daily_profile_combined",
            "voltage_band_combined", "duration_curve",
            "timeseries_downsampled"}.issubset(methods)
