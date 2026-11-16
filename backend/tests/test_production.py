"""Production operation: one script in PowerFactory, dashboard server beside the database, read-only in the network."""

import importlib.util
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

import pytest
from fastapi.testclient import TestClient

from app.simulation import settings
from app.simulation.store import ScenarioStore
from tests.gridlens_fixture import App

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import appconfig  # noqa: E402
import dashboard_launcher as launcher  # noqa: E402

spec = importlib.util.spec_from_file_location("start_assessment", ROOT / "powerfactory/start_assessment.py")
starter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(starter)

HAS_INSTALL = launcher.dashboard_python().is_file() and (ROOT / "frontend/dist/index.html").is_file()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{port}/api/health/ready", timeout=0.5) as response:
                return json.load(response)
        except OSError:
            time.sleep(0.2)
    raise AssertionError("Server not ready")


# -- configuration -----------------------------------------------------------------------------

def test_powerfactory_uses_the_venv_packages_only_for_the_same_python_version(tmp_path):
    venv = tmp_path / "backend" / ".venv"
    (venv / "Lib" / "site-packages").mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text("home = C:\\Python312\nversion = 3.12.7\n")
    assert starter.venv_packages(tmp_path, (3, 12, 1)) == venv / "Lib" / "site-packages"
    assert starter.venv_packages(tmp_path, (3, 11, 9)) is None  # a compiled pyarrow would not load
    assert starter.venv_packages(tmp_path / "missing", (3, 12, 1)) is None


def test_configuration_precedence_environment_file_defaults(tmp_path, monkeypatch):
    for name in ("OA_DATABASE", "OA_HOST", "OA_PORT"):
        monkeypatch.delenv(name, raising=False)
    defaults = appconfig.load(tmp_path)
    assert defaults["port"] == 8765 and defaults["host"] == "127.0.0.1" and defaults["production"] is False
    assert defaults["database"] == tmp_path / "backend/data/outage-assessment.sqlite3"
    (tmp_path / appconfig.CONFIG_NAME).write_text(json.dumps({"database": "data/x.sqlite3", "host": "0.0.0.0", "port": 9000}))
    from_file = appconfig.load(tmp_path)
    assert from_file["database"] == tmp_path / "data/x.sqlite3"  # relative paths start at the project folder
    assert (from_file["host"], from_file["port"], from_file["production"]) == ("0.0.0.0", 9000, True)
    monkeypatch.setenv("OA_PORT", "9100")
    monkeypatch.setenv("OA_DATABASE", str(tmp_path / "env.sqlite3"))
    from_env = appconfig.load(tmp_path)
    assert from_env["port"] == 9100 and from_env["database"] == tmp_path / "env.sqlite3"


def test_broken_configuration_names_the_file(tmp_path):
    (tmp_path / appconfig.CONFIG_NAME).write_text("{broken")
    with pytest.raises(ValueError, match="outage-assessment.config.json"):
        appconfig.load(tmp_path)


def test_network_addresses_only_when_reachable_from_outside():
    assert launcher.lan_urls(8765, "127.0.0.1") == []
    urls = launcher.lan_urls(8765, "0.0.0.0")
    assert urls and urls[0] == f"http://{socket.gethostname()}:8765"


# -- read-only operation in the network -----------------------------------------------------------

@pytest.fixture
def production_client(tmp_path, monkeypatch):
    from app.main import app
    from app.simulation.store import ScenarioStore

    path = tmp_path / "results.sqlite3"
    ScenarioStore(str(path)).close()
    monkeypatch.setattr(settings, "ANALYSIS_MODE", "sqlite")
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(path))
    monkeypatch.setattr(settings, "PRODUCTION", True)
    monkeypatch.setattr(settings, "ALLOW_DB_SWITCH", False)
    with TestClient(app) as client:
        yield client, path


def test_visitors_can_read_but_never_change_anything(production_client):
    client, path = production_client
    assert client.get("/api/simulation/outage-management").status_code == 200
    assert client.get("/api/simulation/across-scenarios/index").status_code == 200
    for path_ in ("/scenarios", "/outage-management/sync", "/jobs/abc/cancel", "/shares"):
        assert client.post("/api/simulation" + path_, json={}).status_code in (404, 405)  # no write endpoints exist
    assert client.post("/api/simulation/database", json={"path": str(path)}).status_code == 403
    capabilities = client.get("/api/simulation/capabilities").json()
    assert capabilities["database_switch"] is False


def test_responses_carry_protective_headers(production_client):
    client, _ = production_client
    headers = client.get("/api/health").headers
    assert headers["x-frame-options"] == "DENY" and headers["referrer-policy"] == "no-referrer"


def test_built_files_are_kept_by_the_browser_and_the_page_is_always_asked_for_again(production_client, tmp_path, monkeypatch):
    from app import main

    (tmp_path / "dist/assets").mkdir(parents=True)
    (tmp_path / "dist/index.html").write_text("<html></html>", encoding="utf-8")
    (tmp_path / "dist/assets/app-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "dist/favicon.svg").write_text("<svg/>", encoding="utf-8")
    monkeypatch.setattr(main, "DIST", tmp_path / "dist")
    client, _ = production_client
    assert "immutable" in client.get("/assets/app-abc123.js").headers["cache-control"]  # named by content hash
    assert client.get("/").headers["cache-control"] == "no-cache"  # links the current build
    assert "cache-control" not in client.get("/favicon.svg").headers  # not hashed: revalidated as before


def test_overview_names_the_job_so_the_dashboard_can_show_what_is_calculated(tmp_path, monkeypatch):
    from app.simulation.store import ScenarioStore

    store = ScenarioStore(str(tmp_path / "x.sqlite3"))
    store.enqueue("run", {"name": "Maintenance North", "outage_ids": ["a"]})
    assert store.overview()["jobs"][0]["name"] == "Maintenance North"
    store.close()


def test_the_polled_overview_answers_unchanged_with_an_empty_304(production_client):
    client, path = production_client
    first = client.get("/api/simulation/outage-management")
    tag = first.headers["etag"]
    assert first.status_code == 200 and first.headers["cache-control"] == "no-cache"
    again = client.get("/api/simulation/outage-management", headers={"If-None-Match": tag})
    assert again.status_code == 304 and again.content == b"" and again.headers["etag"] == tag
    store = ScenarioStore(str(path))
    store.set_progress("running", "STEP 1/5", restart=True)  # the script reports progress: the answer changes
    store.close()
    changed = client.get("/api/simulation/outage-management", headers={"If-None-Match": tag})
    assert changed.status_code == 200 and changed.headers["etag"] != tag and changed.json()["progress"]["state"] == "running"


# -- server and launcher as real processes -----------------------------------------------------------

@pytest.mark.skipif(not HAS_INSTALL, reason="Backend environment or frontend build is missing")
def test_permanent_server_serves_the_database_read_only_and_a_second_start_reuses_it(tmp_path):
    from tests.qds_fixture import create_dummy_database

    database = create_dummy_database(tmp_path / "demo.sqlite3")
    port = free_port()
    server = subprocess.Popen(
        [str(launcher.dashboard_python()), str(ROOT / "scripts/serve.py"), "--db", str(database), "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ready = wait_ready(port)
        assert Path(ready["database_path"]).resolve() == database.resolve()
        # Reuse: the PowerFactory script finds the running server and does not start a second one.
        dashboard = launcher.launch_dashboard(database, port=port, host="127.0.0.1", reuse=True, open_browser=False)
        assert dashboard["reused"] is True and dashboard["process"] is None and dashboard["url"] == f"http://127.0.0.1:{port}"
        # 127.0.0.1 is not "reachable from other PCs", so this server still runs writable; check the log exists.
        assert (tmp_path / "demo.server.log").is_file()
    finally:
        server.terminate()
        server.wait(timeout=10)


@pytest.mark.skipif(not HAS_INSTALL, reason="Backend environment or frontend build is missing")
def test_launcher_starts_once_then_reuses_and_falls_back_when_the_port_is_taken(tmp_path):
    from tests.qds_fixture import create_dummy_database

    database = create_dummy_database(tmp_path / "demo.sqlite3")
    port = free_port()
    first = launcher.launch_dashboard(database, port=port, host="127.0.0.1", open_browser=False)
    try:
        assert first["reused"] is False and first["process"] is not None
        again = launcher.launch_dashboard(database, port=port, host="127.0.0.1", reuse=True, open_browser=False)
        assert again["reused"] is True and again["pid"] == first["pid"]
        # Another database wants the same fixed port: it must not steal it, and it must say so.
        other = create_dummy_database(tmp_path / "other.sqlite3")
        second = launcher.launch_dashboard(other, port=port, host="127.0.0.1", reuse=True, open_browser=False)
        try:
            assert second["reused"] is False and second["url"] != first["url"]
            assert any("in use" in note for note in second["notes"])
        finally:
            second["process"].terminate()
            second["process"].wait(timeout=10)
    finally:
        first["process"].terminate()
        first["process"].wait(timeout=10)


# -- the PowerFactory script ---------------------------------------------------------------------------

@pytest.fixture
def run_starter(tmp_path, monkeypatch):
    """start_assessment.main() with a synthetic PowerFactory, the calculation and the dashboard replaced."""
    monkeypatch.setattr(starter, "prepare_imports", lambda: None)
    monkeypatch.setattr(starter, "ensure_installation", lambda app: None)
    monkeypatch.setenv("OA_DATABASE", str(tmp_path / "results.sqlite3"))
    app = App()
    monkeypatch.setitem(sys.modules, "powerfactory", type("PF", (), {"GetApplication": staticmethod(lambda: app)}))
    monkeypatch.setattr(launcher, "validate_installation", lambda *a: None)
    monkeypatch.setattr(launcher, "start_dashboard", lambda *a, **k: {"port": 8765})
    monkeypatch.setattr(launcher, "stop_started_dashboard", lambda *a: None)
    return app


def test_preflight_rejects_a_full_disk_and_an_unwritable_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(starter.shutil, "disk_usage", lambda p: type("U", (), {"free": 1e9})())
    with pytest.raises(RuntimeError, match="Not enough free space"):
        starter.preflight(tmp_path / "db.sqlite3")
    monkeypatch.setattr(starter.shutil, "disk_usage", lambda p: type("U", (), {"free": 50e9})())
    assert starter.preflight(tmp_path / "ok" / "db.sqlite3") == pytest.approx(50)
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        with pytest.raises(RuntimeError, match="not writable"):
            starter.preflight(locked / "db.sqlite3")
    finally:
        locked.chmod(0o700)


def test_a_database_of_an_earlier_version_is_refused_before_the_case_manager_opens(run_starter, tmp_path, monkeypatch):
    import sqlite3

    from app.analysis.schema import OutdatedDatabaseError

    db = sqlite3.connect(tmp_path / "results.sqlite3")
    db.executescript("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (1);")
    db.close()
    monkeypatch.setattr(starter, "run_assessment", lambda *a: pytest.fail("No calculation may start"))
    with pytest.raises(OutdatedDatabaseError):
        starter.main()


def test_a_progress_note_can_never_stop_the_calculation(run_starter, monkeypatch):
    monkeypatch.setattr(ScenarioStore, "set_progress", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("database is locked")))
    monkeypatch.setattr(launcher, "wait_for_dashboard", lambda *a, **k: {"url": "http://127.0.0.1:8765", "lan_urls": [], "notes": []})
    monkeypatch.setattr(starter, "run_assessment", lambda app, db, saved: saved(1, 1, "QDS C1", 1) or {"cases": 1, "assessment_id": "a"})
    assert starter.main()["url"] == "http://127.0.0.1:8765"
    assert any("Progress could not be updated" in line for line in run_starter.messages)


def test_a_failing_dashboard_does_not_waste_the_calculation(run_starter, monkeypatch):
    monkeypatch.setattr(launcher, "wait_for_dashboard", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Port blocked")))
    monkeypatch.setattr(starter, "run_assessment", lambda app, db, saved: saved(2, 2, "QDS C1", 1) or {"cases": 1, "assessment_id": "a"})
    outcome = starter.main()
    assert outcome["assessment_id"] == "a" and "url" not in outcome
    assert any("Port blocked" in line for line in run_starter.messages)


def test_the_addresses_for_other_pcs_are_printed(run_starter, monkeypatch):
    monkeypatch.setattr(launcher, "wait_for_dashboard", lambda *a, **k: {
        "url": "http://127.0.0.1:8765", "lan_urls": ["http://pf-pc:8765"], "notes": ["Port 8765 is in use; a free port is used instead."]})
    monkeypatch.setattr(starter, "run_assessment", lambda app, db, saved: {"cases": 0, "assessment_id": "a"})
    starter.main()
    assert any("pf-pc:8765" in line for line in run_starter.messages)
    assert any("free port" in line for line in run_starter.messages)


def test_modules_of_an_earlier_run_are_not_reused(monkeypatch):
    """PowerFactory keeps its Python between runs: modules of an earlier run (maybe of another copy) must not be used."""
    from types import ModuleType

    monkeypatch.setattr(sys, "path", list(sys.path))
    saved = dict(sys.modules)
    try:
        for name in ("gridlens_runtime", "gridlens_dashboard", "dashboard_launcher", "app", "app.simulation.store"):
            sys.modules.setdefault(name, ModuleType(name))
        starter.prepare_imports()
        assert not {"gridlens_runtime", "gridlens_dashboard", "dashboard_launcher", "app", "app.simulation.store"} & set(sys.modules)
        assert "json" in sys.modules
    finally:
        sys.modules.clear()
        sys.modules.update(saved)  # the rest of the test session keeps its modules













def test_release_package_contains_what_the_powerfactory_pc_needs_and_no_secrets(tmp_path):
    import package_release
    import zipfile

    root = tmp_path / "project"
    for relative, content in {
        "backend/app/main.py": "x", "backend/app/__pycache__/main.pyc": "x", "backend/pyproject.toml": 'version = "9.9.9"',
        "backend/data/results.sqlite3": "secret-data", "backend/.venv/bin/python": "x",
        "frontend/dist/index.html": "<html>", "frontend/node_modules/a.js": "x",
        "powerfactory/start_assessment.py": "x", "powerfactory/assessment.config.json": '{"token":"secret"}',
        "scripts/serve.py": "x", "scripts/dashboard_launcher.py": "x", "scripts/appconfig.py": "x",
        "setup.ps1": "x", "setup.cmd": "x", "deploy/windows/uninstall.ps1": "x", "docs/ASSESSMENT.md": "x", "README.md": "x",
        "outage-assessment.config.json": '{"database":"x"}', "outage-assessment.config.example.json": "{}",
    }.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    archive = package_release.build(root, tmp_path / "out")
    assert archive.name == "outage-assessment-9.9.9.zip"
    names = set(zipfile.ZipFile(archive).namelist())
    base = "outage-assessment/"
    for needed in ("backend/app/main.py", "frontend/dist/index.html", "powerfactory/start_assessment.py", "scripts/serve.py",
                   "setup.ps1", "setup.cmd", "deploy/windows/uninstall.ps1", "docs/ASSESSMENT.md", "outage-assessment.config.example.json"):
        assert base + needed in names, needed
    leaked = [n for n in names if n.endswith((".sqlite3", ".pyc")) or "/.venv/" in n or "node_modules" in n
              or n.endswith("assessment.config.json")]
    assert leaked == []


def test_release_build_refuses_without_the_frontend_build(tmp_path):
    import package_release

    (tmp_path / "backend").mkdir()
    (tmp_path / "backend/pyproject.toml").write_text('version = "1.0.0"')
    with pytest.raises(SystemExit):
        package_release.build(tmp_path, tmp_path / "out")





