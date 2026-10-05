"""One line per saved scenario for the PowerFactory output window. Standard library only, no PF access.

Works on the serialized runs (ScenarioStore.save_scenario input): REF and OUTAGE loading, compared inside
the scenario's outage windows, so the reader sees at once whether the outage changed anything.
"""

LOADING = "loading"

# Raise when the way this module is called by the others changes (arguments, return values). start_assessment.py
# compares it across all modules, so files of different versions are named instead of failing in a confusing way.
INTERFACE_VERSION = 5


def window_maxima(run, windows):
    """Highest loading per element inside the windows (the whole run without windows).

    Samples are (element_id, metric, epoch seconds, value) as ScenarioStore.save_scenario takes them.
    """
    bounds = list(windows)
    peak = {}
    for element_id, metric, stamp, value in run["samples"]:
        if metric != LOADING or value is None:
            continue
        if bounds and not any(lo <= stamp <= hi for lo, hi in bounds):
            continue
        if element_id not in peak or value > peak[element_id]:
            peak[element_id] = value
    return peak


def describe(runs, windows, limit=100.0):
    """'highest loading 87.2 % (Line A), REF 64.1 %; above 100 %: 1 (REF 0); largest rise +23.1 (Line A)'."""
    by_kind = {run["kind"]: run for run in runs}
    ref, out = by_kind.get("REF"), by_kind.get("OUTAGE")
    if ref is None or out is None:
        return ""
    names = {element[0]: element[1] for element in out["elements"]}
    out_peak, ref_peak = window_maxima(out, windows), window_maxima(ref, windows)
    if not out_peak:
        return "no loading values inside the outage window"
    worst = max(out_peak, key=out_peak.get)
    text = "in the outage window: highest loading {:.1f} % ({}), REF {} %".format(
        out_peak[worst], names.get(worst, worst),
        "{:.1f}".format(ref_peak[worst]) if worst in ref_peak else "-",
    )
    text += "; above {:g} %: {} (REF {})".format(
        limit, sum(v > limit for v in out_peak.values()), sum(v > limit for v in ref_peak.values())
    )
    rises = [(out_peak[k] - ref_peak[k], k) for k in out_peak if k in ref_peak]
    if rises:
        rise, element = max(rises)
        text += "; largest rise {:+.1f} pp ({})".format(rise, names.get(element, element))
    return text
