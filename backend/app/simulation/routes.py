import json
import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict
from app.analysis.bootstrap import get_repository, select_database
from app.simulation import across, data, grids, settings
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


def store():
    connection = ScenarioStore(settings.ANALYSIS_DB_PATH)
    try:
        yield connection
    finally:
        connection.close()


@router.get("/capabilities")
def capabilities():
    return {
        "mode": settings.ANALYSIS_MODE,
        "powerfactory_bridge": settings.ANALYSIS_MODE == "sqlite",
        "database_switch": settings.ALLOW_DB_SWITCH,
    }


@router.get("/outage-management")
def overview(db=Depends(store)):
    result = db.overview()
    if result["catalog"]:
        result["catalog"]["signature"] = catalog_signature(result["catalog"])
    return {
        **result,
        "database_path": settings.ANALYSIS_DB_PATH,
        "mode": settings.ANALYSIS_MODE,
    }


@router.get("/across-scenarios/index")
def across_index(db=Depends(store)):
    """Scenarios and what they switch off; reads no samples, so it answers at once on any database size."""
    return across.scenario_index(db)


@router.get("/across-scenarios/{scenario_id}/cells")
def across_cells(
    scenario_id: str,
    over: list[float] = Query(list(across.DEFAULT_LIMITS), min_length=1, max_length=5),
    db=Depends(store),
):
    """Reduced values of one scenario, loaded on demand and cached."""
    result = across.scenario_cells(db, scenario_id, tuple(over))
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return result


@router.get("/across-scenarios")
def across_scenarios(
    over: list[float] = Query(list(across.DEFAULT_LIMITS), min_length=1, max_length=5),
    db=Depends(store),
):
    return across.across_scenarios(db, tuple(over))


@router.get("/across-scenarios/{scenario_id}/profile")
def scenario_profile(
    scenario_id: str,
    top: int = Query(5, ge=1, le=10),
    points: int = Query(240, ge=20, le=1000),
    grid: str | None = Query(None, max_length=500),
    db=Depends(store),
):
    result = across.scenario_profile(db, scenario_id, top, points, grid)
    if result is None:
        raise HTTPException(404, "Scenario not found.")
    return result


@router.get("/grids")
def grid_list(db=Depends(store)):
    """Grids (ElmNet) of the stored elements, for the grid filter; "" collects elements without a grid."""
    return grids.grids(db.db)


@router.get("/facilities")
def scenarios(repo=Depends(get_repository)):
    offered = across.current_run_ids(repo.db)
    return [
        {"id": r["id"], "name": r["name"] + ("" if r["status"] == "completed" else " (" + r["status"].replace("_", " ") + ")"),
         "project": r["project"]}
        for r in repo.runs()
        if offered is None or r["id"] in offered
    ]


@router.get("/facilities/{run_id}/components")
def elements(run_id: str, repo=Depends(get_repository)):
    return [
        {
            "id": data.component_id(run_id, e["id"]),
            "facility_id": run_id,
            "name": e["name"],
            "class_name": e["className"],
            "grid": grids.grid_name(e["path"]),
        }
        for e in repo.elements(run_id)
    ]


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
            (3600, "Hourly mean"),
            (86400, "Daily mean"),
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
    return data.timeseries(
        repo, identifier, code, start, end, limit=limit, cursor=cursor
    )


@router.get("/timeseries/aggregate/{identifier}/{code}")
def aggregate(
    identifier: str,
    code: str,
    start: str | None = None,
    end: str | None = None,
    bucket: int = Query(..., ge=1),
    aggregation_method: str = "AVG",
    repo=Depends(get_repository),
):
    return data.timeseries(
        repo, identifier, code, start, end, bucket, aggregation_method
    )


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
    return data.metric_analytics(
        repo, identifier, code, kind, start, end, group_by, threshold
    )


@router.get("/analytics/{identifier}/{kind}")
def component_analysis(
    identifier: str,
    kind: str,
    start: str | None = None,
    end: str | None = None,
    types: str | None = None,
    repo=Depends(get_repository),
):
    return data.component_analytics(
        repo, identifier, kind, start, end, types
    )
