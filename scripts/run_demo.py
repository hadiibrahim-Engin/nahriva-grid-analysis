"""Create dummy QDS results and keep the local dashboard running until Ctrl+C."""

import argparse
from pathlib import Path

from dashboard_launcher import ROOT, launch_dashboard
from seed_dummy_qds import create_dummy_database


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db", type=Path, default=ROOT / "backend/data/outage-assessment-demo.sqlite3"
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument(
        "--existing",
        action="store_true",
        help="Vorhandene Ergebnisdatenbank öffnen; keine Dummy-Daten erzeugen.",
    )
    args = parser.parse_args()
    if args.existing:
        from app.analysis.bootstrap import close_repositories, select_database

        database = Path(select_database(str(args.db.expanduser().resolve())))
        close_repositories()
    else:
        database = create_dummy_database(args.db)
    dashboard = launch_dashboard(
        database, port=args.port, open_browser=not args.no_browser
    )
    print(
        "Outage Assessment" + ("" if args.existing else " · Dummy QDS (synthetisch)"),
        flush=True,
    )
    print("Datenbank: " + str(database), flush=True)
    print("Dashboard: " + dashboard["url"], flush=True)
    print("Ctrl+C beendet diesen Dashboard-Server.", flush=True)
    try:
        code = dashboard["process"].wait()
        if code:
            raise RuntimeError("Dashboard beendet. Log: " + dashboard["log"])
    except KeyboardInterrupt:
        dashboard["process"].terminate()
        dashboard["process"].wait(timeout=5)


if __name__ == "__main__":
    main()
