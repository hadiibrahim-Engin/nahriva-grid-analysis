"""Which grid (PowerFactory ElmNet) an element belongs to, read from its stored full path.

The PowerFactory script stores every element with its full name, e.g.
    \\User\\Project.IntPrj\\Network Model.IntPrjfolder\\Network Data.IntPrjfolder\\D7 Grid.ElmNet\\L1.ElmLne
so the grid is known for every database, also for ones written before the dashboard had a grid filter.
"""

from app.core.cache import TTLCache

NO_GRID = ""


def grid_name(path):
    """Name of the innermost ElmNet in the path ("D7 Grid"), or NO_GRID when the path has none."""
    for part in reversed((path or "").replace("/", "\\").split("\\")):
        if part.endswith(".ElmNet"):
            return part[: -len(".ElmNet")]
    return NO_GRID


_GRIDS_CACHE = TTLCache(max_entries=16, ttl_seconds=3600)


def grids(db, path=None):
    """Every grid with the number of distinct elements in it, in name order; elements without a grid last.

    Cached per file and number of runs: the grids change only when a run is added (100,000 elements take a second).
    """
    runs = db.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0]
    return _GRIDS_CACHE.get_or_compute((path, runs), lambda: _grids(db))


def _grids(db):
    counts = {}
    for row in db.execute("SELECT DISTINCT id, path FROM analysis_elements"):
        name = grid_name(row["path"])
        counts[name] = counts.get(name, 0) + 1
    return [
        {"name": name, "elements": count}
        for name, count in sorted(counts.items(), key=lambda item: (item[0] == NO_GRID, item[0].casefold()))
    ]
