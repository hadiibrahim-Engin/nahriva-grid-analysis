"""Audit log helper.

Writes structured events to a dedicated logger (`app.audit`) so they can
be routed to a different sink than ordinary application logs if needed
(file, syslog, SIEM). Today it shares the JSON stdout handler from
configure_logging; rebind the logger at deploy time to fan out.

Use sparingly: these lines describe security-relevant actions like
login attempts, exports, and configuration changes. Don't log dashboard
reads here; the access log already covers those.
"""

from __future__ import annotations

import logging
from typing import Any

_log = logging.getLogger("app.audit")


def audit(event: str, **fields: Any) -> None:
    """Emit one audit event at INFO. Fields land as top-level JSON keys."""
    _log.info(event, extra={"audit": True, **fields})
