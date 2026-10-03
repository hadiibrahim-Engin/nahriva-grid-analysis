"""Shared configuration of the PowerFactory script and the permanent dashboard server (standard library only).

Order of precedence: environment variable, then outage-assessment.config.json in the project folder,
then the defaults given by the caller. Typical file:

    {"database": "D:/OutageAssessment/results/outages.sqlite3", "host": "127.0.0.1", "port": 8765}
"""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_NAME = "outage-assessment.config.json"
DEFAULT_PORT = 8765
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def load(root=ROOT, *, database=None, host="127.0.0.1", port=DEFAULT_PORT):
    data = {}
    path = Path(root) / CONFIG_NAME
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise ValueError(f"{path.name} is not valid JSON: {exc}") from None
    env = os.environ
    chosen = env.get("OA_DATABASE") or data.get("database") or database or Path(root) / "backend/data/outage-assessment.sqlite3"
    chosen = Path(chosen).expanduser()
    if not chosen.is_absolute():
        chosen = Path(root) / chosen
    chosen_host = str(env.get("OA_HOST") or data.get("host") or host)
    try:
        chosen_port = int(env.get("OA_PORT") or data.get("port") or port)
    except ValueError:
        raise ValueError("The port must be a number.") from None
    return {
        "database": chosen,
        "host": chosen_host,
        "port": chosen_port,
        # Reachable from other PCs means read-only for visitors (see backend settings).
        "production": chosen_host not in LOOPBACK,
    }
