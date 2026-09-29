import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.analysis.models import RunBundle

print(json.dumps(RunBundle.model_json_schema(), indent=2, ensure_ascii=False))
