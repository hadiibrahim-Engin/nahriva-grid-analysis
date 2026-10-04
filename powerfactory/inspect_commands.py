"""Read-only ComPython script: shows which commands the active Study Case has and what the
sensitivity / distribution-factor command offers (class, methods, attributes with their values).

Run it once in PowerFactory (external script, like start_assessment.py). It changes nothing and writes
nothing. Its output tells us how to call PowerFactory's own LODF calculation from the assessment.
"""

from pathlib import Path
import sys

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "powerfactory"))

import gridlens_engine as engine
from pf_console import RULE, detail, log

# Commands whose class or name contains one of these words are described in full.
KEYWORDS = ("sens", "distr", "ldf", "contin", "ptdf", "lodf")


def commands(study_case):
    """Every command object of the Study Case (class, name, object)."""
    try:
        found = study_case.GetContents("*.Com*", 1) or []
    except Exception:
        found = []
    return [(engine.class_name(obj), engine.object_name(obj), obj) for obj in found]


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
    for kind, name, obj in chosen:
        log(app, RULE)
        log(app, "{} '{}'".format(kind, name))
        for line in engine.describe_object_api(obj).split("; "):
            detail(app, line)
    return len(found), len(chosen)


def main():
    import powerfactory

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError("Run this script in PowerFactory as an external ComPython script.")
    inspect(app)


if __name__ == "__main__":
    main()
