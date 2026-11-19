"""Network maps: SVG exported from Figma, layers matched to the elements of an analysis."""

import pytest
from fastapi.testclient import TestClient

from app.simulation import maps, settings, timepoint
from app.simulation.store import ScenarioStore
from tests import ieee39, large_dataset

SVG = """<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
<g id="Frame_1"><rect id="Background" width="100" height="100" fill="white"/>
<g id="Elements">
<path id="Line_L0" d="M0 0L10 10" stroke="#475569"/>
<path id="Line_L0_2" d="M0 5L10 15" stroke="#475569"/>
<rect id="North_Busbar_B0" width="4" height="2" fill="#0F172A"/>
<path id="Old_line_removed" d="M0 0L1 1" stroke="#475569"/>
</g><text id="Label">L0</text></g></svg>"""


@pytest.fixture(scope="module")
def database(tmp_path_factory):
    path = tmp_path_factory.mktemp("maps") / "m.sqlite3"
    large_dataset.build(path, branches=6, cases=1, contingencies=0, window=24)
    (path.parent / "maps").mkdir()
    (path.parent / "maps" / "plant.svg").write_text(SVG, encoding="utf-8")
    return path


@pytest.fixture
def api(database, monkeypatch):
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(database))
    monkeypatch.delenv("OA_MAP_DIR", raising=False)
    from app.main import app
    with TestClient(app) as client:
        yield client


def test_the_example_map_has_one_layer_per_element_of_the_example_network():
    model = ieee39.Ieee39()
    layers = {maps.key(layer) for layer in maps.element_layers(ieee39.map_svg())}
    assert layers == {maps.key(e.loc_name) for e in model.branches + model.buses + model.sources}
    assert len(layers) == 34 + 12 + 39 + 10


def test_layers_match_by_name_or_grid_and_name_and_leftovers_are_reported(database, monkeypatch):
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(database))
    store = ScenarioStore(str(database))
    try:
        result = maps.match(store.db, "plant")
        names = dict(store.db.execute("SELECT element_id, name FROM gl_elements").fetchall())
    finally:
        store.close()
    assert {layer: names[result["elements"][i][0]] for layer, i in result["layers"].items()} == {
        "Line_L0": "Line L0", "Line_L0_2": "Line L0", "North_Busbar_B0": "Busbar B0"}
    assert result["repeated_layers"] == ["Line_L0_2"]  # Figma numbers a repeated layer name
    assert result["unmatched_layers"] == ["Old_line_removed"]  # drawing outside "Elements" is not counted
    assert result["counts"] == {"layers": 4, "matched": 3, "elements": len(names),
                                "elements_without_layer": len(names) - 2}


def test_unsafe_or_unusable_maps_are_refused(database, monkeypatch, tmp_path):
    monkeypatch.setenv("OA_MAP_DIR", str(tmp_path))
    (tmp_path / "entities.svg").write_text('<!DOCTYPE svg [<!ENTITY a "x">]><svg><g id="Elements"/></svg>')
    (tmp_path / "flat.svg").write_text('<svg><path id="Line_L0"/></svg>')
    with pytest.raises(ValueError, match="DOCTYPE"):
        maps.element_layers(maps.read("entities"))
    with pytest.raises(ValueError, match="Elements"):
        maps.element_layers(maps.read("flat"))
    assert maps.read("../m") is None and maps.read("missing") is None


def test_map_values_come_as_columns_in_the_order_of_the_matched_elements(database, monkeypatch):
    monkeypatch.setattr(settings, "ANALYSIS_DB_PATH", str(database))
    store = ScenarioStore(str(database))
    try:
        scenario = store.db.execute("SELECT id FROM pf_scenarios").fetchone()[0]
        t = store.db.execute("SELECT MIN(t) FROM pf_run_times").fetchone()[0]
        result = maps.values(store, "plant", scenario, t)
        order = [e[1] for e in maps.match(store.db, "plant")["elements"]]
        snapshot = {r["name"]: r for metric in ("loading", "voltage")
                    for r in timepoint.snapshot(store, scenario, t, metric, limit=10_000)["rows"]}
        assert maps.values(store, "plant", "nope", t) is None
    finally:
        store.close()
    assert order == ["Line L0", "Busbar B0"]
    assert result["m"] == [0, 1]  # a branch by loading, a busbar by voltage
    for i, name in enumerate(order):
        assert result["v"][i] == pytest.approx(snapshot[name]["value"], abs=1e-4)
        assert result["r"][i] == pytest.approx(snapshot[name]["ref"], abs=1e-4)


def test_the_map_api_lists_serves_without_scripts_and_matches(api):
    assert [m["name"] for m in api.get("/api/simulation/maps").json()["maps"]] == ["plant"]
    svg = api.get("/api/simulation/maps/plant.svg")
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    assert "default-src 'none'" in svg.headers["content-security-policy"]
    assert api.get("/api/simulation/maps/plant/match").json()["counts"]["matched"] == 3
    assert api.get("/api/simulation/maps/nope/match").status_code == 404
