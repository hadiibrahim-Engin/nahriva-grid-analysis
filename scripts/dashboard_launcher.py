"""Standard-library launcher shared by ComPython and local command-line tools."""

import json
import os
from pathlib import Path
import socket
import subprocess
import threading
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
            "Backend is missing. Run setup.ps1 (Windows) or start-dashboard.command (macOS) first."
        )
    if not (root / "frontend/dist/index.html").is_file():
        raise RuntimeError(
            "Frontend build is missing. In the frontend folder run: npm ci and npm run build."
        )
    return interpreter


def lan_urls(port, host="0.0.0.0"):
    """Addresses other PCs can use: the computer name and, where it can be determined, its IP address."""
    if host in ("127.0.0.1", "localhost", "::1"):
        return []
    urls = [f"http://{socket.gethostname()}:{port}"]
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # documentation address: nothing is sent, the OS just picks a route
            address = probe.getsockname()[0]
        if address and not address.startswith("127."):
            urls.append(f"http://{address}:{port}")
    except OSError:
        pass
    return urls


def read_state(database):
    path = Path(database).with_suffix(".dashboard.json")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def serves_database(url, database, timeout=0.7):
    """True when a dashboard server at `url` is ready and serves exactly this database."""
    try:
        with urlopen(url + "/api/health/ready", timeout=timeout) as response:
            ready = json.load(response)
        return ready.get("status") == "ready" and Path(ready["database_path"]).resolve() == Path(database).resolve()
    except (OSError, ValueError, KeyError):
        return False


def open_browser_nonblocking(url):
    """Open the browser without ever stalling the calling script (webbrowser.open can block on macOS)."""
    try:
        if os.name == "nt":
            os.startfile(url)  # returns at once
        else:
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    except Exception:
        pass


def _rotate(log_path, limit=5 * 1024 * 1024):
    try:
        if log_path.is_file() and log_path.stat().st_size > limit:
            log_path.replace(log_path.with_suffix(log_path.suffix + ".1"))
    except OSError:
        pass


def _detached_options():
    if os.name != "nt":
        return {"start_new_session": True}
    # Outlive the PowerFactory process: no console, own process group, out of its job object when allowed.
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    return {"creationflags": flags | getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)}


def _choose_port(host, port, notes):
    """The fixed port when it is free, otherwise any free one (noted in `notes`)."""
    with socket.socket() as sock:
        try:
            sock.bind((host, port))
            return sock.getsockname()[1]
        except OSError:
            if not port:
                raise
    notes.append(f"Port {port} is in use; a free port is used instead.")
    with socket.socket() as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


def _spawn_server(command, root, env, log, notes):
    options = dict(cwd=root / "backend", env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    try:
        return subprocess.Popen(command, **options, **_detached_options())
    except OSError:
        # Breaking away from the caller's job object can be forbidden; retry as a plain child.
        fallback = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        process = subprocess.Popen(command, **options, **fallback)
        notes.append("The server is tied to the calling process; set up autostart for permanent operation.")
        return process


def _wait_until_serving(process, url, database, log_path):
    """Block until the server answers for `database`; stop it and raise when it cannot."""
    try:
        for _ in range(150):
            if process.poll() is not None:
                raise RuntimeError("Dashboard stopped. Log: " + str(log_path))
            if serves_database(url, database, timeout=0.5):
                return
            time.sleep(0.1)
        raise RuntimeError("Dashboard did not start in time. Log: " + str(log_path))
    except BaseException:
        process.terminate()
        process.wait(timeout=5)
        raise


def launch_dashboard(
    database_path,
    *,
    port=0,
    python=None,
    open_browser=True,
    root=ROOT,
    host="127.0.0.1",
    reuse=False,
    production=False,
):
    """Start the dashboard server for one database, or reuse the one that already serves it.

    With `reuse=True` a running server for the same database is kept (it follows new results by
    itself) instead of starting a second one. A busy fixed port for a different server falls back to a
    free one and says so in `notes`.
    """
    interpreter = validate_installation(root, python)
    database = Path(database_path).expanduser().resolve()
    if not database.is_file():
        raise RuntimeError("Results database does not exist: " + str(database))
    notes = []
    local = lambda number: f"http://127.0.0.1:{number}"  # noqa: E731
    log_path = database.parent / (database.stem + ".dashboard.log")

    def result(number, pid, process, reused):
        if open_browser:
            open_browser_nonblocking(local(number))
        return {
            "pid": pid,
            "url": local(number),
            "lan_urls": lan_urls(number, host),
            "log": str(log_path),
            "process": process,
            "reused": reused,
            "notes": notes,
        }

    if reuse:
        state = read_state(database)
        if state and serves_database(state.get("url", ""), database):
            return result(int(state["port"]), state.get("pid"), None, True)
        if port and serves_database(local(port), database):
            return result(port, None, None, True)

    chosen = _choose_port(host, port, notes)
    env = {**os.environ, "ANALYSIS_MODE": "sqlite", "ANALYSIS_DB_PATH": str(database)}
    if production:
        env["APP_ENV"] = "production"
    _rotate(log_path)
    command = [str(interpreter), "-m", "uvicorn", "app.main:app", "--host", host, "--port", str(chosen)]
    with log_path.open("a", encoding="utf-8") as log:
        process = _spawn_server(command, root, env, log, notes)
    _wait_until_serving(process, local(chosen), database, log_path)
    state = {"pid": process.pid, "url": local(chosen), "port": chosen, "host": host, "database": str(database), "log": str(log_path)}
    (database.parent / (database.stem + ".dashboard.json")).write_text(json.dumps(state, indent=2), encoding="utf-8")
    return result(chosen, process.pid, process, False)
