import asyncio
import base64

import pytest
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.auth import _password_verification_slots
from app.database import SessionLocal
from app.main import SecurityMiddleware, response_security_headers, settings


async def ok_app(scope, receive, send):
    await PlainTextResponse("ok")(scope, receive, send)


def test_global_concurrency_limit_fails_fast_and_exempts_health(monkeypatch):
    monkeypatch.setattr(settings, "max_concurrent_requests", 1)
    monkeypatch.setattr(settings, "request_queue_timeout_seconds", 0.01)
    middleware = SecurityMiddleware(ok_app)

    asyncio.run(middleware.request_slots.acquire())
    client = TestClient(middleware)
    try:
        busy = client.get("/api/avatars/example.png")
        assert busy.status_code == 503
        assert busy.json()["error"]["code"] == "SERVER_BUSY"
        assert busy.headers["cache-control"] == "no-store"
        assert busy.headers["retry-after"] == "1"
        assert client.get("/api/health").status_code == 200
    finally:
        client.close()
        middleware.request_slots.release()


def test_login_password_verification_gate_returns_busy(client):
    assert _password_verification_slots.acquire(blocking=False)
    assert _password_verification_slots.acquire(blocking=False)
    try:
        response = client.post("/api/auth/login", json={"loginIdentifier": "2026001", "password": "Student123!"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "LOGIN_BUSY"
    finally:
        _password_verification_slots.release()
        _password_verification_slots.release()


def test_avatar_binary_is_externalized_and_requires_login(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "avatar_dir", tmp_path / "avatars")
    with SessionLocal.begin() as db:
        db.execute(text("UPDATE roommate_cards SET status='DRAFT' WHERE user_id=2"))
    login_response = client.post("/api/auth/login", json={"loginIdentifier": "2026001", "password": "Student123!"})
    assert login_response.status_code == 200
    client.headers["x-csrf-token"] = client.cookies.get("csrf_token")
    image = b"\x89PNG\r\n\x1a\n" + b"avatar-content"
    encoded = base64.b64encode(image).decode()

    response = client.put("/api/me/roommate-card", json={"avatar_url": f"data:image/png;base64,{encoded}"})
    assert response.status_code == 200
    avatar_url = response.json()["card"]["avatar_url"]
    assert avatar_url.startswith("/api/avatars/")
    assert list((tmp_path / "avatars").iterdir())[0].read_bytes() == image
    with SessionLocal() as db:
        assert db.execute(text("SELECT avatar_url FROM roommate_cards WHERE user_id=2")).scalar_one() == avatar_url

    avatar = client.get(avatar_url)
    assert avatar.status_code == 200
    assert avatar.content == image
    assert avatar.headers["cache-control"] == "private, max-age=31536000, immutable"
    with TestClient(client.app) as anonymous:
        denied = anonymous.get(avatar_url)
        assert denied.status_code == 401
        assert denied.headers["cache-control"] == "no-store"
    missing = client.get(f"/api/avatars/{'0' * 64}.png")
    assert missing.status_code == 404
    assert missing.headers["cache-control"] == "no-store"

    with TestClient(client.app) as super_admin:
        login_response = super_admin.post("/api/auth/login", json={"loginIdentifier": "admin", "password": "Admin123!"})
        assert login_response.status_code == 200
        assert super_admin.get(avatar_url).status_code == 200


@pytest.mark.parametrize("status", [301, 401, 403, 404, 500, 503])
def test_avatar_error_responses_are_not_cached(status):
    headers = dict(response_security_headers("avatar", "request-id", status))
    assert headers[b"cache-control"] == b"no-store"
