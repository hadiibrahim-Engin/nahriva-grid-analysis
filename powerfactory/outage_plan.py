"""Scenario plan: which planned outages make up which named scenario. No PowerFactory access."""


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
