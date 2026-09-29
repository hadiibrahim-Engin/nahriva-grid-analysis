from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm

from app.auth.auth import authenticate_user, create_access_token, get_current_user
from app.auth.rate_limit import login_rate_limit, _client_ip
from app.config import is_admin_user
from app.core.audit import audit
from app.models.models import User
from app.models.schemas import UserResponse, Token

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


@router.post("/login", response_model=Token, dependencies=[Depends(login_rate_limit)])
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends()):
    username = authenticate_user(form_data.username, form_data.password)
    if not username:
        audit("login.failed", username=form_data.username, ip=_client_ip(request))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Falscher Benutzername oder Passwort",
        )
    audit("login.success", username=username, ip=_client_ip(request))
    role = "admin" if is_admin_user(username) else "viewer"
    token = create_access_token(data={"sub": username, "role": role})
    return {"access_token": token, "token_type": "bearer"}


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user
