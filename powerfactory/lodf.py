"""Line outage distribution factors (LODF) from AC load flows.

Runs once at the start of an assessment, before any QDS simulation. For every outage (the equipment of
one scenario) the switched-off branches are taken out of service together, one AC load flow (the Study
Case's own ComLdf, unchanged) is calculated, and the change of every monitored branch flow is related to
the flow the switched-off branches carried before:

    LODF(l, S) = (P_l,after - P_l,before) / sum(P_k,before)   for exactly one k
    LODF(l, S) = (P_l,after - P_l,before) / sum(|P_k,before|) for several k

so that a single outage gives the classical, signed LODF and combined outages a normalised factor whose
magnitude is comparable. The dashboard uses |LODF|.

The LODF describes how flow is redistributed in a connected grid. It is NOT DEFINED for an outage that
the AC load flow cannot solve (e.g. a generator step-up transformer: the generator is cut off) or that
cuts branches off the grid; such an outage is reported with its reason and gets no values.

Standard library plus the engine helpers only. Every changed setting goes through
pf_state.StateGuard: it is read back and restored; a restoration failure raises
StateRestoreError so that nothing is saved on top of an unknown PowerFactory state.
"""

import gridlens_engine as engine
from pf_state import StateGuard

# Branch classes with a flow result and the variable that holds it.
FLOW_ATTRIBUTES = {
    "ElmLne": "m:P:bus1",
    "ElmTr2": "m:P:bushv",
    "ElmTr3": "m:P:bushv",
    "ElmCoup": "m:P:bus1",
}
DC_LOAD_FLOW = 2  # ComLdf.iopt_net: 0 AC balanced, 1 AC unbalanced, 2 DC
AC_LOAD_FLOW = 0
MIN_FLOW = 1e-6  # MW; a switched-off branch carrying less has no defined LODF
CUT_OFF_FLOW = 0.01  # MW; a branch that carried more before and exactly 0 after is cut off from the grid


class LodfError(RuntimeError):
    """The load flow could not be evaluated; PowerFactory state was restored."""


class NotConverged(LodfError):
    """The load flow ran but found no solution."""


class NotDefined(LodfError):
    """The LODF of one outage is not defined; the other outages are not affected."""


def _flow(branch):
    found, value = engine._read_setting(branch, FLOW_ATTRIBUTES[engine.class_name(branch)])
    return engine.finite_number(value) if found else None


def branches(app):
    found = []
    for class_name in FLOW_ATTRIBUTES:
        for item in engine._as_objects(app.GetCalcRelevantObjects("*." + class_name)):
            if not engine.element_in_scope(item):
                continue
            known, state = engine._read_setting(item, "outserv")
            if known and engine.finite_number(state) == 1:
                continue  # already out of service in the study case: no flow, nothing to compare
            found.append(item)
    return found


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
        if engine.class_name(item) in FLOW_ATTRIBUTES:
            unique[engine.object_key(item)] = item
    return list(unique.values())


def _execute(ldf):
    try:
        status = ldf.Execute()
    except Exception as exc:
        raise LodfError("AC load flow failed: " + str(exc)) from None
    if engine.finite_number(status) not in (0, None):
        raise NotConverged("AC load flow did not converge (status " + str(status) + ").")


def _flows(ldf, monitored):
    """Flows of the branches PowerFactory reports one for, and the branches it reports none for."""
    _execute(ldf)
    flows, missing = {}, []
    for branch in monitored:
        value = _flow(branch)
        if value is None:
            missing.append(branch)
        else:
            flows[engine.object_key(branch)] = value
    return flows, missing


def _names(branches, limit=5):
    names = [engine.object_name(b) for b in branches[:limit]]
    return ", ".join(names) + (" and {} more".format(len(branches) - limit) if len(branches) > limit else "")


def _outage_rows(ldf, monitored, before, scenario, element_id, log):
    """LODF rows of one outage; the switched-off branches are put back before this returns.

    NotDefined: the AC load flow has no solution without this equipment, or the outage cuts branches off.
    """
    equipment = scenario["equipment"]
    label = scenario.get("name") or scenario["key"]
    if not equipment:
        raise NotDefined("LODF '{}': the outage switches no line, transformer or coupler; not defined.".format(label))
    remaining = [b for b in monitored if b not in equipment]
    try:
        with StateGuard() as guard:
            for branch in equipment:
                if not guard.set(branch, "outserv", 1, "outserv of " + engine.object_name(branch)):
                    raise LodfError("Could not switch off " + engine.object_name(branch))
            after, absent = _flows(ldf, remaining)
    except NotConverged:
        raise NotDefined(
            "LODF '{}': the AC load flow has no solution without {}; not defined (typically a generator or "
            "a part of the grid is cut off).".format(label, _names(equipment))
        ) from None
    cut_off = absent + [
        b for b in remaining
        if engine.object_key(b) in after and engine.object_key(b) in before
        and after[engine.object_key(b)] == 0.0 and abs(before[engine.object_key(b)]) >= CUT_OFF_FLOW
    ]
    if cut_off:
        raise NotDefined("LODF '{}': switching off {} cuts off {} branches ({}); not defined.".format(
            label, _names(equipment), len(cut_off), _names(cut_off)))
    keys = {engine.object_key(b) for b in equipment}
    lost = [before[k] for k in keys if k in before]
    denominator = sum(lost) if len(lost) == 1 else sum(abs(v) for v in lost)
    if abs(denominator) < MIN_FLOW:
        raise NotDefined("LODF '{}': {} carries no flow before the outage; not defined.".format(label, _names(equipment)))
    rows = []
    for branch in remaining:
        key = engine.object_key(branch)
        if key in after and key in before:
            rows.append((
                scenario["key"], element_id(branch),
                (after[key] - before[key]) / denominator, before[key], after[key],
            ))
    return rows


def calculate(app, scenarios, element_id, log=lambda message: None, undefined=None):
    """Return LODF rows (outage_key, element_id, lodf, p_pre, p_post).

    `scenarios` is a list of {"key": str, "name": str (optional), "equipment": [branch objects]};
    `element_id` maps a branch object to the identifier stored in the results; `log` receives notes.
    Outages whose LODF is not defined are skipped; with a dict as `undefined` their key and reason are
    collected there.
    LodfError: nothing could be calculated, the state is unchanged.
    StateRestoreError: a setting could not be put back (and says what stopped the calculation).
    """
    ldf = app.GetFromStudyCase("ComLdf")
    if ldf is None:
        raise LodfError("The active Study Case has no ComLdf; LODF was not calculated.")
    known, mode = engine._read_setting(ldf, "iopt_net")
    mode = engine.finite_number(mode) if known else None
    if mode is None:
        raise LodfError("ComLdf.iopt_net is not readable; LODF was not calculated.")
    monitored = branches(app)
    if not monitored:
        raise LodfError("No lines or transformers found; LODF was not calculated.")
    rows = []
    skipped = []
    with StateGuard() as guard:
        if mode == DC_LOAD_FLOW:
            # The Study Case is set to DC: the LODF is calculated with AC, then the setting is put back.
            log("The Study Case's load flow is set to DC; the LODF uses AC for its calculation.")
            if not guard.set(ldf, "iopt_net", AC_LOAD_FLOW, "ComLdf.iopt_net"):
                raise LodfError("Could not select the AC load flow (ComLdf.iopt_net is not writable).")
        try:
            before, missing = _flows(ldf, monitored)
        except NotConverged:
            raise LodfError("The AC load flow of the base case did not converge; LODF was not calculated.") from None
        if missing:
            # De-energised or isolated branches have no flow result; they cannot take part, the rest can.
            log("LODF: {} of {} branches have no flow result and are left out: {}.".format(
                len(missing), len(monitored), _names(missing)))
            monitored = [b for b in monitored if b not in missing]
        if not before:
            raise LodfError("The AC load flow reports no branch flow; LODF was not calculated.")
        for scenario in scenarios:
            try:
                rows.extend(_outage_rows(ldf, monitored, before, scenario, element_id, log))
            except NotDefined as exc:
                log(str(exc))
                skipped.append(scenario.get("name") or scenario["key"])
                if undefined is not None:
                    undefined[scenario["key"]] = str(exc)
    log("LODF: {} values for {} outages; {} not defined{}.".format(
        len(rows), len({row[0] for row in rows}), len(skipped), (": " + ", ".join(skipped)) if skipped else ""))
    return rows
