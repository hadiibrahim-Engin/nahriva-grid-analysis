import csv
import io
from datetime import datetime
from typing import Annotated
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from app.analysis.bootstrap import get_repository
from app.simulation import settings
from app.analysis.service import analyze
from app.analysis.models import AnalysisResponse, RunSummary, Element, Metric


router = APIRouter(prefix="/api/analysis", tags=["Simulation Analysis"])


@router.get("/capabilities")
def capabilities():
    return {
        "mode": settings.ANALYSIS_MODE,
        "powerfactory_bridge": True,
        "schema_version": 1,
    }


@router.get("/runs", response_model=list[RunSummary])
def runs(repo=Depends(get_repository)):
    return repo.runs()


@router.get(
    "/runs/{run_id}/elements",
    response_model=list[Element],
)
def elements(run_id: str, repo=Depends(get_repository)):
    return repo.elements(run_id)


@router.get(
    "/runs/{run_id}/metrics",
    response_model=list[Metric],
)
def metrics(run_id: str, repo=Depends(get_repository)):
    return repo.metrics(run_id)


def result(
    run_id: str,
    metric_id: str = "loading",
    compare_run_id: str | None = None,
    element_type: str | None = None,
    search: Annotated[str | None, Query(max_length=200)] = None,
    element_ids: Annotated[list[str] | None, Query(max_length=500)] = None,
    start: datetime | None = None,
    end: datetime | None = None,
    repo=Depends(get_repository),
):
    return analyze(
        repo,
        run_id,
        metric_id,
        compare_run_id,
        element_type,
        search,
        element_ids,
        start,
        end,
    )


@router.get("/query", response_model=AnalysisResponse)
def query(data=Depends(result)):
    return data[0]


def safe_csv(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


@router.get("/export.csv")
def export(data=Depends(result)):
    analysis, rows = data
    lookup = {e["id"]: e for e in analysis["elements"]}
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(
        [
            "run_id",
            "project",
            "study_case",
            "timestamp_utc",
            "element_id",
            "name",
            "className",
            "type",
            "path",
            "metric",
            "unit",
            "value",
            "status",
        ]
    )
    for r in rows:
        e = lookup[r["element_id"]]
        writer.writerow(
            [
                safe_csv(v)
                for v in [
                    analysis["run"]["id"],
                    analysis["run"]["project"],
                    analysis["run"]["study_case"],
                    r["timestamp"],
                    e["id"],
                    e["name"],
                    e["className"],
                    e["type"],
                    e["path"],
                    analysis["metric"]["id"],
                    analysis["metric"]["unit"],
                    r["value"],
                    r["status"],
                ]
            ]
        )
    return Response(
        "\ufeff" + stream.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="analysis.csv"'},
    )
