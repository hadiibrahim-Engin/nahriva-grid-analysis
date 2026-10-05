"""External ComPython script: tests the LODF calculation on its own, one stage at a time. One file, nothing else needed.

Run it in PowerFactory as an external ComPython script (active project and Study Case). It does what the assessment
does before the first simulation, but stops at the first stage that fails and says what PowerFactory answered:

    STAGE 1  load the planned outages and the equipment they switch off
    STAGE 2  create a Contingency Analysis with one contingency (ComOutage) per chosen outage, read it back
    STAGE 3  run 'Sensitivities / Distribution Factors' (ComVstab) on it and read the LODF

It works in its own Contingency Analysis (PROBE_ANALYSIS_NAME), sets some ComVstab settings for the run and puts
them back. What it created stays in the Study Case (CLEAN_UP = True deletes it). The first output line names the
VERSION of this file: raise it when the file changes, so the output shows which copy ran.
"""

from datetime import datetime
import traceback

VERSION = 5

# Which planned outages to test: None = the first MAX_OUTAGES that switch a line, transformer or coupler,
# or a list of outage names, for example ["Outage North", "Outage South"].
OUTAGES = None
MAX_OUTAGES = 3
PROBE_ANALYSIS_NAME = "LODF Probe"  # separate from the analysis of the assessment and from the user's own
CLEAN_UP = False  # True: delete what this script created
TOP = 5  # lines shown per contingency (largest |LODF|)
# ComVstab settings for the run, put back afterwards. isContSens is 'Consider contingencies': without it PowerFactory
# stops with "Please enable at least one sensitivity factor". lodflim 0: record every value, not only the large ones.
RUN_SETTINGS = (("isContSens", 1), ("calcLodf", 1), ("lodflim", 0))
EXTRA_SETTINGS = {}  # more settings to try, for example {"calcPtdf": 1}

PREFIX = "[LODF probe]"
OUTAGE_CLASSES = ("IntPlannedout", "IntOutage")
BRANCH_CLASSES = ("ElmLne", "ElmTr2", "ElmTr3", "ElmCoup")
EQUIPMENT_ATTRIBUTES = ("components", "p_target", "pTarget", "pObject", "p_object", "obj_id", "pDevice", "cpObject", "pElm",
                        "p_target1", "p_target2")
START_ATTRIBUTES = ("starttime", "tStart", "t_start", "date_start", "time_start")
END_ATTRIBUTES = ("endtime", "tEnd", "t_end", "date_end", "time_end")
LODF_VARIABLE = "m:LODF:bus1"
OUTAGE_ID_VARIABLE = "b:outid"
LODF_RESULT_SUFFIX = "_LODF"


class Stop(Exception):
    """A stage failed; the reason was already written to the output."""


# ---- output ------------------------------------------------------------------------------------------------------

def out(app, message, level=""):
    line = "{}{} {}".format(PREFIX, "[" + level + "]" if level else "", message)
    try:
        app.PrintPlain(line)
    except Exception:
        print(line)


def section(app, title):
    out(app, "")
    out(app, "=" * 78)
    out(app, " " + title)
    out(app, "=" * 78)


def table(app, header, rows):
    lines = [tuple(header)] + [tuple(str(cell) for cell in row) for row in rows]
    widths = [max(len(line[i]) for line in lines) for i in range(len(header))]
    for number_, line in enumerate(lines):
        out(app, "    " + "  ".join(cell.ljust(widths[i]) if i < len(line) - 1 else cell for i, cell in enumerate(line)))
        if number_ == 0:
            out(app, "    " + "  ".join("-" * widths[i] if i < len(line) - 1 else "-" * min(widths[i], 40) for i in range(len(line))))


# ---- reading PowerFactory objects ---------------------------------------------------------------------------------

def read(obj, name):
    """(True, value) when the attribute can be read, else (False, None)."""
    try:
        return True, getattr(obj, name)
    except Exception:
        getter = getattr(obj, "GetAttribute", None)
        if callable(getter):
            try:
                return True, getter(name)
            except Exception:
                pass
    return False, None


def attr(obj, name):
    return read(obj, name)[1]


def number(value):
    if value is None or isinstance(value, (bool, list, tuple, str)):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and abs(result) != float("inf") else None


def class_of(obj):
    try:
        return str(obj.GetClassName())
    except Exception:
        return ""


def key_of(obj):
    try:
        value = obj.GetFullName()
        if value:
            return str(value)
    except Exception:
        pass
    return str(attr(obj, "loc_name") or "unknown")


def name_of(obj):
    return str(attr(obj, "loc_name") or key_of(obj).rsplit("\\", 1)[-1])


def described(obj):
    return "{} ({})".format(name_of(obj), class_of(obj))


def objects_of(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return []
    if isinstance(value, (list, tuple)):
        return [item for item in value if item is not None and not isinstance(item, (str, int, float, bool))]
    return [value]


def contents(holder, pattern):
    try:
        return list(holder.GetContents(pattern, 1) or [])
    except Exception:
        return []


def shown(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if number(value) is not None:
        return "{:g}".format(number(value))
    if class_of(value):
        return "'{}' ({})".format(name_of(value), class_of(value))
    return str(value)


def time_text(value):
    stamp = number(value)
    if stamp is None:
        return ""
    if stamp > 315532800:
        try:
            return datetime.fromtimestamp(stamp).strftime("%Y-%m-%d %H:%M")
        except (OSError, OverflowError, ValueError):
            pass
    return "{:g}".format(stamp)


def equipment_text(branches):
    return ", ".join(described(b) for b in branches) or "none"


# ---- changing settings, always put back ---------------------------------------------------------------------------

def same(left, right):
    if number(left) is not None and number(right) is not None:
        return number(left) == number(right)
    if class_of(left) and class_of(right):
        return key_of(left) == key_of(right)
    return left is right or left == right


def write(obj, name, value):
    """Set an attribute and read it back; False when that did not work."""
    try:
        setattr(obj, name, value)
    except Exception:
        setter = getattr(obj, "SetAttribute", None)
        if not callable(setter):
            return False
        try:
            setter(name, value)
        except Exception:
            return False
    known, current = read(obj, name)
    return known and same(current, value)


class Changes:
    """Remembers what was changed; put_back() restores it in reverse order and says what could not be restored."""

    def __init__(self):
        self.items = []

    def set(self, obj, name, value):
        known, original = read(obj, name)
        if not known:
            return False
        self.items.append((obj, name, original))
        return write(obj, name, value)

    def put_back(self):
        problems = []
        for obj, name, original in reversed(self.items):
            known, current = read(obj, name)
            if known and same(current, original):
                continue
            if not write(obj, name, original):
                problems.append("{} (expected {}, found {})".format(name, shown(original), shown(current) if known else "unreadable"))
        self.items = []
        return problems


# ---- stage 1: planned outages --------------------------------------------------------------------------------------

def find_outages(app):
    roots = []
    getter = getattr(app, "GetProjectFolder", None)
    if callable(getter):
        for folder in ("outage", "outages"):
            try:
                roots.extend(objects_of(getter(folder)))
            except Exception:
                pass
    roots.extend(objects_of(app.GetActiveProject()))
    unique = {}
    for root in roots:
        for kind in OUTAGE_CLASSES:
            for outage in contents(root, "*." + kind):
                if class_of(outage) in OUTAGE_CLASSES:
                    unique[key_of(outage)] = outage
    return sorted(unique.values(), key=lambda o: (name_of(o).casefold(), key_of(o)))


def branches_of(outage):
    """The lines, transformers and couplers a planned outage switches off (the outage object and its actions)."""
    found = {}
    for holder in [outage] + contents(outage, "*"):
        for attribute in EQUIPMENT_ATTRIBUTES:
            for item in objects_of(attr(holder, attribute)):
                if class_of(item) in BRANCH_CLASSES:
                    found[key_of(item)] = item
    return list(found.values())


def explain_empty(app, outage):
    for attribute in EQUIPMENT_ATTRIBUTES:
        found = objects_of(attr(outage, attribute))
        if found:
            out(app, "      {} = {}".format(attribute, ", ".join(described(item) for item in found)))
    for child in contents(outage, "*")[:10]:
        out(app, "      contains {}".format(described(child)))


def first_value(obj, names):
    return next((attr(obj, n) for n in names if attr(obj, n) not in (None, "")), None)


def stage_outages(app):
    section(app, "STAGE 1/3 · planned outages and their equipment")
    try:
        outages = find_outages(app)
    except Exception as exc:
        out(app, "    Planned outages could not be loaded: {}".format(exc), "ERROR")
        raise Stop("stage 1: planned outages could not be loaded") from None
    out(app, "    {} planned outage(s) in the project.".format(len(outages)))
    rows, usable = [], []
    for outage in outages:
        branches = branches_of(outage)
        start, end = time_text(first_value(outage, START_ATTRIBUTES)), time_text(first_value(outage, END_ATTRIBUTES))
        rows.append((name_of(outage), class_of(outage), (start + " .. " + end) if start or end else "no window", equipment_text(branches)))
        if branches:
            usable.append((outage, branches))
    table(app, ("Outage", "Class", "Window", "Branches it switches off"), rows[:60])
    empty = next((o for o in outages if not any(o is item for item, _ in usable)), None)
    if empty is not None:
        out(app, "    No line, transformer or coupler found for '{}':".format(name_of(empty)), "WARN")
        explain_empty(app, empty)
    if OUTAGES is None:
        chosen = usable[:MAX_OUTAGES]
    else:
        wanted = [n.casefold() for n in OUTAGES]
        chosen = [(o, b) for o, b in usable if name_of(o).casefold() in wanted]
        for name in OUTAGES:
            if not any(name_of(o).casefold() == name.casefold() for o, _ in chosen):
                out(app, "    '{}' is not a planned outage with a branch.".format(name), "WARN")
    if not chosen:
        out(app, "    Nothing to test: no planned outage switches a line, transformer or coupler.", "ERROR")
        raise Stop("stage 1: no outage with a branch")
    out(app, "    Testing: {}".format("; ".join("{} -> {}".format(name_of(o), equipment_text(b)) for o, b in chosen)))
    return chosen


# ---- stage 2: contingency objects ----------------------------------------------------------------------------------

def create(parent, class_name, name):
    try:
        created = parent.CreateObject(class_name, name)
    except Exception as exc:
        raise Stop("stage 2: PowerFactory could not create '{}.{}' in '{}': {}".format(name, class_name, name_of(parent), exc)) from None
    if created is None:
        raise Stop("stage 2: PowerFactory could not create '{}.{}' in '{}'.".format(name, class_name, name_of(parent)))
    return created


def contingency_keys(contingency):
    """(keys, objects) of the equipment a contingency (ComOutage) switches off, from its table (GetObject)."""
    found = []
    getter = getattr(contingency, "GetObject", None)
    for line in range(50 if callable(getter) else 0):
        try:
            item = getter(line)
        except Exception:
            break
        if item is None:
            break
        found.append(item)
    return frozenset(key_of(item) for item in found), found


def stage_contingencies(app, study_case, chosen, created):
    section(app, "STAGE 2/3 · contingency objects (ComOutage)")
    analyses = contents(study_case, "*.ComSimoutage")
    out(app, "    Contingency Analyses in Study Case '{}': {}".format(name_of(study_case), ", ".join(name_of(a) for a in analyses) or "none"))
    analysis = next((a for a in analyses if name_of(a) == PROBE_ANALYSIS_NAME), None)
    if analysis is None:
        analysis = create(study_case, "ComSimoutage", PROBE_ANALYSIS_NAME)
        created.append(analysis)
        out(app, "    Created Contingency Analysis '{}'.".format(PROBE_ANALYSIS_NAME))
    else:
        try:
            out(app, "    Reusing Contingency Analysis '{}' from an earlier run; ClearCont returned {}.".format(
                PROBE_ANALYSIS_NAME, analysis.ClearCont()))
        except Exception as exc:
            out(app, "    ClearCont failed: {}".format(exc), "ERROR")
            raise Stop("stage 2: the Contingency Analysis could not be emptied") from None
    rows, failed = [], False
    for outage, branches in chosen:
        name = name_of(outage)
        try:
            contingency = create(analysis, "ComOutage", name)
            code = contingency.SetObjs(list(branches))
        except Stop:
            raise
        except Exception as exc:
            out(app, "    Contingency '{}': {}".format(name, exc), "ERROR")
            failed = True
            continue
        keys, listed = contingency_keys(contingency)
        matches = keys == frozenset(key_of(b) for b in branches)
        failed = failed or not matches or number(code) not in (0.0, None)
        rows.append((name, str(code), equipment_text(branches), equipment_text(listed), "ok" if matches else "DIFFERENT"))
    table(app, ("Contingency", "SetObjs", "Requested", "Read back (GetObject)", "Check"), rows)
    found = contents(analysis, "*.ComOutage")
    out(app, "    The analysis now holds {} contingency object(s): {}.".format(len(found), ", ".join(name_of(c) for c in found) or "none"))
    if failed or not found:
        raise Stop("stage 2: the contingencies are not what was asked for")
    return analysis


# ---- stage 3: Sensitivities / Distribution Factors ------------------------------------------------------------------

def show_attributes(app, distribution):
    """All settings of the command with value and description, so the switch that enables a factor can be found."""
    try:
        text = app.GetAvailableAttributes("ComVstab", "", 1, "e")
        names = [line.strip().split(":", 1)[-1] for line in str(text or "").splitlines() if line.strip()]
    except Exception:
        names = []
    if not names:
        out(app, "    The attribute list is not available; only the settings used below are shown.")
        names = [n for n, _ in RUN_SETTINGS] + ["pComSimoutage", "pResult"]
    rows = []
    for name in names:
        known, value = read(distribution, name)
        try:
            description = distribution.GetAttributeDescription(name, 1)
        except Exception:
            description = None
        rows.append((name, shown(value) if known else "not readable", (description or "")[:90]))
    out(app, "    ComVstab '{}': {} attributes".format(name_of(distribution), len(rows)))
    table(app, ("Attribute", "Value", "Description"), rows)


def lodf_result(distribution):
    """(result file, folder): the child of ComVstab.pResult whose name ends with _LODF, or None."""
    known, holder = read(distribution, "pResult")
    if not known or not class_of(holder):
        return None, holder
    for child in contents(holder, "*"):
        if class_of(child) == "ElmRes" and name_of(child).endswith(LODF_RESULT_SUFFIX):
            return child, holder
    return None, holder


def result_value(result, row, column):
    try:
        raw = result.GetValue(row, column)
    except Exception:
        return None
    if isinstance(raw, (tuple, list)):
        if len(raw) < 2 or number(raw[0]) != 0.0:
            return None
        raw = raw[1]
    return number(raw)


def read_matrix(result):
    """[(contingency, {line key: (line, LODF as fraction)})] for every calculated contingency."""
    try:
        result.Load()
        rows, columns = int(result.GetNumberOfRows()), int(result.GetNumberOfColumns())
    except Exception as exc:
        raise Stop("stage 3: the LODF result file could not be read: {}".format(exc)) from None
    try:
        outid_column, lines = None, {}
        for column in range(columns):
            variable = str(result.GetVariable(column))
            if variable == OUTAGE_ID_VARIABLE:
                outid_column = column
            elif variable == LODF_VARIABLE:
                lines[column] = result.GetObject(column)
        if outid_column is None or not lines:
            raise Stop("stage 3: the LODF result file has no '{}' column or no '{}' columns ({} columns found)".format(
                OUTAGE_ID_VARIABLE, LODF_VARIABLE, columns))
        matrix = []
        for row in range(rows):
            outid = result_value(result, row, outid_column)
            try:
                contingency = result.GetObj(int(outid)) if outid is not None else None
            except Exception:
                contingency = None
            if contingency is None:
                continue
            values = {}
            for column, line in lines.items():
                value = result_value(result, row, column)  # None: not written (below the recording limit)
                if value is not None:
                    values[key_of(line)] = (line, value / 100.0)
            matrix.append((contingency, values))
        return matrix
    finally:
        try:
            result.Release()
        except Exception:
            pass


def stage_lodf(app, study_case, analysis, created):
    section(app, "STAGE 3/3 · Sensitivities / Distribution Factors (ComVstab)")
    commands = contents(study_case, "*.ComVstab")
    distribution = commands[0] if commands else None
    if distribution is None:
        out(app, "    The Study Case has no ComVstab; asking PowerFactory for one (GetFromStudyCase).")
        distribution = app.GetFromStudyCase("ComVstab")
        if distribution is None:
            out(app, "    PowerFactory returned no ComVstab.", "ERROR")
            raise Stop("stage 3: no Distribution Factors command")
        created.append(distribution)
    elif len(commands) > 1:
        out(app, "    The Study Case has {} ComVstab commands; using '{}'.".format(len(commands), name_of(distribution)), "WARN")
    show_attributes(app, distribution)
    changes = Changes()
    try:
        if not changes.set(distribution, "pComSimoutage", analysis):
            raise Stop("stage 3: ComVstab.pComSimoutage cannot be set to the Contingency Analysis")
        out(app, "    pComSimoutage now points to {}.".format(described(attr(distribution, "pComSimoutage"))))
        for name, value in RUN_SETTINGS + tuple(EXTRA_SETTINGS.items()):
            if not read(distribution, name)[0]:
                out(app, "    {} = {}: not available in this PowerFactory version".format(name, value), "WARN")
                continue
            ok = changes.set(distribution, name, value)
            out(app, "    {} = {}: {}".format(name, value, "set" if ok else "CANNOT BE READ OR WRITTEN"), "" if ok else "ERROR")
            if not ok:
                raise Stop("stage 3: ComVstab.{} cannot be set".format(name))
        out(app, "    Executing ...")
        code = distribution.Execute()
        out(app, "    Execute returned {!r}.".format(code))
        if number(code) not in (0.0, None):
            raise Stop("stage 3: Execute ended with error code {!r}".format(code))
        result, holder = lodf_result(distribution)
        if result is None:
            out(app, "    ComVstab.pResult is {}.".format(described(holder) if class_of(holder) else repr(holder)), "ERROR")
            for child in (contents(holder, "*") if class_of(holder) else []):
                out(app, "        contains {}".format(described(child)), "ERROR")
            raise Stop("stage 3: no result file ending with '{}'".format(LODF_RESULT_SUFFIX))
        out(app, "    Result file: {}.".format(described(result)))
        return read_matrix(result)
    finally:
        problems = changes.put_back()
        if problems:
            out(app, "    Could not put back: {}. Check this command in the Study Case.".format("; ".join(problems)), "ERROR")
        else:
            out(app, "    ComVstab settings are put back.")


def report(app, chosen, matrix):
    section(app, "RESULT")
    solved = {contingency_keys(contingency)[0]: values for contingency, values in matrix}
    out(app, "    {} contingency row(s) in the result file.".format(len(matrix)))
    rows, good = [], 0
    for outage, branches in chosen:
        values = solved.get(frozenset(key_of(b) for b in branches))
        if values is None:
            rows.append((name_of(outage), "no row", "no solution, or the row does not match the equipment"))
            continue
        good += 1
        top = sorted(values.values(), key=lambda pair: -abs(pair[1]))[:TOP]
        rows.append((name_of(outage), "{} lines".format(len(values)), ", ".join("{} {:+.3f}".format(name_of(line), value) for line, value in top)))
    table(app, ("Outage", "Values", "Largest LODF (signed fraction)"), rows)
    out(app, "    {} of {} outages have a LODF.".format(good, len(chosen)))
    return good == len(chosen)


def run(app):
    """The three stages; returns "ok" or the reason of the stage that failed."""
    section(app, "LODF PROBE · version {}".format(VERSION))
    study_case = app.GetActiveStudyCase()
    out(app, "    Project: {}".format(name_of(app.GetActiveProject())))
    if study_case is None:
        out(app, "    There is no active Study Case.", "ERROR")
        return "no active Study Case"
    out(app, "    Study Case: {}".format(name_of(study_case)))
    created, verdict = [], "ok"
    try:
        chosen = stage_outages(app)
        analysis = stage_contingencies(app, study_case, chosen, created)
        matrix = stage_lodf(app, study_case, analysis, created)
        if not report(app, chosen, matrix):
            verdict = "some outages have no LODF"
    except Stop as stopped:
        verdict = str(stopped)
    except Exception as exc:  # whatever PowerFactory raised: show where
        verdict = "{}: {}".format(type(exc).__name__, exc)
        for line in traceback.format_exc().splitlines():
            out(app, "    " + line, "ERROR")
    finally:
        if CLEAN_UP:
            for item in reversed(created):
                try:
                    out(app, "    Deleted '{}' (return value {}).".format(name_of(item), item.Delete()))
                except Exception as exc:
                    out(app, "    '{}' could not be deleted: {}".format(name_of(item), exc))
        elif created:
            out(app, "    Left in the Study Case for inspection: {}.".format(", ".join("'{}'".format(name_of(c)) for c in created)))
    section(app, "LODF PROBE version {} · {}".format(VERSION, "OK" if verdict == "ok" else "PROBLEM FOUND"))
    if verdict != "ok":
        out(app, verdict, "ERROR")
    return verdict


def main():
    import powerfactory

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError("Run this script in PowerFactory as an external ComPython script.")
    return run(app)


if __name__ == "__main__":
    main()
