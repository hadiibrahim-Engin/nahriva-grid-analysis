"""release-manifest.json: nobody maintains a version number, the files are compared with a generated list."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import release_manifest as manifest  # noqa: E402


def tree(root):
    for relative, text in {
        "powerfactory/analysis_worker.py": "VALUE = 1\nGRID = ''  # setting\n",
        "powerfactory/start_assessment.py": "SETTINGS = 1\n",
        "scripts/appconfig.py": "A = 1\n",
        "scripts/serve.py": "not used by the script\n",
        "backend/app/store.py": "B = 1\n",
    }.items():
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        (root / relative).write_text(text, encoding="utf-8", newline="\n")


def test_this_repository_has_a_current_manifest_and_matches_it():
    """Fails when a file the script depends on was changed: run  python scripts/release_manifest.py --write"""
    assert manifest.main(["--check"]) == 0, "release-manifest.json is out of date: python scripts/release_manifest.py --write"
    release, count, problems = manifest.verify(ROOT)
    assert problems == [] and count > 20 and release


def test_only_the_files_the_script_depends_on_are_listed(tmp_path):
    tree(tmp_path)
    assert set(manifest.files(tmp_path)) == {"powerfactory/analysis_worker.py", "scripts/appconfig.py", "backend/app/store.py"}
    # start_assessment.py carries the settings of the PC; serve.py is not used by the script


def test_a_changed_missing_or_extra_file_is_named_and_settings_and_line_endings_are_not_changes(tmp_path):
    tree(tmp_path)
    manifest.write(tmp_path)
    assert manifest.verify(tmp_path)[2] == []
    (tmp_path / "powerfactory/analysis_worker.py").write_bytes(b"VALUE = 1\r\nGRID = 'D7'  # setting\r\n")  # CRLF + a setting
    (tmp_path / "powerfactory/start_assessment.py").write_text("SETTINGS = 2\n")
    assert manifest.verify(tmp_path)[2] == []
    (tmp_path / "powerfactory/analysis_worker.py").write_text("VALUE = 2\nGRID = ''  # setting\n")
    (tmp_path / "backend/app/store.py").unlink()
    (tmp_path / "powerfactory/lodf.py").write_text("NEW = 1\n")
    release, count, problems = manifest.verify(tmp_path)
    assert count == 3
    assert [p.split(":")[0] for p in problems] == ["backend/app/store.py", "powerfactory/analysis_worker.py", "powerfactory/lodf.py"]
    assert "missing" in problems[0] and "differs" in problems[1] and "not part of release" in problems[2]


def test_a_missing_manifest_is_reported_not_raised(tmp_path):
    tree(tmp_path)
    assert manifest.verify(tmp_path) == (None, 0, ["release-manifest.json is missing or unreadable"])


def test_the_release_id_changes_with_the_files(tmp_path):
    tree(tmp_path)
    first = manifest.write(tmp_path)["release"]
    (tmp_path / "backend/app/store.py").write_text("B = 2\n")
    assert manifest.write(tmp_path)["release"] != first
    assert json.loads((tmp_path / "release-manifest.json").read_text())["release"] != first
