# Outage Assessment

The PowerFactory script runs the Outage Assessment of GridLensAssessment (`main_qt.py` 8.2): its case manager
selects cases and settings, its native QDS/n-1/(n-1)' pipeline calculates and keeps `ElmRes` results. Instead
of a PDF report the raw results are imported into a local database and the dashboard opens as soon as the first
case is stored. Workflow, result contract and widget API: [docs/GRIDLENS.md](docs/GRIDLENS.md).

Dashboard for exploring planned outages calculated in PowerFactory. The PowerFactory script
opens GridLens, calculates the chosen scenarios and stores complete native results in a SQLite file; the dashboard
reads that file and shows, per scenario, whether the outage is permissible, conditionally
permissible or not permissible, with the reasons.

Everything runs on one PC, as a normal user: no administrator rights, no firewall rule, no
service and no extra network port. The dashboard listens on `127.0.0.1` on one port (default 8765).
One script sets everything up (`setup.cmd`), one script runs in PowerFactory (`powerfactory/start_assessment.py`).

## Quick start (Windows, PowerFactory PC)

1. Copy the project folder (or unpack the release package) to the PC, for example to
   `C:\OutageAssessment`.
2. In PowerFactory add **one** script: create a `ComPython` object (external script file) that points to

   ```
   C:\OutageAssessment\powerfactory\start_assessment.py
   ```

3. Activate the project and study case and execute the script. On first start it automatically prepares
   the backend packages and frontend build. A Windows progress window shows the six setup steps, an activity
   indicator and live output. Missing Node is downloaded locally; Python is chosen to match PowerFactory.
   Internet access is needed for downloads. PowerFactory must use Python 3.12 or newer.
4. After setup the case manager opens automatically. Define the cases and assessments and calculate.
   **The browser opens as soon as the first case is stored** (default `http://127.0.0.1:8765`).

Later starts reuse the installation. Incomplete builds and missing backend packages trigger automatic repair.
Setup failures display the reason and point to `.tools\setup.log`; run the script again after fixing the cause.
An incompatible existing backend environment is preserved as `backend/.venv.backup-<id>` before replacement.
`setup.cmd` / `setup.ps1` remain available for manual setup, offline installation and advanced options.

Build a release package for other PCs with `.\setup.ps1 -Package`
(`release\outage-assessment-<version>.zip`). More options: `Get-Help .\setup.ps1 -Detailed`.

The automatic setup matches PowerFactory's Python major/minor version. For manual setup, use
`.\setup.ps1 -PythonVersion 3.12 -Python C:\path\to\python.exe` (replace 3.12 with PowerFactory's version).
Untick **n-0** to run n-1 without QDS: the **n-1 time step** in Settings samples the outage windows.
The **PowerFactory assessment** panel shows the original 8.2 findings and contingency extremes; the dashboard
analysis below uses its own adjustable criteria. Earlier imports have no stored original assessment.

## Try it on this computer

```bash
scripts/try_example.sh
```

Builds the IEEE 39-bus transmission system as a synthetic run through the real import path (with its network map
in the Figma export format) and opens the dashboard; `--fresh` builds it again. Map: [docs/MAP.md](docs/MAP.md).
For a test on a Windows PC before the rollout, `backend/.venv/bin/python scripts/package_example.py` builds
`release/ieee39-example.zip` (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), "Test before the rollout").

## Quick start (macOS, development)

Requirements: Node.js >= 22.13, npm and uv.

```bash
./start-dashboard.command --db /path/to/results.sqlite3 --port 18017
```

Double-clicking `start-dashboard.command` asks for the path instead. The starter installs the
dependencies, builds the frontend, checks the database (it never creates or overwrites it) and opens
the browser. **Ctrl+C** stops the server.

## What the dashboard shows

The standard view is the **summary**: key figures, an assessment per scenario with reasons, the
profile of the chosen scenario, busbar voltage, a matrix of all equipment (lines and transformers),
comparison charts, a radar plot and a detail table. A navigation bar follows this reading order.

- **Little text:** explanations are off. The **i** on a card opens its explanation; **Explanations**
  shows all of them.
- **Large databases:** data loads scenario by scenario, heavy sections only when they are scrolled
  into view.
- The **time series overlay** is an optional view under the summary. Further charts of selected
  signals or of all scenarios come from **Add chart** (see [docs/ASSESSMENT.md](docs/ASSESSMENT.md)).
- Thresholds and criteria are central in `frontend/src/config/`.
- The page scrolls continuously; the left navigation highlights the visible section and jumps to it on click.
- n-1 results load after **Load n-1 results**; equipment extremes stay hidden until **Show n-1 extremes**.
- The loading profile supports time/loading sliders, Ctrl + mouse wheel, dragging to pan and **Reset zoom**.
- Light and dark themes; the database button in the header loads another results file (only when
  the server is not exposed to the network).

Definitions, criteria, LODF, API and customisation: [docs/ASSESSMENT.md](docs/ASSESSMENT.md).

## Scenarios

Define cases, fixed background outages, network scope and n-1 options in the **case manager** that opens when
the script runs. Its Results choice loads a kept run without recalculation. Period, step size, profiles and
result variables come from the active `ComStatsim`; the script restores every PowerFactory setting it changes
(verified) and creates no `IntScenario` objects. Details: [docs/GRIDLENS.md](docs/GRIDLENS.md).

## Settings

`outage-assessment.config.json` in the project folder (template:
`outage-assessment.config.example.json`) sets `database`, `host` and `port`. The environment
variables `OA_DATABASE`, `OA_HOST` and `OA_PORT` take precedence. The PowerFactory script and the
autostart use the same file, so both work on the same database.

## Development and checks

```bash
bash scripts/dev.sh                                 # API and Vite dev server, both on 127.0.0.1
bash scripts/check.sh                               # ruff, pytest, frontend checks, build, npm audit
backend/.venv/bin/python scripts/smoke_production.py
```

`azure-pipelines.yml` runs the same checks on Azure DevOps (Linux) and then builds the release ZIP on Windows
(`setup.ps1 -Package`), sets it up on a clean folder and publishes it as the artifact `outage-assessment-release`.

Backend tests use a synthetic results database (`backend/tests/qds_fixture.py`) and a native API
replacement for PowerFactory. To try the dashboard with a large amount of data without PowerFactory,
`backend/tests/large_dataset.py` runs the real path (main.py runtime, restoration, case-by-case import, n-1
summaries) against synthetic PowerFactory objects: by default 330 branches and 330 busbars over a year, REF and 6
planning cases, n-1 and (n-1)' with 100 contingencies (about 28 million QDS values, 95 million n-1 cells, 1 GB,
one minute). It is development only and not part of the release ZIP.

```bash
cd backend
.venv/bin/python -m tests.large_dataset          # options: --branches --cases --contingencies --window --spacing --db
# 100,000 branches without n-1 over a few days (2 GB, about 2.5 min):
.venv/bin/python -m tests.large_dataset --branches 100000 --cases 2 --contingencies 0 --window 24 --spacing 48 --db data/big.sqlite3
.venv/bin/python ../scripts/run_dashboard.py --db data/synthetic-large.sqlite3
```

A real PowerFactory 2026 run on Windows is still required; the mapping of ElmRes timestamps to outage windows
is part of that acceptance.

More: [PowerFactory workflow and data](docs/GRIDLENS.md) · [Database](docs/DATABASE.md) ·
[Deployment](docs/DEPLOYMENT.md) · [Storage and Parquet archive](docs/STORAGE.md) ·
[Areas: load, generation, transit](docs/AREAS.md) ·
[Performance review and restore benchmarks](docs/PERFORMANCE.md) · [Complete SQLite/Parquet export](docs/DATABASE.md#complete-access-across-sqlite-and-parquet-layout-15) · [Troubleshooting](backend/DEBUGGING.md).
