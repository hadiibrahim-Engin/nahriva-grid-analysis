from functools import lru_cache
from pathlib import Path
from app.config import BASE_DIR, APP_ENV, ConfigError, _env, validate_auth_config
from app.analysis.repository import AnalysisRepository

ANALYSIS_MODE = _env("ANALYSIS_MODE", default="demo")
ANALYSIS_DB_PATH = _env(
    "ANALYSIS_DB_PATH", default=str(BASE_DIR / "data" / "analysis.sqlite3")
)
if ANALYSIS_MODE not in ("demo", "sqlite"):
    raise ConfigError("ANALYSIS_MODE must be demo or sqlite")
if APP_ENV == "production" and ANALYSIS_MODE == "demo":
    raise ConfigError(
        "Production requires ANALYSIS_MODE=sqlite; demo data is development-only"
    )


@lru_cache(maxsize=1)
def get_repository():
    repo = AnalysisRepository(
        ":memory:"
        if ANALYSIS_MODE == "demo"
        else str(Path(ANALYSIS_DB_PATH).expanduser())
    )
    if ANALYSIS_MODE == "demo":
        from app.analysis.seed import demo_bundles

        for bundle in demo_bundles():
            repo.import_bundle(bundle)
    return repo


def initialize_analysis():
    if APP_ENV == "production":
        validate_auth_config()
    get_repository()
