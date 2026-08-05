import asyncio
import json
import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
from starlette.datastructures import URL
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .admin import router as admin_router
from .auth import router as auth_router
from .config import get_settings
from .database import SessionLocal
from .dormitories import router as dormitories_router
from .errors import ApiError, api_error_handler, validation_error_handler
from .student import router as student_router

settings = get_settings()
logger = logging.getLogger("openshude")
CSP = (
    b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    b"connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)


def response_security_headers(api_request: bool | str, request_id: str) -> list[tuple[bytes, bytes]]:
    cache_control = b"no-cache"
    if api_request:
        cache_control = b"no-store"
    if api_request == "avatar":
        cache_control = b"private, max-age=31536000, immutable"
    return [
        (b"x-content-type-options", b"nosniff"),
        (b"referrer-policy", b"no-referrer"),
        (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
        (b"content-security-policy", CSP),
        (b"cache-control", cache_control),
        (b"x-request-id", request_id.encode("ascii")),
    ]


def valid_request_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True
    try:
        parsed = URL(origin)
    except ValueError:
        return False
    same_origin = parsed.scheme in ("http", "https") and parsed.netloc == request.headers.get("host", "")
    return same_origin or origin in settings.allowed_origins


def ensure_request_id(scope: Scope) -> str:
    request_id = dict(scope.get("headers", [])).get(b"x-request-id", b"").decode("ascii", "ignore")[:100]
    if not request_id:
        request_id = str(uuid.uuid4())
        scope["headers"] = [*scope.get("headers", []), (b"x-request-id", request_id.encode("ascii"))]
    return request_id


def request_rejection(request: Request) -> JSONResponse | None:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > settings.max_body_bytes:
                return JSONResponse(
                    status_code=413, content={"error": {"code": "BODY_TOO_LARGE", "message": "请求内容过大"}}
                )
        except ValueError:
            return JSONResponse(
                status_code=400, content={"error": {"code": "INVALID_CONTENT_LENGTH", "message": "请求长度无效"}}
            )
    if request.method not in ("GET", "HEAD", "OPTIONS") and not valid_request_origin(request):
        return JSONResponse(status_code=403, content={"error": {"code": "INVALID_ORIGIN", "message": "请求来源无效"}})
    return None


class SecurityMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.request_slots = asyncio.Semaphore(settings.max_concurrent_requests)

    async def acquire_request_slot(self, path: str) -> bool | None:
        if path == "/api/health":
            return False
        try:
            await asyncio.wait_for(self.request_slots.acquire(), timeout=settings.request_queue_timeout_seconds)
            return True
        except TimeoutError:
            return None

    async def send_busy_response(self, scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse(
            status_code=503,
            headers={"Retry-After": "1"},
            content={"error": {"code": "SERVER_BUSY", "message": "服务器繁忙，请稍后重试"}},
        )(scope, receive, send)

    def finish_request(
        self, request: Request, request_id: str, started: float, response_status: int, acquired: bool
    ) -> None:
        if acquired:
            self.request_slots.release()
        if request.url.path == "/api/health":
            return
        logger.info(
            json.dumps(
                {
                    "requestId": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": response_status,
                    "durationMs": round((time.perf_counter() - started) * 1000, 2),
                    "clientIp": request.client.host if request.client else "",
                },
                ensure_ascii=False,
            )
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = ensure_request_id(scope)
        request = Request(scope)
        started = time.perf_counter()
        response_status = 500

        consumed = 0

        async def limited_receive() -> Message:
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > settings.max_body_bytes:
                    raise ApiError(413, "BODY_TOO_LARGE", "请求内容过大")
            return message

        async def security_send(message: Message) -> None:
            nonlocal response_status
            if message["type"] == "http.response.start":
                response_status = message["status"]
                response_headers = list(message.get("headers", []))
                api_request = (
                    "avatar" if request.url.path.startswith("/api/avatars/") else request.url.path.startswith("/api/")
                )
                response_headers.extend(response_security_headers(api_request, request_id))
                message["headers"] = response_headers
            await send(message)

        rejection = request_rejection(request)
        if rejection:
            await rejection(scope, receive, security_send)
            return

        slot_acquired = await self.acquire_request_slot(request.url.path)
        if slot_acquired is None:
            await self.send_busy_response(scope, receive, security_send)
            return

        try:
            await self.app(scope, limited_receive, security_send)
        except ApiError as error:
            await JSONResponse(
                status_code=error.status, content={"error": {"code": error.code, "message": error.message}}
            )(scope, receive, security_send)
        finally:
            self.finish_request(request, request_id, started, response_status, slot_acquired)


app = FastAPI(
    title="OpenShude API",
    docs_url="/docs" if settings.docs_enabled else None,
    redoc_url="/redoc" if settings.docs_enabled else None,
    openapi_url="/openapi.json" if settings.docs_enabled else None,
)
if settings.environment == "production" and not settings.session_cookie_secure:
    logger.warning("SESSION_COOKIE_SECURE is disabled because production is currently served over HTTP")
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
app.add_middleware(SecurityMiddleware)
app.add_exception_handler(ApiError, api_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(student_router)
app.include_router(dormitories_router)


@app.get("/api/health")
def health() -> dict:
    with SessionLocal() as db:
        db.execute(text("SELECT 1"))
    return {"status": "ok", **({"version": settings.app_version} if settings.app_version else {})}


@app.exception_handler(Exception)
def unexpected_error(request: Request, error: Exception) -> JSONResponse:
    logger.exception("Unhandled request error on %s", request.url.path, exc_info=error)
    return JSONResponse(status_code=500, content={"error": {"code": "INTERNAL_ERROR", "message": "服务器内部错误"}})


@app.get("/{path:path}", include_in_schema=False)
def static_file(path: str) -> FileResponse:
    if path.startswith("api/"):
        raise ApiError(404, "NOT_FOUND", "接口不存在")
    public = settings.public_dir.resolve()
    requested = (public / path).resolve()
    if path and requested.is_file() and requested.is_relative_to(public):
        return FileResponse(requested)
    generated = public / "generated"
    generated_page = (generated / path / "index.html").resolve() if path else generated / "index.html"
    if generated_page.is_file() and generated_page.is_relative_to(generated):
        return FileResponse(generated_page)
    if path in ("login", "roommates"):
        application = public / "app.html"
        if application.is_file():
            return FileResponse(application)
    raise ApiError(404, "NOT_FOUND", "页面不存在")
