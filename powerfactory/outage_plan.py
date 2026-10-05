"""Scenario plan: which planned outages make up which named scenario. No PowerFactory access."""

# Raise when the way this module is called by the others changes (arguments, return values). start_assessment.py
# compares it across all modules, so files of different versions are named instead of failing in a confusing way.
INTERFACE_VERSION = 1


def scenario_plan(catalog, definitions=None):
    eligible = [o for o in catalog["outages"] if o["in_period"]]
    if definitions is None:
        definitions = [{"name": o["name"], "outages": [o["path"]]} for o in eligible]
    if not definitions:
        raise ValueError("No outage scenarios in the configured QDS period.")
    plan = []
    names = set()
    for definition in definitions:
        name = definition["name"].strip()
        if not name or len(name) > 200 or name in names:
            raise ValueError("Scenarios need unique names of 1–200 characters.")
        names.add(name)
        ids = []
        for reference in definition["outages"]:
            matches = [
                o for o in eligible if reference in (o["id"], o["path"], o["name"])
            ]
            if len(matches) != 1:
                raise ValueError(
                    "Outage is missing, outside the period or ambiguous: "
                    + reference
                )
            ids.append(matches[0]["id"])
        if not ids or len(ids) != len(set(ids)):
            raise ValueError(
                "A scenario needs a unique selection of outages: " + name
            )
        plan.append({"name": name, "outage_ids": ids})
    return plan


def split_by_period(plan, catalog):
    """Scenarios whose outages all lie in the catalogue's period, and the others with the outages outside
    (catalogue entries; an id the catalogue does not know is given as {"id": ..., "name": ...}).

    PowerFactory applies an outage only inside its own window; a scenario whose window is not part of the
    simulated period would produce an OUTAGE run identical to the reference and no values in the dashboard.
    """
    by_id = {o["id"]: o for o in catalog["outages"]}
    runnable, skipped = [], []
    for selection in plan:
        outside = [
            by_id.get(i, {"id": i, "name": i})
            for i in selection["outage_ids"]
            if not by_id.get(i, {}).get("in_period")
        ]
        if outside:
            skipped.append((selection, outside))
        else:
            runnable.append(selection)
    return runnable, skipped
