"""Shared service helpers."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.core.errors import InvalidRequestError
from app.models.models import FDWH_MEASUREMENT_MAP, parse_component_id


def normalize_measurement_type(measurement_type: str) -> str:
    normalized = measurement_type.upper()
    if normalized not in FDWH_MEASUREMENT_MAP:
        raise InvalidRequestError(f"Unsupported measurement type: {measurement_type}")
    return normalized


def split_component_id(component_id: str) -> tuple[str, str]:
    try:
        return parse_component_id(component_id)
    except ValueError as exc:
        raise InvalidRequestError(str(exc)) from exc


def component_window_params(
    component_id: str,
    start: datetime | None,
    end: datetime | None,
) -> dict[str, Any]:
    anr, fnr = split_component_id(component_id)
    return {
        "anr": anr,
        "fnr": fnr,
        "start": start.strftime("%Y-%m-%d %H:%M:%S") if start else None,
        "end": end.strftime("%Y-%m-%d %H:%M:%S") if end else None,
    }