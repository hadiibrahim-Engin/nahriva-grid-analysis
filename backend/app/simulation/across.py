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

Equipment: branches (lines, transformers) are evaluated by loading. Busbars are
evaluated by voltage against the limits stored with the results (`buses`);
without stored limits no violation is derived.
"""

import json
from datetime import datetime, timezone

from app.core.cache import TTLCache
from app.simulation.store import outage_key

LOADING = "loading"
VOLTAGE = "voltage"
DEFAULT_LIMITS = (100.0, 110.0, 120.0)
# Results of a saved scenario never change; the cache only spares repeated reads.
_CELLS_CACHE = TTLCache(max_entries=256, ttl_seconds=3600)


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def _window_clause(windows):
    if not windows:
        return "", []
    parts, params = [], []
    for start, end in windows:
        parts.append("(timestamp>=? AND timestamp<=?)")
        params += [_iso(start), _iso(end)]
    return " AND (" + " OR ".join(parts) + ")", params


def _extremes(db, run_id, windows=None):
    clause, params = _window_clause(windows)
    rows = db.execute(
        "SELECT element_id, MAX(value) hi FROM analysis_samples "
        "WHERE run_id=? AND metric_id=? AND value IS NOT NULL" + clause + " GROUP BY element_id",
        (run_id, LOADING, *params),
    )
    return {row["element_id"]: row["hi"] for row in rows}


def _voltage_range(db, run_id, windows=None):
    clause, params = _window_clause(windows)
    rows = db.execute(
        "SELECT element_id, MIN(value) lo, MAX(value) hi FROM analysis_samples "
        "WHERE run_id=? AND metric_id=? AND value IS NOT NULL" + clause + " GROUP BY element_id",
        (run_id, VOLTAGE, *params),
    )
    return {row["element_id"]: [row["lo"], row["hi"]] for row in rows}


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
    rows = db.execute(
        "SELECT s.element_id, COUNT(*) n, MIN(s.timestamp) t0, MAX(s.timestamp) t1, "
        "SUM(CASE WHEN s.value < COALESCE(l.lower,-1e9) OR s.value > COALESCE(l.upper,1e9) THEN 1 ELSE 0 END) bad "
        "FROM analysis_samples s JOIN pf_element_limits l "
        "ON l.run_id=s.run_id AND l.element_id=s.element_id AND l.metric_id=s.metric_id "
        "WHERE s.run_id=? AND s.metric_id=? AND s.value IS NOT NULL GROUP BY s.element_id",
        (run_id, VOLTAGE),
    ).fetchall()
    result = {}
    for row in rows:
        step = 0.0
        if row["n"] > 1:
            span = datetime.fromisoformat(row["t1"]) - datetime.fromisoformat(row["t0"])
            step = span.total_seconds() / (row["n"] - 1) / 3600
        result[row["element_id"]] = (row["bad"] or 0) * step
    return result


def _window_expr(windows):
    """SQL condition 'timestamp lies inside one of the outage windows' (always true without windows)."""
    if not windows:
        return "1", []
    parts, params = [], []
    for start, end in windows:
        parts.append("(timestamp>=? AND timestamp<=?)")
        params += [_iso(start), _iso(end)]
    return " OR ".join(parts), params


def _loading_stats(db, run_id, windows, limits):
    """One grouped pass per run: full and in-window maximum, hours above each limit, period."""
    expr, wparams = _window_expr(windows)
    over = ",".join("SUM(CASE WHEN value>? THEN 1 ELSE 0 END)" for _ in limits)
    rows = db.execute(
        "SELECT element_id, COUNT(*) n, MIN(timestamp) t0, MAX(timestamp) t1, MAX(value) full_max, "
        "MAX(CASE WHEN " + expr + " THEN value END) win_max, " + over +
        " FROM analysis_samples WHERE run_id=? AND metric_id=? AND value IS NOT NULL GROUP BY element_id",
        (*wparams, *limits, run_id, LOADING),
    ).fetchall()
    result = {}
    for row in rows:
        n = row["n"]
        step = 0.0
        if n > 1:
            span = datetime.fromisoformat(row["t1"]) - datetime.fromisoformat(row["t0"])
            step = span.total_seconds() / (n - 1) / 3600
        counts = [row[i] or 0 for i in range(6, 6 + len(limits))]
        result[row["element_id"]] = {
            "full_max": row["full_max"],
            "win_max": row["win_max"],
            "hours_over": [c * step for c in counts],
            "period": n * step,
        }
    return result


def _scenario_rows(db):
    """Saved scenarios in creation order; the newest wins when a name was calculated more than once."""
    seen, rows = set(), []
    for row in db.execute("SELECT * FROM pf_scenarios ORDER BY created_at DESC"):
        if row["name"] in seen:
            continue
        seen.add(row["name"])
        rows.append(row)
    rows.reverse()
    return rows


def _runs(db, scenario_id):
    return {
        r["kind"]: r["run_id"]
        for r in db.execute("SELECT run_id, kind FROM pf_scenario_runs WHERE scenario_id=?", (scenario_id,))
    }


def _outage_context(store, row):
    outages = {o["id"]: o for o in (store.catalog() or {"outages": []}).get("outages", [])}
    ids = json.loads(row["outages"])
    chosen = [outages[i] for i in ids if i in outages]
    windows = [(o["start"], o["end"]) for o in chosen if o.get("start") is not None and o.get("end") is not None]
    equipment = {o["equipment_name"] for o in chosen if o.get("equipment_name")}
    return ids, chosen, windows, equipment


def scenario_index(store):
    """Scenarios with what they switch off. Reads no samples, so it is cheap on any database size."""
    db = store.db
    catalog = store.catalog() or {}
    lodf_keys = {r["outage_key"] for r in db.execute("SELECT DISTINCT outage_key FROM pf_lodf")}
    scenarios = []
    for row in _scenario_rows(db):
        runs = _runs(db, row["id"])
        if "REF" not in runs or "OUTAGE" not in runs:
            continue
        ids, chosen, _windows, equipment = _outage_context(store, row)
        outaged = [
            e["id"]
            for e in db.execute("SELECT id, name FROM analysis_elements WHERE run_id=?", (runs["OUTAGE"],))
            if e["name"] in equipment
        ]
        scenarios.append(
            {
                "id": row["id"],
                "name": row["name"],
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
            }
        )
    return {
        "scenarios": scenarios,
        "period": catalog.get("period"),
        "has_lodf": any(s["has_lodf"] for s in scenarios),
    }


def scenario_cells(store, scenario_id, limits=DEFAULT_LIMITS):
    """Per element the reduced values of one scenario (cached); None for an unknown scenario."""
    db = store.db
    stamp = db.execute("SELECT MAX(computed_at) FROM pf_lodf").fetchone()[0]
    key = (getattr(store, "path", None), scenario_id, tuple(limits), stamp)
    return _CELLS_CACHE.get_or_compute(key, lambda: _scenario_cells(store, scenario_id, limits))


def _branch_rows(elements, ref, out, equipment, lodf):
    """Branch cells of one scenario and the simulated period; busbars are handled separately."""
    lines, period_hours = [], 0.0
    for element_id, ref_stats in ref.items():
        element = elements.get(element_id)
        if element is None or element["type"] == "bus":
            continue
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
        for e in db.execute("SELECT id, name, className, type FROM analysis_elements WHERE run_id=?", (runs["OUTAGE"],))
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
                {k: item[k] for k in ("id", "name", "class_name", "type")} | {"base": None, "cells": {}},
            )
            if entry["base"] is None or (item["ref_full"] is not None and item["ref_full"] > entry["base"]):
                entry["base"] = item["ref_full"]
            entry["cells"][scenario["id"]] = item["cell"]
        for item in part["buses"]:
            entry = buses.setdefault(
                item["id"],
                {k: item[k] for k in ("id", "name", "class_name", "type", "unit", "limits")} | {"cells": {}},
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


def across_scenarios(store, limits=DEFAULT_LIMITS):
    """Everything at once: the index plus the cells of every scenario."""
    index = scenario_index(store)
    cells = {s["id"]: scenario_cells(store, s["id"], limits) for s in index["scenarios"]}
    return merge_cells(index, cells, limits)


def scenario_profile(store, scenario_id, top=5, points=240):
    """Loading over time of the most critical branches of one scenario.

    The elements switched off in the scenario are left out. Series are reduced to at
    most `points` buckets by their maximum, so short peaks are never averaged away.
    """
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
    catalog = store.catalog() or {"outages": []}
    outages = {o["id"]: o for o in catalog.get("outages", [])}
    chosen = [outages[i] for i in json.loads(row["outages"]) if i in outages]
    windows = [(o["start"], o["end"]) for o in chosen if o.get("start") is not None and o.get("end") is not None]
    equipment = {o["equipment_name"] for o in chosen if o.get("equipment_name")}
    elements = {
        e["id"]: e
        for e in db.execute(
            "SELECT id, name, className, type FROM analysis_elements WHERE run_id=?", (runs["OUTAGE"],)
        )
        if e["type"] != "bus" and e["name"] not in equipment
    }
    peaks = _extremes(db, runs["OUTAGE"], windows)
    ranked = sorted((i for i in peaks if i in elements), key=lambda i: peaks[i], reverse=True)[: max(1, top)]
    if not ranked:
        return {"scenario_id": scenario_id, "times": [], "windows": windows, "series": []}

    marks = ",".join("?" for _ in ranked)

    def samples(run_id):
        result = {}
        for r in db.execute(
            "SELECT element_id, timestamp, value FROM analysis_samples WHERE run_id=? AND metric_id=? "
            "AND element_id IN (" + marks + ") ORDER BY timestamp",
            (run_id, LOADING, *ranked),
        ):
            result.setdefault(r["element_id"], []).append((r["timestamp"], r["value"]))
        return result

    out, ref = samples(runs["OUTAGE"]), samples(runs["REF"])
    stamps = [t for t, _ in out[ranked[0]]] if ranked[0] in out else []
    size = max(1, -(-len(stamps) // max(points, 1)))
    bucket_of = {t: i // size for i, t in enumerate(stamps)}
    times = [stamps[i] for i in range(0, len(stamps), size)]

    def reduce(pairs):
        buckets = [None] * len(times)
        for t, v in pairs:
            b = bucket_of.get(t)
            if b is not None and v is not None and (buckets[b] is None or v > buckets[b]):
                buckets[b] = v
        return buckets

    series = [
        {
            "id": i,
            "name": elements[i]["name"],
            "type": elements[i]["type"],
            "max": peaks[i],
            "out": reduce(out.get(i, [])),
            "ref": reduce(ref.get(i, [])),
        }
        for i in ranked
    ]
    return {"scenario_id": scenario_id, "times": times, "windows": windows, "series": series}
