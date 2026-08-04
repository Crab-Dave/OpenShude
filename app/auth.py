import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import text, update
from sqlalchemy.orm import Session

from .common import authenticate, clean_text, management_profile, now, one
from .config import get_settings
from .database import get_db
from .errors import ApiError
from .models import User
from .security import hash_password, new_csrf_token, new_session_token, token_hash, verify_password

router = APIRouter(prefix="/api")
DB = Annotated[Session, Depends(get_db)]
_login_failures: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_login_failures_lock = Lock()


def user_payload(db: Session, user: dict, include_identifier: bool = False) -> dict:
    payload = {
        "id": user["id"],
        "accountType": user["account_type"],
        "name": user["name"],
        "grade": user["grade"],
        "gradeId": user["grade_id"],
        "gender": user["gender"],
        "major": user["major"],
        "status": user["status"],
        "mustChangePassword": bool(user["must_change_password"]),
        **management_profile(db, user),
    }
    if include_identifier:
        payload["loginIdentifier"] = user["login_identifier"]
    return payload


@router.post("/auth/login")
def login(request: Request, response: Response, body: dict, db: DB) -> dict:
    identifier = clean_text(body.get("loginIdentifier"), 100, True)
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    key = (request.client.host if request.client else "unknown", identifier)
    current = time.monotonic()
    with _login_failures_lock:
        failures = _login_failures[key]
        while failures and failures[0] < current - 300:
            failures.popleft()
        if len(failures) >= 10:
            raise ApiError(429, "LOGIN_RATE_LIMITED", "登录尝试过于频繁，请稍后再试")
    user = one(db, "SELECT * FROM users WHERE login_identifier=:identifier", {"identifier": identifier})
    if not user or not verify_password(password, user["password_salt"], user["password_hash"]):
        with _login_failures_lock:
            _login_failures[key].append(time.monotonic())
            if len(_login_failures) > 10_000:
                _login_failures.pop(next(iter(_login_failures)))
        raise ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误")
    with _login_failures_lock:
        _login_failures.pop(key, None)
    if user["status"] not in ("ACTIVE", "PENDING_ACTIVATION"):
        raise ApiError(403, "ACCOUNT_UNAVAILABLE", "账号当前不可用，请联系管理员")
    token = new_session_token()
    csrf = new_csrf_token()
    timestamp = now()
    expires = (
        (datetime.now(UTC) + timedelta(days=get_settings().session_days))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    db.execute(
        text(
            "INSERT INTO sessions(token_hash,csrf_token,user_id,expires_at,created_at) VALUES(:hash,:csrf,:user,:expires,:created)"
        ),
        {"hash": token_hash(token), "csrf": csrf, "user": user["id"], "expires": expires, "created": timestamp},
    )
    db.execute(
        text("UPDATE users SET status='ACTIVE',last_login_at=:now,updated_at=:now WHERE id=:id"),
        {"now": timestamp, "id": user["id"]},
    )
    db.commit()
    user["status"] = "ACTIVE"
    response.set_cookie(
        "session",
        token,
        max_age=get_settings().session_days * 86400,
        httponly=True,
        samesite="lax",
        secure=get_settings().session_cookie_secure,
        path="/",
    )
    return {"user": user_payload(db, user), "csrfToken": csrf}


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: DB) -> dict:
    user = authenticate(request, db, True)
    db.execute(text("DELETE FROM sessions WHERE token_hash=:hash"), {"hash": token_hash(request.cookies["session"])})
    db.commit()
    response.delete_cookie(
        "session", path="/", httponly=True, samesite="lax", secure=get_settings().session_cookie_secure
    )
    return {"ok": True, "userId": user["id"]}


@router.get("/me")
def me(request: Request, db: DB) -> dict:
    user = authenticate(request, db, False)
    return {"user": user_payload(db, user, True), "csrfToken": user["csrf_token"]}


@router.patch("/me/password")
def change_password(request: Request, body: dict, db: DB) -> dict:
    user = authenticate(request, db, True)
    current = clean_text(body.get("currentPassword"), 200, True)
    new = clean_text(body.get("newPassword"), 200, True)
    if len(new) < 8:
        raise ApiError(400, "WEAK_PASSWORD", "新密码至少需要 8 位")
    account = one(db, "SELECT * FROM users WHERE id=:id", {"id": user["id"]})
    if not verify_password(current, account["password_salt"], account["password_hash"]):
        raise ApiError(400, "INVALID_CURRENT_PASSWORD", "当前密码不正确")
    password = hash_password(new)
    db.execute(
        update(User)
        .where(User.id == user["id"])
        .values(
            {
                User.password_hash: password.hash,
                User.password_salt: password.salt,
                User.must_change_password: 0,
                User.updated_at: now(),
            }
        )
    )
    db.execute(
        text("DELETE FROM sessions WHERE user_id=:user_id AND token_hash<>:current_token_hash"),
        {"user_id": user["id"], "current_token_hash": token_hash(request.cookies["session"])},
    )
    db.commit()
    return {"ok": True}
