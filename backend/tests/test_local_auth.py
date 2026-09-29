from app.auth.local import hash_password, verify_password
from app.auth.auth import authenticate_user


def test_local_auth_valid_and_invalid_credentials(monkeypatch):
    import app.config as config

    hashed = hash_password("test-only-long-password")
    assert verify_password("test-only-long-password", hashed)
    assert not verify_password("wrong", hashed)
    assert not verify_password("wrong", "broken")
    monkeypatch.setattr(config, "AUTH_BACKEND", "local")
    monkeypatch.setattr(config, "LOCAL_USERNAME", "reader")
    monkeypatch.setattr(config, "LOCAL_PASSWORD_HASH", hashed)
    assert authenticate_user("reader", "test-only-long-password") == "reader"
    assert authenticate_user("other", "test-only-long-password") is None
    assert authenticate_user("reader", "wrong") is None
