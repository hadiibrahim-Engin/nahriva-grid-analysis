"""External ComPython script: tests the LODF calculation on its own, one stage at a time.

Run it in PowerFactory like start_assessment.py (active project and Study Case). It does what the assessment
does before the first simulation, but stops at the first stage that fails and says exactly what PowerFactory
answered:

    STAGE 1  load the planned outages and the equipment they switch off
    STAGE 2  create a Contingency Analysis with one contingency (ComOutage) per chosen outage, read it back
    STAGE 3  run 'Sensitivities / Distribution Factors' (ComVstab) on it and read the LODF

Nothing of the user's is changed: it works in its own Contingency Analysis (PROBE_ANALYSIS_NAME) and puts the
ComVstab settings back. What it created stays in the Study Case for inspection (CLEAN_UP = True deletes it).
Send the whole output window when a stage fails.
"""

from pathlib import Path
import sys
import traceback

PROJECT_DIR = Path(__file__).resolve().parents[1]
# Which planned outages to test: None = the first MAX_OUTAGES that switch a line, transformer or coupler,
# or a list of outage names, for example ["Outage North", "Outage South"].
OUTAGES = None
MAX_OUTAGES = 3
PROBE_ANALYSIS_NAME = "LODF Probe"  # separate from the analysis of the assessment and from the user's own
CLEAN_UP = False  # True: delete what this script created
TOP = 5  # lines shown per contingency (largest |LODF|)
# ComVstab attributes the assessment relies on; shown with their value.
VSTAB_ATTRIBUTES = ("calcLodf", "lodflim", "calcPtdf", "ptdflim", "factors4trf", "pComSimoutage", "pResult")
# More ComVstab settings for the run, put back afterwards, to try what PowerFactory asks for, for example
# {"calcPtdf": 1}. The output lists every attribute of ComVstab that looks like a switch for a sensitivity factor.
EXTRA_SETTINGS = {}
_PREFIXES = ("", "calc", "iopt_", "iopt", "i", "b", "use", "en", "do", "sel", "p")
_WORDS = ("lodf", "ptdf", "otdf", "psdf", "vsens", "sens", "factor", "factors", "dist", "distfac", "flow", "volt", "trf", "branch",
          "gen", "load", "lod", "all", "sym", "dc", "ac", "vstab", "dv", "dq", "dp", "outage", "cont", "sensitivity", "sensitivities")

sys.path.insert(0, str(PROJECT_DIR / "powerfactory"))


def forget_cached_modules(modules):
    """PowerFactory keeps its Python between runs: read this project's modules from disk again."""
    names = {path.stem for path in (PROJECT_DIR / "powerfactory").glob("*.py")} - {"__init__", Path(__file__).stem}
    for name in [n for n in modules if n in names]:
        del modules[name]


import importlib.util  # noqa: E402

if importlib.util.find_spec("powerfactory") is not None:  # only inside PowerFactory, never in tests or tools
    forget_cached_modules(sys.modules)

import gridlens_engine as engine  # noqa: E402
import lodf  # noqa: E402
from pf_console import detail, log, section, table  # noqa: E402
from pf_state import StateGuard  # noqa: E402


class Stop(Exception):
    """A stage failed; the reason was already written to the output."""


def _described(obj):
    return "{} ({})".format(engine.object_name(obj), engine.class_name(obj))


def _equipment_text(branches):
    return ", ".join(_described(b) for b in branches) or "none"


def _explain_empty(app, outage):
    """Why an outage yields no branch: what its equipment attributes and children say."""
    for attribute in engine.OUTAGE_EQUIPMENT_ATTRIBUTES:
        found = engine._as_objects(engine.safe_attr(outage, attribute))
        if found:
            detail(app, "    {} = {}".format(attribute, ", ".join(
                _described(item) if engine.class_name(item) else repr(item) for item in found)))
    try:
        children = outage.GetContents("*", 1) or []
    except Exception as exc:
        children = []
        detail(app, "    its contents cannot be listed: {}".format(exc))
    for child in children[:10]:
        detail(app, "    contains {}".format(_described(child)))


def stage_outages(app):
    """STAGE 1: the planned outages of the project and the branches they switch off."""
    section(app, "STAGE 1/3 · planned outages and their equipment")
    try:
        outages = engine._find_project_outages(app)
    except Exception as exc:
        detail(app, "Planned outages could not be loaded: {}".format(exc), "ERROR")
        raise Stop("stage 1: planned outages could not be loaded") from None
    detail(app, "{} planned outage(s) in the project.".format(len(outages)))
    rows, usable = [], []
    for outage in outages:
        record = engine._outage_record(outage)
        branches = lodf.outage_equipment(outage)
        start, end = (engine._format_pf_time(value) for value in record["window"])
        rows.append((engine.object_name(outage), engine.class_name(outage), (start + " .. " + end) if start or end else "no window",
                     _equipment_text(branches)))
        if branches:
            usable.append((outage, branches))
    table(app, ("Outage", "Class", "Window", "Branches it switches off"), rows[:60])
    if len(rows) > 60:
        detail(app, "... and {} more.".format(len(rows) - 60))
    for outage in outages:
        if not any(outage is item for item, _ in usable):
            detail(app, "No line, transformer or coupler found for '{}':".format(engine.object_name(outage)), "WARN")
            _explain_empty(app, outage)
            break  # one example is enough to see what the attributes look like
    if OUTAGES is None:
        chosen = usable[:MAX_OUTAGES]
    else:
        wanted = [name.casefold() for name in OUTAGES]
        chosen = [(o, b) for o, b in usable if engine.object_name(o).casefold() in wanted]
        for name in OUTAGES:
            if not any(engine.object_name(o).casefold() == name.casefold() for o, _ in chosen):
                detail(app, "'{}' is not a planned outage with a branch.".format(name), "WARN")
    if not chosen:
        detail(app, "Nothing to test: no planned outage switches a line, transformer or coupler.", "ERROR")
        raise Stop("stage 1: no outage with a branch")
    detail(app, "Testing: {}".format("; ".join("{} -> {}".format(engine.object_name(o), _equipment_text(b)) for o, b in chosen)))
    return chosen


def stage_contingencies(app, study_case, chosen, created):
    """STAGE 2: one ComOutage per chosen outage in our own Contingency Analysis; every step is read back."""
    section(app, "STAGE 2/3 · contingency objects (ComOutage)")
    others = [engine.object_name(a) for a in lodf._contents(study_case, "ComSimoutage")]
    detail(app, "Contingency Analyses in Study Case '{}': {}".format(engine.object_name(study_case), ", ".join(others) or "none"))
    analysis = next((a for a in lodf._contents(study_case, "ComSimoutage") if engine.object_name(a) == PROBE_ANALYSIS_NAME), None)
    try:
        if analysis is None:
            analysis = lodf._create(study_case, "ComSimoutage", PROBE_ANALYSIS_NAME)
            created.append(analysis)
            detail(app, "Created Contingency Analysis '{}'.".format(PROBE_ANALYSIS_NAME))
        else:
            detail(app, "Reusing Contingency Analysis '{}' from an earlier run; ClearCont returned {}.".format(
                PROBE_ANALYSIS_NAME, analysis.ClearCont()))
    except lodf.LodfError as exc:
        detail(app, str(exc), "ERROR")
        raise Stop("stage 2: the Contingency Analysis could not be created") from None
    rows, failed = [], False
    for outage, branches in chosen:
        name = engine.object_name(outage)
        try:
            contingency = lodf._create(analysis, "ComOutage", name)
            code = contingency.SetObjs(list(branches))
        except Exception as exc:
            detail(app, "Contingency '{}': {}".format(name, exc), "ERROR")
            failed = True
            continue
        listed = [contingency.GetObject(i) for i in range(len(branches) + 1)]
        listed = [item for item in listed if item is not None]
        same = lodf.contingency_keys(contingency) == frozenset(engine.object_key(b) for b in branches)
        failed = failed or not same or engine.finite_number(code) not in (0, None)
        rows.append((name, str(code), _equipment_text(branches), _equipment_text(listed), "ok" if same else "DIFFERENT"))
    table(app, ("Contingency", "SetObjs", "Requested", "Read back (GetObject)", "Check"), rows)
    found = lodf.contingencies(study_case, analysis)
    detail(app, "The analysis now holds {} contingency object(s): {}.".format(
        len(found), ", ".join(engine.object_name(c) for c in found) or "none"))
    if failed or not found:
        raise Stop("stage 2: the contingencies are not what was asked for")
    return analysis


def _has_attribute(obj, name):
    checker = getattr(obj, "HasAttribute", None)
    if callable(checker):
        try:
            return bool(checker(name))
        except Exception:
            pass
    return engine._read_setting(obj, name)[0]


def _candidate_names():
    names = list(VSTAB_ATTRIBUTES)
    for prefix in _PREFIXES:
        for word in _WORDS:
            for name in (prefix + word, prefix + word.capitalize(), prefix + word.upper()):
                if name not in names:
                    names.append(name)
    return names


def _available_names(app, class_name_):
    """Every input attribute PowerFactory knows for the class (Application.GetAvailableAttributes, namespace 'e');
    None when that is not available, so that the guessed names are tried instead."""
    try:
        text = app.GetAvailableAttributes(class_name_, "", 1, "e")
    except Exception:
        return None
    names = [line.strip().split(":", 1)[-1] for line in str(text or "").splitlines() if line.strip()]  # 'e:calcLodf' -> 'calcLodf'
    return names or None


def _vstab_attributes(app, distribution):
    """All settings of the command with value and description, so the switch that enables a factor can be found."""
    listed = _available_names(app, "ComVstab")
    detail(app, "ComVstab '{}': {}".format(
        engine.object_name(distribution),
        "{} attributes known to PowerFactory".format(len(listed)) if listed else "attribute list not available, trying likely names"))
    rows = []
    for name in listed or _candidate_names():
        if not listed and not _has_attribute(distribution, name):
            continue
        known, value = engine._read_setting(distribution, name)
        try:
            description = distribution.GetAttributeDescription(name, 1)
        except Exception:
            description = None
        rows.append((name, engine._format_setting_value(value) if known else "not readable", (description or "")[:90]))
    table(app, ("Attribute", "Value", "Description"), rows)
    found = {row[0] for row in rows}
    missing = [name for name in VSTAB_ATTRIBUTES if name not in found]
    if missing:
        detail(app, "Not found on this command: {}.".format(", ".join(missing)), "WARN")


def _where_is_the_result(app, distribution):
    """The result file was not found: list what is there instead."""
    known, holder = engine._read_setting(distribution, "pResult")
    if not known or holder is None or isinstance(holder, (str, int, float, bool)):
        detail(app, "ComVstab.pResult is not an object ({!r}).".format(holder), "ERROR")
        return
    detail(app, "ComVstab.pResult is {}; it contains:".format(_described(holder)), "ERROR")
    try:
        children = holder.GetContents("*", 1) or []
    except Exception as exc:
        children = []
        detail(app, "    cannot be listed: {}".format(exc), "ERROR")
    for child in children:
        detail(app, "    {}".format(_described(child)), "ERROR")
    if not children:
        detail(app, "    nothing", "ERROR")


def stage_lodf(app, study_case, analysis, chosen, created):
    """STAGE 3: Sensitivities / Distribution Factors on our Contingency Analysis, then read the result file."""
    section(app, "STAGE 3/3 · Sensitivities / Distribution Factors (ComVstab)")
    distribution = lodf._first(study_case, "ComVstab")
    if distribution is None:
        detail(app, "The Study Case has no ComVstab; asking PowerFactory for one (GetFromStudyCase).")
        distribution = app.GetFromStudyCase("ComVstab")
        if distribution is None:
            detail(app, "PowerFactory returned no ComVstab.", "ERROR")
            raise Stop("stage 3: no Distribution Factors command")
        created.append(distribution)
    _vstab_attributes(app, distribution)
    try:
        with lodf._Link(distribution, analysis):
            known, linked = engine._read_setting(distribution, "pComSimoutage")
            detail(app, "pComSimoutage now points to {}.".format(_described(linked) if known and linked is not None else "nothing"))
            with StateGuard() as guard:
                for attribute, value, outcome in lodf.set_run_settings(guard, distribution, tuple(EXTRA_SETTINGS.items())):
                    failed = outcome == "CANNOT BE READ OR WRITTEN"
                    detail(app, "{} = {}: {}".format(attribute, value, outcome), "ERROR" if failed else "")
                    if failed:
                        raise Stop("stage 3: ComVstab.{} cannot be set".format(attribute))
                detail(app, "Executing ...")
                code = distribution.Execute()
                detail(app, "Execute returned {!r}.".format(code))
                if engine.finite_number(code) not in (0, None):
                    raise Stop("stage 3: Execute ended with error code {!r}".format(code))
                result = lodf.lodf_result(distribution)
                if result is None:
                    _where_is_the_result(app, distribution)
                    raise Stop("stage 3: no result file ending with '{}'".format(lodf.LODF_RESULT_SUFFIX))
                detail(app, "Result file: {}.".format(_described(result)))
                matrix = lodf.read_matrix(result)
    except lodf.LodfError as exc:
        detail(app, str(exc), "ERROR")
        raise Stop("stage 3: " + str(exc)) from None
    detail(app, "ComVstab settings are put back ({}, pComSimoutage).".format(", ".join(a for a, _ in lodf.RUN_SETTINGS)))
    return matrix


def report(app, chosen, matrix):
    """Match the calculated contingencies with the chosen outages and show the largest values."""
    section(app, "RESULT")
    solved = {}
    for contingency, values in matrix:
        solved[lodf.contingency_keys(contingency)] = values
    detail(app, "{} contingency row(s) in the result file.".format(len(matrix)))
    rows, good = [], 0
    for outage, branches in chosen:
        values = solved.get(frozenset(engine.object_key(b) for b in branches))
        if values is None:
            rows.append((engine.object_name(outage), "no row", "no solution, or the row does not match the equipment"))
            continue
        good += 1
        top = sorted(values.values(), key=lambda pair: -abs(pair[1]))[:TOP]
        rows.append((engine.object_name(outage), "{} lines".format(len(values)),
                     ", ".join("{} {:+.3f}".format(engine.object_name(line), value) for line, value in top)))
    table(app, ("Outage", "Values", "Largest LODF (signed fraction)"), rows)
    detail(app, "{} of {} outages have a LODF.".format(good, len(chosen)))
    return good == len(chosen)


def run(app):
    """The three stages; returns "ok" or the reason of the stage that failed."""
    study_case = app.GetActiveStudyCase()
    section(app, "LODF TEST")
    detail(app, "Project: {}".format(engine.object_name(app.GetActiveProject())))
    if study_case is None:
        detail(app, "There is no active Study Case.", "ERROR")
        return "no active Study Case"
    detail(app, "Study Case: {}".format(engine.object_name(study_case)))
    created, verdict = [], "ok"
    try:
        chosen = stage_outages(app)
        analysis = stage_contingencies(app, study_case, chosen, created)
        matrix = stage_lodf(app, study_case, analysis, chosen, created)
        if not report(app, chosen, matrix):
            verdict = "some outages have no LODF"
    except Stop as stopped:
        verdict = str(stopped)
    except Exception as exc:  # whatever PowerFactory raised: show where
        verdict = "{}: {}".format(type(exc).__name__, exc)
        for line in traceback.format_exc().splitlines():
            detail(app, line, "ERROR")
    finally:
        if CLEAN_UP:
            lodf.clean_up(created, lambda message: detail(app, message))
        elif created:
            detail(app, "Left in the Study Case for inspection: {}.".format(", ".join("'{}'".format(engine.object_name(c)) for c in created)))
    section(app, "LODF TEST · " + ("OK" if verdict == "ok" else "PROBLEM FOUND"))
    if verdict != "ok":
        log(app, verdict, "ERROR")
    return verdict


def main():
    import powerfactory

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError("Run this script in PowerFactory as an external ComPython script.")
    return run(app)


if __name__ == "__main__":
    main()
