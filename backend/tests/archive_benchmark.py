"""Reproducible synthetic archive round-trip benchmark; run with backend/.venv/bin/python.

python backend/tests/archive_benchmark.py --out /tmp/gridlens-archive-bench
The output directory must be new. Times include verification; file cache is warm.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.archive.parquet import export_analysis, import_analysis, TABLES
from tests.large_dataset import build


def digest(db, table):
    # Canonical primary-key/column order; fetchmany avoids loading raw results into Python memory.
    columns = len(db.execute(f'PRAGMA table_info("{table}")').fetchall())
    cursor = db.execute(f'SELECT * FROM "{table}" ORDER BY ' + ','.join(str(i + 1) for i in range(columns)))
    result = hashlib.sha256()
    while rows := cursor.fetchmany(16_384):
        for row in rows:
            result.update(repr(row).encode())
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    measurements = []
    for label, branches, spacing, window in [('small', 12, 48, 24), ('large', 1000, 240, 72)]:
        source = args.out / f'{label}.sqlite3'
        started = time.perf_counter()
        result = build(source, branches=branches, cases=2, contingencies=4, window=window, spacing=spacing)
        processing = time.perf_counter() - started
        started = time.perf_counter()
        archive = export_analysis(source, result['assessment_id'], args.out / label)
        exporting = time.perf_counter() - started
        started = time.perf_counter()
        restored = args.out / f'{label}-restored.sqlite3'
        import_analysis(archive, restored)
        restoring = time.perf_counter() - started
        with sqlite3.connect(source) as a, sqlite3.connect(restored) as b:
            for table in {table for _, table, _ in TABLES} | {'analysis_values'}:
                assert digest(a, table) == digest(b, table), table
            values = a.execute('SELECT COUNT(*) FROM analysis_values').fetchone()[0]
        measurements.append(dict(dataset=label, branches=branches, values=values, processing_s=processing,
                                 export_s=exporting, restore_s=restoring, sqlite_bytes=source.stat().st_size,
                                 archive_bytes=sum(p.stat().st_size for p in archive.rglob('*') if p.is_file()),
                                 all_table_digests_equal=True))
    (args.out / 'measurements.json').write_text(json.dumps(measurements, indent=2))
    print(json.dumps(measurements, indent=2))


if __name__ == '__main__':
    main()
