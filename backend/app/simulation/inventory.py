"""Database contents from metadata only; never scan measurement cells to populate the picker."""

from pathlib import Path

from app.simulation import across

KINDS = ('QDS', 'n-1', "(n-1)'")


def contents(store):
    db = store.db
    owned = not db.in_transaction
    if owned:
        db.execute('BEGIN')
    try:
        analyses = across.analyses(db)
        by_id = {item['id']: item for item in analyses}
        for item in analyses:
            item['cases'] = []
            item['results'] = {kind: {} for kind in KINDS}
        for row in db.execute('SELECT assessment_id,case_id,name,status,reason FROM gl_cases ORDER BY rowid'):
            owner = by_id.get(row['assessment_id'])
            if owner is not None:
                owner['cases'].append({key: row[key] for key in ('case_id', 'name', 'status', 'reason')})
        missing_definitions = {identifier for identifier, item in by_id.items() if not item['cases']}
        for row in db.execute('SELECT id,analysis_id,name FROM pf_scenarios ORDER BY rowid'):
            owner_id = row['analysis_id'] or across.UNASSIGNED
            if owner_id in missing_definitions:
                by_id[owner_id]['cases'].append({'case_id': row['id'], 'name': row['name'], 'status': 'imported', 'reason': ''})
        for row in db.execute('SELECT assessment_id,kind,status,COUNT(*) AS n FROM gl_results GROUP BY assessment_id,kind,status'):
            owner = by_id.get(row['assessment_id'])
            if owner is not None:
                owner['results'].setdefault(row['kind'], {})[row['status']] = row['n']
        # Earlier files may link QDS runs to scenarios without native gl_results metadata.
        # Count each such run once per calculation, using run headers only.
        for row in db.execute(
            "SELECT DISTINCT COALESCE(s.analysis_id,?) AS owner,a.id,a.status FROM pf_scenarios s "
            "JOIN pf_scenario_runs r ON r.scenario_id=s.id JOIN analysis_runs a ON a.id=r.run_id "
            "WHERE NOT EXISTS (SELECT 1 FROM gl_results g WHERE g.assessment_id=s.analysis_id AND g.analysis_run_id=a.id)",
            (across.UNASSIGNED,)):
            owner = by_id.get(row['owner'])
            if owner is not None:
                status = row['status']
                bucket = owner['results']['QDS']
                bucket[status] = bucket.get(status, 0) + 1
        totals = {'calculations': 0, 'cases': 0, 'imported_cases': 0, 'unassigned_cases': 0,
                  'results': {kind: {} for kind in KINDS}}
        for item in analyses:
            item['case_count'] = len(item['cases']) or item['scenarios']
            if item['id'] == across.UNASSIGNED:
                totals['unassigned_cases'] += item['case_count']
            else:
                totals['calculations'] += 1
            totals['cases'] += item['case_count']
            totals['imported_cases'] += item['scenarios']
            for kind, statuses in item['results'].items():
                target = totals['results'].setdefault(kind, {})
                for status, count in statuses.items():
                    target[status] = target.get(status, 0) + count
        path = Path(store.path)
        try:
            sqlite_bytes = path.stat().st_size
        except OSError:
            sqlite_bytes = None
        return {'path': str(path), 'filename': path.name, 'sqlite_bytes': sqlite_bytes,
                'default_analysis': across.default_analysis(db), 'totals': totals, 'analyses': analyses}
    finally:
        if owned:
            db.rollback()
