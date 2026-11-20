"""Dedicated map workspace: an exact clock, scenario heatmap and generator/hour comparison."""

from decimal import Decimal, localcontext
from app.simulation import across, timepoint, values, redispatch


def _scenarios(store, analysis):
    return [(r, across._runs(store.db, r['id'])) for r in across._scenario_rows(store.db, analysis)]


def timeline(store, analysis=None, element=None, metric='loading', points=180, start=None, end=None):
    analysis = across.resolve_analysis(store.db, analysis)
    scenarios = _scenarios(store, analysis)
    delivery = redispatch.latest(store.db, analysis)
    courses, clock = [], set()
    for row, runs in scenarios:
        course = {}
        if metric == 'redispatch':
            if delivery:
                clause = ' AND element_id=?' if element else ''
                params = (delivery['id'], row['id'], element) if element else (delivery['id'], row['id'])
                for r in store.db.execute('SELECT start_t,cost_eur FROM rd_hours WHERE import_id=? AND scenario_id=?' + clause, params):
                    with localcontext() as context:
                        context.prec = 64
                        course[r[0]] = course.get(r[0], Decimal(0)) + Decimal(r[1])
                course = {t: float(v) for t,v in course.items()}
        elif 'OUTAGE' in runs:
            if element:
                course = dict(values.query(store.db, runs['OUTAGE'],
                    'SELECT v.t,v.value FROM analysis_series se JOIN analysis_values v ON v.series_id=se.id '
                    'WHERE se.run_id=? AND se.element_id=? AND se.metric_id=? ORDER BY v.t', (runs['OUTAGE'], element, metric)))
            else:
                field = 0 if metric == 'loading' else 2
                course = {t: r[field] for t, r in timepoint.run_times(store, runs['OUTAGE'])['rows'].items()}
        course = {t: v for t, v in course.items() if (start is None or t >= start) and (end is None or t <= end)}
        clock.update(course)
        courses.append((row, runs, course))
    # Costs may cover hours without a calculated QDS sample. Keep those navigable, with missing network values.
    if delivery:
        clock.update(r[0] for r in store.db.execute('SELECT DISTINCT start_t FROM rd_hours WHERE import_id=?', (delivery['id'],))
                     if (start is None or r[0] >= start) and (end is None or r[0] <= end))
    clock = sorted(clock)
    size = max(1, -(-len(clock) // points))
    columns = [{'start': clock[i], 'end': clock[min(i + size - 1, len(clock) - 1)]} for i in range(0, len(clock), size)]
    position = {t: i // size for i, t in enumerate(clock)}
    result = []
    for row, runs, course in courses:
        cells = [None] * len(columns)
        for t, value in course.items():
            if value is None:
                continue
            i, cell = position[t], cells[position[t]]
            worse = cell is None or (value < cell['value'] if metric == 'voltage' else abs(value) > abs(cell['value']))
            if worse:
                cells[i] = {'t': t, 'value': value}
        result.append({'id': row['id'], 'name': row['name'], 'has_qds': 'OUTAGE' in runs, 'cells': cells})
    return {'analysis': analysis, 'times': clock, 'columns': columns, 'scenarios': result, 'metric': metric,
            'interval_steps': size, 'element': element, 'delivery': delivery}


def at_time(store, analysis, t, element=None, grid=None, kv=None):
    analysis = across.resolve_analysis(store.db, analysis)
    scenarios = _scenarios(store, analysis)
    delivery = redispatch.latest(store.db, analysis)
    costs = redispatch.for_hour(store.db, delivery, t)
    plants = [dict(r) for r in store.db.execute(
        "SELECT element_id,name,class_name,grid,nominal_kv FROM gl_elements WHERE assessment_id=? "
        "AND class_name IN ('ElmSym','ElmGenstat','ElmPvsys') ORDER BY name", (analysis,))
        if (grid is None or r['grid'] == grid) and (kv is None or r['nominal_kv'] == kv)]
    selected = store.db.execute('SELECT * FROM gl_elements WHERE assessment_id=? AND element_id=?', (analysis, element)).fetchone() if element else None
    plant_ids = [plant["element_id"] for plant in plants]
    results, generators = [], []
    for row, runs in scenarios:
        entry = {'id': row['id'], 'name': row['name'], 'loading_max': None, 'loading_over': None, 'value': None, 'ref': None,
                 'metric': None, 'outaged': False, 'has_time': False}
        if 'OUTAGE' in runs:
            run_times = timepoint.run_times(store, runs['OUTAGE'])['rows']
            entry['has_time'] = t in run_times
            if t in run_times:
                entry['loading_max'], entry['loading_over'] = run_times[t][:2]
            if selected:
                metric = 'voltage' if selected['class_name'] == 'ElmTerm' else 'active_power' if selected['class_name'] in redispatch.PLANT_CLASSES else 'loading'
                vals = []
                for kind in ('OUTAGE', 'REF'):
                    run = runs.get(kind)
                    found = values.element_values_at(store.db, run, metric, t, [element])
                    vals.append(found.get(element))
                entry.update(value=vals[0], ref=vals[1], metric=metric)
                _ids, _chosen, windows, equipment = across._outage_context(store, row)
                entry['outaged'] = selected['name'] in equipment and any(a <= t <= b for a, b in windows)
            power = values.element_values_at(store.db, runs['OUTAGE'], 'active_power', t, plant_ids)
        else:
            power = {}
        hour_rows = []
        for plant in plants:
            rd = costs.get((row['id'], plant['element_id']))
            if rd:
                hour_rows.append(rd)
            generators.append({**plant, 'scenario_id': row['id'], 'scenario_name': row['name'],
                               'active_power_mw': power.get(plant['element_id']),
                               'energy_mwh': float(rd['energy_mwh']) if rd else None,
                               'price_eur_per_mwh': float(rd['price_eur_per_mwh']) if rd else None,
                               'cost_eur': float(rd['cost_eur']) if rd else None})
        entry['redispatch'] = redispatch.amounts(hour_rows)
        entry['redispatch_expected_plants'] = len(plants)
        results.append(entry)
    return {'analysis': analysis, 't': t, 'hour_start': t - t % 3600, 'scenarios': results, 'plants': generators,
            'element': dict(selected) if selected else None, 'delivery': delivery}


def equipment_at_time(store, analysis, t, element):
    """All recorded QDS metrics for one equipment at exactly t, across all scenarios.

    Kept separate from the page summary: hovering never scans values of every equipment. Shared reference
    runs are read once. Missing samples stay null; Redispatch belongs only to the selected generator/hour.
    """
    analysis = across.resolve_analysis(store.db, analysis)
    selected = store.db.execute('SELECT * FROM gl_elements WHERE assessment_id=? AND element_id=?', (analysis, element)).fetchone()
    if not selected:
        return None
    delivery = redispatch.latest(store.db, analysis)
    costs = redispatch.for_hour(store.db, delivery, t) if selected['class_name'] in redispatch.PLANT_CLASSES else {}
    samples, metadata = {}, {}

    def read(run):
        if run not in samples:
            rows = store.db.execute(
                'SELECT se.id AS series_id,m.id,m.name,m.unit,COALESCE(l.lower,m.lower) AS lower,'
                'COALESCE(l.upper,m.upper) AS upper FROM analysis_series se '
                'JOIN analysis_metrics m ON m.run_id=se.run_id AND m.id=se.metric_id '
                'LEFT JOIN pf_element_limits l ON l.run_id=se.run_id AND l.element_id=se.element_id AND l.metric_id=se.metric_id '
                'WHERE se.run_id=? AND se.element_id=?', (run, element)).fetchall() if run else []
            series = {r['series_id']: r['id'] for r in rows}
            samples[run] = {series[sid]: v for sid, v in values.samples_at(store.db, run, t, series).items()}
            metadata[run] = {r['id']: {k: r[k] for k in ('id', 'name', 'unit', 'lower', 'upper')} for r in rows}
        return samples[run], metadata[run]

    result = []
    for row, runs in _scenarios(store, analysis):
        actual, actual_meta = read(runs.get('OUTAGE'))
        reference, ref_meta = read(runs.get('REF'))
        metrics = []
        for key, meta in (ref_meta | actual_meta).items():
            value, ref = actual.get(key), reference.get(key)
            metrics.append({**meta, 'value': value, 'ref': ref,
                            'delta': value-ref if value is not None and ref is not None else None})
        _ids, _chosen, windows, equipment = across._outage_context(store, row)
        off = selected['name'] in equipment and any(a <= t <= b for a, b in windows)
        rd = costs.get((row['id'], element))
        result.append({'id': row['id'], 'name': row['name'], 'has_time': bool(actual), 'has_qds': 'OUTAGE' in runs,
                       'outaged': off, 'metrics': metrics,
                       'redispatch': {k: float(rd[k]) for k in ('energy_mwh', 'price_eur_per_mwh', 'cost_eur')} if rd else None})
    return {'analysis': analysis, 't': t, 'hour_start': t-t % 3600, 'element': dict(selected),
            'scenarios': result, 'delivery': delivery}
