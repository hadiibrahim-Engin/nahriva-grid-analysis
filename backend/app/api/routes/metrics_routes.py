"""System & API performance metrics (System Analytics).

Open to every authenticated user — the dashboard exposes backend health
transparently. The payload contains only aggregate numbers and endpoint
*templates*: never IDs, query strings, tokens, or SQL.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.auth.auth import get_current_user
from app.core.metrics import metrics_collector
from app.models.models import User

router = APIRouter(prefix="/api/metrics", tags=["System Analytics"])


@router.get(
    "/summary",
    summary="System- und API-Performance",
    description=(
        "Aggregierte Backend-Metriken über **alle** Nutzer und Requests im "
        "rollierenden Fenster dieser Instanz: Latenz-Perzentile, Oracle-Zeit, "
        "Fehlerquote, Roh- vs. aggregierte Requests, langsamste Endpunkte, "
        "Cache-Trefferquote und DB-Pool-Auslastung. Für alle angemeldeten "
        "Nutzer sichtbar. Enthält keine IDs, Query-Strings, Tokens oder SQL."
    ),
)
def metrics_summary(_user: User = Depends(get_current_user)):
    return metrics_collector.summary()
