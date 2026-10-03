"""Permanent dashboard server: run it with the backend's Python (Autostart / scheduled task / by hand).

It serves the results database read-only to every PC that can reach the port, with or without
PowerFactory running. Scenarios saved by the PowerFactory script appear without a restart.

    backend/.venv/Scripts/python.exe scripts/serve.py            (settings from outage-assessment.config.json)
    backend/.venv/Scripts/python.exe scripts/serve.py --db D:/results/x.sqlite3 --port 8765
"""

import argparse
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))
import appconfig  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, help="Ergebnisdatenbank (sonst aus der Konfiguration)")
    parser.add_argument("--host", help="0.0.0.0 = im Netz erreichbar, 127.0.0.1 = nur dieser PC")
    parser.add_argument("--port", type=int)
    args = parser.parse_args(argv)

    config = appconfig.load(ROOT)
    database = (args.db or config["database"]).expanduser().resolve()
    host = args.host or config["host"]
    port = args.port or config["port"]
    production = host not in appconfig.LOOPBACK

    database.parent.mkdir(parents=True, exist_ok=True)
    log_path = database.parent / (database.stem + ".server.log")
    handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler()])

    os.environ["ANALYSIS_MODE"] = "sqlite"
    os.environ["ANALYSIS_DB_PATH"] = str(database)
    if production:
        os.environ["APP_ENV"] = "production"
    from app.simulation.store import ScenarioStore  # creates an empty database on first start

    ScenarioStore(str(database)).close()
    if not (ROOT / "frontend/dist/index.html").is_file():
        raise SystemExit("Frontend-Build fehlt (frontend/dist). Das Release-Paket enthält ihn bereits.")

    import uvicorn

    logging.getLogger("outage-assessment").info(
        "Dashboard auf %s:%s, Datenbank %s, %s", host, port, database, "Nur-Lese-Betrieb im Netz" if production else "nur dieser PC"
    )
    uvicorn.run("app.main:app", host=host, port=port, log_config=None, access_log=False)


if __name__ == "__main__":
    main()
