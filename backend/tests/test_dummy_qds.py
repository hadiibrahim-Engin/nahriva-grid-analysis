"""The Mac fixture is persistent, complete, and never overwrites a real dataset."""

from pathlib import Path
import sys
import pytest
from app.simulation.store import ScenarioStore

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from seed_dummy_qds import create_dummy_database, STEPS


def test_dummy_qds_is_small_complete_and_idempotent(tmp_path):
    path = tmp_path / "demo.sqlite3"
    create_dummy_database(path)
    create_dummy_database(path)
    store = ScenarioStore(str(path))
    assert len(store.overview()["scenarios"]) == 8
    assert store.db.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0] == 16
    assert (
        store.db.execute(
            "SELECT COUNT(*) FROM analysis_samples WHERE run_id=(SELECT id FROM analysis_runs LIMIT 1) AND element_id='line-nord' AND metric_id='loading'"
        ).fetchone()[0]
        == STEPS
    )
    assert (
        store.db.execute("SELECT DISTINCT source FROM analysis_runs").fetchone()[0]
        == "Dummy QDS (synthetic)"
    )
    assert store.db.execute("SELECT COUNT(*) FROM pf_lodf").fetchone()[0] > 0
    provenance = store.overview()["scenarios"][0]["provenance"]
    assert provenance["data_source"] == "synthetic"
    assert provenance["powerfactory_version"] is None
    assert provenance["sample_interval_seconds"] == 900
    # Treat an existing imported/real catalog as authoritative.
    store.publish_catalog({**store.catalog(), "dummy_qds_version": None})
    store.close()
    with pytest.raises(ValueError, match="andere Ergebnisse"):
        create_dummy_database(path)
