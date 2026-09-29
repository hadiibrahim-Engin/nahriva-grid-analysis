"""FastAPI dependency factories.

When DUCKDB_ENABLED is false (the default) every service receives a
plain ``FDWHRepository`` — byte-identical to the Oracle-only baseline.

When DUCKDB_ENABLED is true the dependency layer wraps the Oracle
repository with a ``RoutingRepository`` that decides per call whether
DuckDB can serve the query. Services don't know or care which is in
play; they only see the repository interface.
"""

from __future__ import annotations

import logging

from fastapi import Depends
from sqlalchemy.orm import Session

from app.config import (
    DUCKDB_ENABLED,
    DUCKDB_FALLBACK_TO_ORACLE,
    DUCKDB_PATH,
)
from app.db.database import get_db
from app.repositories.fdwh_repository import FDWHRepository
from app.services.analytics_service import AnalyticsService
from app.services.component_service import ComponentService
from app.services.timeseries_service import TimeseriesService

log = logging.getLogger(__name__)


def _build_duckdb_routing(oracle_repo: FDWHRepository):
    """Lazily import DuckDB modules and build the routing wrapper.

    Called only when ``DUCKDB_ENABLED=true``. Failures here fall back
    to the plain Oracle repository so a broken DuckDB file never takes
    down the dashboard.
    """
    try:
        from app.duckdb.connection import get_duckdb_handle
        from app.duckdb.repository import DuckDBRepository
        from app.repositories.routing_repository import RoutingRepository

        handle = get_duckdb_handle(DUCKDB_PATH)
        duck_repo = DuckDBRepository(handle)
        return RoutingRepository(
            duck_repo,
            oracle_repo,
            fallback_to_oracle=DUCKDB_FALLBACK_TO_ORACLE,
        )
    except FileNotFoundError as exc:
        log.warning(
            "DuckDB file not found (%s); falling back to Oracle-only mode for this request",
            exc,
        )
        return oracle_repo
    except Exception:
        log.exception(
            "DuckDB routing setup failed; falling back to Oracle-only mode "
            "(set DUCKDB_ENABLED=false to silence this)"
        )
        return oracle_repo


def get_fdwh_repository(db: Session = Depends(get_db)):
    """Return the repository every service should depend on.

    The type annotation stays ``FDWHRepository`` in service files because
    the routing wrapper is a structural duck-typed substitute. The
    invariant is: with DUCKDB_ENABLED=false this returns a plain
    ``FDWHRepository`` exactly like the pre-replica baseline.
    """
    oracle_repo = FDWHRepository(db)
    if not DUCKDB_ENABLED:
        return oracle_repo
    return _build_duckdb_routing(oracle_repo)


def get_component_service(
    repository=Depends(get_fdwh_repository),
) -> ComponentService:
    return ComponentService(repository)


def get_timeseries_service(
    repository=Depends(get_fdwh_repository),
) -> TimeseriesService:
    return TimeseriesService(repository)


def get_analytics_service(
    repository=Depends(get_fdwh_repository),
) -> AnalyticsService:
    return AnalyticsService(repository)