"""The one catalogue of result states the dashboard reports, versioned with STATES_VERSION.

A missing result is never a number: every value the API cannot give as a number carries one of these states.
Cell states describe one value at one time, result and case states one stored result or planning case, analysis
states one import. The catalogue holds only states the code produces; a new state is added here first.
"""

STATES_VERSION = 1

# QDS value the bridge stored as NULL: PowerFactory wrote no valid number (de-energised node, invalid cell).
INVALID_OR_MISSING = "invalid_or_missing"

CELL_STATES = {
    "value": "A finite value from PowerFactory, including a real zero.",
    INVALID_OR_MISSING: "No valid number from PowerFactory (de-energised node, invalid or missing cell). Never shown as 0.",
    "not_recorded": "n-1: inside the recording limits of the contingency analysis (PowerFactory code 3); the "
                    "value lies below the loading limit or inside the voltage band and is not stored.",
    "missing_row": "n-1: the contingency has no row at this study time (e.g. its equipment is already out of service).",
    "missing_column": "n-1: the element was not recorded at this study time.",
    "invalid": "n-1: the native cell holds no finite number.",
    "read_error": "n-1: the native cell could not be read.",
}
ELEMENT_STATES = {
    "outaged": "The element is switched off by a planned outage of the scenario inside its outage window.",
}
RESULT_STATES = {
    "completed": "Stored completely.",
    "incomplete": "Stored, but with values or study times missing (see the metadata of the result).",
    "failed": "The calculation produced no result.",
    "not_calculated": "Not calculated (e.g. no contingency analysis in the study case).",
}
CASE_STATES = {
    "READY": "Calculated and stored.",
    "NOT SIMULATED": "Not calculated (main.py: no outage window in the period or not runnable).",
    "NOT EVALUATED": "Calculated, but not evaluable (main.py).",
    "FAILED": "The calculation of the case failed.",
    "IMPORT FAILED": "The import stopped before the case was stored; the native results stay in PowerFactory.",
}
ANALYSIS_STATES = {
    "importing": "The import is running; stored cases are already shown.",
    "complete": "Every result was imported.",
    "failed": "The import stopped; stored cases are shown, the others are marked IMPORT FAILED.",
    "unknown": "Imported before the status was recorded.",
}


def catalogue():
    return {
        "version": STATES_VERSION,
        "cell": CELL_STATES,
        "element": ELEMENT_STATES,
        "result": RESULT_STATES,
        "case": CASE_STATES,
        "analysis": ANALYSIS_STATES,
    }
