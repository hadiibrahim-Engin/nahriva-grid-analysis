import importlib.util
import hashlib
import json
import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, ConfigDict
from app.analysis.bootstrap import get_repository, select_database
from app.simulation import across, areas, gridlens_store, compare, data, grids, inventory, maps, settings, states, timepoint
from app.simulation.store import ScenarioStore, catalog_signature, now

router = APIRouter(prefix="/api/simulation", tags=["PowerFactory scenarios"])


class DatabaseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=4096)


@router.get("/database")
def database():
    return {"path": settings.ANALYSIS_DB_PATH}


@router.post("/database")
def change_database(body: DatabaseRequest):
    if not settings.ALLOW_DB_SWITCH:
        raise HTTPException(403, "Switching the database is disabled in this mode.")
    try:
        return {"path": select_database(body.path.strip())}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    directory: str = Field(min_length=1, max_length=4096)
    analysis: str | None = Field(None, max_length=200)
    context: dict = Field(default_factory=dict)


class ImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    archive: str = Field(min_length=1, max_length=4096)
    database: str = Field(min_length=1, max_length=4096)


def archive_access():
    if not settings.ALLOW_DB_SWITCH:
        raise HTTPException(403, "Local archive access is disabled in this mode.")


@router.post("/archives/export")
def export_archive(body: ExportRequest):
    from pathlib import Path
    from app.archive.parquet import export_analysis, ArchiveError
    archive_access()
    if not Path(body.directory).expanduser().is_absolute():
        raise HTTPException(422, "Use an absolute archive directory path.")
    if len(json.dumps(body.context)) > 1_000_000:
        raise HTTPException(422, "Saved view context is too large.")
    try:
        connection = ScenarioStore(settings.ANALYSIS_DB_PATH)
        try:
            chosen = across.resolve_analysis(connection.db, body.analysis)
        finally:
            connection.close()
        path = export_analysis(settings.ANALYSIS_DB_PATH, chosen, Path(body.directory).expanduser(), context=body.context)
        return {"path": str(path), "analysis_id": chosen}
    except (ArchiveError, OSError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/archives/import")
def import_archive(body: ImportRequest):
    from app.archive.parquet import import_analysis, ArchiveError
    archive_access()
    try:
        # Reuse normal database selection after a complete, atomic restore.
        result = import_analysis(body.archive, body.database)
        select_database(result["path"])
        return result
    except (ArchiveError, OSError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


def store():
    connection = ScenarioStore(settings.ANALYSIS_DB_PATH)
    try:
        yield connection
    finally:
        connection.close()


@router.get("/database/contents")
def database_contents(db=Depends(store)):
    """Contents of the open database: analysis/case/result metadata, without loading measurement values."""
    return inventory.contents(db)


@router.get("/states")
def state_catalogue():
    """Every result state the API reports, with its meaning (versioned)."""
    return states.catalogue()


@router.get("/capabilities")
def capabilities():
    return {
        "mode": settings.ANALYSIS_MODE,
        "powerfactory_bridge": settings.ANALYSIS_MODE == "sqlite",
        "database_switch": settings.ALLOW_DB_SWITCH,
        "gridlens_raw_results": True,
        "parquet_archive": importlib.util.find_spec("pyarrow") is not None,
    }


@router.get("/outage-management")
def overview(request: Request, analysis: str | None = Query(None, max_length=200), db=Depends(store)):
    result = db.overview()
    # The scenarios of one analysis (default: the newest), as everywhere else in the dashboard.
    chosen = across.resolve_analysis(db.db, analysis)
    owner = None if chosen == across.UNASSIGNED else chosen
    result["scenarios"] = [s for s in result["scenarios"] if s.get("analysis_id") == owner]
    result["analysis"] = chosen
    if result["catalog"]:
        result["catalog"]["signature"] = catalog_signature(result["catalog"])
    response = JSONResponse({
        **result,
        "database_path": settings.ANALYSIS_DB_PATH,
        "mode": settings.ANALYSIS_MODE,
    })
    # The dashboard asks every few seconds; mostly nothing changed. With the tag the browser asks "still this one?"
    # and gets an empty 304 instead of the whole overview again (no-cache: it must ask every time).
    tag = 'W/"' + hashlib.sha256(response.body).hexdigest()[:24] + '"'
    headers = {"ETag": tag, "Cache-Control": "no-cache"}
    if tag in (t.strip() for t in request.headers.get("if-none-match", "").split(",")):
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)
    return response


@router.get("/analyses")
def analysis_list(db=Depends(store)):
    """Every analysis (import of one PowerFactory run) of the file, newest first, and the one shown by default."""
    return {"analyses": across.analyses(db.db), "default": across.default_analysis(db.db)}


@router.get("/across-scenarios/index")
def across_index(analysis: str | None = Query(None, max_length=200), db=Depends(store)):
    """Scenarios and what they switch off; reads no samples, so it answers at once on any database size."""
    return across.scenario_index(db, analysis)


class Relevance(BaseModel):
    """The thresholds of the dashboard's evaluation; above FULL_LIST_LIMIT elements only what they make relevant is sent."""
    warning: float = 80.0
    band_lower: float = 0.9
    band_upper: float = 1.1
    margin: float = 0.02

    def apply(self, cells):
        return across.relevant_cells(cells, self.warning, (self.band_lower, self.band_upper), self.margin)


@router.get("/across-scenarios/cells")
def across_cells_batch(
    ids: list[str] = Query(..., min_length=1, max_length=50),
    over: list[float] = Query(list(across.DEFAULT_LIMITS), min_length=1, max_length=5),
    relevance: Relevance = Depends(),
    db=Depends(store),
):
    """Reduced values of several scenarios in one answer; null for a scenario that does not exist (any more).

    The dashboard loads the scenarios in a few growing groups instead of one request each: fewer round trips, and each
    group arrives in one piece, so the summary is evaluated a few times instead of once per scenario.
    """
    return JSONResponse({"cells": {i: relevance.apply(across.scenario_cells(db, i, tuple(over))) for i in dict.fromkeys(ids)}})


@router.get("/across-scenarios/{scenario_id}/cells")
def across_cells(
    scenario_id: str,
    over: list[float] = Query(list(across.DEFAULT_LIMITS), min_length=1, max_length=5),
    relevance: Relevance = Depends(),
    db=Depends(store),
):
    """Reduced values of one scenario, loaded on demand and cached."""
    result = relevance.apply(across.scenario_cells(db, scenario_id, tuple(over)))
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    # Sent as it is: the dashboard asks for every scenario on each visit, and FastAPI would first walk every element
    # once more (several ms per scenario, more than reading it).
    return JSONResponse(result)


@router.get("/across-scenarios")
def across_scenarios(
    over: list[float] = Query(list(across.DEFAULT_LIMITS), min_length=1, max_length=5),
    analysis: str | None = Query(None, max_length=200),
    db=Depends(store),
):
    return across.across_scenarios(db, tuple(over), analysis)


@router.get("/across-scenarios/{scenario_id}/profile")
def scenario_profile(
    scenario_id: str,
    top: int = Query(5, ge=1, le=10),
    points: int = Query(240, ge=20, le=1000),
    grid: str | None = Query(None, max_length=500),
    kv: float | None = None,
    db=Depends(store),
):
    result = across.scenario_profile(db, scenario_id, top, points, grid, kv)
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return JSONResponse(result)


@router.get("/voltage-levels")
def voltage_levels(analysis: str | None = Query(None, max_length=200), db=Depends(store)):
    """Nominal voltages of the elements of one analysis (default: the newest), with their element count."""
    chosen = across.resolve_analysis(db.db, analysis)
    return timepoint.voltage_levels(db.db, chosen) if chosen and chosen != across.UNASSIGNED else []


@router.get("/maps")
def network_maps():
    """The network maps (SVG exported from Figma) in the folder `maps` next to the results database."""
    return {"folder": str(maps.folder()), "maps": maps.available()}


@router.get("/maps/{name}.svg")
def network_map(name: str):
    """One map as stored. Sent with a policy that forbids scripts, so the file cannot run code when opened."""
    try:
        svg = maps.read(name)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    if svg is None:
        raise HTTPException(404, "Map not found.")
    return Response(svg, media_type="image/svg+xml", headers={
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"})


@router.get("/maps/{name}/match")
def network_map_match(name: str, analysis: str | None = Query(None, max_length=200), db=Depends(store)):
    """Which map layer shows which element of the analysis (default: the newest), and what is left over."""
    try:
        result = maps.match(db.db, name, analysis)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    if result is None:
        raise HTTPException(404, "Map not found.")
    return JSONResponse(result)  # sent as built: 20,000 layers would otherwise be walked once more


@router.get("/maps/{name}/values")
def network_map_values(name: str, scenario: str = Query(..., max_length=200), t: int = Query(...), db=Depends(store)):
    """The numbers of every map element at time t (compact columns in the order of the match's `elements`)."""
    try:
        result = maps.values(db, name, scenario, t)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    if result is None:
        raise HTTPException(404, "Map or scenario not found.")
    return JSONResponse(result)


@router.get("/compare/analyses")
def compare_analyses(a: str = Query(..., max_length=200), b: str = Query(..., max_length=200), db=Depends(store)):
    """Analysis A against B: what makes them comparable (project, study case, engine, period, settings, elements)
    and their scenarios paired by switched-off equipment with the peak values of both."""
    result = compare.compare_analyses(db, a, b)
    if result is None:
        raise HTTPException(404, "Analysis not found.")
    return JSONResponse(result)


@router.get("/compare/scenarios")
def compare_scenarios(
    a: str = Query(..., max_length=200),
    b: str = Query(..., max_length=200),
    metric: str = Query("loading", pattern="^(loading|voltage)$"),
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    grid: str | None = Query(None, max_length=200),
    q: str | None = Query(None, max_length=200),
    kv: float | None = None,
    db=Depends(store),
):
    """Scenario A against B (also from different analyses): every element with its value in both and the change
    B - A, largest change first, paged; with the checks that tell how comparable the two are."""
    result = compare.compare_scenarios(db, a, b, metric, limit, offset, grid, q, kv)
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return JSONResponse(result)


@router.get("/scenarios/{scenario_id}/times")
def scenario_times(scenario_id: str, top: int = Query(10, ge=1, le=100), points: int = Query(2000, ge=10, le=50000),
                   start: int | None = Query(None, description="Range start, epoch seconds (inclusive)"),
                   end: int | None = Query(None, description="Range end, epoch seconds (inclusive)"),
                   db=Depends(store)):
    """Per time the extremes and violation counts of REF and the scenario (reduced to `points` worst-per-interval
    values when longer), and its most critical times at full resolution; `start`/`end` cut it to a time range."""
    if start is not None and end is not None and end < start:
        raise HTTPException(422, "The range ends before it starts.")
    result = timepoint.scenario_times(db, scenario_id, top, points, start, end)
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return JSONResponse(result)


@router.get("/scenarios/{scenario_id}/areas")
def scenario_areas(scenario_id: str,
                   start: int | None = Query(None, description="Range start, epoch seconds (inclusive)"),
                   end: int | None = Query(None, description="Range end, epoch seconds (inclusive)"),
                   points: int = Query(1500, ge=10, le=20000), db=Depends(store)):
    """Load, generation, net, flows between areas and transit per area of the scenario and its REF; with
    `capability` saying what the recorded variables allow and which are missing."""
    if start is not None and end is not None and end < start:
        raise HTTPException(422, "The range ends before it starts.")
    result = areas.area_view(db, scenario_id, start, end, points)
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return JSONResponse(result)


@router.get("/scenarios/{scenario_id}/n1-pairs")
def scenario_n1_pairs(scenario_id: str,
                      kind: str = Query("(n-1)'", pattern="^(n-1|\\(n-1\\)')$"),
                      start: int | None = Query(None, description="Range start, epoch seconds (inclusive)"),
                      end: int | None = Query(None, description="Range end, epoch seconds (inclusive)"),
                      limit: int = Query(100, ge=1, le=100_000),
                      grid: str | None = Query(None, max_length=200), kv: float | None = None,
                      equipment: str = Query('all', pattern='^(all|line|transformer)$'),
                      element_ids: str | None = Query(None, max_length=20_000), db=Depends(store)):
    """Which contingency overloads which branch: per pair the loading before and after the contingency and the
    hours above the limit, worst first. kind "(n-1)'" with the scenario's planned outages, "n-1" without; grid and
    kv keep the pairs whose overloaded branch lies there."""
    if start is not None and end is not None and end < start:
        raise HTTPException(422, "The range ends before it starts.")
    chosen = [item for item in (element_ids or '').split(',') if item]
    result = gridlens_store.n1_pairs(db.db, scenario_id, kind, start, end, limit, grid, kv, equipment, chosen)
    if result is None:
        raise HTTPException(404, "The scenario has no such n-1 sweep.")
    return JSONResponse(result)


@router.get("/scenarios/{scenario_id}/snapshot")
def scenario_snapshot(
    scenario_id: str,
    t: int,
    metric: str = Query("loading", pattern="^(loading|voltage)$"),
    limit: int = Query(50, ge=1, le=100_000),  # a network map asks for every element at once
    offset: int = Query(0, ge=0),
    grid: str | None = Query(None, max_length=200),
    kv: float | None = None,
    db=Depends(store),
):
    """Every element of the scenario at one time against REF, most critical first, in pages."""
    result = timepoint.snapshot(db, scenario_id, t, metric, limit, offset, grid, kv)
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return JSONResponse(result)


@router.get("/scenarios/{scenario_id}/restore-package")
def restore_package(scenario_id: str, t: int | None = None, db=Depends(store)):
    """What PowerFactory needs to rebuild the scenario (optionally one time of it), with its limitations."""
    result = timepoint.restore_package(db, scenario_id, t)
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return result


@router.get("/assets/{element_id}")
def asset(element_id: str, analysis: str | None = Query(None, max_length=200), db=Depends(store)):
    """One element across the scenarios of an analysis: master data, key figures, n-1 per case."""
    result = timepoint.asset(db, element_id, analysis)
    if result is None:
        raise HTTPException(404, "Element not found in this analysis.")
    return JSONResponse(result)


@router.get("/grids")
def grid_list(db=Depends(store)):
    """Grids (ElmNet) of the stored elements, for the grid filter; "" collects elements without a grid."""
    return grids.grids(db.db, db.path)


@router.get("/facilities")
def scenarios(analysis: str | None = Query(None, max_length=200), repo=Depends(get_repository)):
    offered = across.current_run_ids(repo.db, analysis)
    return [
        {"id": r["id"], "name": r["name"] + ("" if r["status"] == "completed" else " (" + r["status"].replace("_", " ") + ")"),
         "project": r["project"]}
        for r in repo.runs()
        if offered is None or r["id"] in offered
    ]


@router.get("/facilities/{run_id}/components")
def elements(
    run_id: str,
    q: str | None = Query(None, max_length=200),
    grid: str | None = Query(None, max_length=200),
    kv: float | None = None,
    limit: int | None = Query(None, ge=1, le=5000),
    repo=Depends(get_repository),
):
    """The elements of one run, optionally filtered by name or class (`q`), grid and nominal voltage, at most `limit`.

    X-Total-Count gives the number of matches, so a client can tell a complete list from one page of a large one.
    """
    repo.run(run_id)  # an unknown run is a 404, as before
    owner = repo.tuples("SELECT assessment_id FROM gl_results WHERE analysis_run_id = ? LIMIT 1", (run_id,))
    conditions, params = ["e.run_id = ?"], [run_id]
    if q:
        conditions.append("(e.name LIKE ? ESCAPE '\\' OR e.className LIKE ? ESCAPE '\\')")
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        params += [pattern, pattern]
    if grid is not None:
        conditions.append(
            "instr(e.path, '\\' || ? || '.ElmNet\\') > 0" if grid else "instr(e.path, '.ElmNet') = 0")
        if grid:
            params.append(grid)
    if kv is not None:
        conditions.append("g.nominal_kv = ?")
        params.append(kv)
    source = (
        # The analysis is looked up once (a reused case repeats the gl_results row of its run).
        "FROM analysis_elements e LEFT JOIN gl_elements g ON g.assessment_id = ? AND g.element_id = e.id WHERE "
        + " AND ".join(conditions)
    )
    params = [owner[0][0] if owner else None] + params
    total = repo.tuples("SELECT COUNT(*) " + source, params)[0][0]
    rows = repo.tuples("SELECT e.id, e.name, e.className, e.path, g.nominal_kv " + source + " ORDER BY e.name, e.id"
                       + (" LIMIT ?" if limit else ""), params + ([limit] if limit else []))
    return JSONResponse([
        {
            "id": data.component_id(run_id, element_id),
            "facility_id": run_id,
            "name": name,
            "class_name": class_name,
            "grid": grids.grid_name(path),
            "nominal_kv": nominal_kv,
        }
        for element_id, name, class_name, path, nominal_kv in rows
    ], headers={"X-Total-Count": str(total)})


@router.get("/components/{identifier}/measurement-types")
def measurements(identifier: str, repo=Depends(get_repository)):
    run_id, element = data.resolve(repo, identifier)
    rows = repo._all(
        "SELECT m.id,m.unit FROM analysis_metrics m JOIN analysis_series se ON se.run_id=m.run_id AND se.metric_id=m.id WHERE m.run_id=? AND se.element_id=?",
        (run_id, element["id"]),
    )
    return [
        {"type": data.METRIC_CODES.get(r["id"], r["id"]), "unit": r["unit"]}
        for r in rows
    ]


@router.get("/timeseries/aggregate/resolutions")
def resolutions():
    return [
        {"seconds": s, "label": label}
        for s, label in [
            (0, "Original resolution"),
            (900, "15 minutes"),
            (3600, "Hourly"),
            (86400, "Daily"),
        ]
    ]


@router.get("/timeseries/raw/{identifier}/{code}")
def raw(
    identifier: str,
    code: str,
    start: str | None = None,
    end: str | None = None,
    limit: int = Query(50000, ge=1, le=50000),
    cursor: str | None = None,
    repo=Depends(get_repository),
):
    # Large answers (a year of 15-minute values): sent as they are, FastAPI would first walk every point once more.
    return JSONResponse(data.timeseries(
        repo, identifier, code, start, end, limit=limit, cursor=cursor
    ))


@router.get("/timeseries/aggregate/{identifier}/{code}")
def aggregate(
    identifier: str,
    code: str,
    start: str | None = None,
    end: str | None = None,
    bucket: int = Query(..., ge=1),
    aggregation_method: str = "MINMAX",
    repo=Depends(get_repository),
):
    return JSONResponse(data.timeseries(
        repo, identifier, code, start, end, bucket, aggregation_method
    ))


@router.get("/analytics/{identifier}/{code}/{kind}")
def metric_analysis(
    identifier: str,
    code: str,
    kind: str,
    start: str | None = None,
    end: str | None = None,
    group_by: str = "hour",
    threshold: float = Query(100, allow_inf_nan=False),
    repo=Depends(get_repository),
):
    # Large answers (a year of 15-minute values): sent as they are, FastAPI would first walk every point once more.
    return JSONResponse(data.metric_analytics(
        repo, identifier, code, kind, start, end, group_by, threshold
    ))


@router.get("/analytics/{identifier}/{kind}")
def component_analysis(
    identifier: str,
    kind: str,
    start: str | None = None,
    end: str | None = None,
    types: str | None = None,
    repo=Depends(get_repository),
):
    # Large answers (a year of 15-minute values): sent as they are, FastAPI would first walk every point once more.
    return JSONResponse(data.component_analytics(
        repo, identifier, kind, start, end, types
    ))
