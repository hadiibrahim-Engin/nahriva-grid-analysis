"""Which files belong to one release, and a check that the files on this PC are all of that release.

PowerFactory runs whatever files it finds. After copying single files, or with two copies of the project on a PC, a
new script can meet an old module and fail with errors like "too many values to unpack". `release-manifest.json`
lists a hash of every file the PowerFactory script depends on; `verify` names the files that differ. Nobody maintains
a version number: the manifest is generated from the files.

    python scripts/release_manifest.py --write     update release-manifest.json (after every change of those files)
    python scripts/release_manifest.py --check     exit 1 when it is out of date

Settings that a user edits stay out of the comparison: a line that ends with "# setting" is not part of the hash, and
neither is powerfactory/start_assessment.py (its top is the place for settings). Line endings do not matter (a Windows
checkout may convert them). Standard library only.
"""

import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "release-manifest.json"
FOLDERS = ("powerfactory", "scripts", "backend/app")
SKIP = {"powerfactory/start_assessment.py"}  # carries the settings of the PC, see above
ONLY_IN_SCRIPTS = {"scripts/appconfig.py", "scripts/dashboard_launcher.py", "scripts/release_manifest.py"}  # used by the script
SUFFIXES = {".py", ".sql"}
SETTING = "# setting"


def digest(path):
    """Hash of a file without its settings lines and independent of the line endings."""
    text = Path(path).read_bytes().decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    kept = "\n".join(line for line in text.split("\n") if not line.rstrip().endswith(SETTING))
    return hashlib.sha256(kept.encode("utf-8")).hexdigest()[:16]


def files(root=ROOT):
    """Relative paths (with /) of the files the PowerFactory script depends on."""
    found = []
    for folder in FOLDERS:
        for path in sorted((Path(root) / folder).rglob("*")):
            relative = path.relative_to(root).as_posix()
            if not path.is_file() or path.suffix not in SUFFIXES or "__pycache__" in path.parts or relative in SKIP:
                continue
            if folder == "scripts" and relative not in ONLY_IN_SCRIPTS:
                continue
            found.append(relative)
    return found


def build(root=ROOT):
    entries = {relative: digest(Path(root) / relative) for relative in files(root)}
    release = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()[:10]
    return {"release": release, "files": entries}


def write(root=ROOT):
    manifest = build(root)
    (Path(root) / MANIFEST).write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def verify(root=ROOT):
    """(release id, number of files, problems): one line per file that differs from the manifest; [] when all match.

    A missing manifest is reported as a problem list of its own (release id None), so the caller can decide.
    """
    path = Path(root) / MANIFEST
    try:
        expected = json.loads(path.read_text(encoding="utf-8"))
        wanted = expected["files"]
    except (OSError, ValueError, KeyError):
        return None, 0, [MANIFEST + " is missing or unreadable"]
    problems = []
    for relative, known in sorted(wanted.items()):
        file = Path(root) / relative
        if not file.is_file():
            problems.append("{}: missing".format(relative))
        elif digest(file) != known:
            problems.append("{}: differs ({})".format(relative, file))
    for relative in files(root):  # a module of another release that this release does not have
        if relative not in wanted:
            problems.append("{}: not part of release {} (an older or newer file)".format(relative, expected.get("release", "?")))
    return expected.get("release"), len(wanted), problems


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    if "--write" in arguments:
        manifest = write()
        print("{}: release {}, {} files".format(MANIFEST, manifest["release"], len(manifest["files"])))
        return 0
    if "--check" in arguments:
        current = build()
        try:
            recorded = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            recorded = None
        if recorded != current:
            print(MANIFEST + " is out of date. Run: python scripts/release_manifest.py --write")
            return 1
        print("{} is current (release {})".format(MANIFEST, current["release"]))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
