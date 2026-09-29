"""Dump the live OpenAPI schema to docs/openapi.json for review/versioning.

Run from the backend directory:

    python -m scripts.dump_openapi

CI can run this and fail if the committed file is stale, which catches
accidental, unreviewed API-contract changes.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.main import app

OUTPUT = Path(__file__).resolve().parent.parent.parent / "docs" / "openapi.json"


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(app.openapi(), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
