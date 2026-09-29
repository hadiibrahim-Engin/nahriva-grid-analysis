"""Component/facility use cases."""

from __future__ import annotations

from app.core.cache import cached as _cached
from app.core.errors import ResourceNotFoundError
from app.models.models import FDWH_MEASUREMENT_TYPES, fdwh_unit
from app.models.schemas import ComponentResponse, FacilityResponse
from app.repositories.fdwh_repository import FDWHRepository


class ComponentService:
    def __init__(self, repository: FDWHRepository) -> None:
        self._repository = repository

    @_cached
    def list_facilities(self) -> list[FacilityResponse]:
        # Drop rows with NULL ANLAGENNUMMER and dedupe by id; both can collapse
        # to identical React keys ("00000_None") downstream.
        seen: set[str] = set()
        result: list[FacilityResponse] = []
        for row in self._repository.list_facilities():
            if row[0] is None:
                continue
            facility_id = str(row[0])
            if facility_id in seen:
                continue
            seen.add(facility_id)
            result.append(FacilityResponse(id=facility_id, name=row[1] or facility_id))
        return result

    @_cached
    def list_components_by_facility(self, facility_id: str) -> list[ComponentResponse]:
        rows = self._repository.list_components_by_facility(facility_id)
        if not rows:
            raise ResourceNotFoundError("Anlage nicht gefunden")
        # Skip rows with NULL FELDNUMMER (not addressable in the API path) and
        # dedupe so the frontend never sees colliding component ids.
        seen: set[str] = set()
        result: list[ComponentResponse] = []
        for row in rows:
            if row[0] is None:
                continue
            component_id = f"{facility_id}_{row[0]}"
            if component_id in seen:
                continue
            seen.add(component_id)
            result.append(
                ComponentResponse(
                    id=component_id,
                    facility_id=facility_id,
                    name=row[1] or component_id,
                    spannungsebene=row[2],
                )
            )
        return result

    @_cached
    def list_all_components(self) -> list[ComponentResponse]:
        seen: set[str] = set()
        result: list[ComponentResponse] = []
        for row in self._repository.list_all_components():
            if row[0] is None or row[1] is None:
                continue
            component_id = f"{row[0]}_{row[1]}"
            if component_id in seen:
                continue
            seen.add(component_id)
            result.append(
                ComponentResponse(
                    id=component_id,
                    facility_id=str(row[0]),
                    name=row[2] or component_id,
                    spannungsebene=row[4],
                )
            )
        return result

    def get_available_measurement_types(self) -> list[dict[str, str]]:
        return [
            {"type": measurement_type, "unit": fdwh_unit(measurement_type)}
            for measurement_type in FDWH_MEASUREMENT_TYPES
        ]
