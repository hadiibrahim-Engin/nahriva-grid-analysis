"""Analytics endpoints."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response

from app.api.dependencies import get_analytics_service
from app.auth.auth import get_current_user
from app.core.constants import (
    DEFAULT_EXCEEDANCE_THRESHOLD,
    DEFAULT_EXPECTED_POINTS_PER_DAY,
    DEFAULT_POWER_FACTOR_DOWNSAMPLE_MINUTES,
)
from app.models.models import User
from app.models.schemas import (
    BoxPlotResponse,
    CorrelationMatrixResponse,
    CorrelationScatterResponse,
    DSTResponse,
    DailyProfileResponse,
    DurationCurveResponse,
    ErrorResponse,
    ExceedanceResponse,
    HeatmapResponse,
    PowerFactorResponse,
    QualityResponse,
    SeasonRadarResponse,
    VoltageBandResponse,
)
from app.services.analytics_service import AnalyticsService

_ERROR_RESPONSES = {
    401: {"model": ErrorResponse, "description": "Nicht authentifiziert"},
    404: {"model": ErrorResponse, "description": "Keine Daten (NO_DATA)"},
    422: {"model": ErrorResponse, "description": "Ungültige Parameter"},
    504: {"model": ErrorResponse, "description": "Oracle Zeitlimit (DB_TIMEOUT)"},
}


# Analytics responses are computed from immutable historical data; the
# window parameters are baked into the URL, so caching is safe and reduces
# Oracle load when users switch tabs or revisit a dashboard. 5 minutes is
# a conservative default.
_ANALYTICS_CACHE = "private, max-age=1800"


def _set_analytics_cache(response: Response) -> None:
    """Dependency: attaches the analytics Cache-Control header."""
    response.headers["Cache-Control"] = _ANALYTICS_CACHE


router = APIRouter(prefix="/api/analytics", tags=["Analytics"])


@router.get(
    "/{component_id}/{measurement_type}/heatmap",
    response_model=HeatmapResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Heatmap nach Wochentag und Stunde",
)
def get_heatmap(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: Optional[datetime] = Query(None, examples={"start": {"value": "2026-06-01T00:00:00"}}),
    end: Optional[datetime] = Query(None, examples={"end": {"value": "2026-07-01T00:00:00"}}),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_heatmap(component_id, measurement_type, start, end)


@router.get(
    "/{component_id}/voltage-band",
    response_model=VoltageBandResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Spannungsband für Werktag/Wochenende",
)
def get_voltage_band(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_voltage_band(component_id, start, end)


@router.get(
    "/{component_id}/{measurement_type}/duration-curve",
    response_model=DurationCurveResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Dauerlinie",
)
def get_duration_curve(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_duration_curve(component_id, measurement_type, start, end)


@router.get(
    "/{component_id}/{measurement_type}/daily-profile",
    response_model=DailyProfileResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Tagesprofil für Werktag/Wochenende",
)
def get_daily_profile(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_daily_profile(component_id, measurement_type, start, end)


@router.get(
    "/{component_id}/correlation",
    response_model=CorrelationScatterResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Korrelation zweier Messgrößen",
)
def get_correlation(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    type_x: str = Query("P", description="X-axis measurement type"),
    type_y: str = Query("Q", description="Y-axis measurement type"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    lag_minutes: int = Query(0, ge=-720, le=720),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_correlation(component_id, type_x, type_y, start, end, lag_minutes)


@router.get(
    "/{component_id}/correlation-matrix",
    response_model=CorrelationMatrixResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Korrelationsmatrix mehrerer Messgrößen",
)
def get_correlation_matrix(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    types: str = Query("P,Q,S,U,I", description="Comma-separated measurement types"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_correlation_matrix(component_id, types, start, end)


@router.get(
    "/{component_id}/{measurement_type}/boxplot",
    response_model=BoxPlotResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Boxplot-Verteilung",
)
def get_boxplot(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    group_by: str = Query(
        "hour",
        pattern="^(hour|weekday|month|weekday_weekend)$",
        description="How to bucket the boxplot: hour of day, weekday, month, or weekday-vs-weekend.",
    ),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_boxplot(component_id, measurement_type, start, end, group_by)


@router.get(
    "/{component_id}/power-factor",
    response_model=PowerFactorResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Power-Factor-Zeitreihe und Histogramm",
)
def get_power_factor(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    downsample_minutes: Optional[int] = Query(DEFAULT_POWER_FACTOR_DOWNSAMPLE_MINUTES, gt=0),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_power_factor(component_id, start, end, downsample_minutes)


@router.get(
    "/{component_id}/quality",
    response_model=QualityResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Datenqualitäts-Übersicht",
)
def get_quality_view(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    expected_per_day: int = Query(DEFAULT_EXPECTED_POINTS_PER_DAY, gt=0),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_quality(component_id, start, end, expected_per_day)


@router.get(
    "/{component_id}/dst-events",
    response_model=DSTResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="DST-/Zeitumstellungs-Ereignisse",
)
def get_dst_events(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_dst_events(component_id, start, end)


@router.get(
    "/{component_id}/season-radar",
    response_model=SeasonRadarResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Saison-Radar nach Monat",
)
def get_season_radar(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    types: Optional[str] = Query(None, description="Comma list of measurements to compute, e.g. 'P,Q'."),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_season_radar(component_id, start, end, types)


@router.get(
    "/{component_id}/{measurement_type}/exceedance",
    response_model=ExceedanceResponse,
    responses=_ERROR_RESPONSES,
    dependencies=[Depends(_set_analytics_cache)],
    summary="Schwellwert-Überschreitung",
)
def get_exceedance(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    measurement_type: str = Path(..., description="FDWH measurement type, e.g. P/Q/S/U/I"),
    threshold: float = Query(DEFAULT_EXCEEDANCE_THRESHOLD),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    service: AnalyticsService = Depends(get_analytics_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_exceedance(component_id, measurement_type, threshold, start, end)
