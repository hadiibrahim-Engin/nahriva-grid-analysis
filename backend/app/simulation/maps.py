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
from dataclasses import dataclass
from uuid import uuid4
from pathlib import Path

from app.core.cache import TTLCache
from app.simulation import across, settings, states, timepoint
from app.simulation.store import database_revision
from app.simulation.values import samples_at

MAX_BYTES = 20 * 1024 * 1024
ELEMENTS_GROUP = "elements"
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
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
    return _NON_ALNUM.sub("_", text.lower()).strip("_") if text else ""


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


def file_revision(name):
    file = _file(name)
    if file is None:
        return None
    stat = file.stat()
    if stat.st_size > MAX_BYTES:
        raise ValueError(f"The map {name} is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    return str(file), stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size


def match_revision(db, name, analysis):
    file = file_revision(name)
    if file is None:
        return None
    return file, database_revision(db), across.resolve_analysis(db, analysis)


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


def match(db, name, analysis=None, *, revision=None):
    """Which layer of the map shows which element of the analysis, and what is left over on either side (cached).

    `elements` lists the matched elements once ([id, name, grid, nominal kV, class]); `layers` gives every matched
    layer the index of its element there, the order in which `values` sends its numbers. None when the map does
    not exist. Raises ValueError for a file without the "Elements" group or not SVG.
    """
    revision = revision or match_revision(db, name, analysis)
    if revision is None:
        return None
    return _MATCH_CACHE.get_or_compute(revision, lambda: _match(db, name, revision[-1]))


def _match(db, name, analysis):
    svg = read(name)
    if svg is None:
        raise FileNotFoundError(name)
    layers = element_layers(svg)
    elements = _elements(db, analysis)
    ambiguous_key = object()
    by_key = {}
    for row in elements:
        for candidate in (key(row[1]), key(f"{row[3]} {row[1]}"), key(row[4])):
            if candidate:
                if by_key.setdefault(candidate, row[0]) != row[0]:
                    by_key[candidate] = ambiguous_key
    matched, unmatched, ambiguous, repeated = {}, [], [], []
    for layer in layers:
        found = by_key.get(key(layer))
        if found is None and (stem := _REPEATED.match(layer)):
            found = by_key.get(key(stem.group(1)))  # a repeated layer name: Figma appended _2, _3 …
            if found is not None:
                repeated.append(layer)
        if found is None:
            unmatched.append(layer)
        elif found is ambiguous_key:
            ambiguous.append(layer)  # the name exists in several grids: name the layer "<grid> <name>" or by path
        else:
            matched[layer] = found
    shown = set(matched.values())
    missing_rows = sorted((r for r in elements if r[0] not in shown), key=lambda r: (r[3] or "", r[1]))
    missing = [{"element_id": r[0], "name": r[1], "class_name": r[2], "grid": r[3]}
               for r in missing_rows[:LIST_LIMIT]]
    by_id = {r[0]: r for r in elements}
    order = list(dict.fromkeys(matched.values()))
    index = {element_id: i for i, element_id in enumerate(order)}
    return {
        "map": name,
        "analysis": analysis,
        "elements": [[e, by_id[e][1], by_id[e][3], by_id[e][5], by_id[e][2]] for e in order],
        "layers": {layer: index[e] for layer, e in matched.items()},
        "counts": {"layers": len(layers), "matched": len(matched), "elements": len(elements),
                   "elements_without_layer": len(missing_rows)},
        "unmatched_layers": unmatched,
        "ambiguous_layers": ambiguous,
        "repeated_layers": repeated,
        "elements_without_layer": missing,
    }


_LAYOUT_CACHE = TTLCache(max_entries=16, ttl_seconds=3600)
_REFERENCE_IDS = TTLCache(max_entries=16, ttl_seconds=3600)
METRICS = ("loading", "voltage", "active_power")


@dataclass
class MapLayout:
    match: dict
    token: str
    metrics: list
    lower: list
    upper: list
    series_ids: list


def _layout(store, matched, run_id):
    """Choose the displayed series and its limits once, in map order."""
    def compute():
        by_element = {}
        for series, element, metric, lower, upper in store.db.execute(
            "SELECT s.id, s.element_id, s.metric_id, l.lower, l.upper FROM analysis_series s "
            "LEFT JOIN pf_element_limits l ON l.run_id=s.run_id AND l.element_id=s.element_id "
            "AND l.metric_id=s.metric_id WHERE s.run_id=? AND s.metric_id IN (?,?,?)",
            (run_id, *METRICS),
        ):
            priority = METRICS.index(metric)
            if element not in by_element or priority < by_element[element][0]:
                by_element[element] = (priority, series, lower, upper)
        rows = [by_element.get(element[0], (None, None, None, None)) for element in matched["elements"]]
        return MapLayout(matched, uuid4().hex, [r[0] for r in rows], [r[2] for r in rows],
                         [r[3] for r in rows], [r[1] for r in rows])

    # The layout holds a reference to its match so its identity cannot be recycled.
    return _LAYOUT_CACHE.get_or_compute((store.path, id(matched), run_id), compute)


def _sample_column(db, run_id, t, series_ids):
    samples = samples_at(db, run_id, t, [sid for sid in series_ids if sid is not None])
    return [round(value, 4) if (value := samples.get(sid)) is not None else None for sid in series_ids]


def _reference_column(db, run_id, t, layout):
    if run_id is None:
        return [None] * len(layout.series_ids)

    def resolve_ids():
        series = {(element, metric): sid for element, metric, sid in db.execute(
            "SELECT element_id,metric_id,id FROM analysis_series WHERE run_id=? AND metric_id IN (?,?,?)",
            (run_id, *METRICS))}
        return [series.get((element[0], METRICS[metric])) if metric is not None else None
                for element, metric in zip(layout.match["elements"], layout.metrics)]

    ids = _REFERENCE_IDS.get_or_compute((layout.token, run_id), resolve_ids)
    return _sample_column(db, run_id, t, ids)


def values(store, name, scenario_id, t, *, display=False, known_layout=None):
    """All values by default. The renderer requests scenario samples and reuses a matching layout."""
    row, runs = timepoint._scenario(store, scenario_id)
    if row is None:
        return None
    matched = match(store.db, name, row["analysis_id"])
    if matched is None:
        return None
    _ids, _chosen, windows, equipment = across._outage_context(store, row)
    in_window = any(start <= t <= end for start, end in windows)
    layout = _layout(store, matched, runs["OUTAGE"])
    result = {"scenario_id": scenario_id, "t": t, "in_window": in_window, "states_version": states.STATES_VERSION,
              "v": _sample_column(store.db, runs["OUTAGE"], t, layout.series_ids),
              "off": [i for i, e in enumerate(matched["elements"]) if e[1] in equipment] if in_window else []}
    if not display or known_layout != layout.token:
        result.update(m=layout.metrics, lo=layout.lower, up=layout.upper)
    if display:
        result["layout"] = layout.token
    else:
        result["r"] = _reference_column(store.db, runs.get("REF"), t, layout)
    return result
