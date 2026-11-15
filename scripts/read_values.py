"""Export all stored QDS samples (SQLite AND Parquet) as CSV or JSON Lines, without a second value store."""

import argparse
import csv
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.simulation.values import iter_samples  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('--run')
    parser.add_argument('--scenario')
    parser.add_argument('--start', type=int, help='inclusive UTC epoch seconds')
    parser.add_argument('--end', type=int, help='exclusive UTC epoch seconds')
    parser.add_argument('--format', choices=['csv', 'jsonl'], default='csv')
    args = parser.parse_args()
    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        writer = None
        for row in iter_samples(db, run_id=args.run, scenario_id=args.scenario, start=args.start, end=args.end):
            if args.format == 'jsonl':
                print(json.dumps(row, ensure_ascii=False, allow_nan=False))
            else:
                if writer is None:
                    writer = csv.DictWriter(sys.stdout, fieldnames=list(row))
                    writer.writeheader()
                writer.writerow(row)


if __name__ == '__main__':
    main()
