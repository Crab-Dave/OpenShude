import time
from collections import defaultdict, deque
from threading import Lock

from .errors import ApiError

_rate_windows: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_rate_windows_lock = Lock()


def enforce_rate_limit(category: str, subject: str, limit: int, window_seconds: int, error_code: str) -> None:
    current = time.monotonic()
    key = (category, subject)
    with _rate_windows_lock:
        attempts = _rate_windows[key]
        while attempts and attempts[0] <= current - window_seconds:
            attempts.popleft()
        if len(attempts) >= limit:
            raise ApiError(429, error_code, "操作过于频繁，请稍后再试")
        attempts.append(current)
        while len(_rate_windows) > 10_000:
            _rate_windows.pop(next(iter(_rate_windows)))
