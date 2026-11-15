"""Read-only across-scenarios aggregation of stored loading series and LODF values.

Nothing here writes to the database or changes how results are calculated. Per
line and scenario the loading is reduced to a few numbers; classification into
severity bands happens in the frontend (frontend/src/config/loadingBands.ts).

Definitions
- scenario value: maximum OUTAGE loading inside the scenario's outage windows.
- window base:    maximum REF loading inside the same windows (like for like).
- delta:          scenario value minus window base, in percentage points.
- base:           maximum REF loading over the full period (per line).
- hours_over:     time above each limit in the OUTAGE run, related to the whole
                  simulation period (not to the number of scenarios).
A line that is itself switched off in a scenario is flagged `outaged` and
carries no value for that scenario.

Lazy by design: `scenario_index` is cheap (no samples are read), `scenario_cells` reduces
one scenario with a handful of grouped queries and is cached, so a very large database is
only read for the scenarios and the moments the dashboard actually asks for.
`across_scenarios` composes both for callers that want everything at once.

Analyses: every import of a PowerFactory run is one analysis (`gl_assessments`); the dashboard evaluates the
scenarios of one analysis at a time (by default the newest), never a mix of several imports. Each scenario
takes its outage windows and equipment from its own provenance, not from the file-wide catalog that every
import replaces. Scenarios saved without an analysis form the group `UNASSIGNED`.

Equipment: branches (lines, transformers) are evaluated by loading. Busbars are
evaluated by voltage against the limits stored with the results (`buses`);
without stored limits no violation is derived.
"""

import json
import sqlite3
from datetime import datetime, timezone

from app.core.cache import TTLCache
from app.simulation import values
from app.simulation.grids import grid_name
from app.simulation.store import outage_key

LOADING = "loading"
VOLTAGE = "voltage"
DEFAULT_LIMITS = (100.0, 110.0, 120.0)
# Results of a saved scenario never change; the caches only spare repeated reads.
_CELLS_CACHE = TTLCache(max_entries=256, ttl_seconds=3600)
# Profiles are read again whenever a scenario is chosen; a few dozen kB each.
_PROFILE_CACHE = TTLCache(max_entries=128, ttl_seconds=3600)
# Calculation states of a run, best first (pf_run_notes / analysis_runs.status).
RUN_STATUS_ORDER = {"completed": 0, "incomplete": 1, "not_converged": 2, "failed": 3}
# The group of scenarios saved without an analysis.
UNASSIGNED = "unassigned"


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


# Every value of one metric of one run: the series of the run, each read as one contiguous range.
_VALUES = (
    " FROM analysis_series se JOIN analysis_values v ON v.series_id = se.id"
    " WHERE se.run_id=? AND se.metric_id=? AND v.value IS NOT NULL"
)


def _window_expr(windows):
    """SQL condition 'v.t lies inside one of the outage windows' (always true without windows)."""
    if not windows:
        return "1", []
    parts, params = [], []
    for start, end in windows:
        parts.append("(v.t>=? AND v.t<=?)")
        params += [start, end]
    return " OR ".join(parts), params


def _window_clause(windows):
    expr, params = _window_expr(windows)
    return ("", []) if not windows else (" AND (" + expr + ")", params)


def _step_hours(n, t0, t1):
    """Time step of a series in hours, from its first and last time and the number of values."""
    return (t1 - t0) / (n - 1) / 3600 if n > 1 else 0.0


def _extremes(db, run_id, windows=None):
    clause, params = _window_clause(windows)
    rows = values.query(
        db, run_id, "SELECT se.element_id, MAX(v.value) hi" + _VALUES + clause + " GROUP BY se.element_id ORDER BY se.element_id",
        (run_id, LOADING, *params),
    )
    return {element_id: hi for element_id, hi in rows}


def _voltage_range(db, run_id, windows=None):
    clause, params = _window_clause(windows)
    rows = values.query(
        db, run_id, "SELECT se.element_id, MIN(v.value) lo, MAX(v.value) hi" + _VALUES + clause + " GROUP BY se.element_id ORDER BY se.element_id",
        (run_id, VOLTAGE, *params),
    )
    return {element_id: [lo, hi] for element_id, lo, hi in rows}


def _voltage_limits(db, run_id):
    rows = db.execute(
        "SELECT element_id, lower, upper FROM pf_element_limits WHERE run_id=? AND metric_id=?",
        (run_id, VOLTAGE),
    )
    return {row["element_id"]: [row["lower"], row["upper"]] for row in rows}


def _voltage_unit(db, run_id):
    row = db.execute("SELECT unit FROM analysis_metrics WHERE run_id=? AND id=?", (run_id, VOLTAGE)).fetchone()
    return row["unit"] if row else None


def _hours_outside(db, run_id):
    """Per busbar: hours outside the stored voltage band over the whole simulation period."""
    rows = values.query(
        db, run_id,
        "SELECT se.element_id, COUNT(*) n, MIN(v.t) t0, MAX(v.t) t1, "
        "SUM(CASE WHEN v.value < COALESCE(l.lower,-1e9) OR v.value > COALESCE(l.upper,1e9) THEN 1 ELSE 0 END) bad"
        + _VALUES.replace(" WHERE", " JOIN pf_element_limits l"
                          " ON l.run_id=se.run_id AND l.element_id=se.element_id AND l.metric_id=se.metric_id WHERE")
        + " GROUP BY se.element_id ORDER BY se.element_id",
        (run_id, VOLTAGE),
    )
    # Unpacked by position: 100,000 rows read by column name cost more than the query.
    return {element_id: (bad or 0) * _step_hours(n, t0, t1) for element_id, n, t0, t1, bad in rows}


def _loading_stats(db, run_id, windows, limits):
    """One grouped pass per run: full and in-window maximum, hours above each limit, period."""
    expr, wparams = _window_expr(windows)
    over = ",".join("SUM(CASE WHEN v.value>? THEN 1 ELSE 0 END)" for _ in limits)
    rows = values.query(
        db, run_id,
        "SELECT se.element_id, COUNT(*) n, MIN(v.t) t0, MAX(v.t) t1, MAX(v.value) full_max, "
        "MAX(CASE WHEN " + expr + " THEN v.value END) win_max, " + over + _VALUES + " GROUP BY se.element_id ORDER BY se.element_id",
        (*wparams, *limits, run_id, LOADING),
    )
    result = {}
    for element_id, n, t0, t1, full_max, win_max, *counts in rows:
        step = _step_hours(n, t0, t1)
        result[element_id] = {
            "full_max": full_max,
            "win_max": win_max,
            "hours_over": [(c or 0) * step for c in counts],
            "period": n * step,
        }
    return result


def analyses(db):
    """Every analysis of the file with its scenario count, newest first; scenarios without one form UNASSIGNED."""
    found = [
        {**dict(row), "calculation_types": json.loads(row["calculation_types"] or "[]")}
        for row in db.execute(
            "SELECT a.id, a.native_run_id, a.project, a.study_case, a.engine_version, a.created_at, a.mode, a.status, "
            "a.source_system, a.calculation_types, a.period_start, a.period_end, "
            "(SELECT COUNT(*) FROM pf_scenarios s WHERE s.analysis_id = a.id) AS scenarios "
            "FROM gl_assessments a ORDER BY a.created_at DESC, a.rowid DESC"
        )
    ]
    unassigned = db.execute("SELECT COUNT(*) FROM pf_scenarios WHERE analysis_id IS NULL").fetchone()[0]
    if unassigned:
        found.append({"id": UNASSIGNED, "native_run_id": None, "project": None, "study_case": None,
                      "engine_version": None, "created_at": None, "mode": None, "status": "unknown",
                      "source_system": "PowerFactory", "calculation_types": ["QDS"], "period_start": None,
                      "period_end": None, "scenarios": unassigned})
    return found


def default_analysis(db):
    """The newest analysis that has a scenario (it may still be importing), else UNASSIGNED, else None."""
    row = db.execute(
        "SELECT a.id FROM gl_assessments a WHERE EXISTS (SELECT 1 FROM pf_scenarios s WHERE s.analysis_id = a.id) "
        "ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1"
    ).fetchone()
    if row is not None:
        return row[0]
    if db.execute("SELECT 1 FROM pf_scenarios WHERE analysis_id IS NULL LIMIT 1").fetchone():
        return UNASSIGNED
    return None


def resolve_analysis(db, analysis=None):
    return default_analysis(db) if analysis is None else analysis


def _scenario_rows(db, analysis=None):
    """Scenarios of one analysis in the order they were saved (default: the newest analysis).

    UNASSIGNED keeps the earlier rule for scenarios without an analysis: the newest wins when a name was
    calculated more than once.
    """
    analysis = resolve_analysis(db, analysis)
    if analysis is None:
        return []
    if analysis != UNASSIGNED:
        return db.execute("SELECT * FROM pf_scenarios WHERE analysis_id=? ORDER BY rowid", (analysis,)).fetchall()
    seen, rows = set(), []
    for row in db.execute("SELECT * FROM pf_scenarios WHERE analysis_id IS NULL ORDER BY created_at DESC"):
        if row["name"] in seen:
            continue
        seen.add(row["name"])
        rows.append(row)
    rows.reverse()
    return rows


def current_run_ids(db, analysis=None):
    """Ids of the runs the dashboard offers for one analysis (default: the newest): the runs of its scenarios, plus
    its runs no scenario links to yet (a reference stored before its first scenario).
    None for a file without scenarios tables: everything is offered.
    """
    try:
        analysis = resolve_analysis(db, analysis)
        scenarios = {row["id"] for row in _scenario_rows(db, analysis)}
        linked = db.execute("SELECT scenario_id, run_id FROM pf_scenario_runs").fetchall()
        if analysis in (None, UNASSIGNED):
            unlinked = {row["id"] for row in db.execute(
                "SELECT id FROM analysis_runs WHERE id NOT IN (SELECT run_id FROM pf_scenario_runs) "
                "AND id NOT IN (SELECT analysis_run_id FROM gl_results WHERE analysis_run_id IS NOT NULL)")}
        else:
            unlinked = {row["analysis_run_id"] for row in db.execute(
                "SELECT analysis_run_id FROM gl_results WHERE assessment_id=? AND analysis_run_id IS NOT NULL "
                "AND analysis_run_id NOT IN (SELECT run_id FROM pf_scenario_runs)", (analysis,))}
    except sqlite3.OperationalError:
        return None
    return {row["run_id"] for row in linked if row["scenario_id"] in scenarios} | unlinked


def _runs(db, scenario_id):
    return {
        r["kind"]: r["run_id"]
        for r in db.execute("SELECT run_id, kind FROM pf_scenario_runs WHERE scenario_id=?", (scenario_id,))
    }


def _scenario_catalog(store, scenario_id):
    """The catalog the scenario was calculated with: its own provenance, else the file-wide catalog."""
    row = store.db.execute("SELECT payload FROM pf_scenario_provenance WHERE scenario_id=?", (scenario_id,)).fetchone()
    catalog = json.loads(row[0]) if row else {}
    return catalog if "outages" in catalog else (store.catalog() or {})


def _outage_context(store, row):
    outages = {o["id"]: o for o in _scenario_catalog(store, row["id"]).get("outages", [])}
    ids = json.loads(row["outages"])
    chosen = [outages[i] for i in ids if i in outages]
    windows = [(o["start"], o["end"]) for o in chosen if o.get("start") is not None and o.get("end") is not None]
    equipment = {o["equipment_name"] for o in chosen if o.get("equipment_name")}
    return ids, chosen, windows, equipment


def scenario_index(store, analysis=None):
    """Scenarios of one analysis (default: the newest) with what they switch off. Reads no samples."""
    db = store.db
    analysis = resolve_analysis(db, analysis)
    rows = _scenario_rows(db, analysis)
    catalog = _scenario_catalog(store, rows[0]["id"]) if rows else (store.catalog() or {})
    lodf_keys = {r["outage_key"] for r in db.execute("SELECT DISTINCT outage_key FROM pf_lodf")}
    undefined = {r["outage_key"]: r["reason"] for r in db.execute("SELECT outage_key, reason FROM pf_lodf_undefined")}
    scenarios = []
    for row in rows:
        runs = _runs(db, row["id"])
        if "REF" not in runs or "OUTAGE" not in runs:
            continue
        ids, chosen, _windows, equipment = _outage_context(store, row)
        names = sorted(equipment)
        outaged = [e[0] for e in db.execute(
            "SELECT id FROM analysis_elements WHERE run_id=? AND name IN ({})".format(",".join("?" * len(names))),
            (runs["OUTAGE"], *names))] if names else []
        statuses = [r[0] for r in db.execute(
            "SELECT COALESCE(n.status, a.status) FROM analysis_runs a LEFT JOIN pf_run_notes n ON n.run_id = a.id "
            "WHERE a.id IN (?, ?)", (runs["REF"], runs["OUTAGE"]))]
        scenarios.append(
            {
                "id": row["id"],
                "name": row["name"],
                # The worst calculation status of its REF and OUTAGE run.
                "status": max(statuses, key=lambda status: RUN_STATUS_ORDER.get(status, len(RUN_STATUS_ORDER))),
                "outages": [
                    {
                        "id": o["id"],
                        "name": o["name"],
                        "equipment_name": o.get("equipment_name"),
                        "start": o.get("start"),
                        "end": o.get("end"),
                    }
                    for o in chosen
                ],
                "outaged_element_ids": outaged,
                "has_lodf": outage_key(ids) in lodf_keys,
                # why there is no LODF: not defined for this outage (and the reason), or None
                "lodf_note": undefined.get(outage_key(ids)),
            }
        )
    return {
        "analysis": analysis,
        "scenarios": scenarios,
        "period": catalog.get("period"),
        "has_lodf": any(s["has_lodf"] for s in scenarios),
    }


def _lodf_stamp(db):
    return db.execute("SELECT MAX(computed_at) FROM pf_lodf").fetchone()[0]


def _scenario_lodf_stamp(db, scenario_id):
    """When the LODF of this scenario's outages was calculated (None without LODF): a later LODF run of other
    outages leaves the summary of this scenario valid."""
    row = db.execute("SELECT outages FROM pf_scenarios WHERE id=?", (scenario_id,)).fetchone()
    if row is None:
        return None
    key = outage_key(json.loads(row[0]))
    return db.execute("SELECT MAX(computed_at) FROM pf_lodf WHERE outage_key=?", (key,)).fetchone()[0]


def _prepared_cells(db, scenario_id, limits):
    """The summary the PowerFactory script stored when it saved the scenario, if it is still valid."""
    row = db.execute(
        "SELECT payload FROM pf_scenario_cells WHERE scenario_id=? AND limits=? AND lodf_stamp IS ?",
        (scenario_id, json.dumps(list(limits)), _scenario_lodf_stamp(db, scenario_id)),
    ).fetchone()
    return json.loads(row[0]) if row else None


def scenario_cells(store, scenario_id, limits=DEFAULT_LIMITS):
    """Per element the reduced values of one scenario (cached); None for an unknown scenario.

    Read from pf_scenario_cells when the script prepared it, otherwise reduced from the stored values.
    """
    db = store.db
    stamp = _lodf_stamp(db)
    key = (getattr(store, "path", None), scenario_id, tuple(limits), stamp)
    return _CELLS_CACHE.get_or_compute(
        key,
        lambda: _with_nominal_kv(db, scenario_id,
                                 _prepared_cells(db, scenario_id, limits) or _scenario_cells(store, scenario_id, limits)),
    )


def _with_nominal_kv(db, scenario_id, cells):
    """The nominal voltage of every element from its analysis' master data (None when it was not stored)."""
    if cells is None:
        return None
    row = db.execute("SELECT analysis_id FROM pf_scenarios WHERE id=?", (scenario_id,)).fetchone()
    nominal = dict(db.execute("SELECT element_id, nominal_kv FROM gl_elements WHERE assessment_id=?",
                              (row[0],)).fetchall()) if row and row[0] else {}
    for item in cells["lines"] + cells["buses"]:
        item["nominal_kv"] = nominal.get(item["id"])
    return cells


# Above this many elements per scenario the dashboard receives the relevant ones only (relevant_cells).
FULL_LIST_LIMIT = 5000
# Kept in addition to the rule-based ones: the highest loadings, the largest changes, the largest voltage deviations.
TOP_PER_FIGURE = 500


def relevant_cells(cells, warning=80.0, band=(0.9, 1.1), margin=0.02, top=TOP_PER_FIGURE):
    """The cells of a large scenario reduced to what any verdict or key figure of the dashboard depends on.

    Branches: switched off, at or above the warning loading in the scenario or in REF inside the window, any time
    above a limit, and the `top` highest loadings and largest changes. Busbars: outside or within `margin` of the
    band in the scenario or REF, any time outside it, and the `top` largest deviations. A scenario with at most
    FULL_LIST_LIMIT elements is returned unchanged. `listing` says what was left out, so it is never mistaken for
    missing data.
    """
    if cells is None or len(cells["lines"]) + len(cells["buses"]) <= FULL_LIST_LIMIT:
        return cells
    lower, upper = band

    def loading_rule(item):
        cell = item["cell"]
        return (cell.get("outaged") or (cell.get("value") or 0) >= warning or (cell.get("window_base") or 0) >= warning
                or any(hours > 0 for hours in cell.get("hours_over") or ()))  # hours above each limit

    def deviation(rng):
        return max(lower - rng[0], rng[1] - upper) if rng else float("-inf")

    def voltage_rule(item):
        cell = item["cell"]
        return (cell.get("outaged") or (cell.get("hours_outside") or 0) > 0
                or deviation(cell.get("out")) > -margin or deviation(cell.get("ref")) > -margin)

    lines, buses = cells["lines"], cells["buses"]
    keep_lines = {id(item) for item in lines if loading_rule(item)}
    keep_lines.update(id(item) for item in sorted(lines, key=lambda i: i["cell"].get("value") or float("-inf"), reverse=True)[:top])
    keep_lines.update(id(item) for item in sorted(lines, key=lambda i: abs(i["cell"].get("delta") or 0), reverse=True)[:top])
    keep_buses = {id(item) for item in buses if voltage_rule(item)}
    keep_buses.update(id(item) for item in sorted(buses, key=lambda i: deviation(i["cell"].get("out")), reverse=True)[:top])
    listed_lines = [item for item in lines if id(item) in keep_lines]
    listed_buses = [item for item in buses if id(item) in keep_buses]
    return {**cells, "lines": listed_lines, "buses": listed_buses, "listing": {
        "lines": len(lines), "buses": len(buses), "listed_lines": len(listed_lines), "listed_buses": len(listed_buses),
        "warning": warning, "band": [lower, upper], "margin": margin, "top": top,
    }}


def prepare_cells(store, scenario_id, limits=DEFAULT_LIMITS):
    """Reduce a just-saved scenario once and store the result for the dashboard (called by the script).

    Inside the caller's open transaction the summary is committed together with the scenario, so the
    dashboard never lists the scenario without it and never reduces it a second time.
    """
    cells = _scenario_cells(store, scenario_id, limits)
    if cells is None:
        return False
    row = (scenario_id, json.dumps(list(limits)), _scenario_lodf_stamp(store.db, scenario_id), json.dumps(cells))
    if store.db.in_transaction:
        store.db.execute("INSERT OR REPLACE INTO pf_scenario_cells VALUES(?,?,?,?)", row)
    else:
        with store.db:
            store.db.execute("INSERT OR REPLACE INTO pf_scenario_cells VALUES(?,?,?,?)", row)
    return True


def _branch_rows(elements, ref, out, equipment, lodf):
    """Branch cells of one scenario and the simulated period; busbars are handled separately."""
    lines, period_hours = [], 0.0
    for element_id, ref_stats in ref.items():
        element = elements.get(element_id)
        if element is None or element["type"] not in ("line", "transformer"):
            continue  # busbars are assessed by voltage, everything else has no loading assessment
        outaged = element["name"] in equipment
        mine = out.get(element_id)
        value = mine["win_max"] if mine else None
        base = ref_stats["win_max"]
        period_hours = max(period_hours, mine["period"] if mine else 0.0)
        lines.append(
            {
                "id": element_id,
                "name": element["name"],
                "class_name": element["className"],
                "type": element["type"],
                "grid": grid_name(element["path"]),
                "ref_full": ref_stats["full_max"],
                "cell": {
                    "outaged": outaged,
                    "hours_over": None if outaged or not mine else mine["hours_over"],
                    "value": None if outaged else value,
                    "window_base": base,
                    "delta": None if outaged or value is None or base is None else value - base,
                    "lodf": lodf.get(element_id),
                },
            }
        )
    return lines, period_hours


def _bus_rows(db, runs, windows, elements, equipment, unit):
    volt_ref = _voltage_range(db, runs["REF"], windows)
    volt_out = _voltage_range(db, runs["OUTAGE"], windows)
    volt_hours = _hours_outside(db, runs["OUTAGE"])
    band = _voltage_limits(db, runs["OUTAGE"])
    buses = []
    for element_id, rng in volt_out.items():
        element = elements.get(element_id)
        if element is None:
            continue
        buses.append(
            {
                "id": element_id,
                "name": element["name"],
                "class_name": element["className"],
                "type": element["type"],
                "grid": grid_name(element["path"]),
                "unit": unit,
                "limits": band.get(element_id),
                "cell": {
                    "outaged": element["name"] in equipment,
                    "ref": volt_ref.get(element_id),
                    "out": rng,
                    "hours_outside": volt_hours.get(element_id),
                },
            }
        )
    return buses


def _scenario_cells(store, scenario_id, limits):
    db = store.db
    row = db.execute("SELECT * FROM pf_scenarios WHERE id=?", (scenario_id,)).fetchone()
    runs = _runs(db, scenario_id) if row else {}
    if row is None or "REF" not in runs or "OUTAGE" not in runs:
        return None
    ids, _chosen, windows, equipment = _outage_context(store, row)
    lodf = {
        r["element_id"]: r["lodf"]
        for r in db.execute("SELECT element_id, lodf FROM pf_lodf WHERE outage_key=?", (outage_key(ids),))
    }
    elements = {
        e["id"]: e
        for e in db.execute("SELECT id, name, className, type, path FROM analysis_elements WHERE run_id=?", (runs["OUTAGE"],))
    }
    ref = _loading_stats(db, runs["REF"], windows, limits)
    out = _loading_stats(db, runs["OUTAGE"], windows, limits)
    lines, period_hours = _branch_rows(elements, ref, out, equipment, lodf)
    unit = _voltage_unit(db, runs["OUTAGE"])
    return {
        "scenario_id": scenario_id,
        "period_hours": period_hours,
        "voltage_unit": unit,
        "lines": lines,
        "buses": _bus_rows(db, runs, windows, elements, equipment, unit),
    }


def merge_cells(index, cells_by_scenario, limits=DEFAULT_LIMITS):
    """Assemble the combined payload from the index and the per-scenario results."""
    lines, buses, period_hours, voltage_unit = {}, {}, 0.0, None
    scenarios = [s for s in index["scenarios"] if cells_by_scenario.get(s["id"])]
    for scenario in scenarios:
        part = cells_by_scenario[scenario["id"]]
        period_hours = max(period_hours, part["period_hours"])
        voltage_unit = voltage_unit or part["voltage_unit"]
        for item in part["lines"]:
            entry = lines.setdefault(
                item["id"],
                {k: item.get(k) for k in ("id", "name", "class_name", "type", "grid", "nominal_kv")} | {"base": None, "cells": {}},
            )
            if entry["base"] is None or (item["ref_full"] is not None and item["ref_full"] > entry["base"]):
                entry["base"] = item["ref_full"]
            entry["cells"][scenario["id"]] = item["cell"]
        for item in part["buses"]:
            entry = buses.setdefault(
                item["id"],
                {k: item.get(k) for k in ("id", "name", "class_name", "type", "grid", "nominal_kv", "unit", "limits")} | {"cells": {}},
            )
            if entry["limits"] is None:
                entry["limits"] = item["limits"]
            entry["cells"][scenario["id"]] = item["cell"]
    ordered_lines = sorted(lines.values(), key=lambda line: line["name"].casefold())
    ordered_buses = sorted(buses.values(), key=lambda bus: bus["name"].casefold())
    return {
        "scenarios": scenarios,
        "lines": ordered_lines,
        "buses": ordered_buses,
        "voltage_unit": voltage_unit,
        "has_lodf": any(s["has_lodf"] for s in scenarios),
        "period_hours": period_hours,
        "period": index["period"],
        "limits": list(limits),
    }


def across_scenarios(store, limits=DEFAULT_LIMITS, analysis=None):
    """Everything at once for one analysis: the index plus the cells of every scenario."""
    index = scenario_index(store, analysis)
    cells = {s["id"]: scenario_cells(store, s["id"], limits) for s in index["scenarios"]}
    return merge_cells(index, cells, limits)


class _NoProfile(Exception):
    """An unknown scenario: answered with None and never cached, it may be saved later."""


def scenario_profile(store, scenario_id, top=5, points=240, grid=None):
    """Loading over time of the most critical branches of one scenario (of one grid, when `grid` is given), cached.

    The elements switched off in the scenario are left out. Series are reduced to at
    most `points` buckets by their maximum, so short peaks are never averaged away.
    """
    def compute():
        result = _scenario_profile(store, scenario_id, top, points, grid)
        if result is None:
            raise _NoProfile()
        return result

    try:
        return _PROFILE_CACHE.get_or_compute((getattr(store, "path", None), scenario_id, top, points, grid), compute)
    except _NoProfile:
        return None


def _scenario_profile(store, scenario_id, top, points, grid):
    db = store.db
    row = db.execute("SELECT * FROM pf_scenarios WHERE id=?", (scenario_id,)).fetchone()
    if row is None:
        return None
    runs = {
        r["kind"]: r["run_id"]
        for r in db.execute("SELECT run_id, kind FROM pf_scenario_runs WHERE scenario_id=?", (scenario_id,))
    }
    if "REF" not in runs or "OUTAGE" not in runs:
        return None
    _ids, _chosen, windows, equipment = _outage_context(store, row)
    elements = {
        e["id"]: e
        for e in db.execute(
            "SELECT id, name, className, type, path FROM analysis_elements WHERE run_id=?", (runs["OUTAGE"],)
        )
        if e["type"] != "bus" and e["name"] not in equipment and (grid is None or grid_name(e["path"]) == grid)
    }
    peaks = _extremes(db, runs["OUTAGE"], windows)
    ranked = sorted((i for i in peaks if i in elements), key=lambda i: peaks[i], reverse=True)[: max(1, top)]
    if not ranked:
        return {"scenario_id": scenario_id, "times": [], "windows": windows, "series": []}

    marks = ",".join("?" for _ in ranked)
    # The time grid of the first series decides the buckets; per bucket the highest value of each series is kept.
    stamps = [
        r[0]
        for r in values.query(
            db, runs["OUTAGE"],
            "SELECT v.t FROM analysis_series se JOIN analysis_values v ON v.series_id = se.id "
            "WHERE se.run_id=? AND se.metric_id=? AND se.element_id=? ORDER BY v.t",
            (runs["OUTAGE"], LOADING, ranked[0]),
        )
    ]
    size = max(1, -(-len(stamps) // max(points, 1)))
    times = [stamps[i] for i in range(0, len(stamps), size)]
    bucket_of = {t: i // size for i, t in enumerate(stamps)}

    def reduced(run_id):
        """{element: [maximum per bucket, None where a bucket has no value]}"""
        result = {}
        for element_id, t, value in values.query(
            db, run_id,
            "SELECT se.element_id, v.t, v.value FROM analysis_series se JOIN analysis_values v ON v.series_id = se.id "
            "WHERE se.run_id=? AND se.metric_id=? AND se.element_id IN (" + marks + ") AND v.value IS NOT NULL",
            (run_id, LOADING, *ranked),
        ):
            bucket = bucket_of.get(t)
            if bucket is None:
                continue
            peaks_of = result.setdefault(element_id, [None] * len(times))
            if peaks_of[bucket] is None or value > peaks_of[bucket]:
                peaks_of[bucket] = value
        return result

    out, ref = reduced(runs["OUTAGE"]), reduced(runs["REF"])
    empty = [None] * len(times)

    series = [
        {
            "id": i,
            "name": elements[i]["name"],
            "type": elements[i]["type"],
            "max": peaks[i],
            "out": out.get(i, empty),
            "ref": ref.get(i, empty),
        }
        for i in ranked
    ]
    return {"scenario_id": scenario_id, "times": [_iso(t) for t in times], "windows": windows, "series": series}
