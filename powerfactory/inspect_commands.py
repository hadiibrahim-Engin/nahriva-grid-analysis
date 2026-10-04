"""Read-only ComPython script: shows which commands the active Study Case has and how PowerFactory's own
LODF calculation is set up: the settings of "Sensitivities / Distribution Factors" (ComVstab), the
contingencies of the Contingency Analysis (ComSimoutage) with the equipment each one switches off, and the
columns of the result file that holds the LODF values.

Run it in PowerFactory (external script, like start_assessment.py), best after "Sensitivities /
Distribution Factors" was executed once with LODF switched on, so that its result file has columns.
It executes "Sensitivities / Distribution Factors" once, exactly like its Execute button (this recalculates
the contingencies and rewrites that command's own result file; the network and the Study Case settings stay
unchanged), and then shows what the result holds, in particular every column that looks like an LODF with
sample values. Set EXECUTE_DISTRIBUTION_FACTORS = False to only read what is there without running it.
Its output tells us how to read the LODF from PowerFactory's own result.
"""

from pathlib import Path
import sys

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "powerfactory"))

import time

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
VERSION = "4 (child result files, sub result keys)"  # shown first, so the output says which copy ran
MAX_LISTED = 80  # contingencies and result columns shown
# Parameters of a result file that say how its data is organised (rows, contingencies, selected sub result).
RESULT_PARAMETERS = (
    "cnumcont", "cnumrow", "ctotrow", "cnumCase", "cases", "cnttime", "pResElm", "csteps", "cnumfiles", "FileType",
    "usedfor", "unit",
)
EXECUTE_DISTRIBUTION_FACTORS = True  # run the command once, then show its results; False: only read (see above)
# Where a contingency (ComOutage) keeps the equipment it switches off.
CONTINGENCY_TARGETS = ("Branches", "Couplers", "Elms", "Nodes", "Faults", "BBFault", "pSWSC")
REPORT_SETTINGS = (
    "p_resDf", "cSensLodf", "optlodf", "iOutTyp", "optsel", "lodflim", "dlodlim", "optShow", "cDf", "cLdfMethod",
    "iExport", "filename", "frmLimitsBrc",
)


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


def _label(obj):
    return "{} ({})".format(engine.object_name(obj), engine.class_name(obj))


def table_elements(item, limit=10):
    """The elements in the table of a contingency, with the documented ComOutage.GetObject(line)."""
    getter = getattr(item, "GetObject", None)
    found = []
    for line in range(limit if callable(getter) else 0):
        try:
            obj = getter(line)
        except Exception:
            break
        if obj is None:
            break
        found.append(obj)
    return found


def contingency_targets(item):
    """Objects a contingency switches off: its table (GetObject), attributes and child events."""
    targets = ["table[{}]={}".format(number, _label(obj)) for number, obj in enumerate(table_elements(item))]
    for attribute in CONTINGENCY_TARGETS + engine.OUTAGE_EQUIPMENT_ATTRIBUTES:
        for target in engine._as_objects(engine.safe_attr(item, attribute)):
            if not isinstance(target, (str, int, float, bool)):
                targets.append("{}={}".format(attribute, _label(target)))
    try:
        children = item.GetContents("*", 1) or []
    except Exception:
        children = []
    for child in children:
        for attribute in engine.OUTAGE_EQUIPMENT_ATTRIBUTES:
            for target in engine._as_objects(engine.safe_attr(child, attribute)):
                if not isinstance(target, (str, int, float, bool)):
                    targets.append("{}:{}={}".format(engine.class_name(child), attribute, _label(target)))
    return targets


def describe_contingencies(app, study_case, simulation):
    items = contingencies(study_case, simulation)
    log(app, RULE)
    log(app, "Contingencies (ComOutage): {}".format(len(items)))
    for number, item in enumerate(items[:MAX_LISTED], 1):
        found, outserv = engine._read_setting(item, "outserv")
        detail(app, "{:>3}. {} | outserv={} | {}".format(
            number, engine.object_name(item), outserv if found else "?",
            "; ".join(contingency_targets(item)) or "no target found"))
    if len(items) > MAX_LISTED:
        detail(app, "... {} more".format(len(items) - MAX_LISTED))


LODF_WORDS = ("lodf", "outage dist", "distr")  # a variable name containing one of these may hold an LODF


def _sample(result, column, rows):
    """First values of a column with PowerFactory's own return code (0 ok, 3 = below the recording limit)."""
    shown = []
    for row in range(min(rows, 3)):
        try:
            answer = result.GetValue(row, column)
        except Exception as exc:
            shown.append("error: {}".format(exc))
            continue
        shown.append("{}".format(answer))
    return ", ".join(shown) or "no rows"


def find_lodf_columns(app, result, label):
    """Columns whose variable name looks like an LODF, with sample values: this is what we need to read."""
    try:
        rows, columns = int(result.GetNumberOfRows()), int(result.GetNumberOfColumns())
    except Exception:
        return 0
    found = 0
    for column in range(columns):
        try:
            variable = str(result.GetVariable(column))
        except Exception:
            continue
        if not any(word in variable.lower() for word in LODF_WORDS):
            continue
        found += 1
        if found <= 10:
            try:
                owner = _label(result.GetObject(column))
            except Exception:
                owner = "?"
            detail(app, "{}: LODF-like column {} | {} | {} | values (return code, value): {}".format(
                label, column, owner, variable, _sample(result, column, rows)))
    detail(app, "{}: {} LODF-like columns of {}".format(label, found, columns))
    return found


def summarize_columns(app, result, columns):
    """How many columns of which object class and variable a (large) result file has."""
    counts = {}
    for column in range(columns):
        try:
            key = (engine.class_name(result.GetObject(column)), str(result.GetVariable(column)))
        except Exception:
            key = ("?", "?")
        counts[key] = counts.get(key, 0) + 1
    for (kind, variable), number in sorted(counts.items(), key=lambda item: -item[1])[:MAX_LISTED]:
        detail(app, "{:>6} x {:<10} {}".format(number, kind, variable))


def probe_sub_results(app, result, items, label):
    """Select the sub result of a contingency like PowerFactory does (ElmRes.SetSubElmResKey) and look at it.

    The key is put back afterwards. ElmRes.SetSubElmResKey takes a contingency object (parameter pResElm) or a
    number (parameter cnttime); a result file such as 'Distribution Factors Results' looks empty (0 x 0)
    until one of them is chosen.
    """
    setter = getattr(result, "SetSubElmResKey", None)
    if not callable(setter):
        return
    known_time, original_time = engine._read_setting(result, "cnttime")
    known_object, original_object = engine._read_setting(result, "pResElm")
    keys = [("pResElm='{}'".format(engine.object_name(item)), item) for item in items[:3]]
    keys += [("cnttime={}".format(number), number) for number in range(3)]
    try:
        for key_label, key in keys:
            try:
                setter(key)
                result.Load()
                rows, columns = int(result.GetNumberOfRows()), int(result.GetNumberOfColumns())
            except Exception as exc:
                detail(app, "{}: sub result with key {} not readable: {}".format(label, key_label, exc))
                continue
            detail(app, "{}: sub result with key {}: {} rows x {} columns".format(label, key_label, rows, columns))
            if columns:
                for column in range(min(columns, 5)):
                    try:
                        detail(app, "    col {}: {} '{}' | {} | values (return code, value): {}".format(
                            column, engine.class_name(result.GetObject(column)), engine.object_name(result.GetObject(column)),
                            result.GetVariable(column), _sample(result, column, rows)))
                    except Exception as exc:
                        detail(app, "    col {}: not readable ({})".format(column, exc))
                summarize_columns(app, result, columns)
                find_lodf_columns(app, result, "key {}".format(key_label))
    finally:
        try:
            result.Release()
        except Exception:
            pass
        if known_time:
            engine._set_scalar_attribute(result, "cnttime", original_time)
        if known_object:
            try:
                engine._set_attribute(result, "pResElm", original_object)
            except Exception:
                pass


def describe_sub_results(app, result, items, label):
    """Contingency result files may hold one sub result file per contingency (ElmRes.GetSubElmRes)."""
    getter = getattr(result, "GetSubElmRes", None)
    if not callable(getter):
        return
    for item in items[:3]:
        try:
            sub = getter(item)
        except Exception as exc:
            detail(app, "{}: GetSubElmRes('{}') failed: {}".format(label, engine.object_name(item), exc))
            continue
        if sub is None:
            detail(app, "{}: no sub result file for '{}'".format(label, engine.object_name(item)))
            continue
        try:
            sub.Load()
            rows, columns = int(sub.GetNumberOfRows()), int(sub.GetNumberOfColumns())
        except Exception as exc:
            detail(app, "{}: sub result file of '{}' not readable: {}".format(label, engine.object_name(item), exc))
            continue
        detail(app, "{}: sub result file of '{}': {} rows x {} columns".format(label, engine.object_name(item), rows, columns))
        summarize_columns(app, sub, columns)
        find_lodf_columns(app, sub, "sub result of '{}'".format(engine.object_name(item)))
        try:
            sub.Release()
        except Exception:
            pass


def describe_result(app, distribution, heading="Result file of the distribution factors", items=(), depth=0):
    found, result = engine._read_setting(distribution, "pResult")
    log(app, RULE)
    if not found or result is None or isinstance(result, (str, int, float, bool)):
        detail(app, "ComVstab.pResult is empty: execute Sensitivities / Distribution Factors once "
                    "(LODF on), then run this script again.", "WARN")
        return
    log(app, "{}: '{}' ({})".format(heading, engine.object_name(result), engine.class_name(result)))
    for holder, label in ((distribution, "ComVstab"), (result, "result file")):
        try:
            children = holder.GetContents("*", 1) or []
        except Exception as exc:
            detail(app, "Contents of the {} could not be read: {}".format(label, exc))
            continue
        detail(app, "Contents of the {}: {}".format(label, ", ".join(_label(c) for c in children[:20]) or "empty"))
    try:
        result.Load()
    except Exception as exc:
        detail(app, "Load() failed: {}".format(exc), "WARN")
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
        if columns > MAX_LISTED:
            detail(app, "Columns by object class and variable:")
            summarize_columns(app, result, columns)
        find_lodf_columns(app, result, "result")
        settings(app, "Parameters of the result file", result, RESULT_PARAMETERS)
        describe_sub_results(app, result, items, "result")
        probe_sub_results(app, result, items, "result")
        if depth == 0:
            # The result file may hold further result files; the LODF values are probably in the one named ..._LODF.
            try:
                children = [c for c in (result.GetContents("*", 1) or []) if engine.class_name(c) == "ElmRes"]
            except Exception:
                children = []
            for child in children:
                describe_result(app, PFHolder(child), "Child result file '{}'".format(engine.object_name(child)), items, depth=1)
    except Exception as exc:
        detail(app, "The result file could not be read: {}".format(exc), "WARN")
    finally:
        try:
            result.Release()
        except Exception:
            pass


def execute_distribution_factors(app, distribution):
    """Runs the command like its Execute button and reports the outcome and duration."""
    log(app, RULE)
    log(app, "Executing '{}' ...".format(engine.object_name(distribution)))
    started = time.monotonic()
    try:
        code = distribution.Execute()
    except Exception as exc:
        detail(app, "Execute failed: {}".format(exc), "WARN")
        return False
    detail(app, "Execute returned {} after {:.1f} s.".format(code, time.monotonic() - started))
    return True


class PFHolder:
    """Lets describe_result read any ElmRes as if it were the `pResult` of a command."""

    def __init__(self, result):
        self.pResult = result

    def GetContents(self, *args):
        return []


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


def inspect(app, execute=None):
    execute = EXECUTE_DISTRIBUTION_FACTORS if execute is None else execute
    study_case = app.GetActiveStudyCase()
    if study_case is None:
        raise RuntimeError("Activate a project and a Study Case first.")
    found = commands(study_case)
    log(app, RULE)
    log(app, "inspect_commands.py version {} from {}".format(VERSION, Path(__file__).resolve()))
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
        items = contingencies(study_case, by_kind.get("ComSimoutage"))
        describe_result(app, distribution, items=items)
        report = by_kind.get("ComVstabrep")
        if report is not None:
            settings(app, "Settings of ComVstabrep '{}'".format(engine.object_name(report)), report, REPORT_SETTINGS)
            found_report, report_result = engine._read_setting(report, "p_resDf")
            if found_report and report_result is not None and not isinstance(report_result, (str, int, float, bool)):
                describe_result(app, PFHolder(report_result), "Result file of the report (p_resDf)", items)
        if execute and execute_distribution_factors(app, distribution):
            describe_result(app, distribution, "Result file after the execution", items)
    if simulation is not None:
        log(app, RULE)
        settings(app, "Settings of ComSimoutage '{}' (Contingency Analysis)".format(engine.object_name(simulation)),
                 simulation, CONTINGENCY_SETTINGS)
        describe_contingencies(app, study_case, simulation)
        found_result, contingency_result = engine._read_setting(simulation, "p_rescnt")
        if found_result and contingency_result is not None and not isinstance(contingency_result, (str, int, float, bool)):
            holder = PFHolder(contingency_result)
            describe_result(app, holder, "Result file of the contingency analysis", contingencies(study_case, simulation))
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
