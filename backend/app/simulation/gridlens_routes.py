"""Read-only raw-result API for GridLens widgets."""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from app.core.cache import TTLCache

from app.simulation import gridlens_store as raw
from app.simulation.routes import store

router = APIRouter(prefix='/api/simulation/gridlens', tags=['GridLens native results'])


def required_result(db, identifier):
    result = raw.result(db, identifier)
    if result is None:
        raise HTTPException(404, 'GridLens result not found.')
    return result


@router.get('/assessments')
def assessments(db=Depends(store)):
    return {'assessments': raw.assessments(db.db)}


@router.get('/assessments/{identifier}')
def assessment(identifier: str, db=Depends(store)):
    result = raw.assessment(db.db, identifier)
    if result is None:
        raise HTTPException(404, 'GridLens assessment not found.')
    return result


@router.get('/assessments/{identifier}/elements')
def elements(identifier: str, offset: int = Query(0, ge=0), limit: int = Query(1000, ge=1, le=5000), db=Depends(store)):
    """Master data of the monitored elements of one analysis, in pages (internal key, name, class, grid, kV, mRID)."""
    if raw.assessment(db.db, identifier) is None:
        raise HTTPException(404, 'GridLens assessment not found.')
    rows = db.db.execute('SELECT element_id, name, class_name, path, grid, nominal_kv, mrid FROM gl_elements '
                         'WHERE assessment_id=? ORDER BY name, element_id LIMIT ? OFFSET ?', (identifier, limit, offset))
    total = db.db.execute('SELECT COUNT(*) FROM gl_elements WHERE assessment_id=?', (identifier,)).fetchone()[0]
    return {'elements': [dict(row) for row in rows], 'total': total, 'offset': offset, 'limit': limit}


@router.get('/results/{identifier}')
def result(identifier: str, db=Depends(store)):
    return required_result(db.db, identifier)


@router.get('/results/{identifier}/columns')
def columns(identifier: str, offset: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=1000), db=Depends(store)):
    required_result(db.db, identifier)
    rows = db.db.execute('SELECT * FROM gl_columns WHERE result_id=? ORDER BY column_id LIMIT ? OFFSET ?',
                         (identifier, limit, offset))
    return {'columns': [dict(row) for row in rows], 'offset': offset, 'limit': limit}


@router.get('/results/{identifier}/contingencies')
def contingencies(identifier: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=1000), db=Depends(store)):
    required_result(db.db, identifier)
    return {'contingencies': raw.contingencies(db.db, identifier, offset, limit), 'offset': offset, 'limit': limit}


@router.get('/results/{identifier}/times')
def times(identifier: str, offset: int = Query(0, ge=0), limit: int = Query(1000, ge=1, le=5000), db=Depends(store)):
    required_result(db.db, identifier)
    return {'timestamps': raw.times(db.db, identifier, offset, limit), 'unit': 'epoch_seconds_utc', 'offset': offset, 'limit': limit}


@router.get('/results/{identifier}/series')
def series(identifier: str, column_id: int = Query(..., ge=0), contingency_id: str = '',
           start: int | None = None, end: int | None = None,
           offset: int = Query(0, ge=0), limit: int = Query(1000, ge=1, le=5000), db=Depends(store)):
    native = required_result(db.db, identifier)
    if start is not None and end is not None and start >= end:
        raise HTTPException(422, 'end must be after start (end exclusive).')
    column = db.db.execute('SELECT * FROM gl_columns WHERE result_id=? AND column_id=?', (identifier, column_id)).fetchone()
    if column is None:
        raise HTTPException(404, 'Result column not found.')
    if native['kind'] != 'QDS':
        if not db.db.execute('SELECT 1 FROM gl_contingencies WHERE result_id=? AND id=?', (identifier, contingency_id)).fetchone():
            raise HTTPException(404, 'Contingency not found in this result.')
    elif contingency_id:
        raise HTTPException(422, 'A QDS series has no additional contingency.')
    return {'result_id': identifier, 'column': dict(column), 'contingency_id': contingency_id or None,
            'metadata': native['metadata'], 'offset': offset, 'limit': limit,
            'points': raw.series(db.db, identifier, column_id, contingency_id, start, end, limit, offset)}


# Results never change once imported; the Gantt chart of a large sweep is built once per result.
_GANTT_CACHE = TTLCache(max_entries=64, ttl_seconds=3600)


@router.get('/results/{identifier}/n1-gantt')
def n1_gantt(identifier: str, limit: int = Query(50, ge=1, le=500), db=Depends(store)):
    """Overload episodes of an n-1 sweep per branch: loading before and after the contingency that triggers it."""
    native = required_result(db.db, identifier)
    if native['kind'] == 'QDS':
        raise HTTPException(422, 'A QDS result has no contingencies.')
    return JSONResponse(_GANTT_CACHE.get_or_compute((db.path, identifier, limit), lambda: raw.n1_gantt(db.db, identifier, limit)))
