"""Line outage distribution factors (LODF) from native DC load flows.

Runs once at the start of an assessment, before any QDS simulation. For every
scenario the switched-off branches are taken out of service together, one DC
load flow is calculated and the change of every monitored branch flow is related
to the flow the switched-off branches carried before:

    LODF(l, S) = (P_l,after - P_l,before) / sum(P_k,before)   for exactly one k
    LODF(l, S) = (P_l,after - P_l,before) / sum(|P_k,before|) for several k

so that a single outage gives the classical, signed LODF and combined outages a
normalised factor whose magnitude is comparable. The dashboard uses |LODF|.

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
MIN_FLOW = 1e-6  # MW; a switched-off branch carrying less has no defined LODF


class LodfError(RuntimeError):
    """The load flow could not be evaluated; PowerFactory state was restored."""


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
        raise LodfError("DC load flow failed: " + str(exc)) from None
    if engine.finite_number(status) not in (0, None):
        raise LodfError("DC load flow did not converge (status " + str(status) + ").")


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
    """LODF rows of one scenario; the switched-off branches are put back before this returns."""
    equipment = scenario["equipment"]
    label = scenario.get("name") or scenario["key"]
    if not equipment:
        log("LODF '{}': the outage switches no line, transformer or coupler; no LODF.".format(label))
        return []
    with StateGuard() as guard:
        for branch in equipment:
            if not guard.set(branch, "outserv", 1, "outserv of " + engine.object_name(branch)):
                raise LodfError("Could not switch off " + engine.object_name(branch))
        after, _missing = _flows(ldf, [b for b in monitored if b not in equipment])
    keys = {engine.object_key(b) for b in equipment}
    lost = [before[k] for k in keys if k in before]
    denominator = sum(lost) if len(lost) == 1 else sum(abs(v) for v in lost)
    if abs(denominator) < MIN_FLOW:
        log("LODF '{}': {} carries no flow before the outage; no LODF.".format(label, _names(equipment)))
        return []
    rows = []
    for branch in monitored:
        key = engine.object_key(branch)
        if key in keys or key not in after:
            continue
        rows.append((
            scenario["key"], element_id(branch),
            (after[key] - before[key]) / denominator, before[key], after[key],
        ))
    return rows


def calculate(app, scenarios, element_id, log=lambda message: None):
    """Return LODF rows (outage_key, element_id, lodf, p_pre, p_post).

    `scenarios` is a list of {"key": str, "name": str (optional), "equipment": [branch objects]};
    `element_id` maps a branch object to the identifier stored in the results; `log` receives notes
    about branches and scenarios that get no LODF.
    LodfError: nothing could be calculated, the state is unchanged.
    StateRestoreError: a setting could not be put back (and says what stopped the calculation).
    """
    ldf = app.GetFromStudyCase("ComLdf")
    if ldf is None:
        raise LodfError("The active Study Case has no ComLdf; LODF was not calculated.")
    monitored = branches(app)
    if not monitored:
        raise LodfError("No lines or transformers found; LODF was not calculated.")
    rows = []
    with StateGuard() as guard:
        if not guard.set(ldf, "iopt_net", DC_LOAD_FLOW, "ComLdf.iopt_net"):
            raise LodfError("Could not select the DC load flow (ComLdf.iopt_net is not readable or not writable).")
        before, missing = _flows(ldf, monitored)
        if missing:
            # De-energised or isolated branches have no DC flow; they cannot take part, the rest can.
            log("LODF: {} of {} branches have no DC flow result and are left out: {}.".format(
                len(missing), len(monitored), _names(missing)))
            monitored = [b for b in monitored if b not in missing]
        if not before:
            raise LodfError("The DC load flow reports no branch flow; LODF was not calculated.")
        for scenario in scenarios:
            rows.extend(_outage_rows(ldf, monitored, before, scenario, element_id, log))
    log("LODF: {} values for {} scenarios.".format(len(rows), len({row[0] for row in rows})))
    return rows
