"""Domain exceptions decoupled from FastAPI response handling.

Each domain error carries a stable, machine-readable ``error_code`` and an
optional ``suggested_action`` so the API can return a consistent error
envelope (see ``app.models.schemas.ErrorResponse``) without leaking raw
Oracle/SQL internals to dashboard users.
"""

from __future__ import annotations

from typing import Any, Optional


class DashboardError(RuntimeError):
    """Base class for expected dashboard-domain failures.

    Subclasses set ``error_code`` and ``http_status``; the message passed to
    the constructor is the safe, user-facing text.
    """

    error_code: str = "INTERNAL_ERROR"
    http_status: int = 500

    def __init__(
        self,
        message: str,
        *,
        details: Optional[dict[str, Any]] = None,
        suggested_action: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details
        self.suggested_action = suggested_action


class ResourceNotFoundError(DashboardError):
    """Raised when a requested FDWH entity or result set does not exist."""

    error_code = "NO_DATA"
    http_status = 404


class InvalidRequestError(DashboardError):
    """Raised when input is syntactically valid but unsupported by the domain."""

    error_code = "INVALID_REQUEST"
    http_status = 400


class InvalidDateRangeError(InvalidRequestError):
    """Raised when start/end are missing or start is not before end."""

    error_code = "INVALID_DATE_RANGE"
    http_status = 422


class RawRangeTooLargeError(DashboardError):
    """Raised when an unpaginated raw request would exceed the point cap.

    Raw data is never silently downsampled; the caller must paginate with a
    cursor, export, or explicitly switch to the /aggregate endpoint.
    """

    error_code = "RAW_RANGE_TOO_LARGE"
    http_status = 422

    def __init__(self, *, estimated_points: int, max_points: int) -> None:
        super().__init__(
            (
                f"Der angeforderte Rohdaten-Zeitraum umfasst ca. {estimated_points:,} "
                f"Messpunkte und überschreitet das Limit von {max_points:,}. "
                "Rohdaten werden nicht automatisch verdichtet."
            ).replace(",", "."),
            details={"estimated_points": estimated_points, "max_points": max_points},
            suggested_action=(
                "Zeitraum verkleinern, mit Cursor seitenweise laden (limit/cursor), "
                "exportieren, oder bewusst die Aggregation (/aggregate) wählen."
            ),
        )


class UnsupportedAggregationError(InvalidRequestError):
    """Raised when an aggregation bucket or method is not supported."""

    error_code = "UNSUPPORTED_BUCKET"
    http_status = 422


class ForbiddenError(DashboardError):
    """Raised when an authenticated user lacks the required role."""

    error_code = "FORBIDDEN"
    http_status = 403
