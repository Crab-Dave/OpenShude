import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from threading import BoundedSemaphore, Lock
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import text, update
from sqlalchemy.orm import Session

from .common import authenticate, clean_text, management_profile, now, one, verify_csrf
from .config import get_settings
from .database import get_db
from .errors import ApiError
from .models import User
from .security import (
    ACCESS_COOKIE,
    CSRF_COOKIE,
    REFRESH_COOKIE,
    hash_password,
    new_auth_token,
    new_csrf_token,
    token_hash,
    verify_password,
)

router = APIRouter(prefix="/api")
DB = Annotated[Session, Depends(get_db)]
LOGIN_WINDOW_SECONDS = 300
LOGIN_LIMITS = {"ip": 30, "identifier": 10, "pair": 10}
REFRESH_REUSE_GRACE_SECONDS = 10
_login_failures: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_login_failures_lock = Lock()
_dummy_password = hash_password(new_auth_token())
_password_verification_slots = BoundedSemaphore(get_settings().login_password_concurrency)


def login_rate_keys(ip_address: str, identifier: str) -> tuple[tuple[str, str], ...]:
    return (("ip", ip_address), ("identifier", identifier), ("pair", f"{ip_address}\0{identifier}"))


def check_login_rate_limit(ip_address: str, identifier: str, current: float) -> None:
    with _login_failures_lock:
        for key in login_rate_keys(ip_address, identifier):
            failures = _login_failures[key]
            while failures and failures[0] < current - LOGIN_WINDOW_SECONDS:
                failures.popleft()
            if len(failures) >= LOGIN_LIMITS[key[0]]:
                raise ApiError(429, "LOGIN_RATE_LIMITED", "登录尝试过于频繁，请稍后再试")


def record_login_failure(ip_address: str, identifier: str, current: float) -> None:
    with _login_failures_lock:
        for key in login_rate_keys(ip_address, identifier):
            _login_failures[key].append(current)
        while len(_login_failures) > 10_000:
            _login_failures.pop(next(iter(_login_failures)))


def clear_login_success(ip_address: str, identifier: str) -> None:
    with _login_failures_lock:
        _login_failures.pop(("identifier", identifier), None)
        _login_failures.pop(("pair", f"{ip_address}\0{identifier}"), None)


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


def iso_after(delta: timedelta) -> str:
    return (datetime.now(UTC) + delta).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def clear_auth_cookies(response: Response) -> None:
    secure = get_settings().auth_cookie_secure
    response.delete_cookie(ACCESS_COOKIE, path="/api", httponly=True, samesite="lax", secure=secure)
    response.delete_cookie(REFRESH_COOKIE, path="/api/auth", httponly=True, samesite="strict", secure=secure)
    response.delete_cookie(CSRF_COOKIE, path="/", httponly=False, samesite="lax", secure=secure)


def set_auth_cookies(
    response: Response,
    access_token: str,
    refresh_token: str,
    csrf_token: str | None,
    refresh_expires_at: str,
) -> None:
    settings = get_settings()
    response.set_cookie(
        ACCESS_COOKIE,
        access_token,
        max_age=settings.access_token_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.auth_cookie_secure,
        path="/api",
    )
    refresh_seconds = max(0, int((parse_timestamp(refresh_expires_at) - datetime.now(UTC)).total_seconds()))
    response.set_cookie(
        REFRESH_COOKIE,
        refresh_token,
        max_age=refresh_seconds,
        httponly=True,
        samesite="strict",
        secure=settings.auth_cookie_secure,
        path="/api/auth",
    )
    if csrf_token is not None:
        response.set_cookie(
            CSRF_COOKIE,
            csrf_token,
            max_age=refresh_seconds,
            httponly=False,
            samesite="lax",
            secure=settings.auth_cookie_secure,
            path="/",
        )


def cleanup_expired_sessions(db: Session, timestamp: str) -> None:
    db.execute(text("DELETE FROM sessions WHERE refresh_expires_at<=:now"), {"now": timestamp})


def create_session(db: Session, user_id: int, timestamp: str) -> tuple[str, str, str, str]:
    settings = get_settings()
    access_token = new_auth_token()
    refresh_token = new_auth_token()
    csrf_token = new_csrf_token()
    access_expires_at = iso_after(timedelta(minutes=settings.access_token_minutes))
    refresh_expires_at = iso_after(timedelta(days=settings.refresh_token_days))
    result = db.execute(
        text("""INSERT INTO sessions(
          user_id,access_token_hash,access_expires_at,csrf_token_hash,refresh_expires_at,created_at,refreshed_at
        ) VALUES(:user,:access,:access_expires,:csrf,:refresh_expires,:created,:refreshed)"""),
        {
            "user": user_id,
            "access": token_hash(access_token),
            "access_expires": access_expires_at,
            "csrf": token_hash(csrf_token),
            "refresh_expires": refresh_expires_at,
            "created": timestamp,
            "refreshed": timestamp,
        },
    )
    db.execute(
        text("""INSERT INTO refresh_tokens(token_hash,session_id,expires_at,created_at)
        VALUES(:hash,:session,:expires,:created)"""),
        {
            "hash": token_hash(refresh_token),
            "session": result.lastrowid,
            "expires": refresh_expires_at,
            "created": timestamp,
        },
    )
    return access_token, refresh_token, csrf_token, refresh_expires_at


def auth_error(status: int, code: str, message: str) -> JSONResponse:
    response = JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})
    clear_auth_cookies(response)
    return response


@router.post("/auth/login")
def login(request: Request, response: Response, body: dict, db: DB) -> dict:
    identifier = clean_text(body.get("loginIdentifier"), 100, True)
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    ip_address = request.client.host if request.client else "unknown"
    current = time.monotonic()
    check_login_rate_limit(ip_address, identifier, current)
    user = one(db, "SELECT * FROM users WHERE login_identifier=:identifier", {"identifier": identifier})
    password_record = user or {"password_salt": _dummy_password.salt, "password_hash": _dummy_password.hash}
    if not _password_verification_slots.acquire(blocking=False):
        raise ApiError(503, "LOGIN_BUSY", "登录请求较多，请稍后重试")
    try:
        password_valid = verify_password(password, password_record["password_salt"], password_record["password_hash"])
    finally:
        _password_verification_slots.release()
    if not user or not password_valid:
        record_login_failure(ip_address, identifier, time.monotonic())
        raise ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误")
    clear_login_success(ip_address, identifier)
    if user["status"] not in ("ACTIVE", "PENDING_ACTIVATION"):
        raise ApiError(403, "ACCOUNT_UNAVAILABLE", "账号当前不可用，请联系管理员")
    timestamp = now()
    cleanup_expired_sessions(db, timestamp)
    access_token, refresh_token, csrf_token, refresh_expires_at = create_session(db, user["id"], timestamp)
    db.execute(
        text("UPDATE users SET status='ACTIVE',last_login_at=:now,updated_at=:now WHERE id=:id"),
        {"now": timestamp, "id": user["id"]},
    )
    db.commit()
    user["status"] = "ACTIVE"
    set_auth_cookies(response, access_token, refresh_token, csrf_token, refresh_expires_at)
    return {"user": user_payload(db, user)}


@router.post("/auth/refresh", response_model=None)
def refresh(request: Request, response: Response, db: DB) -> dict | Response:
    refresh_token = request.cookies.get(REFRESH_COOKIE)
    if not refresh_token:
        return auth_error(401, "INVALID_REFRESH_TOKEN", "请重新登录")
    refresh_hash = token_hash(refresh_token)
    db.connection().exec_driver_sql("BEGIN IMMEDIATE")
    session = one(
        db,
        """SELECT rt.consumed_at,rt.expires_at AS token_expires_at,s.id AS session_id,
          s.csrf_token_hash,s.refresh_expires_at,u.status
        FROM refresh_tokens rt JOIN sessions s ON s.id=rt.session_id JOIN users u ON u.id=s.user_id
        WHERE rt.token_hash=:hash""",
        {"hash": refresh_hash},
    )
    if not session:
        db.rollback()
        return auth_error(401, "INVALID_REFRESH_TOKEN", "请重新登录")
    verify_csrf(request, session["csrf_token_hash"])
    timestamp = now()
    if session["status"] not in ("ACTIVE", "PENDING_ACTIVATION"):
        db.execute(text("DELETE FROM sessions WHERE id=:id"), {"id": session["session_id"]})
        db.commit()
        return auth_error(403, "ACCOUNT_UNAVAILABLE", "账号当前不可用")
    if session["refresh_expires_at"] <= timestamp or session["token_expires_at"] <= timestamp:
        db.execute(text("DELETE FROM sessions WHERE id=:id"), {"id": session["session_id"]})
        db.commit()
        return auth_error(401, "REFRESH_TOKEN_EXPIRED", "登录已过期，请重新登录")
    if session["consumed_at"]:
        age = (datetime.now(UTC) - parse_timestamp(session["consumed_at"])).total_seconds()
        if age <= REFRESH_REUSE_GRACE_SECONDS:
            db.rollback()
            raise ApiError(409, "REFRESH_ALREADY_ROTATED", "登录状态已由另一个请求刷新")
        db.execute(text("DELETE FROM sessions WHERE id=:id"), {"id": session["session_id"]})
        db.commit()
        return auth_error(401, "REFRESH_TOKEN_REUSED", "检测到重复使用的登录凭据，请重新登录")
    access_token = new_auth_token()
    replacement_refresh_token = new_auth_token()
    replacement_hash = token_hash(replacement_refresh_token)
    access_expires_at = iso_after(timedelta(minutes=get_settings().access_token_minutes))
    db.execute(
        text("UPDATE refresh_tokens SET consumed_at=:now,replaced_by_hash=:replacement WHERE token_hash=:hash"),
        {"now": timestamp, "replacement": replacement_hash, "hash": refresh_hash},
    )
    db.execute(
        text("""INSERT INTO refresh_tokens(token_hash,session_id,expires_at,created_at)
        VALUES(:hash,:session,:expires,:created)"""),
        {
            "hash": replacement_hash,
            "session": session["session_id"],
            "expires": session["refresh_expires_at"],
            "created": timestamp,
        },
    )
    db.execute(
        text("""UPDATE sessions SET access_token_hash=:access,access_expires_at=:expires,refreshed_at=:now
        WHERE id=:id"""),
        {
            "access": token_hash(access_token),
            "expires": access_expires_at,
            "now": timestamp,
            "id": session["session_id"],
        },
    )
    db.commit()
    set_auth_cookies(response, access_token, replacement_refresh_token, None, session["refresh_expires_at"])
    return {"ok": True}


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: DB) -> dict:
    refresh_token = request.cookies.get(REFRESH_COOKIE)
    access_token = request.cookies.get(ACCESS_COOKIE)
    session = None
    if refresh_token:
        session = one(
            db,
            """SELECT s.id,s.csrf_token_hash FROM refresh_tokens rt JOIN sessions s ON s.id=rt.session_id
            WHERE rt.token_hash=:hash""",
            {"hash": token_hash(refresh_token)},
        )
    if not session and access_token:
        session = one(
            db,
            "SELECT id,csrf_token_hash FROM sessions WHERE access_token_hash=:hash",
            {"hash": token_hash(access_token)},
        )
    if session:
        verify_csrf(request, session["csrf_token_hash"])
        db.execute(text("DELETE FROM sessions WHERE id=:id"), {"id": session["id"]})
        db.commit()
    clear_auth_cookies(response)
    return {"ok": True}


@router.get("/me")
def me(request: Request, db: DB) -> dict:
    user = authenticate(request, db, False)
    return {"user": user_payload(db, user, True)}


@router.patch("/me/password")
def change_password(request: Request, response: Response, body: dict, db: DB) -> dict:
    user = authenticate(request, db, True)
    current = clean_text(body.get("currentPassword"), 200, True)
    new = clean_text(body.get("newPassword"), 200, True)
    if len(new) < 8:
        raise ApiError(400, "WEAK_PASSWORD", "新密码至少需要 8 位")
    account = one(db, "SELECT * FROM users WHERE id=:id", {"id": user["id"]})
    if not verify_password(current, account["password_salt"], account["password_hash"]):
        raise ApiError(400, "INVALID_CURRENT_PASSWORD", "当前密码不正确")
    password = hash_password(new)
    timestamp = now()
    db.execute(
        update(User)
        .where(User.id == user["id"])
        .values(
            {
                User.password_hash: password.hash,
                User.password_salt: password.salt,
                User.must_change_password: 0,
                User.updated_at: timestamp,
            }
        )
    )
    db.execute(text("DELETE FROM sessions WHERE user_id=:user_id"), {"user_id": user["id"]})
    access_token, refresh_token, csrf_token, refresh_expires_at = create_session(db, user["id"], timestamp)
    db.commit()
    set_auth_cookies(response, access_token, refresh_token, csrf_token, refresh_expires_at)
    return {"ok": True}
