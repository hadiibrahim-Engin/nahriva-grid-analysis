"""Facility and component endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path

from app.api.dependencies import get_component_service
from app.auth.auth import get_current_user
from app.models.models import User
from app.models.schemas import ComponentResponse, ErrorResponse, FacilityResponse, MeasurementTypeResponse
from app.services.component_service import ComponentService

_ERROR_RESPONSES = {
    401: {"model": ErrorResponse, "description": "Nicht authentifiziert"},
    404: {"model": ErrorResponse, "description": "Anlage oder Betriebsmittel nicht gefunden"},
    504: {"model": ErrorResponse, "description": "Oracle Zeitlimit (DB_TIMEOUT)"},
}

router = APIRouter(prefix="/api", tags=["Components"])


@router.get(
    "/facilities",
    response_model=list[FacilityResponse],
    responses=_ERROR_RESPONSES,
    summary="Anlagen auflisten",
    description=(
        "Liest die FDWH-Stammdaten und gibt deduplizierte Anlagen zurück. "
        "Dies ist der erste Schritt im Dashboard-Query-Flow."
    ),
)
def list_facilities(
    service: ComponentService = Depends(get_component_service),
    _current_user: User = Depends(get_current_user),
):
    return service.list_facilities()


@router.get(
    "/facilities/{facility_id}/components",
    response_model=list[ComponentResponse],
    responses=_ERROR_RESPONSES,
    summary="Betriebsmittel einer Anlage auflisten",
    description=(
        "Gibt alle adressierbaren Betriebsmittel/Felder für eine Anlage zurück. "
        "`id` ist der zusammengesetzte Schlüssel `{ANLAGENNUMMER}_{FELDNUMMER}` "
        "und wird für alle Zeitreihen- und Analytics-Abfragen verwendet."
    ),
)
def list_components(
    facility_id: str = Path(..., description="ANLAGENNUMMER, e.g. 10001234"),
    service: ComponentService = Depends(get_component_service),
    _current_user: User = Depends(get_current_user),
):
    return service.list_components_by_facility(facility_id)


@router.get(
    "/components/{component_id}/measurement-types",
    response_model=list[MeasurementTypeResponse],
    responses=_ERROR_RESPONSES,
    summary="Verfügbare Messgrößen auflisten",
    description=(
        "Gibt die Messgrößen zurück, die das Backend aktuell für Zeitreihen- "
        "und Analytics-Abfragen unterstützt. Die Liste ist bewusst klein und "
        "FDWH-kompatibel: P, Q, S, U, I."
    ),
)
def measurement_types(
    component_id: str = Path(..., description="Composite id `{ANLAGENNUMMER}_{FELDNUMMER}`"),
    service: ComponentService = Depends(get_component_service),
    _current_user: User = Depends(get_current_user),
):
    return service.get_available_measurement_types()
