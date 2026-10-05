"""Line outage distribution factors (LODF) from PowerFactory's own tool "Sensitivities / Distribution Factors".

Runs once at the start of an assessment, before any QDS simulation. The tool (ComVstab, with "LODF" switched on)
calculates, for every contingency of the Contingency Analysis (ComSimoutage), by how much the flow of every line
changes, related to the flow the outaged equipment carried before. It writes one row per calculated contingency
into the result file named "..._LODF" inside ComVstab.pResult:

    b:outid          negative number; ElmRes.GetObj(outid) is the contingency (ComOutage) of the row
    m:LODF:bus1/2    LODF of a line in %, at its bus1 / bus2 side (opposite sign, equal up to losses)

and ComOutage.GetObject(i) lists the equipment a contingency switches off. This module executes the tool with
the recording limit set to 0 (otherwise values below ComVstab.lodflim are not written) and reads the rows of
the contingencies that match the equipment of each scenario. The LODF is signed, a fraction (73.6 % -> 0.736),
and uses the bus1 side; the dashboard shows |LODF|.

What PowerFactory provides, and therefore what a scenario gets:
- monitored: lines (ElmLne). Transformers and couplers are not part of the result.
- outaged: every contingency that converged. A contingency without a row has no solution (typically a generator
  step-up transformer: the generator is cut off); its LODF is not defined. Equipment that is not a contingency of
  the Contingency Analysis is reported, it has to be added there.
- combined outages: only when the Contingency Analysis has a contingency with exactly this equipment.

Standard library plus the engine helpers only. ComVstab.calcLodf and ComVstab.lodflim go through
pf_state.StateGuard: they are read back and restored; a restoration failure raises StateRestoreError.
"""

import gridlens_engine as engine
from pf_state import StateGuard

# Branch classes a planned outage can switch off.
BRANCH_CLASSES = ("ElmLne", "ElmTr2", "ElmTr3", "ElmCoup")
LODF_VARIABLE = "m:LODF:bus1"
OUTAGE_ID_VARIABLE = "b:outid"
LODF_RESULT_SUFFIX = "_LODF"
RECORD_ALL = 0  # ComVstab.lodflim: values below this limit (in %) are not written to the result file
MAX_TABLE_ROWS = 50  # equipment per contingency read from its table

# Raise when the way this module is called by the others changes (arguments, return values). start_assessment.py
# compares it across all modules, so files of different versions are named instead of failing in a confusing way.
INTERFACE_VERSION = 5


class LodfError(RuntimeError):
    """The LODF could not be calculated; PowerFactory settings were restored."""


def outage_equipment(outage):
    """Branches a planned outage switches off (the outage object and its actions)."""
    related = []
    holders = [outage]
    try:
        holders += list(outage.GetContents("*", 1) or [])
    except Exception:
        pass
    for holder in holders:
        for attribute in engine.OUTAGE_EQUIPMENT_ATTRIBUTES:
            related.extend(engine._as_objects(engine.safe_attr(holder, attribute)))
    unique = {}
    for item in related:
        if engine.class_name(item) in BRANCH_CLASSES:
            unique[engine.object_key(item)] = item
    return list(unique.values())


def _first(holder, class_name):
    try:
        found = holder.GetContents("*." + class_name, 1) or []
    except Exception:
        found = []
    return found[0] if found else None


def _names(branches, limit=5):
    names = [engine.object_name(b) for b in branches[:limit]]
    return ", ".join(names) + (" and {} more".format(len(branches) - limit) if len(branches) > limit else "")


def contingency_keys(contingency):
    """Keys of the equipment a contingency (ComOutage) switches off, from its table (GetObject), else Elms."""
    found = []
    getter = getattr(contingency, "GetObject", None)
    for line in range(MAX_TABLE_ROWS if callable(getter) else 0):
        try:
            item = getter(line)
        except Exception:
            break
        if item is None:
            break
        found.append(item)
    if not found:
        found = [o for o in engine._as_objects(engine.safe_attr(contingency, "Elms")) if not isinstance(o, (str, int, float, bool))]
    return frozenset(engine.object_key(item) for item in found)


def contingencies(study_case, simulation):
    """The contingencies (ComOutage) of the Contingency Analysis; the Study Case's own when it lists none."""
    for holder in (simulation, study_case):
        try:
            found = holder.GetContents("*.ComOutage", 1) or []
        except Exception:
            found = []
        if found:
            return list(found)
    return []


def lodf_result(distribution):
    """The result file with the LODF values: the child of ComVstab.pResult whose name ends with _LODF."""
    known, result = engine._read_setting(distribution, "pResult")
    if not known or result is None or isinstance(result, (str, int, float, bool)):
        return None
    try:
        children = result.GetContents("*", 1) or []
    except Exception:
        children = []
    for child in children:
        if engine.class_name(child) == "ElmRes" and engine.object_name(child).endswith(LODF_RESULT_SUFFIX):
            return child
    return None


def read_matrix(result):
    """[(contingency, {line key: (line, LODF as fraction)})] for every calculated contingency of the result file."""
    try:
        result.Load()
        rows, columns = int(result.GetNumberOfRows()), int(result.GetNumberOfColumns())
    except Exception as exc:
        raise LodfError("The LODF result file could not be read: " + str(exc)) from None
    try:
        outid_column, lines = None, {}
        for column in range(columns):
            variable = str(result.GetVariable(column))
            if variable == OUTAGE_ID_VARIABLE:
                outid_column = column
            elif variable == LODF_VARIABLE:
                lines[column] = result.GetObject(column)
        if outid_column is None or not lines:
            raise LodfError(
                "The LODF result file has no '{}' column or no '{}' columns ({} columns found).".format(
                    OUTAGE_ID_VARIABLE, LODF_VARIABLE, columns))
        table = []
        for row in range(rows):
            outid = engine.result_value(result, row, outid_column)
            try:
                contingency = result.GetObj(int(outid)) if outid is not None else None
            except Exception:
                contingency = None
            if contingency is None:
                continue
            values = {}
            for column, line in lines.items():
                value = engine.result_value(result, row, column)  # None: not written (below the recording limit)
                if value is not None:
                    values[engine.object_key(line)] = (line, value / 100.0)
            table.append((contingency, values))
        return table
    finally:
        try:
            result.Release()
        except Exception:
            pass


def _execute(distribution):
    """Run 'Sensitivities / Distribution Factors' with LODF on and every value recorded, then put the settings back."""
    with StateGuard() as guard:
        for attribute, value in (("calcLodf", 1), ("lodflim", RECORD_ALL)):
            if not guard.set(distribution, attribute, value, "ComVstab." + attribute):
                raise LodfError("ComVstab.{} cannot be read or written; LODF was not calculated.".format(attribute))
        try:
            code = distribution.Execute()
        except Exception as exc:
            raise LodfError("'Sensitivities / Distribution Factors' failed: " + str(exc)) from None
        if engine.finite_number(code) not in (0, None):
            raise LodfError("'Sensitivities / Distribution Factors' ended with error code " + str(code) + ".")
        result = lodf_result(distribution)
        if result is None:
            raise LodfError(
                "'Sensitivities / Distribution Factors' left no result file ending with '{}' in ComVstab.pResult.".format(
                    LODF_RESULT_SUFFIX))
        return read_matrix(result)


def calculate(app, scenarios, element_id, log=lambda message: None, undefined=None):
    """Return LODF rows (outage_key, element_id, lodf, None, None).

    `scenarios` is a list of {"key": str, "name": str (optional), "equipment": [branch objects]};
    `element_id` maps a line object to the identifier stored in the results; `log` receives notes.
    An outage without LODF is skipped; with a dict as `undefined` its key and the reason are collected there.
    LodfError: nothing could be calculated. StateRestoreError: a setting could not be put back.
    """
    study_case = app.GetActiveStudyCase()
    distribution = _first(study_case, "ComVstab") if study_case is not None else None
    if distribution is None:
        raise LodfError("The active Study Case has no 'Sensitivities / Distribution Factors' command (ComVstab); "
                        "LODF was not calculated.")
    simulation = engine.safe_attr(distribution, "pComSimoutage") or _first(study_case, "ComSimoutage")
    if simulation is None:
        raise LodfError("'Sensitivities / Distribution Factors' has no Contingency Analysis; LODF was not calculated.")
    defined = {contingency_keys(c) for c in contingencies(study_case, simulation)} - {frozenset()}
    if not defined:
        raise LodfError("The Contingency Analysis has no contingencies; LODF was not calculated.")
    solved = {}
    for contingency, values in _execute(distribution):
        keys = contingency_keys(contingency)
        if keys:
            solved[keys] = values
    log("PowerFactory's LODF covers lines only: {} of {} contingencies have a solution.".format(len(solved), len(defined)))
    rows, without = [], []
    for scenario in scenarios:
        label = scenario.get("name") or scenario["key"]
        equipment = scenario["equipment"]
        wanted = frozenset(engine.object_key(b) for b in equipment)
        if not wanted:
            reason = "LODF '{}': the outage switches no line, transformer or coupler; no LODF.".format(label)
        elif wanted in solved and solved[wanted]:
            rows.extend((scenario["key"], element_id(line), value, None, None) for line, value in solved[wanted].values())
            continue
        elif wanted in solved:
            reason = "LODF '{}': PowerFactory recorded no value for {}; no LODF.".format(label, _names(equipment))
        elif wanted in defined:
            reason = ("LODF '{}': PowerFactory's contingency analysis found no solution without {}; not defined "
                      "(typically a generator or a part of the grid is cut off).").format(label, _names(equipment))
        else:
            reason = ("LODF '{}': {} is no contingency of the Contingency Analysis; add it to the contingency "
                      "definition to get its LODF.").format(label, _names(equipment))
        log(reason)
        without.append(label)
        if undefined is not None:
            undefined[scenario["key"]] = reason
    log("LODF: {} values for {} outages; {} without LODF{}.".format(
        len(rows), len({row[0] for row in rows}), len(without), (": " + ", ".join(without)) if without else ""))
    return rows
