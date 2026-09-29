"""JSON formatter + request_id contextvar."""

from __future__ import annotations

import json
import logging
import sys

from app.core.logging import JsonFormatter, request_id_var


def _make_record(msg: str = "hello", **extras) -> logging.LogRecord:
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=10,
        msg=msg,
        args=(),
        exc_info=None,
    )
    for key, value in extras.items():
        setattr(record, key, value)
    return record


def test_emits_json_with_required_fields():
    line = JsonFormatter().format(_make_record())
    parsed = json.loads(line)
    assert parsed["msg"] == "hello"
    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "test"
    assert "ts" in parsed
    assert "request_id" in parsed


def test_request_id_propagates_via_contextvar():
    token = request_id_var.set("abc-123")
    try:
        line = JsonFormatter().format(_make_record())
    finally:
        request_id_var.reset(token)
    assert json.loads(line)["request_id"] == "abc-123"


def test_extras_are_included():
    line = JsonFormatter().format(_make_record(method="GET", status=200))
    parsed = json.loads(line)
    assert parsed["method"] == "GET"
    assert parsed["status"] == 200


def test_exception_info_serialized():
    try:
        raise ValueError("bad")
    except ValueError:
        record = _make_record("oops")
        record.exc_info = sys.exc_info()
        line = JsonFormatter().format(record)
    parsed = json.loads(line)
    assert "ValueError" in parsed["exc"]
    assert "bad" in parsed["exc"]
