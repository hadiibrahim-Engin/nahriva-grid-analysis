"""Writing time series into the compact layout (analysis_series + analysis_values).

The only place that turns (element, metric, time, value) rows into storage; the PowerFactory script and
the import contract both go through here.
"""

from datetime import datetime

# Raise when the way this module is called by the others changes (arguments, return values). start_assessment.py
# compares it across all modules, so files of different versions are named instead of failing in a confusing way.
INTERFACE_VERSION = 1


def epoch(value):
    """Epoch seconds (int) of a datetime, an ISO string or a number."""
    if isinstance(value, datetime):
        return int(round(value.timestamp()))
    if isinstance(value, str):
        return int(round(datetime.fromisoformat(value).timestamp()))
    return int(round(value))


def insert_values(db, run_id, samples):
    """Store `samples` of one run: iterable of (element_id, metric_id, time, value); time as accepted by epoch().

    Runs inside the caller's transaction. A duplicate (series, time) raises sqlite3.IntegrityError.
    """
    series = {}
    rows = []
    for element_id, metric_id, time, value in samples:
        key = (metric_id, element_id)
        series_id = series.get(key)
        if series_id is None:
            series_id = db.execute(
                "INSERT INTO analysis_series(run_id, metric_id, element_id) VALUES(?,?,?)",
                (run_id, metric_id, element_id),
            ).lastrowid
            series[key] = series_id
        rows.append((series_id, epoch(time), value))
    rows.sort()  # key order: appended to the end of the table instead of inserted in between
    db.executemany("INSERT INTO analysis_values(series_id, t, value) VALUES(?,?,?)", rows)
    return len(rows)
