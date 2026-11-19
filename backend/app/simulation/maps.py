"""Network maps: SVG files exported from the operator's Figma map, matched to the elements of an analysis.

A map is an SVG as Figma exports it with "Include id attribute". Every layer inside the group named "Elements" is
one piece of equipment; its id (the layer name, Figma replaces spaces with underscores and numbers repeated names
"_2", "_3") names the PowerFactory element: its name, "<grid> <name>" or its full path. Everything outside that
group is drawing (background, labels, generators). The maps lie in the folder `maps` next to the results database,
or in OA_MAP_DIR. Read-only; the SVG is never executed on the server (docs/MAP.md).
"""

import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from app.core.cache import TTLCache
from app.simulation import across, settings, states, timepoint

MAX_BYTES = 20 * 1024 * 1024
ELEMENTS_GROUP = "elements"
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$")
_REPEATED = re.compile(r"^(.*)_(\d+)$")
# Unmatched elements listed by name; the rest only counted.
LIST_LIMIT = 200
# A match depends on the map file and the elements of the analysis; both change rarely.
_MATCH_CACHE = TTLCache(max_entries=16, ttl_seconds=3600)


def folder():
    """Where the maps of the open results database lie."""
    configured = os.getenv("OA_MAP_DIR")
    return Path(configured) if configured else Path(settings.ANALYSIS_DB_PATH).resolve().parent / "maps"


def key(text):
    """Comparable form of a layer id or element name: lower case, every run of other characters one underscore."""
    return re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")


def available():
    """The SVG maps of the folder, by name."""
    path = folder()
    if not path.is_dir():
        return []
    return [{"name": file.stem, "bytes": file.stat().st_size}
            for file in sorted(path.glob("*.svg")) if file.is_file() and _NAME.match(file.stem)]


def _file(name):
    if not _NAME.match(name or ""):
        return None
    base = folder().resolve()
    file = (base / f"{name}.svg").resolve()
    return file if file.parent == base and file.is_file() else None


def read(name):
    """The SVG text of one map; None when there is no such map. Raises ValueError for an unusable file."""
    file = _file(name)
    if file is None:
        return None
    if file.stat().st_size > MAX_BYTES:
        raise ValueError(f"The map {name} is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    return file.read_text(encoding="utf-8")


def element_layers(svg):
    """Ids of the equipment layers: the direct children of the group named "Elements" (first one found)."""
    # Figma writes no DTD; refusing one rules out entity expansion and external entities before parsing.
    if re.search(r"<!(DOCTYPE|ENTITY)", svg, re.IGNORECASE):
        raise ValueError("The map declares a DOCTYPE or entities; export it from Figma again.")
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as error:
        raise ValueError(f"The map is not valid SVG: {error}") from None
    group = next((node for node in root.iter() if key(node.get("id")) == ELEMENTS_GROUP), None)
    if group is None:
        raise ValueError('The map has no group named "Elements" with the equipment layers.')
    layers = [child.get("id") for child in group if child.get("id")]
    generators = next((node for node in root.iter() if key(node.get('id')) == 'generators'), None)
    if generators is not None and generators is not group:
        layers.extend(child.get('id') for child in generators if child.get('id'))
    return layers


def _elements(db, analysis):
    if analysis is None or analysis == across.UNASSIGNED:
        return []
    return db.execute("SELECT element_id, name, class_name, grid, path, nominal_kv FROM gl_elements "
                      "WHERE assessment_id = ?", (analysis,)).fetchall()


def match(db, name, analysis=None):
    """Which layer of the map shows which element of the analysis, and what is left over on either side (cached).

    `elements` lists the matched elements once ([id, name, grid, nominal kV, class]); `layers` gives every matched
    layer the index of its element there, the order in which `values` sends its numbers. None when the map does
    not exist. Raises ValueError for a file without the "Elements" group or not SVG.
    """
    file = _file(name)
    if file is None:
        return None
    analysis = across.resolve_analysis(db, analysis)
    count = db.execute("SELECT COUNT(*) FROM gl_elements WHERE assessment_id = ?", (analysis,)).fetchone()[0]
    stat = file.stat()
    key_ = (str(file), stat.st_mtime_ns, stat.st_size, settings.ANALYSIS_DB_PATH, analysis, count)
    return _MATCH_CACHE.get_or_compute(key_, lambda: _match(db, name, analysis))


def _match(db, name, analysis):
    layers = element_layers(read(name))
    elements = _elements(db, analysis)
    by_key = {}
    for row in elements:
        for candidate in {key(row[1]), key(f"{row[3]} {row[1]}"), key(row[4])}:
            if candidate:
                by_key.setdefault(candidate, set()).add(row[0])
    matched, unmatched, ambiguous, repeated = {}, [], [], []
    for layer in layers:
        found = by_key.get(key(layer))
        if found is None and (stem := _REPEATED.match(layer)):
            found = by_key.get(key(stem.group(1)))  # a repeated layer name: Figma appended _2, _3 …
            if found is not None:
                repeated.append(layer)
        if found is None:
            unmatched.append(layer)
        elif len(found) > 1:
            ambiguous.append(layer)  # the name exists in several grids: name the layer "<grid> <name>" or by path
        else:
            matched[layer] = next(iter(found))
    shown = set(matched.values())
    missing = [{"element_id": r[0], "name": r[1], "class_name": r[2], "grid": r[3]}
               for r in sorted(elements, key=lambda r: (r[3] or "", r[1])) if r[0] not in shown]
    by_id = {r[0]: r for r in elements}
    order = list(dict.fromkeys(matched.values()))
    index = {element_id: i for i, element_id in enumerate(order)}
    return {
        "map": name,
        "analysis": analysis,
        "elements": [[e, by_id[e][1], by_id[e][3], by_id[e][5], by_id[e][2]] for e in order],
        "layers": {layer: index[e] for layer, e in matched.items()},
        "counts": {"layers": len(layers), "matched": len(matched), "elements": len(elements),
                   "elements_without_layer": len(missing)},
        "unmatched_layers": unmatched,
        "ambiguous_layers": ambiguous,
        "repeated_layers": repeated,
        "elements_without_layer": missing[:LIST_LIMIT],
    }


_LAYOUT_CACHE = TTLCache(max_entries=16, ttl_seconds=3600)
METRICS = ("loading", "voltage", "active_power")


def _layout(store, matched, run_id, analysis):
    """Per map element what does not change with time: its metric (0 loading, 1 voltage, None not in the run) and
    its limits. Built once per map and run."""
    def compute():
        limits = [{e[0]: (e[6], e[7]) for e in timepoint._run_elements(store, run_id, metric, analysis)}
                  for metric in METRICS]
        rows = []
        for element_id, *_rest in matched["elements"]:
            metric = next((i for i, entries in enumerate(limits) if element_id in entries), None)
            rows.append((element_id, metric, *(limits[metric][element_id] if metric is not None else (None, None))))
        return rows
    key_ = (store.path, matched["map"], id(matched), run_id)
    return _LAYOUT_CACHE.get_or_compute(key_, compute)


def values(store, name, scenario_id, t):
    """The numbers of the map at one time, in the order of `match(...)["elements"]`: per element the metric
    (0 loading, 1 voltage, None not in the run), scenario and REF value, limits, and which are switched off.

    Compact columns instead of one object per element: 20,000 elements are a few hundred kB. None when the map or
    the scenario does not exist.
    """
    row, runs = timepoint._scenario(store, scenario_id)
    if row is None:
        return None
    matched = match(store.db, name, row["analysis_id"])
    if matched is None:
        return None
    _ids, _chosen, windows, equipment = across._outage_context(store, row)
    in_window = any(start <= t <= end for start, end in windows)
    layout = _layout(store, matched, runs["OUTAGE"], row["analysis_id"])
    # One after the other: four parallel reads of the same file wait on each other (measured: 220 against 80 ms).
    got = [[timepoint._values_at(store.path, runs.get(kind), metric, t) for metric in METRICS]
           for kind in ("OUTAGE", "REF")]
    out, ref = got
    rounded = lambda v: None if v is None else round(v, 4)  # noqa: E731
    v = [None if m is None else rounded(out[m].get(e)) for e, m, _lo, _up in layout]
    r = [None if m is None else rounded(ref[m].get(e)) for e, m, _lo, _up in layout]
    off = [i for i, element in enumerate(matched["elements"]) if in_window and element[1] in equipment]
    return {"scenario_id": scenario_id, "t": t, "in_window": in_window, "states_version": states.STATES_VERSION,
            "m": [x[1] for x in layout], "v": v, "r": r, "lo": [x[2] for x in layout], "up": [x[3] for x in layout],
            "off": off}
