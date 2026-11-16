"""Comparison of two analyses (A against B) and of two scenarios element by element. Read-only.

Two analyses are compared by what makes their results comparable (project, study case, engine, period, settings,
monitored elements) and by their scenarios, paired by what they switch off. Two scenarios, also from different
analyses, are compared per element: the value in A, in B and the change B - A, worst change first. Elements are
paired by their id (a hash of project path and element path), else by type, grid and name. Values are raw; an element
without a value in one of them is listed with the state `only_a` / `only_b` / `outaged`, never as 0.
"""

import json
from datetime import datetime, timezone

from app.core.cache import TTLCache
from app.simulation import across, timepoint

_COMPARE_CACHE = TTLCache(max_entries=16, ttl_seconds=600)
# Below these changes two values count as equal (rounding of PowerFactory results).
LOADING_TOLERANCE = 0.5  # percentage points
VOLTAGE_TOLERANCE = 0.002  # p.u.
# A share of common elements below this makes an element comparison only partly meaningful.
OVERLAP_WARNING = 0.95
FACTS = (
    ("project_path", "Project"),
    ("study_case_path", "Study case"),
    ("engine_version", "PowerFactory version"),
    ("period_start", "Period start"),
    ("period_end", "Period end"),
)


def _analysis(db, analysis_id):
    if analysis_id == across.UNASSIGNED:
        return {"id": across.UNASSIGNED, "settings": "{}", "status": "unknown"}
    row = db.execute("SELECT * FROM gl_assessments WHERE id=?", (analysis_id,)).fetchone()
    if row is None:
        return None
    found = dict(row)
    found['name'] = json.loads(found.get('configuration') or '{}').get('analysis_name') or '{} - {}'.format(found.get('project'), found.get('native_run_id'))
    return found


def _flat(value, prefix=""):
    """{dotted key: value} of a nested settings object, so a difference names the setting that differs."""
    if isinstance(value, dict):
        flat = {}
        for key, inner in value.items():
            flat.update(_flat(inner, f"{prefix}{key}."))
        return flat
    return {prefix[:-1]: value}


def _settings_differences(a, b):
    left = _flat(json.loads(a.get("settings") or "{}"))
    right = _flat(json.loads(b.get("settings") or "{}"))
    return [{"setting": key, "a": left.get(key), "b": right.get(key)}
            for key in sorted(left.keys() | right.keys()) if left.get(key) != right.get(key)]


def _check(name, ok, detail, severity="warning"):
    return {"check": name, "status": "ok" if ok else severity, "detail": detail}


def _when(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if epoch is not None else None


def _fact_checks(a, b):
    checks = []
    for field, label in FACTS:
        left, right = a.get(field), b.get(field)
        if left in (None, "") and right in (None, ""):
            continue
        shown = [_when(v) if field.startswith("period_") else v for v in (left, right)]
        checks.append(_check(label, left == right, f"{shown[0]} | {shown[1]}" if left != right else str(shown[0])))
    differences = _settings_differences(a, b)
    checks.append(_check("Settings", not differences,
                         f"{len(differences)} setting(s) differ" if differences else "identical"))
    return checks, differences


def _element_keys(db, analysis_id):
    """{element id: (type, grid, name)} of the monitored elements of an analysis."""
    if analysis_id == across.UNASSIGNED:
        return {}
    return {r[0]: r[1:] for r in db.execute(
        "SELECT element_id, class_name, grid, name FROM gl_elements WHERE assessment_id=?", (analysis_id,))}


def _scenario_summary(store, row):
    """Peak values of a scenario's OUTAGE run over the whole period, from its per-time summary."""
    runs = across._runs(store.db, row["id"])
    if "OUTAGE" not in runs:
        return None
    found = store.db.execute(
        "SELECT MAX(loading_max), MAX(loading_over), SUM(loading_over > 0), MIN(voltage_min), MAX(voltage_max), "
        "MAX(voltage_outside), COUNT(*) FROM pf_run_times WHERE run_id=?", (runs["OUTAGE"],)).fetchone()
    if not found[6]:  # imported before pf_run_times existed
        rows = list(timepoint.run_times(store, runs["OUTAGE"])["rows"].values())
        pick = lambda k, f: f((r[k] for r in rows if r[k] is not None), default=None)  # noqa: E731
        found = (pick(0, max), pick(1, max), sum(1 for r in rows if (r[1] or 0) > 0), pick(2, min), pick(3, max),
                 pick(4, max), len(rows))
    statuses = [r[0] for r in store.db.execute(
        "SELECT COALESCE(n.status, a.status) FROM analysis_runs a LEFT JOIN pf_run_notes n ON n.run_id = a.id "
        "WHERE a.id IN (?, ?)", (runs.get("REF"), runs["OUTAGE"]))]
    _ids, _chosen, windows, equipment = across._outage_context(store, row)
    return {
        "id": row["id"],
        "name": row["name"],
        "status": max(statuses, key=lambda s: across.RUN_STATUS_ORDER.get(s, len(across.RUN_STATUS_ORDER))),
        "equipment": sorted(equipment),
        "windows": windows,
        "loading_max": found[0],
        "overloaded_max": found[1],
        "overloaded_times": found[2],
        "voltage_min": found[3],
        "voltage_max": found[4],
        "voltage_outside_max": found[5],
        "times": found[6],
    }


def _pair(left, right):
    """Scenarios of A and B paired: same equipment and outage windows, then same equipment, then same name."""
    pairs, rest_a, rest_b = [], list(left), list(right)
    for key in (lambda s: (tuple(s["equipment"]), tuple(map(tuple, s["windows"]))),
                lambda s: tuple(s["equipment"]) or None,
                lambda s: s["name"]):
        waiting = {}
        for summary in rest_b:
            if key(summary) is not None:
                waiting.setdefault(key(summary), []).append(summary)
        unpaired = []
        for summary in rest_a:
            found = waiting.get(key(summary)) if key(summary) is not None else None
            if found:
                partner = found.pop(0)
                rest_b.remove(partner)
                pairs.append((summary, partner))
            else:
                unpaired.append(summary)
        rest_a = unpaired
    return pairs + [(s, None) for s in rest_a] + [(None, s) for s in rest_b]


def compare_analyses(store, a, b):
    """Comparability of two analyses and their scenarios paired by switched-off equipment; None if one is unknown."""
    db = store.db
    left, right = _analysis(db, a), _analysis(db, b)
    if left is None or right is None:
        return None

    def compute():
        checks, differences = _fact_checks(left, right)
        keys_a, keys_b = _element_keys(db, a), _element_keys(db, b)
        common = len(keys_a.keys() & keys_b.keys())
        union = len(keys_a.keys() | keys_b.keys())
        if union:
            checks.append(_check("Monitored elements", common / union >= OVERLAP_WARNING,
                                 f"{common} of {union} in both ({len(keys_a)} in A, {len(keys_b)} in B)"))
        sides = [[s for s in (_scenario_summary(store, row) for row in across._scenario_rows(db, analysis)) if s]
                 for analysis in (a, b)]
        pairs = []
        for sa, sb in _pair(*sides):
            delta = lambda field: (sb[field] - sa[field]  # noqa: E731
                                   if sa and sb and sa[field] is not None and sb[field] is not None else None)
            pairs.append({
                "equipment": (sa or sb)["equipment"],
                "a": sa,
                "b": sb,
                "windows_equal": bool(sa and sb and sa["windows"] == sb["windows"]),
                "delta_loading_max": delta("loading_max"),
                "delta_voltage_min": delta("voltage_min"),
                "delta_overloaded_times": delta("overloaded_times"),
            })
        pairs.sort(key=lambda p: (p["delta_loading_max"] is None, -abs(p["delta_loading_max"] or 0)))
        paired = sum(1 for p in pairs if p["a"] and p["b"])
        checks.append(_check("Scenarios", paired == len(pairs),
                             f"{paired} paired (by switched-off equipment, else name), "
                             f"{len(pairs) - paired} only in one analysis"))
        windows = sum(1 for p in pairs if p["a"] and p["b"] and not p["windows_equal"])
        checks.append(_check("Outage windows", windows == 0,
                             f"{windows} paired scenario(s) with different outage windows" if windows else "identical"))
        return {"a": _public(left), "b": _public(right), "checks": checks, "settings": differences, "pairs": pairs}

    return _COMPARE_CACHE.get_or_compute((getattr(store, "path", None), "analyses", a, b), compute)


def _public(analysis):
    return {k: v for k, v in analysis.items() if k not in ("settings", "configuration")}


def _branch_values(cells):
    return {line["id"]: line for line in cells["lines"]}


def _bus_values(cells):
    return {bus["id"]: bus for bus in cells["buses"]}


def _match(items_a, items_b):
    """Pairs of (id in A, id in B): by id, the rest by type, grid and name (other project path, same equipment)."""
    pairs = [(i, i) for i in items_a if i in items_b]
    key = lambda item: (item["type"], item["grid"], item["name"])  # noqa: E731
    rest_b = {key(items_b[i]): i for i in items_b if i not in items_a}
    by_name = 0
    for i in items_a:
        if i in items_b:
            continue
        j = rest_b.pop(key(items_a[i]), None)
        pairs.append((i, j))
        by_name += j is not None
    matched_b = {j for _i, j in pairs if j is not None}
    pairs.extend((None, j) for j in items_b if j not in matched_b)
    return pairs, by_name


def _branch_row(item_a, item_b):
    ca, cb = (item_a or {}).get("cell") or {}, (item_b or {}).get("cell") or {}
    va, vb = ca.get("value"), cb.get("value")
    state = ("only_b" if item_a is None else "only_a" if item_b is None
             else "outaged" if ca.get("outaged") or cb.get("outaged") else "value")
    base = item_a or item_b
    return {
        "element_id": base["id"], "name": base["name"], "type": base["type"], "grid": base["grid"],
        "nominal_kv": base.get("nominal_kv"), "a": va, "b": vb,
        "delta": vb - va if va is not None and vb is not None else None,
        "ref_a": ca.get("window_base"), "ref_b": cb.get("window_base"), "state": state,
    }


def _bus_row(item_a, item_b):
    ca, cb = (item_a or {}).get("cell") or {}, (item_b or {}).get("cell") or {}
    lo = lambda c: c["out"][0] if c.get("out") else None  # noqa: E731
    hi = lambda c: c["out"][1] if c.get("out") else None  # noqa: E731
    state = ("only_b" if item_a is None else "only_a" if item_b is None
             else "outaged" if ca.get("outaged") or cb.get("outaged") else "value")
    deltas = [x for x in ((lo(cb) - lo(ca)) if lo(ca) is not None and lo(cb) is not None else None,
                          (hi(cb) - hi(ca)) if hi(ca) is not None and hi(cb) is not None else None) if x is not None]
    base = item_a or item_b
    return {
        "element_id": base["id"], "name": base["name"], "type": base["type"], "grid": base["grid"],
        "nominal_kv": base.get("nominal_kv"), "a": [lo(ca), hi(ca)], "b": [lo(cb), hi(cb)],
        # The larger change of the lowest and the highest voltage, with its sign.
        "delta": max(deltas, key=abs) if deltas else None, "state": state,
    }


def compare_scenarios(store, a, b, metric="loading", limit=200, offset=0, grid=None, q=None, kv=None):
    """Every element of two scenarios with its value in A and B and the change, worst change first (paged).

    None when a scenario is unknown or has no runs.
    """
    db = store.db
    rows = {s: db.execute("SELECT * FROM pf_scenarios WHERE id=?", (s,)).fetchone() for s in (a, b)}
    if any(r is None for r in rows.values()):
        return None

    def compute():
        cells_a, cells_b = across.scenario_cells(store, a), across.scenario_cells(store, b)
        if cells_a is None or cells_b is None:
            return None
        values = _branch_values if metric == "loading" else _bus_values
        items_a, items_b = values(cells_a), values(cells_b)
        pairs, by_name = _match(items_a, items_b)
        build = _branch_row if metric == "loading" else _bus_row
        found = [build(items_a.get(i) if i else None, items_b.get(j) if j else None) for i, j in pairs]
        found.sort(key=lambda r: (r["delta"] is None, -abs(r["delta"] or 0), r["name"]))
        tolerance = LOADING_TOLERANCE if metric == "loading" else VOLTAGE_TOLERANCE
        changed = [r for r in found if r["delta"] is not None and abs(r["delta"]) > tolerance]
        summary_a = _scenario_summary(store, rows[a])
        summary_b = _scenario_summary(store, rows[b])
        checks = []
        analysis_a, analysis_b = rows[a]["analysis_id"], rows[b]["analysis_id"]
        if analysis_a != analysis_b:
            facts = [_analysis(db, x) for x in (analysis_a or across.UNASSIGNED, analysis_b or across.UNASSIGNED)]
            if all(facts):
                checks, _differences = _fact_checks(*facts)
        both = sum(1 for r in found if r["state"] not in ("only_a", "only_b"))
        checks.append(_check("Elements", both / max(len(found), 1) >= OVERLAP_WARNING,
                             f"{both} of {len(found)} in both" + (f" ({by_name} paired by name)" if by_name else "")))
        checks.append(_check("Switched off", summary_a["equipment"] == summary_b["equipment"],
                             " | ".join(", ".join(s["equipment"]) or "nothing" for s in (summary_a, summary_b)), "info"))
        checks.append(_check("Outage windows", summary_a["windows"] == summary_b["windows"],
                             "identical" if summary_a["windows"] == summary_b["windows"] else "differ", "info"))
        if metric == "voltage" and cells_a["voltage_unit"] != cells_b["voltage_unit"]:
            checks.append(_check("Voltage unit", False, f"{cells_a['voltage_unit']} | {cells_b['voltage_unit']}"))
        return {
            "a": summary_a, "b": summary_b, "metric": metric, "checks": checks,
            "tolerance": tolerance,
            "counts": {
                "total": len(found), "both": both,
                "only_a": sum(1 for r in found if r["state"] == "only_a"),
                "only_b": sum(1 for r in found if r["state"] == "only_b"),
                "higher": sum(1 for r in changed if r["delta"] > 0),
                "lower": sum(1 for r in changed if r["delta"] < 0),
            },
            "rows": found,
        }

    result = _COMPARE_CACHE.get_or_compute((getattr(store, "path", None), "scenarios", a, b, metric), compute)
    if result is None:
        return None
    rows_out = result["rows"]
    if grid is not None:
        rows_out = [r for r in rows_out if r["grid"] == grid]
    if kv is not None:
        rows_out = [r for r in rows_out if r["nominal_kv"] == kv]
    if q:
        needle = q.lower()
        rows_out = [r for r in rows_out if needle in r["name"].lower()]
    return {**{k: v for k, v in result.items() if k != "rows"}, "filtered": len(rows_out),
            "offset": offset, "limit": limit, "rows": rows_out[offset:offset + limit]}
