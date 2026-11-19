"""Explicit hourly Redispatch deliveries. Never inferred from power-flow differences.

Each import is an immutable, complete delivery revision; the latest revision is displayed. Missing rows mean
unknown, including missing hours, never zero. MWh and EUR/MWh are supplied with their signs; Decimal multiplication
and summation preserve them. This contract accepts already integrated UTC hours only, so no energy is invented.
"""

import csv
import io
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext

from app.simulation.imports import serialized

PLANT_CLASSES = ("ElmSym", "ElmGenstat", "ElmPvsys")
FIELDS = ("scenario_id", "element_id", "start_utc", "end_utc", "energy_mwh", "price_eur_per_mwh")
TABLES = """
CREATE TABLE IF NOT EXISTS rd_imports (
    id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES gl_assessments(id),
    source TEXT NOT NULL, quantity_kind TEXT NOT NULL CHECK(quantity_kind IN ('requested','planned','delivered')),
    created_at TEXT NOT NULL, contract_version INTEGER NOT NULL CHECK(contract_version=1), rows INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rd_imports_analysis ON rd_imports(analysis_id,created_at);
CREATE TABLE IF NOT EXISTS rd_hours (
    import_id TEXT NOT NULL REFERENCES rd_imports(id), scenario_id TEXT NOT NULL REFERENCES pf_scenarios(id),
    element_id TEXT NOT NULL, start_t INTEGER NOT NULL, end_t INTEGER NOT NULL,
    energy_mwh TEXT NOT NULL, price_eur_per_mwh TEXT NOT NULL, cost_eur TEXT NOT NULL,
    CHECK(end_t=start_t+3600 AND start_t%3600=0), PRIMARY KEY(import_id,scenario_id,element_id,start_t)
);
"""


def _time(text):
    try:
        value = datetime.fromisoformat(text.replace('Z', '+00:00'))
        if value.tzinfo is None or value.utcoffset().total_seconds() != 0 or value.microsecond:
            raise ValueError()
        return int(value.timestamp())
    except (ValueError, AttributeError, OverflowError):
        raise ValueError('Times must have an explicit UTC offset, e.g. 2025-04-12T05:00:00Z.') from None


def _decimal(text):
    try:
        value = Decimal(text)
        if not value.is_finite() or value.copy_abs() > Decimal('1e12') or value.as_tuple().exponent < -9:
            raise ValueError()
        return value
    except (InvalidOperation, ValueError):
        raise ValueError('Energy and price must be finite decimal numbers (decimal point, at most 9 decimal places).') from None


def product(energy, price):
    with localcontext() as context:
        context.prec = 64  # two bounded 21-digit inputs plus their scale; no default-context rounding
        return energy * price


def import_csv(store, analysis, source, quantity_kind, content):
    from app.simulation import across
    analysis = across.resolve_analysis(store.db, analysis)
    if analysis == across.UNASSIGNED or not store.db.execute('SELECT 1 FROM gl_assessments WHERE id=?', (analysis,)).fetchone():
        raise ValueError('Select a named calculation for Redispatch.')
    if quantity_kind not in ('requested', 'planned', 'delivered'):
        raise ValueError('Choose requested, planned or delivered quantities.')
    scenarios = {r['id'] for r in across._scenario_rows(store.db, analysis)}
    plants = {r[0] for r in store.db.execute(
        "SELECT element_id FROM gl_elements WHERE assessment_id=? AND class_name IN ('ElmSym','ElmGenstat','ElmPvsys')", (analysis,))}
    reader = csv.DictReader(io.StringIO(content.lstrip('\ufeff')))
    if reader.fieldnames != list(FIELDS):
        raise ValueError('CSV columns must be: ' + ','.join(FIELDS))
    prepared, seen = [], set()
    for number, row in enumerate(reader, 2):
        try:
            if None in row or any(v is None for v in row.values()):
                raise ValueError('Unexpected number of columns.')
            if row['scenario_id'] not in scenarios or row['element_id'] not in plants:
                raise ValueError('Unknown scenario or generator ID in this calculation. Use the mapping CSV.')
            start, end = _time(row['start_utc']), _time(row['end_utc'])
            if start % 3600 or end != start + 3600:
                raise ValueError('Each row must cover exactly one complete UTC hour [start, end).')
            key = (row['scenario_id'], row['element_id'], start)
            if key in seen:
                raise ValueError('Duplicate scenario/generator/hour. Supply one aggregated hourly row.')
            seen.add(key)
            energy, price = _decimal(row['energy_mwh']), _decimal(row['price_eur_per_mwh'])
            prepared.append((*key[:2], start, end, str(energy), str(price), str(product(energy, price))))
            if len(prepared) > 50_000:
                raise ValueError('At most 50,000 hourly rows per delivery.')
        except ValueError as exc:
            raise ValueError(f'CSV row {number}: {exc}') from None
    if not prepared:
        raise ValueError('The CSV has no hourly rows.')
    identifier = uuid.uuid4().hex
    with serialized(store.path), store.db:
        store.db.execute('INSERT INTO rd_imports VALUES(?,?,?,?,?,?,?)', (
            identifier, analysis, source, quantity_kind, datetime.now(timezone.utc).isoformat(), 1, len(prepared)))
        store.db.executemany('INSERT INTO rd_hours VALUES(?,?,?,?,?,?,?,?)', [(identifier, *r) for r in prepared])
    return {'id': identifier, 'analysis_id': analysis, 'rows': len(prepared)}


def latest(db, analysis):
    row = db.execute('SELECT * FROM rd_imports WHERE analysis_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (analysis,)).fetchone()
    return dict(row) if row else None


def amounts(rows):
    rows = list(rows)
    with localcontext() as context:
        context.prec = 64
        return {'energy_mwh': float(sum((Decimal(r['energy_mwh']) for r in rows), Decimal(0))),
                'cost_eur': float(sum((Decimal(r['cost_eur']) for r in rows), Decimal(0))), 'hours': len(rows)} if rows else None


def for_hour(db, delivery, t):
    if delivery is None:
        return {}
    hour = t - t % 3600
    return {(r['scenario_id'], r['element_id']): dict(r) for r in db.execute(
        'SELECT * FROM rd_hours WHERE import_id=? AND start_t=?', (delivery['id'], hour))}
