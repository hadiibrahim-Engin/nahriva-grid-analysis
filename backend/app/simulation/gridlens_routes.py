"""Read-only raw-result API for GridLens widgets."""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse


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
def assessment(identifier: str, summary: bool = False, db=Depends(store)):
    result = raw.assessment(db.db, identifier, summary=summary)
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



@router.get('/results/{identifier}/extremes')
def extremes(identifier: str, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=1000), db=Depends(store)):
    required_result(db.db, identifier)
    rows = db.db.execute(
        'SELECT c.name,c.variable,c.unit,n.low,n.high,n.lower,n.upper,n.violation_times,n.violations '
        'FROM gl_n1_columns n JOIN gl_columns c USING(result_id,column_id) WHERE n.result_id=? '
        'ORDER BY n.severity DESC,c.name,n.column_id LIMIT ? OFFSET ?', (identifier, limit, offset))
    total = db.db.execute('SELECT COUNT(*) FROM gl_n1_columns WHERE result_id=?', (identifier,)).fetchone()[0]
    return {'rows': [dict(row) for row in rows], 'total': total, 'offset': offset, 'limit': limit}
