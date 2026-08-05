import asyncio

from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient

from app.auth import _password_verification_slots
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
