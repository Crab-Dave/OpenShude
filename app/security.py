import hashlib
import hmac
import secrets
from dataclasses import dataclass


@dataclass(frozen=True)
class PasswordHash:
    salt: str
    hash: str


def hash_password(password: str, salt: str | None = None) -> PasswordHash:
    current_salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=current_salt.encode("utf-8"),
        n=2**14,
        r=8,
        p=1,
        dklen=64,
    ).hex()
    return PasswordHash(salt=current_salt, hash=digest)


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_password(password, salt).hash, expected_hash)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def new_csrf_token() -> str:
    return secrets.token_urlsafe(24)


def secure_compare(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))
