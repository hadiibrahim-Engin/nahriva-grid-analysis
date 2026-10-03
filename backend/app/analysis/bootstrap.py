from functools import lru_cache
from pathlib import Path
from app.simulation.settings import ANALYSIS_MODE, ANALYSIS_DB_PATH
from app.analysis.repository import AnalysisRepository

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
    get_repository()
