"""Run as an external ComPython in the affected study case AFTER the calculation.

Read-only diagnosis: no Execute(), no model/settings changes, no import, no package installation.
The only written file is .tools/n1-diagnostic-<timestamp>.json in this project.
Uses the Python standard library and the local runtime, without requiring Qt/backend packages.
Optionally set DATABASE_PATH to the exact SQLite file opened in the dashboard.
"""

import importlib.util
import json
import math
import platform
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATABASE_PATH = None  # e.g. r'C:\OutageAssessment\backend\data\outage-assessment.sqlite3'
MAX_RESULTS = 10
MAX_SUBRESULTS = 3
MAX_ROWS = 8
MAX_COLUMNS = 3


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def serial_value(value, engine):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, dict):
        return {str(key): serial_value(item, engine) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [serial_value(item, engine) for item in value]
    return {'type': type(value).__name__, 'class': engine.class_name(value),
            'path': engine.object_key(value), 'name': engine.object_name(value)}


def api_call(function, engine):
    try:
        return {'return': serial_value(function(), engine)}
    except Exception as exc:
        return {'error': '{}: {}'.format(type(exc).__name__, str(exc)[:400])}


def native_results(app, engine):
    study = app.GetActiveStudyCase()
    if study is None:
        raise RuntimeError('Bitte zuerst den betroffenen Study Case aktivieren.')
    candidates = list(engine._contents(study, '*.ElmRes'))
    command_results = set()
    for command in engine._contents(study, '*.ComSimoutage'):
        result = engine.safe_attr(command, engine.N1_RESULT_ATTRIBUTE)
        if result is not None:
            candidates.append(result)
            command_results.add(engine.object_key(result))
    found, seen = [], set()
    for result in candidates:
        path = engine.object_key(result)
        if path in seen:
            continue
        seen.add(path)
        children = [sub for sub in engine._contents(result, '*.ElmRes') if engine.class_name(sub) == 'ElmRes']
        name = engine.object_name(result)
        if not children and not name.endswith(('_N1', '_N1P')) and path not in command_results:
            continue
        found.append((result, children))
    report = {'study_case': engine.object_key(study), 'total_results': len(found), 'results': []}
    found.sort(key=lambda pair: engine.object_name(pair[0]))
    for result, children in found[-MAX_RESULTS:]:
        item = {'name': engine.object_name(result), 'path': engine.object_key(result),
                'study_times': len(children), 'sampled_subresults': []}
        for sub in children[:MAX_SUBRESULTS]:
            sample = {'path': engine.object_key(sub), 'cnttime': engine.finite_number(engine.safe_attr(sub, 'cnttime')),
                      'columns': [], 'sampled_rows': []}
            try:
                code = engine.return_code(sub.Load())
                sample['load_code'] = code
                if code != 0:
                    raise RuntimeError('ElmRes.Load returned {}'.format(code))
                sample['row_count'] = int(sub.GetNumberOfRows())
                sample['column_count'] = int(sub.GetNumberOfColumns())
                for column in range(min(sample['column_count'], MAX_COLUMNS)):
                    sample['columns'].append({'index': column, 'variable': str(sub.GetVariable(column)),
                                              'object': serial_value(sub.GetObject(column), engine)})
                for row in range(min(sample['row_count'], MAX_ROWS)):
                    outage, diagnostics = engine.contingency_row_object(sub, row)
                    sample['sampled_rows'].append({
                        'row': row, 'resolved': outage is not None,
                        'contingency': serial_value(outage, engine), 'resolver_diagnostics': diagnostics,
                        'GetObjectValue_default': api_call(lambda: sub.GetObjectValue(row), engine),
                        'GetObjectValue_axis': api_call(lambda: sub.GetObjectValue(row, -1), engine),
                        'GetValue_axis': api_call(lambda: sub.GetValue(row, -1), engine),
                        'cells': [{'column': col, **api_call(lambda col=col: sub.GetValue(row, col), engine)}
                                  for col in range(min(sample['column_count'], MAX_COLUMNS))],
                    })
            except Exception as exc:
                sample['error'] = '{}: {}'.format(type(exc).__name__, exc)
            finally:
                try:
                    sub.Release()
                except Exception:
                    pass
            item['sampled_subresults'].append(sample)
        report['results'].append(item)
    return report


def database_results(path):
    path = Path(path).expanduser().resolve()
    report = {'path': str(path), 'exists': path.is_file(), 'analyses': [], 'n1_results': []}
    if not path.is_file():
        return report
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        db.execute('BEGIN')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        report['layout'] = db.execute('PRAGMA user_version').fetchone()[0]
        if 'gl_results' not in tables:
            report['error'] = 'Diese Datei enthält keine native GridLens-Ergebnistabelle gl_results.'
            return report
        for row in db.execute('SELECT * FROM gl_assessments ORDER BY created_at DESC,rowid DESC LIMIT 20'):
            config = json.loads(row['configuration'])
            report['analyses'].append({'id': row['id'], 'name': config.get('analysis_name'),
                                      'native_run_id': row['native_run_id'], 'status': row['status'],
                                      'created_at': row['created_at'], 'assessments': config.get('assessments'),
                                      'kinds': [dict(r) for r in db.execute(
                                          'SELECT kind,status,COUNT(*) AS results FROM gl_results WHERE assessment_id=? GROUP BY kind,status', (row['id'],))]})
        for row in db.execute("SELECT * FROM gl_results WHERE kind IN (?,?) ORDER BY rowid DESC LIMIT 20", ('n-1', "(n-1)'")):
            item = {key: row[key] for key in ('id', 'assessment_id', 'case_id', 'kind', 'status', 'reason', 'native_path')}
            item['metadata'] = json.loads(row['metadata'])
            item['counts'] = {table: db.execute('SELECT COUNT(*) FROM ' + table + ' WHERE result_id=?', (row['id'],)).fetchone()[0]
                              for table in ('gl_columns', 'gl_times', 'gl_contingencies', 'gl_n1_columns', 'gl_unresolved_rows') if table in tables}
            item['has_explicit_cells'] = db.execute('SELECT 1 FROM gl_values WHERE result_id=? LIMIT 1', (row['id'],)).fetchone() is not None
            report['n1_results'].append(item)
    finally:
        db.close()
    return report


def diagnose(app, root=ROOT, database=None):
    root = Path(root)
    engine = load_module('_oa_n1_diagnostic_runtime', root / 'powerfactory/gridlens_runtime.py')
    project = app.GetActiveProject()
    report = {'created_at': datetime.now(timezone.utc).isoformat(), 'python': platform.python_version(),
              'platform': platform.platform(), 'project': engine.object_key(project),
              'sample_limits': {'results': MAX_RESULTS, 'subresults': MAX_SUBRESULTS, 'rows': MAX_ROWS, 'columns': MAX_COLUMNS},
              'native': {}, 'database': {}, 'findings': []}
    try:
        report['native'] = native_results(app, engine)
    except Exception as exc:
        report['native']['error'] = str(exc)
    try:
        if database is None:
            config = load_module('_oa_n1_diagnostic_config', root / 'scripts/appconfig.py')
            database = config.load(root)['database']
        path = Path(database).expanduser()
        report['database'] = database_results(path if path.is_absolute() else root / path)
    except Exception as exc:
        report['database']['error'] = str(exc)
    samples = [row for result in report['native'].get('results', [])
               for sub in result['sampled_subresults'] for row in sub['sampled_rows']]
    report['findings'].append('{} von {} geprüften nativen Zeilen sind eindeutig zuordenbar.'.format(
        sum(row['resolved'] for row in samples), len(samples)))
    if report['native'].get('total_results') == 0:
        report['findings'].append('Im aktiven Study Case wurden keine nativen n-1-Ergebnisobjekte gefunden.')
    if not report['database'].get('n1_results'):
        report['findings'].append('In der geprüften Datenbank wurden keine importierten n-1-Ergebnisse gefunden. Datenbankpfad und Import prüfen.')
    else:
        report['findings'].append('{} gespeicherte n-1-Ergebnisse geprüft; Analysis-/Case-IDs und Importstatus stehen im Bericht.'.format(len(report['database']['n1_results'])))
    if samples and any(not row['resolved'] for row in samples):
        report['findings'].append('Mindestens eine native Zeile ist nicht zuordenbar; API-Rückgaben und Diagnose sind im Bericht enthalten.')
    report['findings'].append('Die Diagramme zeigen Überlastungspaare; ohne Überlastungen bleibt dieses Diagramm leer. Die Extremwerttabelle zeigt separat gespeicherte Werte.')
    return report


def main():
    import powerfactory
    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError('Dieses Skript in PowerFactory als ComPython ausführen.')
    app.PrintPlain('[n-1 Diagnose] Vorhandene Ergebnisse werden gelesen. Es wird keine Rechnung gestartet.')
    report = diagnose(app, database=DATABASE_PATH)
    directory = ROOT / '.tools'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ('n1-diagnostic-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f') + '.json')
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    for finding in report['findings']:
        app.PrintPlain('[n-1 Diagnose] ' + finding)
    app.PrintPlain('[n-1 Diagnose] Bericht: ' + str(target))
    return report


if __name__ == '__main__':
    main()
