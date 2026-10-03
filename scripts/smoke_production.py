"""Verify built Outage Assessment against an isolated dummy QDS SQLite database."""

import json
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen
from dashboard_launcher import ROOT, launch_dashboard

sys.path.insert(0, str(ROOT / "backend"))
from tests.qds_fixture import create_dummy_database, STEPS  # noqa: E402


def main():
    with tempfile.TemporaryDirectory(prefix="outage-assessment-smoke-") as directory:
        database = create_dummy_database(Path(directory) / "dummy.sqlite3")
        dashboard = launch_dashboard(database, open_browser=False)
        base = dashboard["url"]
        try:
            with urlopen(base + "/") as response:
                html = response.read().decode()
                assert (
                    "Outage Assessment" in html
                    and "assets/" in html
                    and response.headers.get("Cache-Control")
                )
            with urlopen(base + "/api/simulation/facilities") as response:
                runs = json.load(response)
            assert len(runs) == 16
            with urlopen(
                base + "/api/simulation/facilities/" + runs[0]["id"] + "/components"
            ) as response:
                component = next(
                    e for e in json.load(response) if e["name"] == "Line North–West"
                )
            with urlopen(
                base + "/api/simulation/timeseries/raw/" + component["id"] + "/L"
            ) as response:
                series = json.load(response)
            assert len(series["data"]) == STEPS and series["data"][0][
                "timestamp"
            ].startswith("2026-01-31")
            for route in ("/api/simulation/auth/login", "/api/auth/login"):
                try:
                    urlopen(base + route)
                except HTTPError as exc:
                    assert exc.code == 404
                else:
                    raise AssertionError("Login route still exists")
            print(
                "PASS: SPA, local launcher, isolated named QDS scenarios, complete raw rows without dates, no login"
            )
        finally:
            dashboard["process"].terminate()
            dashboard["process"].wait(timeout=5)


if __name__ == "__main__":
    main()
