FROM ghcr.io/astral-sh/uv:0.10.9 AS uv
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/app/.venv/bin:$PATH \
    ENVIRONMENT=production \
    HOST=0.0.0.0 \
    PORT=4173

WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY public ./public

RUN groupadd --gid 1000 app && \
    useradd --uid 1000 --gid 1000 --create-home app && \
    mkdir -p /app/data /app/backups && \
    chown -R app:app /app

USER app
EXPOSE 4173
VOLUME ["/app/data", "/app/backups"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4173", "--workers", "1", "--no-server-header", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1,172.16.0.0/12"]
