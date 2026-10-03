"""Open an existing results database in the local dashboard and keep it running until Ctrl+C."""

import argparse
from pathlib import Path

from dashboard_launcher import launch_dashboard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True, help="Absolute path of the results database.")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    from app.analysis.bootstrap import close_repositories, select_database

    database = Path(select_database(str(args.db.expanduser().resolve())))
    close_repositories()
    dashboard = launch_dashboard(database, port=args.port, open_browser=not args.no_browser)
    print("Outage Assessment", flush=True)
    print("Database: " + str(database), flush=True)
    print("Dashboard: " + dashboard["url"], flush=True)
    print("Ctrl+C stops this dashboard server.", flush=True)
    try:
        code = dashboard["process"].wait()
        if code:
            raise RuntimeError("Dashboard stopped. Log: " + dashboard["log"])
    except KeyboardInterrupt:
        dashboard["process"].terminate()
        dashboard["process"].wait(timeout=5)


if __name__ == "__main__":
    main()
