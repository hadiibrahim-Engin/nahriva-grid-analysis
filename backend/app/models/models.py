"""
Lightweight models for FDWH integration.
No ORM tables - all data comes from Oracle FDWH views.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple


# Mapping: App measurement type → FDWH column name, unit
FDWH_MEASUREMENT_MAP: Dict[str, Tuple[str, str]] = {
    "P": ('"MW"', "MW"),
    "Q": ('"BMW"', "Mvar"),
    "S": ('"S"', "MVA"),
    "U": ('"UUW"', "kV"),
    "I": ('TO_NUMBER("STROMWERT")', "A"),
}

FDWH_MEASUREMENT_TYPES: List[str] = list(FDWH_MEASUREMENT_MAP.keys())


def parse_component_id(component_id: str) -> Tuple[str, str]:
    """Parse 'ANLAGENNUMMER_FELDNUMMER' → (anlagennummer, feldnummer)."""
    parts = component_id.split("_", 1)
    if len(parts) != 2:
        raise ValueError(f"Ungültige Komponenten-ID: {component_id}")
    return parts[0], parts[1]


def fdwh_column(measurement_type: str) -> str:
    """Return the FDWH column expression for a measurement type."""
    mt = measurement_type.upper()
    if mt not in FDWH_MEASUREMENT_MAP:
        raise ValueError(f"Unbekannter Messwerttyp: {measurement_type}")
    return FDWH_MEASUREMENT_MAP[mt][0]


def fdwh_unit(measurement_type: str) -> str:
    """Return the unit for a measurement type."""
    mt = measurement_type.upper()
    if mt not in FDWH_MEASUREMENT_MAP:
        return ""
    return FDWH_MEASUREMENT_MAP[mt][1]


@dataclass
class User:
    """Lightweight user object built from JWT token (no DB table)."""
    username: str
    role: str = "viewer"