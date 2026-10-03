# Start-up and PowerFactory diagnostics

`/api/health/ready` returns readiness and the actual database path.
`/api/simulation/outage-management` shows catalog, jobs and saved scenarios.

On the Mac use `./start-dashboard.command --db <file>`. The terminal shows the URL with the chosen
port. A synthetic database for the browser smoke test is created with
`cd backend && .venv/bin/python -c "from tests.qds_fixture import create_dummy_database as c; print(c('/tmp/smoke.sqlite3'))"`.
Missing measurements in the dashboard: choose equipment and measurement and click Add. The whole
simulation is always read.

Native execution: run `powerfactory/start_assessment.py` as an external ComPython script. Check the
active project, study case, ComStatsim period and ElmRes variables. `DATABASE_DIRECTORY` /
`DATABASE_NAME` determine the same file that the launcher passes to FastAPI afterwards. There is no
login configuration.

For server errors read `<database>.dashboard.log`. URL and PID are in `<database>.dashboard.json`.
After an aborted PowerFactory process first check the original state of outages, the QDS option and
the result binding. Running jobs are not re-run automatically; previous results are kept.
