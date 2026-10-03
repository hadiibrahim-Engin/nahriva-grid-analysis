import json
import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict
from app.analysis.bootstrap import get_repository, select_database
from app.simulation import data, settings
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


class ScenarioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    outage_ids: list[str] = Field(min_length=1, max_length=500)
    catalog_signature: str


@router.get("/capabilities")
def capabilities():
    return {
        "mode": settings.ANALYSIS_MODE,
        "powerfactory_bridge": settings.ANALYSIS_MODE == "sqlite",
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


@router.post("/outage-management/sync", status_code=202)
def sync(db=Depends(store)):
    if settings.ANALYSIS_MODE != "sqlite":
        raise HTTPException(409, "PowerFactory-Aufträge benötigen den SQLite-Modus.")
    try:
        return {"id": db.enqueue("sync", {})}
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/scenarios", status_code=202)
def create_scenario(body: ScenarioRequest, db=Depends(store)):
    catalog = db.catalog()
    if settings.ANALYSIS_MODE != "sqlite" or not catalog:
        raise HTTPException(
            409, "Zuerst Planned Outages aus PowerFactory synchronisieren."
        )
    if body.catalog_signature != catalog_signature(catalog):
        raise HTTPException(
            409, "PowerFactory-Auswahl hat sich geändert. Liste neu laden."
        )
    if not body.name.strip() or len(set(body.outage_ids)) != len(body.outage_ids):
        raise HTTPException(
            422, "Szenarioname und eindeutige Ausfallauswahl erforderlich."
        )
    known = {o["id"]: o for o in catalog["outages"]}
    if any(
        identifier not in known or not known[identifier]["in_period"]
        for identifier in body.outage_ids
    ):
        raise HTTPException(
            422,
            "Die Auswahl enthält unbekannte Ausfälle oder Ausfälle außerhalb des Rechenzeitraums.",
        )
    try:
        return {
            "id": db.enqueue(
                "run",
                {
                    "name": body.name.strip(),
                    "outage_ids": body.outage_ids,
                    "catalog_signature": body.catalog_signature,
                },
            )
        }
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/jobs/{job_id}/cancel")
def cancel(job_id: str, db=Depends(store)):
    with db.db:
        changed = db.db.execute(
            "UPDATE pf_jobs SET status='cancelled',finished_at=?,message='Cancelled before calculation.' WHERE id=? AND status='queued'",
            (now(), job_id),
        ).rowcount
    if not changed:
        raise HTTPException(
            409, "Nur wartende Aufträge können hier abgebrochen werden."
        )
    return {"status": "cancelled"}


@router.get("/facilities")
def scenarios(repo=Depends(get_repository)):
    return [
        {"id": r["id"], "name": r["name"], "spannungsebene": r["project"]}
        for r in repo.runs()
        if r["status"] == "completed"
    ]


@router.get("/facilities/{run_id}/components")
def elements(run_id: str, repo=Depends(get_repository)):
    return [
        {
            "id": data.component_id(run_id, e["id"]),
            "facility_id": run_id,
            "name": e["name"],
            "spannungsebene": e["className"],
        }
        for e in repo.elements(run_id)
    ]


@router.get("/components/{identifier}/measurement-types")
def measurements(identifier: str, repo=Depends(get_repository)):
    run_id, element = data.resolve(repo, identifier)
    rows = repo._all(
        "SELECT DISTINCT m.id,m.unit FROM analysis_metrics m JOIN analysis_samples s ON s.run_id=m.run_id AND s.metric_id=m.id WHERE m.run_id=? AND s.element_id=?",
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
            (0, "Originalauflösung"),
            (900, "15 Minuten"),
            (3600, "Stundenmittel"),
            (86400, "Tagesmittel"),
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


@router.get("/timeseries/{identifier}/{code}/range")
def date_range(identifier: str, code: str, repo=Depends(get_repository)):
    _, _, rows = data.dataset(repo, identifier, code)
    return {
        "min_date": rows[0]["timestamp"] if rows else None,
        "max_date": rows[-1]["timestamp"] if rows else None,
    }


@router.get("/timeseries/{identifier}/{code}/stats")
def stats(
    identifier: str,
    code: str,
    start: str | None = None,
    end: str | None = None,
    repo=Depends(get_repository),
):
    return data.metric_analytics(repo, identifier, code, "stats", start, end)


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
    type_x: str = "P",
    type_y: str = "Q",
    lag_minutes: int = Query(0, ge=-720, le=720),
    repo=Depends(get_repository),
):
    return data.component_analytics(
        repo, identifier, kind, start, end, types, type_x, type_y, lag_minutes
    )


class ShareRequest(BaseModel):
    kind: str = Field(pattern="^(live|snapshot)$")
    payload: dict


@router.post("/shares")
def create_share(body: ShareRequest, db=Depends(store)):
    identifier = uuid.uuid4().hex
    encoded = json.dumps(body.payload)
    if len(encoded) > 5_000_000:
        raise HTTPException(413, "Ansicht zu groß.")
    with db.db:
        db.db.execute(
            "INSERT INTO ui_shares VALUES(?,?,?,?)",
            (identifier, body.kind, encoded, now()),
        )
    return {"id": identifier}


@router.get("/shares/{identifier}")
def read_share(identifier: str, db=Depends(store)):
    row = db.db.execute("SELECT * FROM ui_shares WHERE id=?", (identifier,)).fetchone()
    if not row:
        raise HTTPException(404, "Geteilte Ansicht nicht gefunden.")
    return {
        "kind": row["kind"],
        "payload": json.loads(row["payload"]),
        "created_at": datetime.fromisoformat(row["created_at"]).timestamp(),
    }
