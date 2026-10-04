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
from tests.test_powerfactory_worker import App

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import appconfig  # noqa: E402
import dashboard_launcher as launcher  # noqa: E402

spec = importlib.util.spec_from_file_location("start_assessment", ROOT / "powerfactory/start_assessment.py")
assessment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assessment)

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


def test_overview_names_the_job_so_the_dashboard_can_show_what_is_calculated(tmp_path, monkeypatch):
    from app.simulation.store import ScenarioStore

    store = ScenarioStore(str(tmp_path / "x.sqlite3"))
    store.enqueue("run", {"name": "Maintenance North", "outage_ids": ["a"]})
    assert store.overview()["jobs"][0]["name"] == "Maintenance North"
    store.close()


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

def test_script_saves_into_the_configured_database_and_shows_the_dashboard_afterwards(tmp_path, monkeypatch):
    database = tmp_path / "results" / "outages.sqlite3"
    monkeypatch.setenv("OA_DATABASE", str(database))
    monkeypatch.setenv("OA_HOST", "0.0.0.0")
    monkeypatch.setenv("OA_PORT", "8765")
    app = App()
    events = []
    printed = []
    app.PrintPlain = printed.append
    original = app.calculate

    def calculate():
        events.append("calculate")
        return original()

    app.qds.Execute = calculate
    monkeypatch.setitem(sys.modules, "powerfactory", type("PF", (), {"GetApplication": staticmethod(lambda: app)}))
    monkeypatch.setattr(assessment, "validate_installation", lambda **kwargs: None)

    def fake_launch(db, **kwargs):
        events.append(("dashboard", kwargs["host"], kwargs["port"], kwargs["production"], kwargs["reuse"]))
        assert Path(db).is_file() and events.count("calculate") == 4  # shown only after all calculations
        return {"url": "http://127.0.0.1:8765", "lan_urls": ["http://pf-pc:8765"], "reused": False, "notes": [], "pid": 1, "process": None}

    monkeypatch.setattr(assessment, "launch_dashboard", fake_launch)
    assessment.main()
    assert events[-1] == ("dashboard", "0.0.0.0", 8765, True, True)  # shown after the calculation; read-only, reuses a running one
    assert events.count("calculate") == 4  # REF and OUTAGE of two scenarios
    assert any("pf-pc:8765" in line for line in printed)  # the address for other PCs is printed
    assert database.is_file()


def test_a_failing_dashboard_does_not_waste_the_calculation(tmp_path, monkeypatch):
    monkeypatch.setenv("OA_DATABASE", str(tmp_path / "r.sqlite3"))
    app = App()
    printed = []
    app.PrintPlain = printed.append
    monkeypatch.setitem(sys.modules, "powerfactory", type("PF", (), {"GetApplication": staticmethod(lambda: app)}))
    monkeypatch.setattr(assessment, "validate_installation", lambda **kwargs: None)
    monkeypatch.setattr(assessment, "launch_dashboard", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Port blocked")))
    assessment.main()
    assert any("WARN" in line and "Port blocked" in line for line in printed)
    assert len(app.calls) == 4


def test_preflight_rejects_a_full_disk_and_an_unwritable_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(assessment.shutil, "disk_usage", lambda p: type("U", (), {"free": 1e9})())
    with pytest.raises(RuntimeError, match="Not enough free space"):
        assessment.preflight(tmp_path / "db.sqlite3")
    monkeypatch.setattr(assessment.shutil, "disk_usage", lambda p: type("U", (), {"free": 50e9})())
    assert assessment.preflight(tmp_path / "ok" / "db.sqlite3") == pytest.approx(50)


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


def test_a_broken_dashboard_step_never_hides_the_assessment_error(tmp_path, monkeypatch):
    import sqlite3

    from tests.test_lodf import LockedLdf, LodfApp

    monkeypatch.setenv("OA_DATABASE", str(tmp_path / "r.sqlite3"))
    app = LodfApp(status=1)
    app.ldf = LockedLdf("Load Flow", "ComLdf", iopt_net=0)
    app.ldf.Execute = lambda: (setattr(app.ldf, "locked", True), 1)[1]

    def deleted(_message):
        raise RuntimeError("'powerfactory.Application' already deleted")

    app.PrintPlain = deleted  # PowerFactory has already torn the application down
    monkeypatch.setitem(sys.modules, "powerfactory", type("PF", (), {"GetApplication": staticmethod(lambda: app)}))
    monkeypatch.setattr(assessment, "validate_installation", lambda **kwargs: None)
    monkeypatch.setattr(assessment, "has_results", lambda database: (_ for _ in ()).throw(sqlite3.OperationalError("unrecognized token")))
    (tmp_path / "r.sqlite3").touch()
    with pytest.raises(RuntimeError, match="restoration failed"):
        assessment.main()
