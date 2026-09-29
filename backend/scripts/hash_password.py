"""Print a local-account password hash; plaintext is read without terminal echo."""

import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.auth.local import hash_password

if __name__ == "__main__":
    password = getpass.getpass("New password (at least 12 characters): ")
    if password != getpass.getpass("Repeat password: "):
        raise SystemExit("Passwords differ")
    print(hash_password(password))
