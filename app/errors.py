from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def api_error_handler(_request: Request, error: ApiError) -> JSONResponse:
    return JSONResponse(status_code=error.status, content={"error": {"code": error.code, "message": error.message}})


def validation_error_handler(_request: Request, _error: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": {"code": "INVALID_REQUEST", "message": "请求参数无效"}},
    )
