"""Read-only ComPython script: shows which commands the active Study Case has and how PowerFactory's own
LODF calculation is set up: the settings of "Sensitivities / Distribution Factors" (ComVstab), the
contingencies of the Contingency Analysis (ComSimoutage) with the equipment each one switches off, and the
columns of the result file that holds the LODF values.

Run it in PowerFactory (external script, like start_assessment.py), best after "Sensitivities /
Distribution Factors" was executed once with LODF switched on, so that its result file has columns.
It changes nothing and writes nothing. Its output tells us how to read the LODF from the assessment.
"""

from pathlib import Path
import sys

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "powerfactory"))

import gridlens_engine as engine
import lodf
from pf_console import RULE, detail, log

# Commands whose class or name contains one of these words are described in full.
KEYWORDS = ("sens", "distr", "ldf", "contin", "ptdf", "lodf")

# Settings of the two commands that carry the LODF calculation.
DISTRIBUTION_SETTINGS = (
    "calcLodf", "calcPtdf", "calcModal", "isContSens", "isLinearCont", "iopt_method", "iopt_mod", "set_mode",
    "lodflim", "pComSimoutage", "pResult", "isResultFile", "iExport", "filename", "useFictitiousGrid",
    "considerThresh", "obj_bus", "factors4bus", "factors4trf", "factors4conv",
)
CONTINGENCY_SETTINGS = (
    "iopt_Linear", "copt_Linear", "iopt_method", "iopt_cntldf", "isPlannedOutages", "cisPlannedOutages",
    "calcPeriod", "startTime", "endTime", "nrProcessedCnt", "nrUnsolvedCnt", "nrInactiveCnt", "p_rescnt",
)
MAX_LISTED = 80  # contingencies and result columns shown


def commands(study_case):
    """Every command object of the Study Case (class, name, object)."""
    try:
        found = study_case.GetContents("*.Com*", 1) or []
    except Exception:
        found = []
    return [(engine.class_name(obj), engine.object_name(obj), obj) for obj in found]


def settings(app, title, obj, names):
    detail(app, title)
    for name in names:
        found, value = engine._read_setting(obj, name)
        detail(app, "    {:<18} {}".format(name, engine._format_setting_value(value) if found else "<not readable>"))


def contingencies(study_case, simulation):
    """The ComOutage objects of the Contingency Analysis (otherwise those of the Study Case)."""
    for holder in (simulation, study_case):
        try:
            found = holder.GetContents("*.ComOutage", 1) or []
        except Exception:
            found = []
        if found:
            return list(found)
    return []


def describe_contingencies(app, study_case, simulation):
    items = contingencies(study_case, simulation)
    log(app, RULE)
    log(app, "Contingencies (ComOutage): {}".format(len(items)))
    for number, item in enumerate(items[:MAX_LISTED], 1):
        targets = []
        for attribute in engine.OUTAGE_EQUIPMENT_ATTRIBUTES:
            for target in engine._as_objects(engine.safe_attr(item, attribute)):
                if not isinstance(target, (str, int, float, bool)):
                    targets.append("{}={} ({})".format(attribute, engine.object_name(target), engine.class_name(target)))
        found, outserv = engine._read_setting(item, "outserv")
        detail(app, "{:>3}. {} | outserv={} | {}".format(
            number, engine.object_name(item), outserv if found else "?", "; ".join(targets) or "no target found"))
    if len(items) > MAX_LISTED:
        detail(app, "... {} more".format(len(items) - MAX_LISTED))
    if items:
        log(app, "Attributes of the first contingency")
        for line in engine.describe_object_api(items[0]).split("; "):
            detail(app, line)


def describe_result(app, distribution):
    found, result = engine._read_setting(distribution, "pResult")
    log(app, RULE)
    if not found or result is None or isinstance(result, (str, int, float, bool)):
        detail(app, "ComVstab.pResult is empty: execute Sensitivities / Distribution Factors once "
                    "(LODF on), then run this script again.", "WARN")
        return
    log(app, "Result file of the distribution factors: '{}' ({})".format(engine.object_name(result), engine.class_name(result)))
    try:
        result.Load()
    except Exception:
        pass
    try:
        rows, columns = int(result.GetNumberOfRows()), int(result.GetNumberOfColumns())
        detail(app, "{} rows x {} columns".format(rows, columns))
        for column in range(min(columns, MAX_LISTED)):
            try:
                obj, variable = result.GetObject(column), result.GetVariable(column)
                unit = result.GetUnit(column)
            except Exception as exc:
                detail(app, "column {}: not readable ({})".format(column, exc), "WARN")
                continue
            sample = engine.finite_number(engine.result_value(result, 0, column)) if rows else None
            detail(app, "col {:>3}: {} '{}' | {} [{}] | first value {}".format(
                column, engine.class_name(obj), engine.object_name(obj), variable, unit, sample))
        if columns > MAX_LISTED:
            detail(app, "... {} more columns".format(columns - MAX_LISTED))
    except Exception as exc:
        detail(app, "The result file could not be read: {}".format(exc), "WARN")
    finally:
        try:
            result.Release()
        except Exception:
            pass


def describe_planned_outages(app):
    outages = engine._find_project_outages(app)
    log(app, RULE)
    log(app, "Planned outages and the line/transformer/coupler equipment they switch off: {}".format(len(outages)))
    for outage in outages:
        equipment = lodf.outage_equipment(outage)
        detail(app, "{} -> {}".format(
            engine.object_name(outage), ", ".join("{} ({})".format(engine.object_name(b), engine.class_name(b)) for b in equipment) or "none"))


def interesting(kind, name):
    text = (kind + " " + name).lower()
    return any(word in text for word in KEYWORDS)


def inspect(app):
    study_case = app.GetActiveStudyCase()
    if study_case is None:
        raise RuntimeError("Activate a project and a Study Case first.")
    found = commands(study_case)
    log(app, RULE)
    log(app, "Commands in the Study Case '{}': {}".format(engine.object_name(study_case), len(found)))
    for kind, name, _obj in sorted(found, key=lambda item: (item[0], item[1])):
        detail(app, "{:<18} {}".format(kind, name))
    chosen = [item for item in found if interesting(item[0], item[1])]
    if not chosen:
        detail(app, "No sensitivity or distribution-factor command found. In PowerFactory open "
                    "Calculation > Load Flow > Sensitivities / Distribution Factors once, then run this again.", "WARN")
    by_kind = {kind: obj for kind, _name, obj in found}
    distribution, simulation = by_kind.get("ComVstab"), by_kind.get("ComSimoutage")
    if distribution is not None:
        log(app, RULE)
        settings(app, "Settings of ComVstab '{}' (Sensitivities / Distribution Factors)".format(engine.object_name(distribution)),
                 distribution, DISTRIBUTION_SETTINGS)
        describe_result(app, distribution)
    if simulation is not None:
        log(app, RULE)
        settings(app, "Settings of ComSimoutage '{}' (Contingency Analysis)".format(engine.object_name(simulation)),
                 simulation, CONTINGENCY_SETTINGS)
        describe_contingencies(app, study_case, simulation)
    try:
        describe_planned_outages(app)
    except Exception as exc:
        detail(app, "Planned outages could not be read: {}".format(exc), "WARN")
    return len(found), len(chosen)


def main():
    import powerfactory

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError("Run this script in PowerFactory as an external ComPython script.")
    inspect(app)


if __name__ == "__main__":
    main()
