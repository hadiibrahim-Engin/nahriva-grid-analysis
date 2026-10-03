"""Standard-library launcher shared by ComPython and local command-line tools."""

import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parents[1]


def dashboard_python(root=ROOT):
    return (
        root
        / "backend/.venv"
        / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )


def validate_installation(root=ROOT, python=None):
    interpreter = Path(python) if python else dashboard_python(root)
    if not interpreter.is_file():
        raise RuntimeError(
            "Backend fehlt. Zuerst start-app.cmd oder start-demo.command ausführen."
        )
    if not (root / "frontend/dist/index.html").is_file():
        raise RuntimeError(
            "Frontend-Build fehlt. Im Ordner frontend: npm ci und npm run build ausführen."
        )
    return interpreter


def launch_dashboard(
    database_path, *, port=0, python=None, open_browser=True, root=ROOT
):
    interpreter = validate_installation(root, python)
    database = Path(database_path).expanduser().resolve()
    if not database.is_file():
        raise RuntimeError("Ergebnisdatenbank existiert nicht: " + str(database))
    # Allocate a separate local port, so another dashboard never shows the wrong DB.
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", port))
        selected_port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{selected_port}"
    log_path = database.parent / (database.stem + ".dashboard.log")
    env = {**os.environ, "ANALYSIS_MODE": "sqlite", "ANALYSIS_DB_PATH": str(database)}
    options = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    with log_path.open("a", encoding="utf-8") as log:
        process = subprocess.Popen(
            [
                str(interpreter),
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(selected_port),
            ],
            cwd=root / "backend",
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            **options,
        )
    try:
        for _ in range(150):
            if process.poll() is not None:
                raise RuntimeError("Dashboard beendet. Log: " + str(log_path))
            try:
                with urlopen(url + "/api/health/ready", timeout=0.5) as response:
                    ready = json.load(response)
                if (
                    ready["status"] == "ready"
                    and Path(ready["database_path"]).resolve() == database
                ):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError(
                "Dashboard startet nicht rechtzeitig. Log: " + str(log_path)
            )
    except BaseException:
        process.terminate()
        process.wait(timeout=5)
        raise
    (database.parent / (database.stem + ".dashboard.json")).write_text(
        json.dumps(
            {
                "pid": process.pid,
                "url": url,
                "database": str(database),
                "log": str(log_path),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    if open_browser:
        webbrowser.open(url)
    return {"pid": process.pid, "url": url, "log": str(log_path), "process": process}
