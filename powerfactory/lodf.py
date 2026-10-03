"""Line outage distribution factors (LODF) from native DC load flows.

Runs once at the start of an assessment, before any QDS simulation. For every
scenario the switched-off branches are taken out of service together, one DC
load flow is calculated and the change of every monitored branch flow is related
to the flow the switched-off branches carried before:

    LODF(l, S) = (P_l,after - P_l,before) / sum(P_k,before)   for exactly one k
    LODF(l, S) = (P_l,after - P_l,before) / sum(|P_k,before|) for several k

so that a single outage gives the classical, signed LODF and combined outages a
normalised factor whose magnitude is comparable. The dashboard uses |LODF|.

Standard library plus the engine helpers only. Every changed setting is read back
and restored; a restoration failure raises so that nothing is saved on top of an
unknown PowerFactory state.
"""

import gridlens_engine as engine

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
    _execute(ldf)
    flows = {}
    for branch in monitored:
        value = _flow(branch)
        if value is None:
            raise LodfError("No flow result for " + engine.object_name(branch))
        flows[engine.object_key(branch)] = value
    return flows


def calculate(app, scenarios, element_id):
    """Return LODF rows (outage_key, element_id, lodf, p_pre, p_post).

    `scenarios` is a list of {"key": str, "equipment": [branch objects]};
    `element_id` maps a branch object to the identifier stored in the results.
    """
    ldf = app.GetFromStudyCase("ComLdf")
    if ldf is None:
        raise LodfError("The active Study Case has no ComLdf; LODF was not calculated.")
    found, original_mode = engine._read_setting(ldf, "iopt_net")
    if not found or engine.finite_number(original_mode) is None:
        raise LodfError("ComLdf.iopt_net is not readable; LODF was not calculated.")
    monitored = branches(app)
    if not monitored:
        raise LodfError("No lines or transformers found; LODF was not calculated.")
    rows = []
    failure = None
    restore_errors = []
    try:
        if not engine._set_scalar_attribute(ldf, "iopt_net", DC_LOAD_FLOW):
            raise LodfError("Could not select the DC load flow.")
        before = _flows(ldf, monitored)
        for scenario in scenarios:
            equipment = scenario["equipment"]
            if not equipment:
                continue
            switched = []
            for branch in equipment:
                found, state = engine._read_setting(branch, "outserv")
                if not found or engine.finite_number(state) not in (0, 1):
                    raise LodfError("Cannot read outserv of " + engine.object_name(branch))
                switched.append((branch, state))
            try:
                # Switching off sits inside the block that restores: if the second branch refuses,
                # the first one is put back as well.
                for branch, _state in switched:
                    if not engine._set_scalar_attribute(branch, "outserv", 1):
                        raise LodfError("Could not switch off " + engine.object_name(branch))
                after = _flows(ldf, [b for b in monitored if b not in equipment])
            finally:
                for branch, state in switched:
                    if not engine._set_scalar_attribute(branch, "outserv", state):
                        restore_errors.append("outserv of " + engine.object_name(branch))
            keys = {engine.object_key(b) for b in equipment}
            lost = [before[k] for k in keys if k in before]
            denominator = sum(lost) if len(lost) == 1 else sum(abs(v) for v in lost)
            if abs(denominator) < MIN_FLOW:
                continue
            for branch in monitored:
                key = engine.object_key(branch)
                if key in keys or key not in after:
                    continue
                rows.append((
                    scenario["key"], element_id(branch),
                    (after[key] - before[key]) / denominator, before[key], after[key],
                ))
    except LodfError as exc:
        failure = exc
    finally:
        if not engine._set_scalar_attribute(ldf, "iopt_net", original_mode):
            restore_errors.append("ComLdf.iopt_net")
    if restore_errors:
        raise RuntimeError(
            "PowerFactory state restoration failed after the LODF calculation. "
            "Verify the Study Case manually: " + ", ".join(restore_errors)
        )
    if failure is not None:
        raise failure
    return rows
