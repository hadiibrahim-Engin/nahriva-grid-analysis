"""PowerFactory entry point: GridLens GUI, native calculations, then dashboard.

Configure this file as an external ComPython script in the active study case.
The complete project folder and its prepared dashboard installation are required.
No IntReport or report template is required. The Qt manager needs PyQt6/PyQt5; Parquet writing needs pyarrow.
"""

import shutil
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DATABASE_DIRECTORY = PROJECT_DIR / 'backend/data'
DATABASE_NAME = 'outage-assessment.sqlite3'
DASHBOARD_HOST = '127.0.0.1'
DASHBOARD_PORT = 8765
DASHBOARD_PYTHON = None
SHOW_DASHBOARD = True
OPEN_BROWSER = True
# Below this much free space in the database folder no run starts: a year of results takes gigabytes.
MIN_FREE_GB = 2


def venv_packages(root=PROJECT_DIR, version=sys.version_info):
    """site-packages of backend/.venv when it was made for this Python version (pyarrow is a compiled package: it
    loads only into the same major.minor version), else None."""
    venv = root / 'backend' / '.venv'
    tag = 'python{}.{}'.format(version[0], version[1])
    config = venv / 'pyvenv.cfg'
    if not config.is_file():
        return None
    text = config.read_text(encoding='utf-8', errors='replace')
    line = next((row for row in text.splitlines() if row.split('=')[0].strip() in ('version', 'version_info')), '')
    if not line.split('=', 1)[-1].strip().startswith('{}.{}.'.format(version[0], version[1])):
        return None
    for candidate in (venv / 'Lib' / 'site-packages', venv / 'lib' / tag / 'site-packages'):
        if candidate.is_dir():
            return candidate
    return None


def prepare_imports():
    """Reload this installation in PowerFactory's persistent Python interpreter.

    The results are written as Parquet (pyarrow): the packages of backend/.venv are used when that environment was
    made for the same Python version as PowerFactory's; preflight() says so plainly when they cannot be loaded.
    """
    for folder in ('backend', 'powerfactory', 'scripts'):
        path = str(PROJECT_DIR / folder)
        if path not in sys.path:
            sys.path.insert(0, path)
    packages = venv_packages()
    if packages is not None and str(packages) not in sys.path:
        sys.path.append(str(packages))  # last: PowerFactory's own packages keep precedence
    names = {'app', 'gridlens_runtime', 'gridlens_dashboard', 'appconfig', 'dashboard_launcher'}
    for name in list(sys.modules):
        if name in names or name.startswith('app.'):
            del sys.modules[name]


def preflight(database):
    """Fail early, in plain words, before the case manager opens: the database folder is writable and has room.

    The results database is opened right after this, so a file of an earlier version is refused here as
    well, not after hours of calculation.
    """
    database.parent.mkdir(parents=True, exist_ok=True)
    probe = database.parent / '.write-test'
    try:
        probe.write_text('ok')
        probe.unlink()
    except OSError as exc:
        raise RuntimeError('The database folder is not writable: {} ({})'.format(database.parent, exc)) from None
    free_gb = shutil.disk_usage(database.parent).free / 1e9
    if free_gb < MIN_FREE_GB:
        raise RuntimeError('Not enough free space in the database folder: {:.1f} GB.'.format(free_gb))
    from app.simulation import values
    try:
        values.check_writer()
    except values.ParquetUnavailable as exc:
        raise RuntimeError(
            "PowerFactory's Python cannot write the results as Parquet. Set PowerFactory to the Python version of "
            "backend\\.venv (see backend\\.venv\\pyvenv.cfg) or install pyarrow into PowerFactory's Python. "
            "Details: {}".format(exc)) from None
    return free_gb


def run_assessment(app, database, on_saved=None):
    import gridlens_runtime as engine
    # A missing Qt installation must not silently run saved cases instead of opening the manager.
    if engine.CASE_SOURCE == 'gui':
        engine.load_qt()
    from gridlens_dashboard import run_assessment as calculate
    return calculate(app, database, on_saved)


def progress(store, logger, *args, **kwargs):
    """A progress note must not replace a calculation, restoration or launch error."""
    try:
        store.set_progress(*args, **kwargs)
    except Exception as exc:
        logger.write('DASHBOARD', 'Progress could not be updated: ' + str(exc), level='WARNING')


class Dashboard:
    """The local dashboard of this run: started before the case manager, shown once the first scenario is stored.

    The server starts while the engineer edits the cases and PowerFactory calculates, so it is ready the
    moment results exist; the browser opens after the first planning case is stored and follows the
    others by itself. A run that ends without showing it stops the server it started.
    """

    def __init__(self, database, config, logger):
        self.logger = logger
        self.handle = None
        self.url = None
        if not SHOW_DASHBOARD:
            return
        from dashboard_launcher import start_dashboard
        try:
            self.handle = start_dashboard(database, host=config['host'], port=config['port'], python=DASHBOARD_PYTHON,
                                          reuse=True, production=config['production'])
        except Exception as exc:
            self.logger.write('DASHBOARD', 'Dashboard could not start; results are still saved: ' + str(exc), level='WARNING')

    def show(self):
        if self.handle is None or self.url:
            return self.url
        from dashboard_launcher import wait_for_dashboard
        try:
            shown = wait_for_dashboard(self.handle, open_browser=OPEN_BROWSER)
        except Exception as exc:
            self.handle = None
            self.logger.write('DASHBOARD', 'Results are saved; dashboard could not start: ' + str(exc), level='WARNING')
            return None
        self.url = shown['url']
        self.logger.write('DASHBOARD', 'Open ' + self.url)
        for url in shown['lan_urls']:
            self.logger.write('DASHBOARD', 'From other PCs in the network: ' + url)
        for note in shown['notes']:
            self.logger.write('DASHBOARD', note)
        return self.url

    def discard(self):
        if not self.url:
            from dashboard_launcher import stop_started_dashboard
            stop_started_dashboard(self.handle)


def main():
    prepare_imports()
    import powerfactory
    import appconfig
    import gridlens_runtime as engine
    from app.simulation.store import ScenarioStore
    from dashboard_launcher import validate_installation

    app = powerfactory.GetApplication()
    if app is None:
        raise RuntimeError('Run this script in an active PowerFactory 2026 study case.')
    logger = engine.RunLogger(app)
    directory = Path(DATABASE_DIRECTORY).expanduser()
    if not directory.is_absolute():
        directory = PROJECT_DIR / directory
    if not DATABASE_NAME or Path(DATABASE_NAME).name != DATABASE_NAME:
        raise ValueError('DATABASE_NAME must be a file name.')
    config = appconfig.load(PROJECT_DIR, database=directory / DATABASE_NAME, host=DASHBOARD_HOST, port=DASHBOARD_PORT)
    database = config['database']
    if SHOW_DASHBOARD:
        validate_installation(PROJECT_DIR, DASHBOARD_PYTHON)
    preflight(Path(database))
    store = ScenarioStore(str(database))
    # No dashboard process receives PowerFactory objects or performs PF API calls.
    dashboard = Dashboard(database, config, logger)

    def saved(done, total, detail, scenarios):
        progress(store, logger, 'running', 'Reading native results', detail, done, total)
        if scenarios:
            dashboard.show()

    try:
        progress(store, logger, 'running', 'GridLens case manager and calculation', restart=True)
        outcome = run_assessment(app, database, saved)
        progress(store, logger, 'finished', 'GridLens native results ready',
                 '{} case(s); assessment {}'.format(outcome['cases'], outcome['assessment_id']))
    except engine.OutageAssessmentCancelled:
        progress(store, logger, 'stopped', 'Cancelled in the GridLens case manager')
        logger.write('CANCELLED', 'Nothing calculated; dashboard was not opened.')
        dashboard.discard()
        return None
    except BaseException as exc:
        progress(store, logger, 'failed', 'GridLens stopped', str(exc)[:1000])
        engine.log_failure(logger, exc)
        dashboard.discard()
        raise
    finally:
        store.close()
    # A run without any stored planning case (REF only) shows its results now.
    url = dashboard.show()
    if url:
        outcome['url'] = url
    return outcome


if __name__ == '__main__':
    main()
