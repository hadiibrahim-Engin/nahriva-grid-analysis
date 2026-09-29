"""JSON structured logging with per-request correlation IDs.

No external deps. The formatter emits one JSON object per log record
with a stable schema; the request_id contextvar is populated by
middleware in app/main.py so any line emitted during a request carries
its ID.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from contextvars import ContextVar
from typing import Any

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

# Accumulated Oracle/DB execution time for the current request, in
# milliseconds. The repository adds to it per statement; middleware reads
# it to emit a Server-Timing header and a structured `db_ms` log field.
db_time_ms_var: ContextVar[float] = ContextVar("db_time_ms", default=0.0)


class JsonFormatter(logging.Formatter):
    """Render LogRecord as a single-line JSON object."""

    # Reserved LogRecord fields; anything else passed via extra= is included.
    _RESERVED = {
        "args", "asctime", "created", "exc_info", "exc_text", "filename",
        "funcName", "levelname", "levelno", "lineno", "message", "module",
        "msecs", "msg", "name", "pathname", "process", "processName",
        "relativeCreated", "stack_info", "thread", "threadName", "taskName",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        for key, value in record.__dict__.items():
            if key not in self._RESERVED and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, default=str, ensure_ascii=False)


def configure_logging(level: str = "INFO") -> None:
    """Replace any existing handlers with a single JSON stdout handler."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # Quiet uvicorn's default handlers but let messages propagate so they
    # come through our JSON formatter.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "sqlalchemy.engine"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
