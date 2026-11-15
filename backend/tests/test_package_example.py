"""The Windows test package of the example: one checked database file, the map, a start script and a checklist."""

import importlib.util
import sqlite3
import zipfile
from pathlib import Path

import pytest

from app.simulation import values
from tests import ieee39, large_dataset, stored_values

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "package_example.py"
spec = importlib.util.spec_from_file_location("package_example", SCRIPT)
package_example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_example)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    folder = tmp_path_factory.mktemp("example")
    database = folder / "ieee39.sqlite3"
    large_dataset.build(database, branches=6, cases=1, contingencies=0, window=24)
    open_reader = sqlite3.connect(database)  # a dashboard still has it open: the package must not depend on it
    open_reader.execute("SELECT COUNT(*) FROM pf_scenarios").fetchone()
    svg = folder / "ieee39.svg"
    svg.write_text(ieee39.map_svg(), encoding="utf-8")
    target = package_example.build(out_dir=folder / "release", database=database, map_svg=svg)
    open_reader.close()
    return target, database


def test_the_package_holds_one_checked_database_the_map_and_windows_files(built, tmp_path):
    target, database = built
    with zipfile.ZipFile(target) as archive:
        names = set(archive.namelist())
        assert {n for n in names if n.endswith(".parquet")} == {
            "ieee39-example/ieee39.values/" + f.name for f in values.folder(database).glob("*.parquet")}
        assert names - {n for n in names if n.endswith(".parquet")} == {
            "ieee39-example/ieee39.sqlite3", "ieee39-example/maps/ieee39.svg",
            "ieee39-example/start-example.cmd", "ieee39-example/README.txt"}  # no WAL or SHM file
        start = archive.read("ieee39-example/start-example.cmd").decode()
        readme = archive.read("ieee39-example/README.txt").decode()
        archive.extractall(tmp_path)
    assert "\r\n" in start and "\n" not in start.replace("\r\n", "")  # Windows line ends
    assert "--host 127.0.0.1 --port 8770" in start and "setup.cmd" in start
    assert "[ ]" in readme and "8770" in readme
    copy = sqlite3.connect(tmp_path / "ieee39-example/ieee39.sqlite3")
    try:
        assert copy.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        count = stored_values.count(copy)  # the database and its value folder travel together
    finally:
        copy.close()
    with sqlite3.connect(database) as source:
        assert count == stored_values.count(source) > 0


def test_the_example_has_two_analyses_to_compare():
    assert ieee39.RUNS == (1.0, 1.06)
    base, more = ieee39.Ieee39(1.0), ieee39.Ieee39(1.06)
    t = ieee39.YEAR_START + 30 * 86400
    assert all(more.demand(n, t) > base.demand(n, t) for n in ieee39.LOADS)
