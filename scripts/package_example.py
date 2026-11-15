"""Build the Windows test package of the IEEE 39-bus example: database, network map, start script and checklist.

    backend/.venv/bin/python scripts/package_example.py            -> release/ieee39-example.zip

For a test on a Windows PC before the rollout: unpack the ZIP into the installed folder (next to setup.cmd) and
double-click ieee39-example\\start-example.cmd. The example is synthetic test data (backend/tests/ieee39.py) and is
therefore not part of the release package; it is built fresh for every package (about 40 s), through the real
import path, and stored as one checked database file without WAL files.
"""

import argparse
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.simulation import values  # noqa: E402

FOLDER = "ieee39-example"
PORT = 8770  # loopback only; leaves 8765 to the dashboard of the installation

START_CMD = rf"""@echo off
rem Opens the IEEE 39-bus example in the dashboard of this installation (test only, this PC only).
setlocal
set "ROOT=%~dp0.."
set "PY=%ROOT%\backend\.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo The dashboard is not set up in %ROOT%. Run setup.cmd there first, then start this again.
  pause
  exit /b 1
)
echo Example dashboard: http://127.0.0.1:{PORT}   (close this window or press Ctrl+C to stop it)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:{PORT}'"
"%PY%" "%ROOT%\scripts\serve.py" --db "%~dp0ieee39.sqlite3" --host 127.0.0.1 --port {PORT}
if errorlevel 1 pause
"""

README = f"""IEEE 39-bus example: test the dashboard on a Windows PC before the rollout
===========================================================================

Content
  ieee39.sqlite3       results database: IEEE 39-bus transmission system (39 busbars, 34 lines, 12 transformers),
                       two analyses (base case and 6 % more load), each with 6 planned outages, QDS and n-1
                       results, active power of loads, generators and branches (DC load flow). Topology public,
                       demand and dispatch from the IEEE case, ratings and profiles synthetic.
  ieee39.values\\       the raw values: one Parquet file per run (and its series, elements, limits); belongs to the
                       database, keep both together
  maps\\ieee39.svg      network map in the format of a Figma SVG export (layers in the group "Elements")
  start-example.cmd    opens the example in the dashboard of this installation (http://127.0.0.1:{PORT})

Use
  1. Set up the release package as usual (setup.cmd). The example needs no PowerFactory.
  2. Unpack this ZIP into the installed folder, so that ieee39-example sits next to setup.cmd.
  3. Double-click ieee39-example\\start-example.cmd. The browser opens after a few seconds.
     Port {PORT} on 127.0.0.1 only: no firewall rule, no administrator rights; the dashboard of the installation
     keeps port 8765. Close the window to stop the example.

Checklist (tick each point; details in docs\\DEPLOYMENT.md, section "Test before the rollout")
  [ ] Dashboard opens; the Analysis field lists two analyses with 6 cases each, status complete (newest shown)
  [ ] Key figures, Assessment, Matrix: in both analyses 5 of 6 maintenances overload neighbouring branches
      (Trf 12 - 13 does not)
  [ ] Scenario "Maintenance Line 02 - 03" -> Network at a time: critical time inside the outage window
  [ ] Network map button: map appears; Line 02 - 03 grey dashed, Line 26 - 27 red (about 137 %); hover shows
      the value; click opens the element in Asset; wheel zooms around the pointer, dragging moves; below the
      map: 85 of 85 layers matched, 29 loads and generators without a layer (not drawn on this map)
  [ ] Network map button again: map hidden (stays hidden after reloading)
  [ ] n-1 review: "before -> after" per branch names the outage that causes it; the Sankey below links
      failing to overloaded branches; "Without maintenance" switches to the plain n-1 sweep
  [ ] Charts -> Add chart -> n-1 contingencies: "before -> after" shows for S01 Line 01 - 02 at about 243 %
      when Line 26 - 27 fails; the Sankey links the failing branches to the branches they overload
  [ ] Compare: tick both analyses -> every check ok, 6 scenario pairs; Elements of a pair: 44 of 46 branches
      higher in B (6 % more load)
  [ ] Areas: table of Area East, North, West; North imports (red), East exports; the flow graph shows arrows
      from East and West into North; balance chart, transit and day heat map appear
  [ ] Time range and calculation-status filters change the views
  [ ] Archive (optional, needs pyarrow): backend\\.venv\\Scripts\\python.exe scripts\\export_parquet.py
      --db ieee39-example\\ieee39.sqlite3 --out ieee39-example\\archive  ->  "Archive written and verified"
  [ ] Close the window: the dashboard on port {PORT} stops; the installation's dashboard is untouched

Remove: delete the folder ieee39-example. It is not used by the installation.
"""


def generate(folder):
    """The example database and map in `folder`, through the real import path (backend/tests/ieee39.py)."""
    database = folder / "ieee39.sqlite3"
    subprocess.run([sys.executable, "-m", "tests.ieee39", "--db", str(database)], cwd=ROOT / "backend", check=True)
    return database, folder / "maps" / "ieee39.svg"


def consistent_copy(source, target):
    """A complete copy of a database that may be open elsewhere, as one file without WAL, checked for integrity."""
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    db = sqlite3.connect(target)
    try:
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("VACUUM")
        problem = db.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        db.close()
    if problem != "ok":
        raise SystemExit(f"The copied database is damaged: {problem}")


def build(out_dir=ROOT / "release", database=None, map_svg=None):
    """Write <out_dir>/ieee39-example.zip and return its path; without `database` the example is built fresh."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "ieee39-example.zip"
    with tempfile.TemporaryDirectory() as scratch:
        if database is None:
            database, map_svg = generate(Path(scratch) / "build")
        copy = Path(scratch) / "ieee39.sqlite3"
        consistent_copy(database, copy)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(copy, f"{FOLDER}/ieee39.sqlite3")
            # The raw values: one Parquet file per run beside the database (already compressed, stored as they are).
            for file in sorted(values.folder(database).glob("*.parquet")):
                archive.write(file, f"{FOLDER}/{values.folder(copy).name}/{file.name}", compress_type=zipfile.ZIP_STORED)
            archive.write(map_svg, f"{FOLDER}/maps/ieee39.svg")
            archive.writestr(f"{FOLDER}/start-example.cmd", START_CMD.replace("\n", "\r\n"))
            archive.writestr(f"{FOLDER}/README.txt", README.replace("\n", "\r\n"))
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=ROOT / "release", help="folder of the ZIP (default: release)")
    args = parser.parse_args()
    target = build(out_dir=args.out)
    print(f"Windows test package: {target} ({target.stat().st_size / 1e6:.1f} MB)")
    print("On the Windows PC: unpack it next to setup.cmd and double-click ieee39-example\\start-example.cmd")
    return 0


if __name__ == "__main__":
    sys.exit(main())
