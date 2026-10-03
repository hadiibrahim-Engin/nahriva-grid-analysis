"""Build one ZIP for the PowerFactory PC: backend, ready-made frontend, scripts, setup script, docs.

    python scripts/package_release.py                  -> release/outage-assessment-<version>.zip
    python scripts/package_release.py --wheelhouse     -> additionally release/wheelhouse (Windows packages for offline PCs)

`setup.ps1 -Package` builds the frontend and then this ZIP in one go. The PowerFactory PC then needs only
Python 3.12+ (or internet access, so that setup.ps1 can fetch it) and, unless a wheelhouse is used, internet
access during the setup.
"""

import argparse
from pathlib import Path
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
INCLUDE = [
    "backend/app",
    "backend/pyproject.toml",
    "backend/.env.example",
    "frontend/dist",
    "powerfactory",
    "scripts/appconfig.py",
    "scripts/dashboard_launcher.py",
    "scripts/serve.py",
    "deploy",
    "setup.ps1",
    "setup.cmd",
    "docs",
    "README.md",
    "BIG_PICTURE.md",
    "outage-assessment.config.example.json",
]
SKIP_PARTS = {"__pycache__", ".pytest_cache", ".DS_Store"}
SKIP_SUFFIXES = {".pyc", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm", ".log"}
SKIP_FILES = {"assessment.config.json", "outage-assessment.config.json"}  # local settings and secrets never ship


def version(root=ROOT):
    text = (root / "backend/pyproject.toml").read_text(encoding="utf-8")
    return re.search(r'^version\s*=\s*"([^"]+)"', text, re.M).group(1)


def files(root=ROOT):
    for entry in INCLUDE:
        path = root / entry
        if not path.exists():
            continue
        for item in ([path] if path.is_file() else sorted(path.rglob("*"))):
            relative = item.relative_to(root)
            if not item.is_file() or SKIP_PARTS & set(relative.parts) or item.suffix in SKIP_SUFFIXES or item.name in SKIP_FILES:
                continue
            if "egg-info" in str(relative):
                continue
            yield item, relative


def build(root=ROOT, out_dir=None):
    if not (root / "frontend/dist/index.html").is_file():
        raise SystemExit("frontend/dist is missing. Build it first: cd frontend && npm ci && npm run build")
    out_dir = Path(out_dir or root / "release")
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"outage-assessment-{version(root)}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for item, relative in files(root):
            archive.write(item, Path("outage-assessment") / relative)
    return target


def wheelhouse(root=ROOT, out_dir=None):
    target = Path(out_dir or root / "release") / "wheelhouse"
    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "download", "--dest", str(target), "--platform", "win_amd64",
         "--python-version", "3.12", "--only-binary=:all:", str(root / "backend")],
        check=True,
    )
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wheelhouse", action="store_true", help="include packages for PCs without internet access")
    args = parser.parse_args()
    print("Package:", build())
    if args.wheelhouse:
        print("Wheelhouse:", wheelhouse())
