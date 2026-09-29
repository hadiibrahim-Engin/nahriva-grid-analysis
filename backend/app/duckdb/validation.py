"""Compare DuckDB query results against the authoritative Oracle answer.

The validation runs each representative dashboard query against both
backends, compares row counts, aggregates, and elapsed time, and emits
a structured report. The Oracle side is hidden behind the same
``OracleReader`` Protocol used by the ETL so tests can exercise this
module without a real Oracle connection.

The CLI wrapper lives at ``scripts/duckdb_validate.py``.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Callable

log = logging.getLogger(__name__)

# Acceptable numeric drift for hourly-rollup aggregates vs raw Oracle.
# Tighter where the math is exact (AVG, MIN, MAX), looser where we lose
# raw-grade resolution (STDDEV from per-hour averages).
DEFAULT_TOLERANCES: dict[str, float] = {
    "count": 0.0,
    "mean": 1e-6,
    "min": 1e-9,
    "max": 1e-9,
    "std_dev": 1e-2,
}


@dataclass
class CaseResult:
    name: str
    ok: bool
    oracle_ms: int
    duckdb_ms: int
    speedup_x: float
    notes: list[str] = field(default_factory=list)
    diffs: dict[str, float] = field(default_factory=dict)


@dataclass
class ValidationReport:
    started_at: str
    cases: list[CaseResult]

    def to_json(self) -> str:
        return json.dumps(
            {
                "started_at": self.started_at,
                "cases": [asdict(c) for c in self.cases],
                "summary": self.summary(),
            },
            indent=2,
            default=str,
        )

    def summary(self) -> dict[str, Any]:
        ok = sum(1 for c in self.cases if c.ok)
        total = len(self.cases)
        return {
            "ok_cases": ok,
            "total_cases": total,
            "all_ok": ok == total,
            "median_speedup": _median([c.speedup_x for c in self.cases]) if self.cases else 0,
        }


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


# -- tolerance helpers ------------------------------------------------


def _within_tolerance(a: float | None, b: float | None, tol: float) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if a == 0 and b == 0:
        return True
    denom = max(abs(a), abs(b), 1e-12)
    return abs(a - b) / denom <= tol or abs(a - b) <= tol


# -- case runners -----------------------------------------------------


def _time_call(fn: Callable[[], Any]) -> tuple[Any, int]:
    t0 = time.monotonic()
    result = fn()
    return result, int((time.monotonic() - t0) * 1000)


def _compare_statistics(case_name: str, ora, duck, tolerances: dict[str, float]) -> CaseResult:
    """Compare (count, mean, min, max, std_dev) tuples."""
    ora_row, ora_ms = _time_call(ora)
    duck_row, duck_ms = _time_call(duck)

    diffs: dict[str, float] = {}
    notes: list[str] = []
    ok = True

    if ora_row is None or duck_row is None:
        notes.append(f"row is None: oracle={ora_row is not None} duckdb={duck_row is not None}")
        ok = ora_row is None and duck_row is None
        return CaseResult(case_name, ok, ora_ms, duck_ms,
                          (ora_ms / duck_ms) if duck_ms else float("inf"),
                          notes, diffs)

    keys = ["count", "mean", "min", "max", "std_dev"]
    for i, key in enumerate(keys):
        a, b = ora_row[i], duck_row[i]
        tol = tolerances.get(key, 1e-6)
        if a is None or b is None:
            diffs[key] = float("nan")
        else:
            diffs[key] = float(abs(a - b))
        if not _within_tolerance(a, b, tol):
            ok = False
            notes.append(f"{key}: oracle={a} duckdb={b} tol={tol}")

    return CaseResult(
        case_name, ok, ora_ms, duck_ms,
        (ora_ms / duck_ms) if duck_ms else float("inf"),
        notes, diffs,
    )


def _compare_row_counts(case_name: str, ora, duck) -> CaseResult:
    ora_rows, ora_ms = _time_call(ora)
    duck_rows, duck_ms = _time_call(duck)

    ora_n = len(list(ora_rows))
    duck_n = len(list(duck_rows))
    diffs: dict[str, float] = {"row_count": float(abs(ora_n - duck_n))}
    notes: list[str] = []
    if ora_n != duck_n:
        notes.append(f"row count differs: oracle={ora_n} duckdb={duck_n}")
    return CaseResult(
        case_name,
        ora_n == duck_n,
        ora_ms,
        duck_ms,
        (ora_ms / duck_ms) if duck_ms else float("inf"),
        notes,
        diffs,
    )


# -- public runner ----------------------------------------------------


def run_validation(
    *,
    oracle_repo: Any,
    duckdb_repo: Any,
    cases: list[dict[str, Any]],
    tolerances: dict[str, float] | None = None,
) -> ValidationReport:
    """Run each case against both backends and produce a comparison report.

    Each ``case`` describes:
        {"name": str,
         "method": str,                # e.g. 'statistics' or 'heatmap'
         "args": list,                 # positional args
         "kwargs": dict,               # keyword args
         "comparison": "statistics"    # or "row_count"
        }
    """
    tols = tolerances or DEFAULT_TOLERANCES
    results: list[CaseResult] = []

    for case in cases:
        name = case["name"]
        method = case["method"]
        args = case.get("args", [])
        kwargs = case.get("kwargs", {})
        cmp_kind = case.get("comparison", "row_count")

        def ora_call() -> Any:
            return getattr(oracle_repo, method)(*args, **kwargs)

        def duck_call() -> Any:
            return getattr(duckdb_repo, method)(*args, **kwargs)

        if cmp_kind == "statistics":
            results.append(_compare_statistics(name, ora_call, duck_call, tols))
        else:
            results.append(_compare_row_counts(name, ora_call, duck_call))

    return ValidationReport(
        started_at=datetime.utcnow().isoformat(),
        cases=results,
    )


def default_cases(anr: str, fnr: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
    """The representative dashboard cases listed in plan §9.

    The caller supplies one component + window; both backends run the
    identical query so any drift surfaces in the report.
    """
    params = {
        "anr": anr,
        "fnr": fnr,
        "start": start.strftime("%Y-%m-%d %H:%M:%S"),
        "end": end.strftime("%Y-%m-%d %H:%M:%S"),
    }
    return [
        {"name": "statistics P 3y", "method": "statistics",
         "args": ["P", params], "comparison": "statistics"},
        {"name": "heatmap P 3y", "method": "heatmap",
         "args": ["P", params], "comparison": "row_count"},
        {"name": "daily profile P 3y", "method": "daily_profile_combined",
         "args": ["P", params], "comparison": "row_count"},
        {"name": "voltage band 3y", "method": "voltage_band_combined",
         "args": [params], "comparison": "row_count"},
        {"name": "duration curve P 3y", "method": "duration_curve",
         "args": ["P", params], "comparison": "row_count"},
        {"name": "timeseries P 30d (hourly bucket)", "method": "timeseries_downsampled",
         "args": ["P", {**params, "bucket": 3600}], "comparison": "row_count"},
    ]
