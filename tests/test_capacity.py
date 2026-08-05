import asyncio
import base64

from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.auth import _password_verification_slots
from app.database import SessionLocal
from app.main import SecurityMiddleware, settings


async def ok_app(scope, receive, send):
    await PlainTextResponse("ok")(scope, receive, send)


def test_global_concurrency_limit_fails_fast_and_exempts_health(monkeypatch):
    monkeypatch.setattr(settings, "max_concurrent_requests", 1)
    monkeypatch.setattr(settings, "request_queue_timeout_seconds", 0.01)
    middleware = SecurityMiddleware(ok_app)

    asyncio.run(middleware.request_slots.acquire())
    client = TestClient(middleware)
    try:
        busy = client.get("/api/example")
        assert busy.status_code == 503
        assert busy.json()["error"]["code"] == "SERVER_BUSY"
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
    client.headers["x-csrf-token"] = login_response.json()["csrfToken"]
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
        assert anonymous.get(avatar_url).status_code == 401
    assert client.get("/api/avatars/../../app.db").status_code == 404
