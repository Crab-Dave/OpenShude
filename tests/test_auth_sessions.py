import hashlib

from fastapi.testclient import TestClient
from sqlalchemy import text

import app.auth as auth_module
from app.database import SessionLocal
from tests.conftest import login


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def expire_access(user_id: int = 2) -> None:
    with SessionLocal.begin() as db:
        db.execute(
            text("UPDATE sessions SET access_expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=:user"),
            {"user": user_id},
        )


def test_login_issues_hashed_cookie_only_tokens(client):
    response = client.post("/api/auth/login", json={"loginIdentifier": "2026001", "password": "Student123!"})

    assert response.status_code == 200
    assert set(response.json()) == {"user"}
    access_token = client.cookies.get("access_token")
    refresh_token = client.cookies.get("refresh_token")
    csrf_token = client.cookies.get("csrf_token")
    assert access_token and refresh_token and csrf_token
    assert access_token not in response.text
    assert refresh_token not in response.text
    with SessionLocal() as db:
        session = (
            db.execute(text("SELECT id,access_token_hash,csrf_token_hash FROM sessions WHERE user_id=2"))
            .mappings()
            .one()
        )
        stored_refresh = db.execute(
            text("SELECT token_hash FROM refresh_tokens WHERE session_id=:session"), {"session": session["id"]}
        ).scalar_one()
    assert session["access_token_hash"] == sha256(access_token)
    assert session["csrf_token_hash"] == sha256(csrf_token)
    assert stored_refresh == sha256(refresh_token)
    cookies = response.headers.get_list("set-cookie")
    access_header = next(item for item in cookies if item.startswith("access_token="))
    refresh_header = next(item for item in cookies if item.startswith("refresh_token="))
    csrf_header = next(item for item in cookies if item.startswith("csrf_token="))
    assert "HttpOnly" in access_header and "Path=/api" in access_header and "SameSite=lax" in access_header
    assert "HttpOnly" in refresh_header and "Path=/api/auth" in refresh_header and "SameSite=strict" in refresh_header
    assert "HttpOnly" not in csrf_header and "Path=/" in csrf_header and "SameSite=lax" in csrf_header


def test_expired_access_rotates_access_and_refresh_tokens(client):
    login(client, "2026001")
    old_access = client.cookies.get("access_token")
    old_refresh = client.cookies.get("refresh_token")
    csrf_token = client.cookies.get("csrf_token")
    expire_access()

    expired = client.get("/api/me")
    refreshed = client.post("/api/auth/refresh")

    assert expired.status_code == 401
    assert expired.json()["error"]["code"] == "ACCESS_TOKEN_EXPIRED"
    assert refreshed.status_code == 200
    assert client.cookies.get("access_token") != old_access
    assert client.cookies.get("refresh_token") != old_refresh
    assert client.cookies.get("csrf_token") == csrf_token
    assert client.get("/api/me").status_code == 200
    with SessionLocal() as db:
        tokens = (
            db.execute(
                text(
                    "SELECT token_hash,consumed_at,replaced_by_hash FROM refresh_tokens ORDER BY created_at,token_hash"
                )
            )
            .mappings()
            .all()
        )
    old = next(item for item in tokens if item["token_hash"] == sha256(old_refresh))
    assert old["consumed_at"] is not None
    assert old["replaced_by_hash"] == sha256(client.cookies.get("refresh_token"))
    assert sum(item["consumed_at"] is None for item in tokens) == 1


def test_refresh_reuse_grace_then_revokes_the_device_session(client, monkeypatch):
    login(client, "2026001")
    old_refresh = client.cookies.get("refresh_token")
    csrf_token = client.cookies.get("csrf_token")
    expire_access()
    assert client.post("/api/auth/refresh").status_code == 200

    with TestClient(client.app) as concurrent:
        concurrent.cookies.set("refresh_token", old_refresh, path="/api/auth")
        concurrent.cookies.set("csrf_token", csrf_token)
        concurrent.headers["x-csrf-token"] = csrf_token
        grace = concurrent.post("/api/auth/refresh")
    assert grace.status_code == 409
    assert grace.json()["error"]["code"] == "REFRESH_ALREADY_ROTATED"
    assert client.get("/api/me").status_code == 200

    monkeypatch.setattr(auth_module, "REFRESH_REUSE_GRACE_SECONDS", -1)
    with TestClient(client.app) as attacker:
        attacker.cookies.set("refresh_token", old_refresh, path="/api/auth")
        attacker.cookies.set("csrf_token", csrf_token)
        attacker.headers["x-csrf-token"] = csrf_token
        reused = attacker.post("/api/auth/refresh")
    assert reused.status_code == 401
    assert reused.json()["error"]["code"] == "REFRESH_TOKEN_REUSED"
    assert client.get("/api/me").status_code == 401
    with SessionLocal() as db:
        assert db.execute(text("SELECT COUNT(*) FROM sessions")).scalar_one() == 0
        assert db.execute(text("SELECT COUNT(*) FROM refresh_tokens")).scalar_one() == 0


def test_refresh_requires_csrf_and_absolute_expiry_forces_login(client):
    login(client, "2026001")
    expire_access()
    csrf_token = client.headers.pop("x-csrf-token")
    missing_csrf = client.post("/api/auth/refresh")
    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["error"]["code"] == "INVALID_CSRF_TOKEN"
    client.headers["x-csrf-token"] = csrf_token
    assert (
        client.post("/api/auth/refresh", headers={"Origin": "http://evil.example"}).json()["error"]["code"]
        == "INVALID_ORIGIN"
    )
    with SessionLocal.begin() as db:
        db.execute(text("UPDATE sessions SET refresh_expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=2"))
        db.execute(text("UPDATE refresh_tokens SET expires_at='2000-01-01T00:00:00.000Z'"))
    expired = client.post("/api/auth/refresh")
    assert expired.status_code == 401
    assert expired.json()["error"]["code"] == "REFRESH_TOKEN_EXPIRED"
    assert client.cookies.get("access_token") is None
    assert client.cookies.get("refresh_token") is None
    assert client.cookies.get("csrf_token") is None


def test_logout_uses_refresh_token_after_access_expiry(client):
    login(client, "2026001")
    expire_access()

    response = client.post("/api/auth/logout")

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert client.cookies.get("access_token") is None
    assert client.cookies.get("refresh_token") is None
    with SessionLocal() as db:
        assert db.execute(text("SELECT COUNT(*) FROM sessions")).scalar_one() == 0
        assert db.execute(text("SELECT COUNT(*) FROM refresh_tokens")).scalar_one() == 0
