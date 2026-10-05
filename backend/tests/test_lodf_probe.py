"""powerfactory/lodf_probe.py: the stand-alone LODF test names the stage that fails."""

from tests.test_lodf import NativeApp  # also puts powerfactory/ on the import path

import lodf_probe  # noqa: E402


def printed(app):
    return "\n".join(app.printed)


def test_all_three_stages_run_and_the_values_are_shown():
    app = NativeApp()
    assert lodf_probe.run(app) == "ok"
    text = printed(app)
    assert "STAGE 1/3" in text and "STAGE 2/3" in text and "STAGE 3/3" in text
    assert "2 of 2 outages have a LODF" in text
    assert app.distribution.lodflim == 10 and app.distribution.calcLodf == 1  # put back
    assert app.distribution.pComSimoutage is app.user_analysis  # the user's analysis is linked again


def test_a_contingency_that_cannot_be_filled_stops_at_stage_2():
    app = NativeApp(fail_setobjs=True)
    verdict = lodf_probe.run(app)
    assert verdict.startswith("stage 2")
    assert "STAGE 3/3" not in printed(app)


def test_a_study_case_that_cannot_create_the_analysis_stops_at_stage_2_with_the_reason():
    app = NativeApp(fail_create="read-only project")
    verdict = lodf_probe.run(app)
    assert verdict.startswith("stage 2") and "read-only project" in printed(app)


def test_a_failing_execution_stops_at_stage_3_and_the_settings_are_put_back():
    app = NativeApp()
    app.fail_with = 1
    verdict = lodf_probe.run(app)
    assert verdict.startswith("stage 3") and "error code 1" in verdict
    assert app.distribution.lodflim == 10 and app.distribution.pComSimoutage is app.user_analysis


def test_an_outage_without_a_solution_is_reported_not_hidden():
    app = NativeApp(unsolvable=("A", "E"))
    assert lodf_probe.run(app) == "some outages have no LODF"
    assert "1 of 2 outages have a LODF" in printed(app)


def test_what_was_created_is_deleted_when_asked(monkeypatch):
    app = NativeApp()
    monkeypatch.setattr(lodf_probe, "CLEAN_UP", True)
    assert lodf_probe.run(app) == "ok"
    assert "LODF Probe" in app.deleted


def test_the_outages_to_test_can_be_named(monkeypatch):
    app = NativeApp()
    first = app.outages[0].loc_name
    monkeypatch.setattr(lodf_probe, "OUTAGES", [first])
    assert lodf_probe.run(app) == "ok"
    assert "1 of 1 outages have a LODF" in printed(app)


def test_extra_settings_are_set_for_the_run_and_put_back(monkeypatch):
    app = NativeApp()
    app.distribution.someFactor = 0
    monkeypatch.setattr(lodf_probe, "EXTRA_SETTINGS", {"someFactor": 1})
    assert lodf_probe.run(app) == "ok"
    assert "someFactor = 1: set" in printed(app)
    assert app.distribution.someFactor == 0


def test_every_attribute_of_the_command_is_listed_with_its_value():
    app = NativeApp()
    app.GetAvailableAttributes = lambda class_name, *args: "e:calcLodf\ne:lodflim\ne:iopt_cont\n"
    app.distribution.iopt_cont = 0
    assert lodf_probe.run(app) == "ok"
    text = printed(app)
    assert "3 attributes" in text and "iopt_cont" in text


def test_consider_contingencies_is_switched_on_for_the_run_and_back_off():
    """PowerFactory 2026 stops with "Please enable at least one sensitivity factor" when it is off, although LODF is on."""
    app = NativeApp()
    app.distribution.isContSens = 0
    original = app.distribution.Execute
    app.distribution.Execute = lambda: 1 if not app.distribution.isContSens else original()
    assert lodf_probe.run(app) == "ok"
    assert app.distribution.isContSens == 0  # as it was


def test_the_output_names_the_version_of_the_file_that_ran():
    app = NativeApp()
    lodf_probe.run(app)
    assert "LODF PROBE · version {}".format(lodf_probe.VERSION) in printed(app)
    assert "version {} · OK".format(lodf_probe.VERSION) in printed(app)


def test_the_probe_is_one_file_that_needs_nothing_else_of_the_project():
    import ast
    import inspect

    imported = {n.names[0].name.split(".")[0] for n in ast.walk(ast.parse(inspect.getsource(lodf_probe))) if isinstance(n, ast.Import)}
    imported |= {n.module.split(".")[0] for n in ast.walk(ast.parse(inspect.getsource(lodf_probe))) if isinstance(n, ast.ImportFrom)}
    assert imported <= {"datetime", "traceback", "powerfactory"}

