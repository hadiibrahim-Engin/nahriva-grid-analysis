import os
from pathlib import Path

from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.auth.auth import get_current_user
from app.api.routes.auth_routes import router as auth_router
from app.api.routes.component_routes import router as component_router
from app.api.routes.timeseries_routes import (
    agg_router as timeseries_agg_router,
    raw_router as timeseries_raw_router,
    router as timeseries_router,
)
from app.api.routes.analytics_routes import router as analytics_router
from app.api.routes.export_routes import router as export_router
from app.api.routes.metrics_routes import router as metrics_router
from app.analysis.routes import router as analysis_router
from app.analysis.bootstrap import initialize_analysis
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    initialize_analysis()
    yield

from app.config import CORS_ORIGINS, ConfigError, ENABLE_HSTS
from app.core.errors import DashboardError
from app.core.logging import configure_logging, request_id_var
from app.core.middleware import (
    ApiRateLimitMiddleware,
    RequestIdMiddleware,
    SecurityHeadersMiddleware,
)

configure_logging(os.getenv("LOG_LEVEL", "INFO"))

_TAGS_METADATA = [
    {"name": "Health", "description": "Liveness/Readiness-Probes."},
    {"name": "Authentication", "description": "Login und JWT-Ausgabe."},
    {
        "name": "Components",
        "description": (
            "FDWH-Stammdaten für den Dashboard-Query-Flow: "
            "`/facilities` -> `/facilities/{facility_id}/components` -> "
            "`/components/{component_id}/measurement-types`."
        ),
    },
    {
        "name": "Measurements - Raw",
        "description": (
            "Messwerte in nativer Auflösung (15 Minuten). Aggregiert oder "
            "verdichtet **niemals**. Zu große, unpaginierte Zeiträume werden "
            "transparent mit `422 RAW_RANGE_TOO_LARGE` abgelehnt — dann "
            "seitenweise laden (`limit`/`cursor`) oder exportieren."
        ),
    },
    {
        "name": "Measurements - Aggregated",
        "description": (
            "Vom Nutzer **explizit** angeforderte Aggregation. Benötigt einen "
            "`bucket` (Sekunden); `aggregation_method` ist `AVG/MIN/MAX/SUM`. "
            "Antwort-Metadaten machen den Modus stets eindeutig."
        ),
    },
    {
        "name": "Analytics",
        "description": (
            "Abgeleitete Auswertungen für Diagramme wie Heatmap, Dauerlinie, "
            "Korrelation, Power Factor, Qualität und Schwellwertanalyse. "
            "Diese Endpunkte sind für Dashboard-Queries gedacht und cachen "
            "historische Fenster kurzzeitig."
        ),
    },
    {"name": "Export", "description": "Excel/PDF-Export."},
    {"name": "System Analytics", "description": "System- und Performance-Metriken (für alle angemeldeten Nutzer)."},
]

_app_kwargs = {
    "title": "Nahriva Grid Analysis API",
    "description": (
        "API für elektrische Betriebsmittel-Überwachung.\n\n"
        "## Dashboard query flow\n\n"
        "1. `POST /api/auth/login` ausführen und den Bearer Token oben über "
        "**Authorize** setzen.\n"
        "2. Anlagen laden: `GET /api/facilities`.\n"
        "3. Betriebsmittel wählen: `GET /api/facilities/{facility_id}/components`.\n"
        "4. Messgrößen prüfen: `GET /api/components/{component_id}/measurement-types`.\n"
        "5. Rohdaten nativ und paginiert über `/api/timeseries/raw/...` laden "
        "oder bewusst aggregierte Daten über `/api/timeseries/aggregate/...` "
        "abfragen.\n"
        "6. Zusatzdiagramme über `/api/analytics/...` berechnen.\n\n"
        "**Rohdaten** (`/api/timeseries/raw/...`) sind native 15-Minuten-Messwerte "
        "und werden nie verdichtet. **Aggregierte Daten** "
        "(`/api/timeseries/aggregate/...`) erfordern eine bewusste Intervall- und "
        "Methodenwahl. Jede Antwort trägt `meta` mit `is_raw`/`downsampled`.\n\n"
        "Zeitfenster werden als ISO-8601 Datetime übergeben, z. B. "
        "`2026-06-01T00:00:00`."
    ),
    "version": "1.0.0",
    "openapi_tags": _TAGS_METADATA,
    # Default docs/redoc routes load their JS/CSS from a CDN, which breaks on
    # a network with no outbound internet access. Custom routes below serve
    # vendored copies instead (see app/main.py DOCS_ASSETS).
    "docs_url": None,
    "redoc_url": None,
}

app = FastAPI(**_app_kwargs, lifespan=lifespan)
app.include_router(analysis_router)

# Vendored Swagger UI / ReDoc assets (see backend/web/README.md) so /docs and
# /redoc render without depending on a CDN. Falls back to the CDN if the
# fetch step hasn't been run (e.g. a fresh clone) so docs still work locally.
DOCS_ASSETS = Path(__file__).resolve().parent.parent / "web" / "docs-assets"
_HAS_LOCAL_DOCS_ASSETS = DOCS_ASSETS.is_dir() and (DOCS_ASSETS / "swagger-ui-bundle.js").is_file()

if _HAS_LOCAL_DOCS_ASSETS:
    app.mount("/docs-assets", StaticFiles(directory=DOCS_ASSETS), name="docs-assets")
    _SWAGGER_JS = "/docs-assets/swagger-ui-bundle.js"
    _SWAGGER_CSS = "/docs-assets/swagger-ui.css"
    _REDOC_JS = "/docs-assets/redoc.standalone.js"
else:
    _SWAGGER_JS = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"
    _SWAGGER_CSS = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"
    _REDOC_JS = "https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"


@app.get("/docs", include_in_schema=False)
def custom_swagger_ui_html() -> HTMLResponse:
    return get_swagger_ui_html(
        openapi_url=app.openapi_url,
        title=f"{app.title} – Swagger UI",
        swagger_js_url=_SWAGGER_JS,
        swagger_css_url=_SWAGGER_CSS,
        swagger_ui_parameters={
            "docExpansion": "list",
            "defaultModelsExpandDepth": 2,
            "defaultModelExpandDepth": 3,
            "displayRequestDuration": True,
            "filter": True,
            "operationsSorter": "alpha",
            "persistAuthorization": True,
            "showExtensions": True,
            "showCommonExtensions": True,
            "tagsSorter": "alpha",
            "tryItOutEnabled": True,
        },
    )


@app.get("/redoc", include_in_schema=False)
def custom_redoc_html() -> HTMLResponse:
    return get_redoc_html(
        openapi_url=app.openapi_url,
        title=f"{app.title} – ReDoc",
        redoc_js_url=_REDOC_JS,
    )


def _error_body(
    error_code: str,
    message: str,
    *,
    details: dict | None = None,
    suggested_action: str | None = None,
) -> dict:
    """Build the consistent ErrorResponse envelope, tagged with request id.

    `detail` is kept as a mirror of `message` so older frontend code that
    reads `detail` keeps working during the migration.
    """
    body = {
        "error_code": error_code,
        "message": message,
        "detail": message,
        "request_id": request_id_var.get(""),
    }
    if details is not None:
        body["details"] = details
    if suggested_action is not None:
        body["suggested_action"] = suggested_action
    return body


@app.exception_handler(ConfigError)
async def config_error_handler(request: Request, exc: ConfigError):
    return JSONResponse(
        status_code=500,
        content=_error_body("CONFIGURATION_ERROR", str(exc)),
    )


@app.exception_handler(DashboardError)
async def dashboard_error_handler(request: Request, exc: DashboardError):
    """Single handler for every domain error.

    Status and code come from the exception class, so adding a new domain
    error never requires touching this function.
    """
    return JSONResponse(
        status_code=exc.http_status,
        content=_error_body(
            exc.error_code,
            exc.message,
            details=exc.details,
            suggested_action=exc.suggested_action,
        ),
    )


try:
    from sqlalchemy.exc import OperationalError as _SAOperationalError
except ImportError:  # pragma: no cover - SQLAlchemy is always present in prod
    _SAOperationalError = None

if _SAOperationalError is not None:
    @app.exception_handler(_SAOperationalError)
    async def db_operational_error_handler(_request: Request, exc):
        # Per-statement call_timeout fires as ORA-03136 / DPY-4011 wrapped in
        # OperationalError. Surface it as a 504 with a German message so the
        # dashboard shows a real error banner instead of a generic 500.
        message = str(exc)
        is_timeout = (
            "DPY-4011" in message
            or "DPI-1067" in message
            or "ORA-03136" in message
            or "timeout" in message.lower()
        )
        if is_timeout:
            return JSONResponse(
                status_code=504,
                content=_error_body(
                    "DB_TIMEOUT",
                    "Abfrage hat das Zeitlimit überschritten.",
                    suggested_action=(
                        "Zeitraum verkleinern, seitenweise laden, oder eine "
                        "Aggregation (/aggregate) wählen."
                    ),
                ),
            )
        return JSONResponse(
            status_code=503,
            content=_error_body(
                "DB_UNAVAILABLE", "Datenbank vorübergehend nicht erreichbar."
            ),
        )


# Request ID + access log first so failures inside other middleware are still tagged.
app.add_middleware(RequestIdMiddleware)
app.add_middleware(SecurityHeadersMiddleware, enable_hsts=ENABLE_HSTS)
app.add_middleware(ApiRateLimitMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1000)

# CORS - only needed when the SPA is served from a different origin than the
# API. In the single-origin deployment (backend serves the built frontend)
# CORS_ORIGINS stays empty and this middleware is skipped entirely.
if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

# Register routes
app.include_router(auth_router)
app.include_router(component_router, dependencies=[Depends(get_current_user)])
# Raw + aggregate routers first so their static subpaths (e.g.
# /aggregate/resolutions) win over the legacy {id}/{mtype} catch-all.
app.include_router(timeseries_raw_router, dependencies=[Depends(get_current_user)])
app.include_router(timeseries_agg_router, dependencies=[Depends(get_current_user)])
app.include_router(timeseries_router, dependencies=[Depends(get_current_user)])
app.include_router(analytics_router, dependencies=[Depends(get_current_user)])
app.include_router(export_router, dependencies=[Depends(get_current_user)])
app.include_router(metrics_router)



@app.get("/api/health", tags=["Health"], summary="Liveness probe")
def health():
    """Liveness probe. Cheap, no I/O."""
    return {"status": "ok"}


@app.get("/api/health/ready", tags=["Health"], summary="Readiness probe")
def health_ready():
    """Readiness probe: pings Oracle and reports pool stats.

    Returns 200 with status=ready when the engine answers SELECT 1 within
    the pool timeout, 503 otherwise. Use this for k8s readinessProbe /
    load-balancer health checks; use /api/health for liveness.
    """
    from app.analysis.bootstrap import get_repository
    try:
        get_repository().runs()
    except Exception:
        return JSONResponse(status_code=503, content={"status": "not_ready"})
    if not os.getenv("DB_NAME") and not os.getenv("DATABASE_URL"):
        return {"status": "ready", "analysis": "ready", "oracle": "not_configured"}
    from sqlalchemy import text
    from app.core.constants import ORACLE_PING_SQL
    from app.db.database import get_engine

    try:
        engine = get_engine()
        with engine.connect() as conn:
            conn.execute(text(ORACLE_PING_SQL))
        pool = engine.pool
        return {
            "status": "ready",
            "pool": {
                "size": pool.size(),
                "checked_in": pool.checkedin(),
                "checked_out": pool.checkedout(),
                "overflow": pool.overflow(),
            },
        }
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "error": "Configured database unavailable"},
        )


# Serve built frontend (always, if dist/ exists).
# FRONTEND_DIST can be overridden via env var so the packaged desktop app
# (PyInstaller) can point at its bundled frontend directory.
_frontend_override = os.getenv("FRONTEND_DIST", "")
FRONTEND_DIST = (
    Path(_frontend_override).resolve()
    if _frontend_override
    else Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
)

class _ImmutableStaticFiles(StaticFiles):
    """Serve Vite's content-hashed assets with a long immutable cache.

    Every file under /assets carries a hash in its name (index-ab12cd.js), so
    its contents never change under a given URL — safe to cache for a year.
    index.html is served separately below and stays no-cache so clients always
    pick up the newest asset references after a deploy.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# index.html must never be cached: it references the current hashed assets, so
# a stale copy would keep loading old (possibly deleted) chunks after a deploy.
_NO_CACHE_HEADERS = {"Cache-Control": "no-cache, no-store, must-revalidate"}


if FRONTEND_DIST.is_dir():
    app.mount("/assets", _ImmutableStaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(request: Request, full_path: str):
        # Never serve index.html for API routes – return proper JSON 404
        if full_path.startswith("api/") or full_path == "api":
            return JSONResponse(
                status_code=404,
                content={"detail": f"API route not found: /{full_path}"},
            )
        file_path = (FRONTEND_DIST / full_path).resolve()
        if not file_path.is_relative_to(FRONTEND_DIST.resolve()):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIST / "index.html", headers=_NO_CACHE_HEADERS)
