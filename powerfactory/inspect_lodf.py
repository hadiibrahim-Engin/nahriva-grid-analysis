"""ComPython script: shows how PowerFactory's own LODF result ("Sensitivities / Distribution Factors", ComVstab)
is organised, and what changes when its recording limit is switched off. Short output, nothing to configure.

The LODF values are in the result file named "..._LODF" inside ComVstab.pResult: one row per calculated
contingency, two columns (m:LODF:bus1, m:LODF:bus2, in %) per line, and the header columns b:index, b:calcmod
and b:outid. b:outid is a negative number that ElmRes.GetObj(outid) turns into the contingency of the row.
Values below PowerFactory's recording limit are not written (return code 3 of GetValue).

The script executes ComVstab three times (the same as its Execute button, results are rewritten):
  1. as set in the Study Case,
  2. with the recording limit lodflim = 0 (every value is recorded),
  3. with lodflim = 0 and factors4trf = 1 (does it add transformers as monitored branches?).
Both settings are put back afterwards; nothing else is changed.
"""

from pathlib import Path
import sys

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "powerfactory"))

import gridlens_engine as engine
from pf_console import RULE, detail, log
from pf_state import StateGuard

VERSION = "1 (LODF matrix, recording limit)"
HEADER_COLUMNS = ("b:index", "b:calcmod", "b:outid")
MAX_ROWS = 80


def _label(obj):
    return "{} ({})".format(engine.object_name(obj), engine.class_name(obj)) if obj is not None else "None"


def lodf_result(distribution):
    """The result file with the LODF values: the child of ComVstab.pResult whose name ends with _LODF."""
    found, result = engine._read_setting(distribution, "pResult")
    if not found or result is None or isinstance(result, (str, int, float, bool)):
        return None
    try:
        children = result.GetContents("*", 1) or []
    except Exception:
        children = []
    for child in children:
        if engine.class_name(child) == "ElmRes" and engine.object_name(child).endswith("_LODF"):
            return child
    return None


def dump_matrix(app, label, result):
    """One line per row: which contingency, and every recorded LODF value of the lines (bus1|bus2, in %)."""
    log(app, RULE)
    log(app, label)
    try:
        result.Load()
        rows, columns = int(result.GetNumberOfRows()), int(result.GetNumberOfColumns())
    except Exception as exc:
        detail(app, "The result file could not be read: {}".format(exc), "WARN")
        return None
    names, kinds = {}, {}
    for column in range(columns):
        variable = str(result.GetVariable(column))
        if variable in HEADER_COLUMNS:
            names[variable] = column
        elif variable.startswith("m:LODF"):
            kinds.setdefault(engine.class_name(result.GetObject(column)), []).append(column)
    detail(app, "{} rows x {} columns; LODF columns by class: {}".format(
        rows, columns, ", ".join("{} {}".format(kind, len(cols)) for kind, cols in sorted(kinds.items())) or "none"))
    outid_column = names.get("b:outid")
    recorded_total, values = 0, []
    for row in range(min(rows, MAX_ROWS)):
        header = {name: engine.result_value(result, row, column) for name, column in names.items()}
        contingency = None
        if header.get("b:outid") is not None:
            try:
                contingency = result.GetObj(int(header["b:outid"]))
            except Exception as exc:
                contingency = "GetObj failed: {}".format(exc)
        entries = {}
        for kind in kinds.values():
            for column in kind:
                value = engine.result_value(result, row, column)
                if value is None:
                    continue
                recorded_total += 1
                values.append(abs(value))
                name = engine.object_name(result.GetObject(column))
                entries.setdefault(name, {})[str(result.GetVariable(column)).rsplit(":", 1)[-1]] = value
        detail(app, "row {:>2} | index {} outid {} calcmod {} | contingency: {} | {} lines recorded: {}".format(
            row + 1, header.get("b:index"), header.get("b:outid"), header.get("b:calcmod"),
            contingency if isinstance(contingency, str) else _label(contingency), len(entries),
            ", ".join("{}:{}|{}".format(name, _fmt(v.get("bus1")), _fmt(v.get("bus2"))) for name, v in sorted(entries.items()))))
    detail(app, "recorded values: {}; smallest |value| {}; largest {}".format(
        recorded_total, _fmt(min(values)) if values else "-", _fmt(max(values)) if values else "-"))
    try:
        result.Release()
    except Exception:
        pass
    return {"rows": rows, "columns": columns, "recorded": recorded_total, "outid_column": outid_column}


def _fmt(value):
    return "-" if value is None else "{:.2f}".format(value)


def run_variant(app, distribution, label, changes):
    """Execute ComVstab with `changes` [(attribute, value)] applied and restored, then show the LODF matrix."""
    with StateGuard() as guard:
        for attribute, value in changes:
            known, before = engine._read_setting(distribution, attribute)
            if not guard.set(distribution, attribute, value, "ComVstab." + attribute):
                detail(app, "ComVstab.{} could not be set (it was {}).".format(attribute, before if known else "unreadable"), "WARN")
        log(app, RULE)
        log(app, "Executing ComVstab: " + label)
        try:
            code = distribution.Execute()
        except Exception as exc:
            detail(app, "Execute failed: {}".format(exc), "WARN")
            return
        detail(app, "Execute returned {}".format(code))
        result = lodf_result(distribution)
        if result is None:
            detail(app, "No result file ending with _LODF inside ComVstab.pResult.", "WARN")
            return
        dump_matrix(app, "LODF matrix: " + label, result)


def inspect(app):
    study_case = app.GetActiveStudyCase()
    if study_case is None:
        raise RuntimeError("Activate a project and a Study Case first.")
    log(app, RULE)
    log(app, "inspect_lodf.py version {} from {}".format(VERSION, Path(__file__).resolve()))
    found = list(study_case.GetContents("*.ComVstab", 1) or [])
    if not found:
        raise RuntimeError("The Study Case has no 'Sensitivities / Distribution Factors' command (ComVstab).")
    distribution = found[0]
    for attribute in ("calcLodf", "lodflim", "considerThresh", "factors4trf", "factors4bus", "isLinearCont"):
        known, value = engine._read_setting(distribution, attribute)
        detail(app, "ComVstab.{} = {}".format(attribute, engine._format_setting_value(value) if known else "<not readable>"))
    run_variant(app, distribution, "as set in the Study Case", [])
    run_variant(app, distribution, "recording limit lodflim = 0", [("lodflim", 0)])
    run_variant(app, distribution, "lodflim = 0 and factors4trf = 1", [("lodflim", 0), ("factors4trf", 1)])
    for attribute in ("lodflim", "factors4trf"):
        known, value = engine._read_setting(distribution, attribute)
        detail(app, "restored: ComVstab.{} = {}".format(attribute, engine._format_setting_value(value) if known else "<not readable>"))


def main():
    import powerfactory

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError("Run this script in PowerFactory as an external ComPython script.")
    inspect(app)


if __name__ == "__main__":
    main()
