"""Local PowerFactory scenario dashboard; original DashB presentation."""

from contextlib import asynccontextmanager
from pathlib import Path
import uuid
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.gzip import GZipMiddleware
from app.analysis.bootstrap import initialize_analysis, get_repository
from app.analysis.routes import router as analysis_router
from app.simulation.routes import router as simulation_router
from app.simulation.store import ScenarioStore
from app.simulation import settings
from app.core.errors import DashboardError


@asynccontextmanager
async def lifespan(app):
    initialize_analysis()
    if settings.ANALYSIS_MODE == "sqlite":
        store = ScenarioStore(settings.ANALYSIS_DB_PATH)
        store.close()
    yield


app = FastAPI(title="Outage Assessment", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
if settings.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
app.include_router(simulation_router)
app.include_router(analysis_router)


@app.middleware("http")
async def request_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Request-ID"] = uuid.uuid4().hex
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(DashboardError)
async def domain_error(request: Request, exc: DashboardError):
    return JSONResponse(
        status_code=exc.http_status,
        content={
            "detail": exc.message,
            "message": exc.message,
            "error_code": exc.error_code,
            "details": exc.details,
            "suggested_action": exc.suggested_action,
        },
    )


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/health/ready")
def ready():
    get_repository()._all("SELECT 1")
    return {"status": "ready", "analysis": "ready", "mode": settings.ANALYSIS_MODE, "database_path": settings.ANALYSIS_DB_PATH}


DIST = Path(__file__).resolve().parents[2] / "frontend/dist"


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path == "api" or path.startswith("api/"):
        raise HTTPException(404, "API route not found.")
    candidate = (DIST / path).resolve()
    if candidate.is_relative_to(DIST.resolve()) and candidate.is_file():
        return FileResponse(candidate)
    if not path.rsplit("/", 1)[-1].count(".") and (DIST / "index.html").is_file():
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
    raise HTTPException(
        404, "Build frontend with npm run build, or use the development launcher."
    )
