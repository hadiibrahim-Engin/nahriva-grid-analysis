"""Exercise the production server with temporary SQLite data and a local account.
No Oracle connection, existing database or persistent user credential is required.
Run after npm run build: backend/.venv/bin/python scripts/smoke_production.py
"""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.analysis.repository import AnalysisRepository
from app.analysis.seed import demo_bundles
from app.auth.local import hash_password


def main():
    with tempfile.TemporaryDirectory(prefix="nahriva-production-") as directory:
        database = Path(directory) / "smoke.sqlite3"
        repo = AnalysisRepository(str(database))
        repo.import_bundle(next(demo_bundles()))
        repo.close()
        password = secrets.token_urlsafe(24)
        env = {**os.environ, "APP_ENV": "production", "ANALYSIS_MODE": "sqlite", "ANALYSIS_DB_PATH": str(database),
               "AUTH_BACKEND": "local", "LOCAL_USERNAME": "smoke-reader", "LOCAL_PASSWORD_HASH": hash_password(password),
               "SECRET_KEY": secrets.token_hex(32), "DB_NAME": "", "DATABASE_URL": "", "DUCKDB_ENABLED": "false"}
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        with (Path(directory) / "server.log").open("w+") as log:
            process = subprocess.Popen([sys.executable,"-m","uvicorn","app.main:app","--host","127.0.0.1","--port",str(port)],cwd=ROOT/"backend",env=env,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    if process.poll() is not None: raise RuntimeError("Production server did not start")
                    try:
                        with urlopen(base+"/api/health",timeout=.5): break
                    except OSError: time.sleep(.1)
                else: raise RuntimeError("Production startup timed out")
                with urlopen(base+"/") as response:
                    html=response.read().decode(); assert 'assets/' in html and response.headers.get("Cache-Control")
                with urlopen(base+"/api/health/ready") as response: assert json.load(response)["status"]=="ready"
                try: urlopen(base+"/api/analysis/runs")
                except HTTPError as error: assert error.code==401
                else: raise AssertionError("Stored data was accessible without authentication")
                form=urlencode({"username":"smoke-reader","password":password}).encode()
                with urlopen(Request(base+"/api/auth/login",data=form,method="POST")) as response: token=json.load(response)["access_token"]
                headers={"Authorization":f"Bearer {token}"}
                with urlopen(Request(base+"/api/analysis/runs",headers=headers)) as response: runs=json.load(response)
                assert len(runs)==1
                query="run_id=demo-reference&metric_id=loading&element_ids=elm-001"
                with urlopen(Request(base+"/api/analysis/query?"+query,headers=headers)) as response:
                    result=json.load(response); assert result["stats"]["count"]==192
                with urlopen(Request(base+"/api/analysis/export.csv?"+query,headers=headers)) as response:
                    assert 'ElmLne' in response.read().decode()
                print("PASS: production startup, SPA, readiness, protected SQL data, local login, analysis and CSV export")
            except Exception:
                log.flush(); log.seek(0); print(log.read(),file=sys.stderr)
                raise
            finally:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == "__main__": main()
