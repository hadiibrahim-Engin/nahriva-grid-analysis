import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
env_file = BASE_DIR / ".env"
if env_file.is_file():
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        if "=" in raw and not raw.lstrip().startswith("#"):
            key, value = raw.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

APP_ENV = os.getenv("APP_ENV", "development")
ANALYSIS_MODE = os.getenv("ANALYSIS_MODE", "sqlite")
ANALYSIS_DB_PATH = os.getenv(
    "ANALYSIS_DB_PATH", str(BASE_DIR / "data/analysis.sqlite3")
)
CORS_ORIGINS = [
    value.strip() for value in os.getenv("CORS_ORIGINS", "").split(",") if value.strip()
]
if ANALYSIS_MODE != "sqlite":
    raise RuntimeError("ANALYSIS_MODE must be sqlite.")

# Production: the dashboard server runs next to the results database and is reachable in the network.
PRODUCTION = APP_ENV == "production"
# In production the dashboard is read-only for visitors: no switching of the database, no job queue.
ALLOW_DB_SWITCH = os.getenv("OA_ALLOW_DB_SWITCH", "0" if PRODUCTION else "1") == "1"
