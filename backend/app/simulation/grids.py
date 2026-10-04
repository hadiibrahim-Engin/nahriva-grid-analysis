"""Which grid (PowerFactory ElmNet) an element belongs to, read from its stored full path.

The PowerFactory script stores every element with its full name, e.g.
    \\User\\Project.IntPrj\\Network Model.IntPrjfolder\\Network Data.IntPrjfolder\\D7 Grid.ElmNet\\L1.ElmLne
so the grid is known for every database, also for ones written before the dashboard had a grid filter.
"""

NO_GRID = ""


def grid_name(path):
    """Name of the innermost ElmNet in the path ("D7 Grid"), or NO_GRID when the path has none."""
    for part in reversed((path or "").replace("/", "\\").split("\\")):
        if part.endswith(".ElmNet"):
            return part[: -len(".ElmNet")]
    return NO_GRID


def grids(db):
    """Every grid with the number of distinct elements in it, in name order; elements without a grid last."""
    counts = {}
    for row in db.execute("SELECT DISTINCT id, path FROM analysis_elements"):
        name = grid_name(row["path"])
        counts[name] = counts.get(name, 0) + 1
    return [
        {"name": name, "elements": count}
        for name, count in sorted(counts.items(), key=lambda item: (item[0] == NO_GRID, item[0].casefold()))
    ]
