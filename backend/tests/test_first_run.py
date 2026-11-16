"""Fresh-clone startup must work before importing Qt/backend packages into PowerFactory."""

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'powerfactory'))
import first_run as boot


@pytest.fixture
def installation(tmp_path, monkeypatch):
    root = tmp_path / 'project with spaces'
    (root / 'frontend/dist/assets').mkdir(parents=True)
    (root / 'frontend/dist/index.html').write_text('<script src="/assets/app.js"></script>')
    (root / 'frontend/dist/assets/app.js').write_text('')
    python = boot.backend_python(root)
    python.parent.mkdir(parents=True)
    python.write_text('')
    (root / 'scripts').mkdir()
    (root / 'scripts/first_run.ps1').touch()
    (root / 'setup.ps1').touch()
    monkeypatch.setattr(boot, 'WINDOWS', True)
    monkeypatch.setattr(boot, 'host_python', lambda: None)
    app = SimpleNamespace(messages=[])
    app.PrintPlain = app.messages.append
    return root, python, app


def healthy(*args, **kwargs):
    return SimpleNamespace(returncode=0, stdout='{}.{}'.format(*sys.version_info[:2]))


def test_ready_installation_does_not_run_setup(installation, monkeypatch):
    root, _, app = installation
    calls = []
    monkeypatch.setenv('PYTHONHOME', 'embedded-host')
    monkeypatch.setenv('PYTHONPATH', 'embedded-packages')

    def run(command, **kwargs):
        calls.append(command)
        assert 'PYTHONHOME' not in kwargs['env'] and 'PYTHONPATH' not in kwargs['env']
        assert kwargs['env']['PYTHONNOUSERSITE'] == '1'
        assert command[1] == '-c'  # Only the readiness probe, no installer.
        return healthy()

    monkeypatch.setattr(boot.subprocess, 'run', run)
    assert boot.ensure_installation(app, root) is False
    assert len(calls) == 1 and not app.messages


def test_fresh_clone_installs_then_rechecks_and_continues(installation, monkeypatch):
    root, python, app = installation
    python.unlink()
    (root / 'frontend/dist/index.html').unlink()
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        if command[0] == 'powershell.exe':
            assert not python.exists()
            python.touch()
            (root / 'frontend/dist/index.html').write_text('<script src="/assets/app.js"></script>')
            return SimpleNamespace(returncode=0)
        return healthy()

    monkeypatch.setattr(boot.subprocess, 'run', run)
    assert boot.ensure_installation(app, root) is True
    setup = commands[0]
    assert setup[setup.index('-File') + 1] == str(root / 'scripts/first_run.ps1')
    assert setup[setup.index('-PythonVersion') + 1] == '{}.{}'.format(*sys.version_info[:2])
    assert '-RebuildFrontend' in setup
    assert len(app.messages) == 2 and 'automatisch' in app.messages[0]
    assert boot.ensure_installation(app, root) is False  # Repeated execution is a fast path.


def test_partial_frontend_is_rebuilt_and_host_python_path_is_one_argument(installation, monkeypatch):
    root, _, app = installation
    (root / 'frontend/dist/assets/app.js').unlink()
    host = r'C:\Program Files\Python312\python.exe'
    monkeypatch.setattr(boot, 'host_python', lambda: host)

    def run(command, **kwargs):
        if command[0] == 'powershell.exe':
            assert command[command.index('-Python') + 1] == host
            assert '-RebuildFrontend' in command
            (root / 'frontend/dist/assets/app.js').touch()
        return healthy()

    monkeypatch.setattr(boot.subprocess, 'run', run)
    assert boot.ensure_installation(app, root)


@pytest.mark.parametrize('result', [SimpleNamespace(returncode=1, stdout=''),
                                   SimpleNamespace(returncode=0, stdout='3.1')])
def test_missing_packages_or_wrong_python_trigger_repair(installation, monkeypatch, result):
    root, _, _ = installation
    monkeypatch.setattr(boot.subprocess, 'run', lambda *a, **k: result)
    assert boot.installation_issues(root) == ['Backend-Pakete fehlen oder Python passt nicht zu PowerFactory']


def test_failed_setup_does_not_continue_to_calculation(installation, monkeypatch):
    root, python, app = installation
    python.unlink()
    monkeypatch.setattr(boot.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=1))
    with pytest.raises(RuntimeError, match='fehlgeschlagen.*setup.log'):
        boot.ensure_installation(app, root)
    assert len(app.messages) == 1


def test_setup_success_without_usable_outputs_is_not_accepted(installation, monkeypatch):
    root, python, app = installation
    python.unlink()
    monkeypatch.setattr(boot.subprocess, 'run', healthy)
    with pytest.raises(RuntimeError, match='noch nicht startbereit'):
        boot.ensure_installation(app, root)


def test_starter_bootstraps_before_preflight_or_case_manager(monkeypatch):
    spec = importlib.util.spec_from_file_location('first_run_starter', ROOT / 'powerfactory/start_assessment.py')
    starter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(starter)
    monkeypatch.setattr(starter, 'prepare_imports', lambda: None)
    monkeypatch.setitem(sys.modules, 'powerfactory', SimpleNamespace(GetApplication=lambda: object()))

    def fail(app):
        raise RuntimeError('setup still missing')

    monkeypatch.setattr(starter, 'ensure_installation', fail)
    monkeypatch.setattr(starter, 'preflight', lambda *a: pytest.fail('preflight called before setup'))
    monkeypatch.setattr(starter, 'run_assessment', lambda *a: pytest.fail('calculation called before setup'))
    with pytest.raises(RuntimeError, match='setup still missing'):
        starter.main()


def test_powershell_scripts_parse_and_progress_is_machine_readable(tmp_path):
    shell = shutil.which('pwsh') or shutil.which('powershell.exe')
    if not shell:
        pytest.skip('PowerShell is not installed')
    progress = tmp_path / 'progress.json'
    # Invoke only the extracted progress function; do not run installers or create the native Windows UI.
    code = '''param($Root, $ProgressFile)
$ErrorActionPreference = 'Stop'
foreach ($file in @('setup.ps1','scripts/first_run.ps1')) {
  $errors = $null; $tokens = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root $file), [ref]$tokens, [ref]$errors)
  if ($errors) { throw ($errors | Out-String) }
  if ($file -eq 'setup.ps1') {
    $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-SetupProgress'}, $true)
    Invoke-Expression $function.Extent.Text
  }
}
Write-SetupProgress 'Backend wird installiert' 16
Write-SetupProgress 'Fertig' 100 'complete'
'''
    script = tmp_path / 'check.ps1'
    script.write_text(code)
    subprocess.run([shell, '-NoProfile', '-File', str(script), '-Root', str(ROOT), '-ProgressFile', str(progress)], check=True)
    assert json.loads(progress.read_text(encoding='utf-8-sig')) == {'message': 'Fertig', 'percent': 100, 'status': 'complete'}


@pytest.mark.parametrize('old_version', [None, '3.1'])
@pytest.mark.parametrize('install_failure', [False, True])
def test_setup_process_emits_completion_and_preserves_wrong_environment(tmp_path, old_version, install_failure):
    shell = shutil.which('pwsh')
    if not shell or sys.platform == 'win32':
        pytest.skip('POSIX fake interpreter harness needs pwsh')
    root = tmp_path / 'fresh clone'
    root.mkdir()
    shutil.copy(ROOT / 'setup.ps1', root / 'setup.ps1')
    (root / 'frontend/dist').mkdir(parents=True)
    (root / 'frontend/dist/index.html').write_text('prebuilt release')
    (root / 'backend').mkdir()
    fake = root / 'python-fixture'
    fake.write_text('#!' + sys.executable + '\nINSTALL_FAILURE = ' + repr(install_failure) + '\n' + '''import pathlib, shutil, sys
if sys.argv[1:2] == ['-c']:
    exec(sys.argv[2])
elif sys.argv[1:3] == ['-m', 'venv']:
    target = pathlib.Path(sys.argv[3]) / 'bin' / 'python'
    target.parent.mkdir(parents=True)
    shutil.copy(__file__, target)
    target.chmod(0o755)
elif sys.argv[1:3] == ['-m', 'pip']:
    if INSTALL_FAILURE and 'install' in sys.argv:
        raise SystemExit(1)
    print('Fixture installer: no downloads performed')
elif sys.argv[1:2] == ['--version']:
    print(sys.version)
else:
    raise SystemExit(1)
''')
    fake.chmod(0o755)
    if old_version:
        old = root / 'backend/.venv/bin/python'
        old.parent.mkdir(parents=True)
        old.write_text('#!' + sys.executable + '\nprint(' + repr(old_version) + ')\n')
        old.chmod(0o755)
    harness = tmp_path / 'run-setup.ps1'
    harness.write_text('''param($Root, $Python, $PythonVersion, $ProgressFile)
function Invoke-RestMethod { return @{ status = 'ready' } }
& (Join-Path $Root 'setup.ps1') -Python $Python -PythonVersion $PythonVersion -ProgressFile $ProgressFile
exit $LASTEXITCODE
''')
    progress = root / 'progress.json'
    result = subprocess.run([shell, '-NoProfile', '-File', str(harness), '-Root', str(root),
                             '-Python', str(fake), '-PythonVersion', '{}.{}'.format(*sys.version_info[:2]),
                             '-ProgressFile', str(progress)], capture_output=True, text=True, timeout=30)
    if install_failure:
        assert result.returncode != 0
        assert json.loads(progress.read_text(encoding='utf-8-sig'))['status'] == 'failed'
        return
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(progress.read_text(encoding='utf-8-sig'))['status'] == 'complete'
    assert (root / 'backend/.venv/bin/python').is_file()
    assert bool(list((root / 'backend').glob('.venv.backup-*'))) == bool(old_version)
