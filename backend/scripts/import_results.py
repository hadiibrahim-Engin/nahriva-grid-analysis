"""Validated, atomic JSON import into the independent analysis database."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.analysis.models import RunBundle
from app.analysis.repository import AnalysisRepository


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--database", required=True, type=Path)
    args = parser.parse_args()
    if args.file.stat().st_size > 100_000_000:
        parser.error("Import file exceeds 100 MB")
    bundle = RunBundle.model_validate_json(args.file.read_bytes())
    repo = AnalysisRepository(str(args.database))
    try:
        repo.import_bundle(bundle)
    finally:
        repo.close()
    print(
        json.dumps(
            {
                "run_id": bundle.run.id,
                "samples": len(bundle.samples),
                "status": "imported",
            }
        )
    )


if __name__ == "__main__":
    main()
