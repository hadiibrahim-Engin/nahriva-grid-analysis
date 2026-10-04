# Outage Assessment

Dashboard for assessing planned outages calculated in PowerFactory. A single PowerFactory script
calculates the outage scenarios and stores REF and OUTAGE results in a SQLite file; the dashboard
reads that file and shows, per scenario, whether the outage is permissible, conditionally
permissible or not permissible, with the reasons.

Everything runs on one PC, as a normal user: no administrator rights, no firewall rule, no
service and no extra network port. The dashboard listens on `127.0.0.1` on one port (default 8765).
One script sets everything up (`setup.cmd`), one script runs in PowerFactory (`powerfactory/start_assessment.py`).

## Quick start (Windows, PowerFactory PC)

1. Copy the project folder (or unpack the release package) to the PC, for example to
   `C:\OutageAssessment`.
2. Double-click **`setup.cmd`** (or run `.\setup.ps1` in a normal PowerShell). It sets up everything
   from A to Z by itself, without administrator rights and inside the folder only:
   - Python 3.12+ (uses yours; otherwise it downloads the portable `uv`, which installs Python for you),
   - the backend environment and packages,
   - the frontend build (needs Node 22.13+; if Node is missing it downloads a portable Node; a release
     package already contains the finished build),
   - `outage-assessment.config.json`, an optional per-user autostart (`-Autostart`) and a self-test.
3. In PowerFactory add **one** script: create a `ComPython` object (external script file) that points to

   ```
   C:\OutageAssessment\powerfactory\start_assessment.py
   ```

   Activate the project and study case and execute it. The script checks folder and free space,
   calculates the scenarios one after another and saves each one. **When the calculation is finished it
   starts the dashboard and opens it in your browser** (default `http://127.0.0.1:8765`).

Build a release package for other PCs with `.\setup.ps1 -Package`
(`release\outage-assessment-<version>.zip`). More options: `Get-Help .\setup.ps1 -Detailed`.

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
- Light and dark themes; the database button in the header loads another results file (only when
  the server is not exposed to the network).

Definitions, criteria, LODF, API and customisation: [docs/ASSESSMENT.md](docs/ASSESSMENT.md).

## Scenarios

`SCENARIOS = None` in `powerfactory/start_assessment.py` calculates every eligible Planned Outage in
the active QDS period, each under its own name. Alternatively define named combinations:

```python
SCENARIOS = [
    {"name": "Outage North", "outages": ["Maintenance Line North"]},
    {"name": "North with transformer", "outages": ["Maintenance Line North", "Maintenance Transformer North"]},
]
```

Use full PowerFactory object paths when names are ambiguous. Period, step size, profiles and result
variables come from the active `ComStatsim`. The script restores the native state (verified) and
creates no `IntScenario` objects. Details: [docs/POWERFACTORY.md](docs/POWERFACTORY.md).

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
replacement for PowerFactory. A real PowerFactory 2026 run on Windows is still required; the mapping
of ElmRes timestamps to outage windows is part of that acceptance.

More: [Big picture with diagrams](BIG_PICTURE.md) · [Deployment](docs/DEPLOYMENT.md) ·
[PowerFactory details](docs/POWERFACTORY.md) · [Troubleshooting](backend/DEBUGGING.md).
