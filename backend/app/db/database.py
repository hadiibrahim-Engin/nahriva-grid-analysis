from functools import lru_cache

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from app.config import get_database_url
from app.core.constants import (
    DB_CALL_TIMEOUT_MS,
    DB_MAX_OVERFLOW,
    DB_POOL_RECYCLE_SECONDS,
    DB_POOL_SIZE,
)


def _set_oracle_nls(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'")
    cursor.execute("ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'")
    cursor.execute("ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'")
    cursor.execute("ALTER SESSION SET NLS_TERRITORY = 'AMERICA'")
    cursor.close()
    # Bound any single statement so a hung query can't pin a connection.
    # `call_timeout` is exposed by python-oracledb on the raw DBAPI conn.
    try:
        dbapi_conn.call_timeout = DB_CALL_TIMEOUT_MS
    except AttributeError:
        # Driver doesn't expose it (older oracledb, or non-Oracle backend in tests).
        pass


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    """Create the SQLAlchemy engine only when a DB endpoint needs it."""

    engine = create_engine(
        get_database_url(),
        pool_size=DB_POOL_SIZE,
        max_overflow=DB_MAX_OVERFLOW,
        pool_pre_ping=True,
        pool_recycle=DB_POOL_RECYCLE_SECONDS,
        thick_mode=None,  # thin mode, no Oracle Client needed
    )
    event.listen(engine, "connect", _set_oracle_nls)
    return engine


@lru_cache(maxsize=1)
def get_session_factory() -> sessionmaker[Session]:
    return sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=get_engine(),
    )


def SessionLocal() -> Session:
    """Compatibility helper for scripts that want a standalone session."""

    return get_session_factory()()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()