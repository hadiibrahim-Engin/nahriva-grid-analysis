"""Summaries the bridge prepares while it imports a QDS run, from the values it holds in memory anyway.

- `RunTimes`: per time of the run the highest branch loading and branches above their limit, the lowest and highest
  node voltage and nodes outside their band (pf_run_times).
- `RunStats`: per element the figures the evaluation summary of a scenario reads (across._scenario_cells): exactly
  what across._loading_stats, _voltage_range and _hours_outside return on the stored values, for the outage windows
  of every scenario the run belongs to. across.prepare_cells then summarises a scenario without reading its runs
  again; for windows or limits it was not built for it reads the stored values as before.

Both aggregate groups of series at once with pyarrow (which the bridge needs for the value files anyway): about a
million values per group, grouped by time (RunTimes) or by series (RunStats). Measured against per-series Python
loops: 12x faster for a year of hourly values, 3x for 73 hours (docs/STORAGE.md). A value PowerFactory did not
deliver (None) counts in no extreme, count or violation, as in the SQL it replaces.
"""

from bisect import bisect_left, bisect_right

from app.simulation.across import DEFAULT_LIMITS, LOADING, VOLTAGE, _step_hours

# Values aggregated in one go: bounds the memory of the tiled index arrays (16 bytes per value).
GROUP_VALUES = 1_000_000


def _arrow():
    import pyarrow
    import pyarrow.compute
    return pyarrow, pyarrow.compute


def window_key(windows):
    """The identity of a set of outage windows, as across._outage_context gives them."""
    return tuple((start, end) for start, end in windows)


def scenario_windows(outages, outage_ids):
    """Outage windows of a scenario from its catalog outages and outage ids, as across._outage_context derives them."""
    known = {o["id"]: o for o in outages}
    chosen = [known[i] for i in outage_ids if i in known]
    return [(o["start"], o["end"]) for o in chosen if o.get("start") is not None and o.get("end") is not None]


def _group_size(rows):
    return max(1, min(1000, GROUP_VALUES // max(rows, 1)))


class _Tiles:
    """Index arrays of a group of series laid end to end: position in the group and time index, built once."""

    def __init__(self, pa, rows, size):
        self.pa, self.rows = pa, rows
        self.series = pa.concat_arrays([pa.repeat(pa.scalar(j, pa.int64()), rows) for j in range(size)])
        self._tiled = {}

    def series_of(self, count):
        return self.series.slice(0, count * self.rows)

    def tile(self, name, array, count):
        """`array` (one series long) repeated for `count` series; cached at the full group size."""
        full = self._tiled.get(name)
        if full is None:
            full = self._tiled[name] = self.pa.concat_arrays([array] * (len(self.series) // self.rows))
        return full.slice(0, count * self.rows)


def _repeat_each(pa, values, rows, kind):
    """One scalar per series (None: null), each repeated over the series' rows."""
    return pa.concat_arrays([pa.repeat(pa.scalar(value, kind), rows) for value in values])


class RunTimes:
    """Per time of one QDS run: highest branch loading, branches above their limit, lowest and highest node voltage,
    nodes outside their band (pf_run_times). Same figures as the per-time SQL of app/simulation/timepoint.py."""

    def __init__(self, rows):
        self.pa, self.pc = _arrow()
        self.rows = rows
        self.size = _group_size(rows)
        self.tiles = None
        self.pending = {"loading": [], "voltage": []}
        self.loading_max = self.loading_over = None
        self.voltage_min = self.voltage_max = self.voltage_outside = None

    def add(self, metric, category, values, lower, upper):
        if metric == LOADING and category in ("line", "transformer"):
            group = "loading"
        elif metric == VOLTAGE and category == "bus":
            group = "voltage"
        else:
            return
        if not isinstance(values, self.pa.Array):
            values = self.pa.array(values, self.pa.float64())
        self.pending[group].append((values, lower, upper))
        if len(self.pending[group]) >= self.size:
            self._flush(group)

    def _flush(self, group):
        pending = self.pending[group]
        if not pending:
            return
        pa, pc, rows, count = self.pa, self.pc, self.rows, len(pending)
        if self.tiles is None:
            self.tiles = _Tiles(pa, rows, self.size)
        index = self.tiles.tile("index", pa.array(range(rows), pa.int64()), count)
        value = pa.concat_arrays([v for v, _l, _u in pending])
        upper = _repeat_each(pa, [u for _v, _l, u in pending], rows, pa.float64())
        above = pc.cast(pc.greater(value, upper), pa.int64())
        if group == "loading":
            table = pa.table({"i": index, "v": value, "o": above}).group_by("i").aggregate(
                [("v", "max"), ("o", "sum")]).sort_by("i")
            high, over = table["v_max"].combine_chunks(), pc.fill_null(table["o_sum"], 0).combine_chunks()
            self.loading_max = high if self.loading_max is None else pc.max_element_wise(self.loading_max, high)
            self.loading_over = over if self.loading_over is None else pc.add(self.loading_over, over)
        else:
            lower = _repeat_each(pa, [lo for _v, lo, _u in pending], rows, pa.float64())
            outside = pc.add(pc.fill_null(above, 0), pc.fill_null(pc.cast(pc.less(value, lower), pa.int64()), 0))
            table = pa.table({"i": index, "v": value, "o": outside}).group_by("i").aggregate(
                [("v", "min"), ("v", "max"), ("o", "sum")]).sort_by("i")
            low, high = table["v_min"].combine_chunks(), table["v_max"].combine_chunks()
            outside = table["o_sum"].combine_chunks()
            self.voltage_min = low if self.voltage_min is None else pc.min_element_wise(self.voltage_min, low)
            self.voltage_max = high if self.voltage_max is None else pc.max_element_wise(self.voltage_max, high)
            self.voltage_outside = outside if self.voltage_outside is None else pc.add(self.voltage_outside, outside)
        self.pending[group] = []

    def columns(self):
        """(loading_max, loading_over, voltage_min, voltage_max, voltage_outside) per time, as Python lists."""
        self._flush("loading")
        self._flush("voltage")
        none, zero = [None] * self.rows, [0] * self.rows

        def listed(array, default):
            return default if array is None else array.to_pylist()
        return (listed(self.loading_max, none), listed(self.loading_over, zero), listed(self.voltage_min, none),
                listed(self.voltage_max, none), listed(self.voltage_outside, zero))

    def store(self, db, run_id, timestamps):
        db.executemany("INSERT INTO pf_run_times VALUES(?,?,?,?,?,?,?)",
                       ((run_id, t, *figures) for t, *figures in zip(timestamps, *self.columns())))


class RunStats:
    """Per element of one QDS run the figures of the evaluation summary, for the given sets of outage windows."""

    def __init__(self, timestamps, window_sets, limits=DEFAULT_LIMITS):
        self.pa, self.pc = _arrow()
        self.limits = tuple(limits)
        self.rows = len(timestamps)
        self.times = self.pa.array(timestamps, self.pa.int64())
        self.size = _group_size(self.rows)
        self.tiles = None
        self.masks = {}
        for windows in window_sets:
            key = window_key(windows)
            if key in self.masks:
                continue
            inside = [not key] * self.rows
            for start, end in key:  # v.t >= start AND v.t <= end, inclusive as in across._window_expr
                low, high = bisect_left(timestamps, start), bisect_right(timestamps, end)
                inside[low:high] = [True] * max(high - low, 0)
            self.masks[key] = self.pa.array(inside, self.pa.bool_())
        self.keys = list(self.masks)
        self.pending = {LOADING: [], VOLTAGE: []}
        self.ids = {LOADING: [], VOLTAGE: []}
        self.limited = []  # per voltage series: whether it has a stored band (a pf_element_limits row)
        self.parts = {LOADING: {}, VOLTAGE: {}}
        self.done = {}

    def add(self, element_id, metric, values, lower, upper):
        if metric not in self.pending:
            return
        if not isinstance(values, self.pa.Array):
            values = self.pa.array(values, self.pa.float64())
        self.pending[metric].append((values, lower, upper))
        self.ids[metric].append(element_id)
        if metric == VOLTAGE:
            self.limited.append(lower is not None or upper is not None)
        if len(self.pending[metric]) >= self.size:
            self._flush(metric)

    def _flush(self, metric):
        pending = self.pending[metric]
        if not pending:
            return
        pa, pc, rows, count = self.pa, self.pc, self.rows, len(pending)
        if self.tiles is None:
            self.tiles = _Tiles(pa, rows, self.size)
        value = pa.concat_arrays([v for v, _l, _u in pending])
        valid_time = pc.if_else(pc.is_valid(value), self.tiles.tile("t", self.times, count), None)
        columns = {"s": self.tiles.series_of(count), "v": value, "t": valid_time}
        aggregates = [("v", "count"), ("t", "min"), ("t", "max")]
        if metric == LOADING:
            aggregates.append(("v", "max"))
            for k, limit in enumerate(self.limits):
                columns[f"o{k}"] = pc.cast(pc.greater(value, limit), pa.int64())
                aggregates.append((f"o{k}", "sum"))
        else:
            lower = _repeat_each(pa, [-1e9 if lo is None else lo for _v, lo, _u in pending], rows, pa.float64())
            upper = _repeat_each(pa, [1e9 if up is None else up for _v, _lo, up in pending], rows, pa.float64())
            columns["bad"] = pc.cast(pc.or_(pc.less(value, lower), pc.greater(value, upper)), pa.int64())
            aggregates.append(("bad", "sum"))
        for n, key in enumerate(self.keys):
            inside = pc.if_else(self.tiles.tile(("mask", key), self.masks[key], count), value, None)
            columns[f"w{n}"] = inside
            aggregates += [(f"w{n}", "max")] if metric == LOADING else [(f"w{n}", "min"), (f"w{n}", "max")]
        table = pa.table(columns).group_by("s").aggregate(aggregates).sort_by("s")
        for name in table.column_names:
            if name != "s":
                self.parts[metric].setdefault(name, []).append(table[name].combine_chunks())
        self.pending[metric] = []

    def _columns(self, metric):
        """The aggregated figures of every series of `metric`, as Python lists (computed once)."""
        if metric not in self.done:
            self._flush(metric)
            self.done[metric] = {name: self.pa.concat_arrays(parts).to_pylist()
                                 for name, parts in self.parts[metric].items()}
            self.parts[metric] = {}
            if len(self.done) == len(self.pending):
                self.tiles = None
        return self.done[metric]

    def _rows(self, metric):
        columns = self._columns(metric)
        order = sorted(range(len(self.ids[metric])), key=self.ids[metric].__getitem__)  # ORDER BY element_id
        return [i for i in order if columns.get("v_count", [])[i]], columns  # only elements with a valid value

    def loading_stats(self, windows, limits):
        """As across._loading_stats; None when this run was not prepared for these windows or limits."""
        n = self.keys.index(window_key(windows)) if window_key(windows) in self.masks else None
        if n is None or tuple(limits) != self.limits:
            return None
        rows, c = self._rows(LOADING)
        ids, result = self.ids[LOADING], {}
        for i in rows:
            count, t0, t1 = c["v_count"][i], c["t_min"][i], c["t_max"][i]
            step = _step_hours(count, t0, t1)
            result[ids[i]] = {
                "full_max": c["v_max"][i],
                "win_max": c[f"w{n}_max"][i],
                "hours_over": [(c[f"o{k}_sum"][i] or 0) * step for k in range(len(self.limits))],
                "period": count * step,
            }
        return result

    def voltage_range(self, windows):
        """As across._voltage_range; None when this run was not prepared for these windows."""
        if window_key(windows) not in self.masks:
            return None
        n = self.keys.index(window_key(windows))
        rows, c = self._rows(VOLTAGE)
        ids = self.ids[VOLTAGE]
        return {ids[i]: [c[f"w{n}_min"][i], c[f"w{n}_max"][i]] for i in rows if c[f"w{n}_min"][i] is not None}

    def hours_outside(self):
        """As across._hours_outside: hours outside the stored band, for the series that have one."""
        rows, c = self._rows(VOLTAGE)
        ids = self.ids[VOLTAGE]
        return {ids[i]: (c["bad_sum"][i] or 0) * _step_hours(c["v_count"][i], c["t_min"][i], c["t_max"][i])
                for i in rows if self.limited[i]}
