"""The PowerFactory test script reads kept results and SQLite without calculation or backend setup."""

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'powerfactory'))
import gridlens_runtime as engine
from tests.gridlens_fixture import App, PFObject, PERIOD_START

spec = importlib.util.spec_from_file_location('n1_diagnostic', ROOT / 'powerfactory/check_n1_results.py')
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class NativeSub(PFObject):
    def __init__(self):
        super().__init__('Time', 'ElmRes', cnttime=PERIOD_START)
        self.released = False
        self.fault = PFObject('Fault', 'ComOutage')
        self.owner = PFObject('Line', 'ElmLne')

    def Load(self):
        return 0

    def Release(self):
        self.released = True

    def GetNumberOfRows(self):
        return 2

    def GetNumberOfColumns(self):
        return 1

    def GetVariable(self, _column):
        return 'c:loading'

    def GetObject(self, _column):
        return self.owner

    def GetObjectValue(self, row, column=-1):
        return 0, self.fault if row == 0 else None

    def GetValue(self, row, column=-1):
        return (3, None) if column == -1 else (0, 115.0)


def test_native_diagnosis_reports_identities_raw_cells_and_no_calculation():
    app = App()
    sub = NativeSub()
    parent = PFObject('OA_261116-100000_C1_N1', 'ElmRes')
    parent.GetContents = lambda *args: [sub]
    app.study.copies = [parent]
    before = (app.study_time.cDate, app.study_time.cTime, app.qds.iopt_maint)
    result = diagnostic.native_results(app, engine)
    assert result['total_results'] == 1
    rows = result['results'][0]['sampled_subresults'][0]['sampled_rows']
    assert rows[0]['resolved'] is True and rows[1]['resolved'] is False
    assert rows[0]['cells'][0]['return'] == [0, 115.0]
    assert sub.released and app.qds.execute_calls == 0
    assert before == (app.study_time.cDate, app.study_time.cTime, app.qds.iopt_maint)
    json.dumps(result, allow_nan=False)  # Report contains JSON values, no PowerFactory handles.


def test_missing_database_is_not_created(tmp_path):
    path = tmp_path / 'not-there.sqlite3'
    assert diagnostic.database_results(path)['exists'] is False
    assert not path.exists()


def test_database_diagnosis_does_not_upgrade_or_modify_old_database(tmp_path):
    path = tmp_path / 'old.sqlite3'
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE unrelated(value INTEGER)')
    db.execute('PRAGMA user_version=12')
    db.commit()
    db.close()
    before = path.read_bytes()
    report = diagnostic.database_results(path)
    assert report['layout'] == 12 and 'gl_results' in report['error']
    assert path.read_bytes() == before


def test_database_diagnosis_reports_imported_n1_metadata(tmp_path):
    from app.simulation.gridlens_store import TABLES
    path = tmp_path / 'n1.sqlite3'
    db = sqlite3.connect(path)
    db.executescript(TABLES)
    db.execute("INSERT INTO gl_assessments(id,native_run_id,project,study_case,engine_version,created_at,settings,configuration,mode) "
               "VALUES(?,?,?,?,?,?,?,?,?)", ('a', 'run', 'P', 'S', '8.2', '2026-11-16', '{}', '{"analysis_name":"Test n-1","assessments":["n-1"]}', 'calculated'))
    db.execute("INSERT INTO gl_results VALUES(?,?,?,?,?,?,?,?,?,?)", ('r', 'a', 'C1', 'n-1', 'Native', 'P/Native', 'incomplete', 'Unresolved row', '{}', None))
    db.execute('PRAGMA user_version=17')
    db.commit()
    db.close()
    before = path.read_bytes()
    report = diagnostic.database_results(path)
    assert report['analyses'][0]['name'] == 'Test n-1'
    assert report['n1_results'][0]['status'] == 'incomplete'
    assert report['n1_results'][0]['kind'] == 'n-1'
    assert report['n1_results'][0]['counts']['gl_n1_columns'] == 0
    assert path.read_bytes() == before


def test_complete_diagnostic_runs_with_only_standard_library_and_no_database(tmp_path):
    import subprocess
    code = '''import importlib.util,json,sys
from pathlib import Path
root=Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('diagnostic',root/'powerfactory/check_n1_results.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Object:
    def GetFullName(self): return 'Project/Study'
    def GetClassName(self): return 'IntCase'
    def GetContents(self,*args): return []
class App:
    def GetActiveStudyCase(self): return Object()
    def GetActiveProject(self): return Object()
report=module.diagnose(App(),root=root,database=sys.argv[2])
assert not report['database']['exists']
assert report['native']['total_results']==0
assert 'fastapi' not in sys.modules and 'PyQt6' not in sys.modules
print(json.dumps(report,allow_nan=False))
'''
    database = tmp_path / 'absent.sqlite3'
    result = subprocess.run([sys.executable, '-I', '-c', code, str(ROOT), str(database)],
                            capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)['findings']
    assert not database.exists()
