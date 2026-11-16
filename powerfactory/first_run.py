"""Standard-library first-run bootstrap; usable before any project packages are installed."""

import os
import re
import subprocess
import sys
from pathlib import Path


WINDOWS = os.name == 'nt'

PROBE = """import sys
import fastapi, uvicorn, pydantic, pyarrow, duckdb
try:
    from PyQt6 import QtCore, QtGui, QtWidgets
except ImportError:
    from PyQt5 import QtCore, QtGui, QtWidgets
print('%d.%d' % sys.version_info[:2])
"""


def setup_environment():
    # An embedded host can export its Python paths; they must not override the new virtual environment.
    env = {key: value for key, value in os.environ.items() if key.upper() not in ('PYTHONHOME', 'PYTHONPATH')}
    env['PYTHONNOUSERSITE'] = '1'
    return env


def backend_python(root):
    return root / 'backend' / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def installation_issues(root, python=None, version=None):
    """Check usable packages and the assets referenced by the production build, not just directory names."""
    root = Path(root)
    version = version or sys.version_info[:2]
    interpreter = Path(python) if python else backend_python(root)
    issues = []
    if not interpreter.is_file():
        issues.append('Backend-Umgebung fehlt')
    else:
        try:
            result = subprocess.run([str(interpreter), '-c', PROBE], capture_output=True, text=True,
                                    timeout=45, env=setup_environment(), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode or result.stdout.strip() != '{}.{}'.format(*version):
                issues.append('Backend-Pakete fehlen oder Python passt nicht zu PowerFactory')
        except (OSError, subprocess.TimeoutExpired):
            issues.append('Backend-Umgebung ist nicht startbereit')
    index = root / 'frontend/dist/index.html'
    if not index.is_file():
        issues.append('Frontend-Build fehlt')
    else:
        html = index.read_text(encoding='utf-8')
        assets = re.findall(r'''(?:src|href)=["']/?(assets/[^"']+)["']''', html)
        if not assets or any(not (index.parent / asset).is_file() for asset in assets):
            issues.append('Frontend-Build ist unvollständig')
        else:
            inputs = list((root / 'frontend/src').rglob('*'))
            inputs += [root / 'frontend' / name for name in ('package.json', 'package-lock.json', 'index.html', 'vite.config.ts')]
            inputs += list((root / 'frontend').glob('tsconfig*.json'))
            if any(path.is_file() and path.stat().st_mtime_ns > index.stat().st_mtime_ns for path in inputs):
                issues.append('Frontend-Build ist veraltet')
    return issues


def host_python():
    """PowerFactory's sys.executable may be PowerFactory.exe; only suggest a real Python executable."""
    candidates = [Path(sys.base_prefix) / 'python.exe', Path(sys.prefix) / 'python.exe',
                  Path(getattr(sys, '_base_executable', '') or sys.executable)]
    return next((str(path) for path in candidates if path.name.lower() == 'python.exe' and path.is_file()), None)


def ensure_installation(app, root, python=None):
    root = Path(root).resolve()
    issues = installation_issues(root, python)
    if not issues:
        return False
    message = ('Erster Start: ' + '; '.join(issues) + '. Die Einrichtung startet automatisch. '
               'Downloads benötigen Internetzugang; dieser Vorgang kann einige Minuten dauern.')
    app.PrintPlain('[Outage Assessment] ' + message)
    if not WINDOWS:
        raise RuntimeError(message + ' Die automatische PowerFactory-Einrichtung ist für Windows vorgesehen. '
                           'Auf diesem System setup.ps1 bzw. start-dashboard.command ausführen.')
    if sys.version_info[:2] < (3, 12):
        raise RuntimeError('Das Dashboard benötigt Python 3.12 oder neuer. Bitte zuerst diese Python-Version '
                           'in PowerFactory auswählen und das Skript erneut starten.')
    if python and Path(python).resolve() != backend_python(root).resolve():
        raise RuntimeError('Die automatische Einrichtung verwendet backend\\.venv. '
                           'DASHBOARD_PYTHON auf None setzen oder die eigene Umgebung vollständig einrichten.')
    script = root / 'scripts/first_run.ps1'
    if not script.is_file() or not (root / 'setup.ps1').is_file():
        raise RuntimeError('Einrichtungsdateien fehlen. Bitte das vollständige Projekt klonen bzw. kopieren.')
    command = ['powershell.exe', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', str(script),
               '-PythonVersion', '{}.{}'.format(*sys.version_info[:2])]
    if any('Frontend' in issue for issue in issues):
        command.append('-RebuildFrontend')
    interpreter = host_python()
    if interpreter:
        command.extend(['-Python', interpreter])
    try:
        result = subprocess.run(command, cwd=str(root), env=setup_environment(), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except OSError as exc:
        raise RuntimeError('Automatische Einrichtung konnte nicht starten: {}. Details: .tools\\setup.log'.format(exc)) from None
    if result.returncode:
        raise RuntimeError('Automatische Einrichtung fehlgeschlagen. Das Fenster und .tools\\setup.log zeigen '
                           'die Ursache. Nach der Korrektur start_assessment.py erneut ausführen.')
    remaining = installation_issues(root, python)
    if remaining:
        raise RuntimeError('Einrichtung beendet, aber noch nicht startbereit: ' + '; '.join(remaining)
                           + '. Details: .tools\\setup.log')
    app.PrintPlain('[Outage Assessment] Einrichtung abgeschlossen. Der Case Manager wird geöffnet.')
    return True
