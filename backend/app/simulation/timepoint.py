"""The network of one scenario at one time: what happens everywhere at that hour, against the reference.

`scenario_times` gives per time the extremes and the violation counts of the REF and the OUTAGE run (from
pf_run_times, written at import) and ranks the critical times. `snapshot` gives every element of the scenario at
one time, read by key (one lookup per series), sorted with the most critical first and returned in pages.
Values are raw; a time without a valid value is `invalid_or_missing`, never 0. Read-only.
"""

import json
import sqlite3
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.core.cache import TTLCache
from app.simulation import across, states, values
from app.simulation.data import component_id
from app.simulation.grids import grid_name

# Results of a stored run never change; the fallback aggregation of an earlier import takes seconds once.
_TIMES_CACHE = TTLCache(max_entries=64, ttl_seconds=3600)
TIME_FIELDS = ("loading_max", "loading_over", "voltage_min", "voltage_max", "voltage_outside")
# Same aggregation as the bridge's RunTimes, for runs imported before pf_run_times existed.
_FALLBACK_SQL = """
    SELECT v.t,
           MAX(CASE WHEN se.metric_id = 'loading' AND e.type IN ('line', 'transformer') THEN v.value END),
           SUM(CASE WHEN se.metric_id = 'loading' AND e.type IN ('line', 'transformer') AND v.value > l.upper THEN 1 ELSE 0 END),
           MIN(CASE WHEN se.metric_id = 'voltage' AND e.type = 'bus' THEN v.value END),
           MAX(CASE WHEN se.metric_id = 'voltage' AND e.type = 'bus' THEN v.value END),
           SUM(CASE WHEN se.metric_id = 'voltage' AND e.type = 'bus' AND (v.value < l.lower OR v.value > l.upper) THEN 1 ELSE 0 END)
    FROM analysis_series se
    JOIN analysis_values v ON v.series_id = se.id
    JOIN analysis_elements e ON e.run_id = se.run_id AND e.id = se.element_id
    LEFT JOIN pf_element_limits l ON l.run_id = se.run_id AND l.element_id = se.element_id AND l.metric_id = se.metric_id
    WHERE se.run_id = ? AND se.metric_id IN ('loading', 'voltage')
    GROUP BY v.t ORDER BY v.t
"""
# Bins of the distribution chart: loading in %, voltage in p.u.
LOADING_BINS = (0, 20, 40, 60, 80, 90, 100, 110, 120)
VOLTAGE_BINS = (0.85, 0.9, 0.925, 0.95, 0.975, 1.0, 1.025, 1.05, 1.075, 1.1, 1.15)


def run_times(store, run_id):
    """{t: (loading_max, loading_over, voltage_min, voltage_max, voltage_outside)} of one run and where it came from."""
    def compute():
        rows = store.db.execute(
            "SELECT t, " + ", ".join(TIME_FIELDS) + " FROM pf_run_times WHERE run_id=? ORDER BY t", (run_id,)).fetchall()
        if rows:
            return {"source": "import", "rows": {r[0]: tuple(r[1:]) for r in rows}}
        rows = values.query(store.db, run_id, _FALLBACK_SQL, (run_id,))
        return {"source": "computed", "rows": {r[0]: tuple(r[1:]) for r in rows}}
    return _TIMES_CACHE.get_or_compute((getattr(store, "path", None), run_id), compute)


def _scenario(store, scenario_id):
    row = store.db.execute("SELECT * FROM pf_scenarios WHERE id=?", (scenario_id,)).fetchone()
    if row is None:
        return None, None
    runs = across._runs(store.db, scenario_id)
    return (row, runs) if "OUTAGE" in runs else (None, None)


# How each column is reduced to one value per interval: the worst value, never a mean.
_REDUCE = {"loading_max": max, "loading_over": max, "voltage_min": min, "voltage_max": max, "voltage_outside": max}


def _reduce(times, outage, reference, points):
    """At most `points` intervals: per interval the worst value of every column, at the real time of the scenario's
    worst value (a click on the chart therefore lands on a calculated time, not on an interval start)."""
    size = -(-len(times) // points)
    kept, out, ref = [], {f: [] for f in TIME_FIELDS}, {f: [] for f in TIME_FIELDS}
    for start in range(0, len(times), size):
        chunk = times[start:start + size]
        severity = lambda t: (outage["rows"][t][1] + outage["rows"][t][4], outage["rows"][t][0] or float("-inf"))  # noqa: E731
        kept.append(max(chunk, key=severity))
        for k, field in enumerate(TIME_FIELDS):
            for target, data in ((out, outage), (ref, reference)):
                values = [data["rows"][t][k] for t in chunk if t in data["rows"] and data["rows"][t][k] is not None]
                target[field].append(_REDUCE[field](values) if values else None)
    return kept, out, ref, size


def scenario_times(store, scenario_id, top=10, points=2000, start=None, end=None):
    """Per time the extremes and violation counts of REF and OUTAGE, and the most critical times of the OUTAGE run.

    `start`/`end` (epoch seconds, inclusive) cut the course to a time range: the reduction and the critical times then
    refer to that range only, so a zoomed week comes at full resolution. `period` is the whole course either way.
    A course longer than `points` comes reduced to the worst value per interval (`interval_steps` > 1); the critical
    times are always ranked at full resolution.
    """
    row, runs = _scenario(store, scenario_id)
    if row is None:
        return None
    outage = run_times(store, runs["OUTAGE"])
    reference = run_times(store, runs["REF"]) if "REF" in runs else {"source": None, "rows": {}}
    every = sorted(outage["rows"])
    times = [t for t in every if (start is None or t >= start) and (end is None or t <= end)]
    _ids, _chosen, windows, _equipment = across._outage_context(store, row)
    ranked = sorted(
        (t for t in times if outage["rows"][t][0] is not None),
        key=lambda t: (outage["rows"][t][1] + outage["rows"][t][4], outage["rows"][t][0]), reverse=True)
    if len(times) > points:
        shown, out, ref, steps = _reduce(times, outage, reference, points)
    else:
        columns = lambda data: {field: [data["rows"].get(t, (None,) * 5)[k] for t in times]  # noqa: E731
                                for k, field in enumerate(TIME_FIELDS)}
        shown, out, ref, steps = times, columns(outage), columns(reference), 1
    return {
        "scenario_id": scenario_id,
        "times": shown,
        "interval_steps": steps,
        "windows": windows,
        "outage": out,
        "ref": ref,
        "critical": ranked[:top],
        "period": [every[0], every[-1]] if every else None,
        "range": [start, end],
        "source": outage["source"],
    }


# What a snapshot needs of every element of a run besides its value: unchanged for the life of the run, so it is
# read once (one SQL join) and kept; per time only the values are read.
_ELEMENTS_SQL = """
    SELECT e.id, e.name, e.className, e.type, e.path, g.nominal_kv, l.lower, l.upper
    FROM analysis_series so
    JOIN analysis_elements e ON e.run_id = so.run_id AND e.id = so.element_id
    LEFT JOIN gl_elements g ON g.assessment_id = :analysis AND g.element_id = e.id
    LEFT JOIN pf_element_limits l ON l.run_id = so.run_id AND l.element_id = e.id AND l.metric_id = so.metric_id
    WHERE so.run_id = :run AND so.metric_id = :metric
"""
# The value of every series of a run and metric at one time: one key lookup per series.
_VALUES_SQL = """
    SELECT se.element_id, v.value FROM analysis_series se
    JOIN analysis_values v ON v.series_id = se.id AND v.t = ?
    WHERE se.run_id = ? AND se.metric_id = ?
"""
_ELEMENTS_CACHE = TTLCache(max_entries=8, ttl_seconds=3600)
# The sorted elements of the last few snapshots: "show more" and the CSV export read further pages from here.
_SNAPSHOT_CACHE = TTLCache(max_entries=4, ttl_seconds=600)


def _run_elements(store, run_id, metric, analysis):
    """(element_id, name, class, type, grid, nominal kV, lower, upper) of every element of the run with the metric."""
    def compute():
        rows = store.db.execute(_ELEMENTS_SQL, {"run": run_id, "metric": metric, "analysis": analysis}).fetchall()
        return [(r[0], r[1], r[2], r[3], grid_name(r[4]), r[5], r[6], r[7]) for r in rows]
    return _ELEMENTS_CACHE.get_or_compute((getattr(store, "path", None), run_id, metric, analysis), compute)


def _values_at(path, run_id, metric, t):
    """{element_id: value} of one run at time t, on a connection of its own so that two runs can be read at once."""
    if run_id is None:
        return {}
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
    try:
        return {row[0]: row[1] for row in values.query(db, run_id, _VALUES_SQL, (t, run_id, metric))}
    finally:
        db.close()


def _histogram(values, edges):
    counts = [0] * (len(edges) + 1)
    for value in values:
        if value is not None:
            counts[bisect_right(edges, value)] += 1
    return counts


def snapshot(store, scenario_id, t, metric="loading", limit=50, offset=0, grid=None, kv=None):
    """Every element of the scenario at time t with REF, scenario, delta and limit; most critical first, in pages."""
    row, runs = _scenario(store, scenario_id)
    if row is None or metric not in ("loading", "voltage"):
        return None
    _ids, _chosen, windows, equipment = across._outage_context(store, row)
    in_window = any(start <= t <= end for start, end in windows)
    low, default_upper = float("-inf"), 100.0

    def severity(item):
        _id, name, _cls, _type, _path, _kv, _ref, value, lower, upper = item
        if value is None or (in_window and name in equipment):
            return low
        if metric == "loading":
            return value - (upper if upper is not None else default_upper)
        return max(value - upper if upper is not None else low, lower - value if lower is not None else low)

    def compute():
        elements = [e for e in _run_elements(store, runs["OUTAGE"], metric, row["analysis_id"])
                    if (grid is None or e[4] == grid) and (kv is None or e[5] == kv)]
        # The scenario and the REF values at t, read at the same time (SQLite releases Python while it searches).
        with ThreadPoolExecutor(max_workers=2) as pool:
            out_values = pool.submit(_values_at, store.path, runs["OUTAGE"], metric, t)
            ref_values = pool.submit(_values_at, store.path, runs.get("REF"), metric, t)
            values, reference = out_values.result(), ref_values.result()
        found = [(e[0], e[1], e[2], e[3], e[4], e[5], reference.get(e[0]), values.get(e[0]), e[6], e[7]) for e in elements]
        return sorted(((severity(item), item) for item in found), key=lambda pair: pair[0], reverse=True)
    scored = _SNAPSHOT_CACHE.get_or_compute((getattr(store, "path", None), scenario_id, t, metric, grid, kv), compute)

    def as_row(item):
        element_id, name, class_name, kind, grid_of, nominal_kv, ref, value, lower, upper = item
        outaged = in_window and name in equipment
        return {
            "element_id": element_id, "name": name, "class_name": class_name, "type": kind, "grid": grid_of,
            "nominal_kv": nominal_kv, "ref": ref, "value": value,
            "delta": None if value is None or ref is None else value - ref,
            "lower": lower, "upper": upper, "outaged": outaged,
            "state": "outaged" if outaged else "value" if value is not None else states.INVALID_OR_MISSING,
        }
    edges = LOADING_BINS if metric == "loading" else VOLTAGE_BINS
    return {
        "scenario_id": scenario_id, "t": t, "metric": metric, "in_window": in_window,
        "total": len(scored),
        "violations": sum(1 for score, _item in scored if score > 0),
        "distribution": {
            "edges": list(edges),
            "outage": _histogram((item[7] for _s, item in scored if not (in_window and item[1] in equipment)), edges),
            "ref": _histogram((item[6] for _s, item in scored), edges),
        },
        "rows": [as_row(item) for _score, item in scored[offset:offset + limit]], "offset": offset, "limit": limit,
    }


_LEVELS_CACHE = TTLCache(max_entries=16, ttl_seconds=3600)


def voltage_levels(db, analysis):
    """Nominal voltages of the elements of one analysis with their element count, highest first (cached per
    analysis and element count: it changes only while the analysis is imported)."""
    count = db.execute("SELECT COUNT(*) FROM gl_elements WHERE assessment_id=?", (analysis,)).fetchone()[0]
    return _LEVELS_CACHE.get_or_compute((analysis, count), lambda: _voltage_levels(db, analysis))


def _voltage_levels(db, analysis):
    return [{"kv": r[0], "elements": r[1]} for r in db.execute(
        "SELECT nominal_kv, COUNT(*) FROM gl_elements WHERE assessment_id=? AND nominal_kv IS NOT NULL "
        "GROUP BY nominal_kv ORDER BY nominal_kv DESC", (analysis,))]


def asset(store, element_id, analysis=None, limits=across.DEFAULT_LIMITS):
    """One element across every scenario of an analysis: master data, key figures per scenario, n-1 per case."""
    db = store.db
    analysis = across.resolve_analysis(db, analysis)
    scenarios = across._scenario_rows(db, analysis)
    master = db.execute("SELECT element_id, name, class_name, path, grid, nominal_kv, mrid FROM gl_elements "
                        "WHERE assessment_id=? AND element_id=?", (analysis, element_id)).fetchone()
    per_scenario, found = [], dict(master) if master else None
    for row in scenarios:
        runs = across._runs(db, row["id"])
        cells = across.scenario_cells(store, row["id"], limits)
        if cells is None:
            continue
        line = next((item for item in cells["lines"] if item["id"] == element_id), None)
        bus = next((item for item in cells["buses"] if item["id"] == element_id), None)
        item = line or bus
        if item is None:
            continue
        if found is None:
            found = {"element_id": element_id, "name": item["name"], "class_name": item["class_name"],
                     "path": None, "grid": item["grid"], "nominal_kv": None, "mrid": None}
        per_scenario.append({
            "scenario_id": row["id"], "name": row["name"], "kind": "branch" if line else "bus",
            "ref_full": line["ref_full"] if line else None, "cell": item["cell"],
            "components": {kind: component_id(run, element_id) for kind, run in runs.items()},
        })
    if found is None:
        return None
    n1 = [dict(r) for r in db.execute(
        "SELECT r.case_id, r.kind, k.metric, k.low, k.low_t, k.high, k.high_t, k.high_contingency, k.lower, k.upper, "
        "k.violation_times, k.violations, g.name AS contingency_name "
        "FROM gl_results r JOIN gl_columns c ON c.result_id = r.id AND c.element_id = ? "
        "JOIN gl_n1_columns k ON k.result_id = r.id AND k.column_id = c.column_id "
        "LEFT JOIN gl_contingencies g ON g.result_id = r.id AND g.id = k.high_contingency "
        "WHERE r.assessment_id = ? ORDER BY r.case_id, r.kind", (element_id, analysis))]
    return {"analysis": analysis, "element": found, "scenarios": per_scenario, "n1": n1}


def restore_package(store, scenario_id, t=None):
    """What PowerFactory needs to rebuild the scenario (and, with `t`, one time of it), as a checkable JSON package.

    The dashboard only hands the facts over; rebuilding and recalculating is PowerFactory's job. Everything that
    is not recorded is listed under `limitations`, so a package is never taken for more than it is.
    """
    db = store.db
    row = db.execute("SELECT * FROM pf_scenarios WHERE id=?", (scenario_id,)).fetchone()
    if row is None:
        return None
    catalog = across._scenario_catalog(store, scenario_id)
    outages = {o["id"]: o for o in catalog.get("outages", [])}
    analysis = db.execute("SELECT * FROM gl_assessments WHERE id=?", (row["analysis_id"],)).fetchone() if row["analysis_id"] else None
    case_id = scenario_id[len(row["analysis_id"]) + 1:] if analysis is not None else None
    case = db.execute("SELECT * FROM gl_cases WHERE assessment_id=? AND case_id=?",
                      (row["analysis_id"], case_id)).fetchone() if analysis is not None else None
    definition = json.loads(case["definition"]) if case else {}
    describe = lambda ids: [  # noqa: E731
        {k: outages[i].get(k) for k in ("id", "name", "path", "equipment_name", "equipment_paths", "start", "end")}
        if i in outages else {"id": i, "name": None, "path": None} for i in ids]
    limitations = ["The operation scenario of the study case is not recorded.",
                   "The model version is not recorded; check that the project has not changed since the run.",
                   "CGMES mRIDs are not recorded (no verified source yet)."]
    if analysis is None:
        limitations.insert(0, "Saved without an analysis: settings, case definition and native results are unknown.")
    elif analysis["status"] != "complete":
        limitations.insert(0, "The import of this analysis is {}.".format(analysis["status"]))
    if t is not None and not any(start <= t <= end for start, end in (
            (o["start"], o["end"]) for o in describe(json.loads(row["outages"])) if o.get("start") is not None)):
        limitations.append("The chosen time lies outside the outage windows of the scenario.")
    native = [dict(r) for r in db.execute(
        "SELECT kind, native_name, native_path, status FROM gl_results WHERE assessment_id=? AND case_id IN (?, 'REF') "
        "ORDER BY case_id, kind", (row["analysis_id"], case_id))] if analysis is not None else []
    return {
        "schema": "outage-assessment.restore-package", "version": 1,
        "reproducible": "partial" if analysis is not None else "no",
        "limitations": limitations,
        "analysis": None if analysis is None else {
            "analysis_id": analysis["id"], "native_run_id": analysis["native_run_id"], "status": analysis["status"],
            "engine_version": analysis["engine_version"], "created_at": analysis["created_at"],
            "created_by": analysis["created_by"], "project": analysis["project"], "project_path": analysis["project_path"],
            "study_case": analysis["study_case"], "study_case_path": analysis["study_case_path"],
            "period": [analysis["period_start"], analysis["period_end"]],
            "settings": json.loads(analysis["settings"]),
        },
        "scenario": {
            "scenario_id": scenario_id, "case_id": case_id, "name": row["name"],
            "planned_outages": describe(json.loads(row["outages"])),
            "background_outages": describe(definition.get("background_ids", [])),
            "windows": definition.get("windows"), "states": definition.get("states"),
            "fingerprint": definition.get("fingerprint"),
        },
        "time": None if t is None else {"epoch": t, "utc": across._iso(t)},
        "native_results": native,
    }
