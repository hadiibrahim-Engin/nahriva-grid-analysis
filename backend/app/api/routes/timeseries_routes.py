"""Timeseries endpoints.

Two clearly separated contracts:

* ``/api/timeseries/raw/...``       — native resolution, never aggregated.
* ``/api/timeseries/aggregate/...`` — explicit user-requested aggregation.

The pre-split endpoint ``/api/timeseries/{id}/{mtype}`` is kept as a
**deprecated** alias that delegates to the raw path (it no longer performs
the old adaptive downsampling).
"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response

from app.api.dependencies import get_timeseries_service
from app.auth.auth import get_current_user
from app.core.constants import (
    ALLOWED_AGGREGATION_BUCKETS,
    ONE_HOUR_SECONDS,
    RAW_PAGE_LIMIT_DEFAULT,
    RAW_PAGE_LIMIT_MAX,
)
from app.models.models import User
from app.models.schemas import (
    AggregatedTimeseriesResponse,
    AggregationResolutionResponse,
    AggregationMethod,
    DateRangeResponse,
    ErrorResponse,
    PointCountResponse,
    RawTimeseriesResponse,
    StatisticsResponse,
)
from app.services.timeseries_service import TimeseriesService

# Reusable error responses so Swagger documents the full contract.
_ERROR_RESPONSES = {
    401: {"model": ErrorResponse, "description": "Nicht authentifiziert"},
    404: {"model": ErrorResponse, "description": "Keine Daten (NO_DATA)"},
    422: {"model": ErrorResponse, "description": "Ungültiger Zeitraum / Bereich zu groß"},
    504: {"model": ErrorResponse, "description": "Oracle Zeitlimit (DB_TIMEOUT)"},
}

raw_router = APIRouter(prefix="/api/timeseries/raw", tags=["Measurements - Raw"])
agg_router = APIRouter(prefix="/api/timeseries/aggregate", tags=["Measurements - Aggregated"])
router = APIRouter(prefix="/api/timeseries", tags=["Measurements - Raw"])


# Aggregation intervals offered to the dashboard (for /aggregate).
_SUPPORTED_RESOLUTIONS = [
    {"seconds": b, "label": label}
    for b, label in sorted(
        {
            900: "15 Minuten",
            3600: "1 Stunde",
            14400: "4 Stunden",
            86400: "1 Tag",
        }.items()
    )
    if b in ALLOWED_AGGREGATION_BUCKETS
]


# =====================================================================
# Raw — native resolution, never downsampled
# =====================================================================

@raw_router.get(
    "/{component_id}/{measurement_type}",
    response_model=RawTimeseriesResponse,
    responses=_ERROR_RESPONSES,
    summary="Rohdaten in nativer Auflösung",
    description=(
        "Liefert Messwerte in nativer Auflösung (15 Minuten). "
        "**Aggregiert oder verdichtet niemals.** Zu große, unpaginierte "
        "Zeiträume werden mit `422 RAW_RANGE_TOO_LARGE` abgelehnt — dann "
        "seitenweise laden (`limit`/`cursor`), exportieren oder bewusst "
        "`/aggregate` verwenden. `meta.is_raw=true`, `meta.downsampled=false`."
    ),
)
def get_raw(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: datetime = Query(..., examples={"1d": {"value": "2025-05-01T00:00:00"}}),
    end: datetime = Query(..., examples={"1d": {"value": "2025-05-02T00:00:00"}}),
    limit: int = Query(
        RAW_PAGE_LIMIT_DEFAULT,
        gt=0,
        le=RAW_PAGE_LIMIT_MAX,
        description="Maximum native rows to return. Use with `next_cursor` for paging.",
    ),
    cursor: Optional[str] = Query(
        None, description="LOKALZEIT der letzten Zeile der vorherigen Seite"
    ),
    service: TimeseriesService = Depends(get_timeseries_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_raw(
        component_id=component_id,
        measurement_type=measurement_type,
        start=start,
        end=end,
        limit=limit,
        cursor=cursor,
    )


# =====================================================================
# Aggregated — explicit bucket + method
# =====================================================================

@agg_router.get(
    "/{component_id}/{measurement_type}",
    response_model=AggregatedTimeseriesResponse,
    responses=_ERROR_RESPONSES,
    summary="Aggregierte Messwerte (explizit angefordert)",
    description=(
        "Aggregiert Messwerte über ein **explizit** angegebenes Intervall "
        "(`bucket` in Sekunden) mit der gewählten Methode (`AVG/MIN/MAX/SUM`). "
        "Nur verwenden, wenn die Nutzer:in Aggregation bewusst auswählt. "
        "`meta.is_raw=false`, `meta.downsampled=true`, `bucket_seconds` und "
        "`aggregation_method` sind stets gesetzt."
    ),
)
def get_aggregated(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: datetime = Query(..., examples={"30d": {"value": "2026-06-01T00:00:00"}}),
    end: datetime = Query(..., examples={"30d": {"value": "2026-07-01T00:00:00"}}),
    bucket: int = Query(
        ONE_HOUR_SECONDS,
        gt=0,
        description="Bucket-Größe in Sekunden. Erlaubte Werte siehe `/api/timeseries/aggregate/resolutions`.",
        examples={"hour": {"value": 3600}, "day": {"value": 86400}},
    ),
    aggregation_method: AggregationMethod = Query(
        AggregationMethod.AVG,
        description="Aggregation applied to all native samples in each bucket.",
    ),
    service: TimeseriesService = Depends(get_timeseries_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_aggregated(
        component_id=component_id,
        measurement_type=measurement_type,
        start=start,
        end=end,
        bucket_seconds=bucket,
        aggregation_method=aggregation_method,
    )


@agg_router.get(
    "/resolutions",
    response_model=list[AggregationResolutionResponse],
    responses={401: {"model": ErrorResponse, "description": "Nicht authentifiziert"}},
    summary="Verfügbare Aggregations-Intervalle",
    description="UI-Hilfsendpoint für alle erlaubten `bucket`-Werte des aggregierten Pfads.",
)
def get_resolutions(_current_user: User = Depends(get_current_user)):
    return _SUPPORTED_RESOLUTIONS


# =====================================================================
# Shared metadata endpoints
# =====================================================================

@router.get(
    "/{component_id}/{measurement_type}/range",
    response_model=DateRangeResponse,
    responses=_ERROR_RESPONSES,
    summary="Datenbereich einer Zeitreihe",
    description=(
        "Gibt das früheste und späteste Datum zurück, für das Messwerte für "
        "das Betriebsmittel vorhanden sind. `measurement_type` bleibt im Pfad "
        "für Frontend-Kompatibilität, der Bereich ist aktuell komponentenweit."
    ),
)
def get_date_range(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    service: TimeseriesService = Depends(get_timeseries_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_date_range(component_id)


@router.get(
    "/{component_id}/{measurement_type}/count",
    response_model=PointCountResponse,
    responses=_ERROR_RESPONSES,
    summary="Messpunkte zählen",
    description="Zählt native Messpunkte für eine Komponente/Messgröße in einem optionalen Zeitfenster.",
)
def get_point_count(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: Optional[datetime] = Query(None, examples={"start": {"value": "2026-06-01T00:00:00"}}),
    end: Optional[datetime] = Query(None, examples={"end": {"value": "2026-07-01T00:00:00"}}),
    service: TimeseriesService = Depends(get_timeseries_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_point_count(component_id, measurement_type, start, end)


@router.get(
    "/{component_id}/{measurement_type}/stats",
    response_model=StatisticsResponse,
    responses=_ERROR_RESPONSES,
    summary="Statistik einer Zeitreihe",
    description="Berechnet count/mean/min/max/std_dev für eine Messgröße im optionalen Zeitfenster.",
)
def get_statistics(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: Optional[datetime] = Query(None, examples={"start": {"value": "2026-06-01T00:00:00"}}),
    end: Optional[datetime] = Query(None, examples={"end": {"value": "2026-07-01T00:00:00"}}),
    service: TimeseriesService = Depends(get_timeseries_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_statistics(component_id, measurement_type, start, end)


# =====================================================================
# Deprecated legacy alias — delegates to raw (no silent downsampling)
# =====================================================================

@router.get(
    "/{component_id}/{measurement_type}",
    response_model=RawTimeseriesResponse,
    responses=_ERROR_RESPONSES,
    deprecated=True,
    summary="[Veraltet] -> /api/timeseries/raw/...",
    description=(
        "Veraltet. Leitet auf den Rohdaten-Pfad um und verdichtet **nicht** "
        "mehr automatisch. Bitte auf `/api/timeseries/raw/...` bzw. "
        "`/api/timeseries/aggregate/...` migrieren."
    ),
)
def get_timeseries_legacy(
    response: Response,
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: datetime = Query(..., examples={"start": {"value": "2026-06-01T00:00:00"}}),
    end: datetime = Query(..., examples={"end": {"value": "2026-07-01T00:00:00"}}),
    limit: int = Query(RAW_PAGE_LIMIT_DEFAULT, gt=0, le=RAW_PAGE_LIMIT_MAX),
    cursor: Optional[str] = Query(None, description="LOKALZEIT der letzten Zeile der vorherigen Seite"),
    service: TimeseriesService = Depends(get_timeseries_service),
    _current_user: User = Depends(get_current_user),
):
    response.headers["Deprecation"] = "true"
    response.headers["Link"] = (
        f'</api/timeseries/raw/{component_id}/{measurement_type}>; rel="successor-version"'
    )
    return service.get_raw(
        component_id=component_id,
        measurement_type=measurement_type,
        start=start,
        end=end,
        limit=limit,
        cursor=cursor,
    )
