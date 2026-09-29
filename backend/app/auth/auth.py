from datetime import datetime, timedelta, timezone
from typing import Optional

import oracledb
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt

from app.config import (
    SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES,
    DB_HOST, DB_PORT, DB_NAME, ConfigError, validate_auth_config,
)
from app.models.models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


# -- Oracle DB credential auth --------------------------------------

def verify_oracle_credentials(username: str, password: str) -> bool:
    """Try to connect to Oracle FDWH with the given credentials."""
    try:
        validate_auth_config()
        dsn = oracledb.makedsn(DB_HOST, int(DB_PORT), service_name=DB_NAME)
        conn = oracledb.connect(user=username, password=password, dsn=dsn)
        conn.close()
        return True
    except ConfigError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc
    except oracledb.Error:
        return False


def authenticate_user(username: str, password: str) -> Optional[str]:
    """Authenticate user against Oracle FDWH. Returns username on success."""
    from app.config import AUTH_BACKEND, LOCAL_USERNAME, LOCAL_PASSWORD_HASH
    if AUTH_BACKEND == "local":
        import hmac
        from app.auth.local import verify_password
        valid_password = verify_password(password, LOCAL_PASSWORD_HASH)
        return username if hmac.compare_digest(username.encode(), LOCAL_USERNAME.encode()) and valid_password else None
    if verify_oracle_credentials(username, password):
        return username
    return None


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    """Validate JWT and return lightweight User object (no DB lookup).

    The role is read from the token's ``role`` claim (set at login), so it
    cannot be elevated client-side without the signing secret. Tokens
    issued before roles existed default to ``viewer``.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Ungültige Anmeldedaten",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    role = payload.get("role") or "viewer"
    return User(username=username, role=role)


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Dependency guarding admin-only endpoints (System Analytics)."""
    from app.core.errors import ForbiddenError

    if current_user.role != "admin":
        raise ForbiddenError(
            "Nur für Administratoren.",
            suggested_action="Mit einem Administrator-Konto anmelden.",
        )
    return current_user