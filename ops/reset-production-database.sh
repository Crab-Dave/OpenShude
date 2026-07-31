#!/usr/bin/env bash
set -Eeuo pipefail

confirmation=${1:-}
if [[ "$confirmation" != "RESET-OPENSHUDE-PRODUCTION-DATABASE" ]]; then
  echo "Usage: INITIAL_ADMIN_PASSWORD=... $0 RESET-OPENSHUDE-PRODUCTION-DATABASE" >&2
  exit 2
fi
initial_admin_password=${INITIAL_ADMIN_PASSWORD:-}
if [[ ${#initial_admin_password} -lt 12 ]]; then
  echo "INITIAL_ADMIN_PASSWORD must contain at least 12 characters" >&2
  exit 2
fi
export INITIAL_ADMIN_PASSWORD="$initial_admin_password"

deploy_dir=${DEPLOY_DIR:-/opt/myapp}
public_host=${PUBLIC_HOST:-39.96.36.207}
cd "$deploy_dir"

image_tag=$(<.deployed-image-tag)
if [[ ! "$image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "No valid deployed image tag was found" >&2
  exit 1
fi

compose() {
  IMAGE_TAG="$image_tag" docker compose -f compose.prod.yml "$@"
}

wait_for_healthy() {
  for ((attempt = 1; attempt <= 30; attempt++)); do
    container=$(compose ps -q web)
    if [[ -n "$container" ]]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
      if [[ "$status" == "healthy" ]] && \
         curl --fail --silent --show-error --max-time 5 \
           -H "Host: $public_host" http://127.0.0.1/api/health >/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

compose config --quiet
echo "Deleting the current OpenShude database without creating a backup."
compose stop web
compose run -T --rm --no-deps --user root web \
  sh -c 'rm -f /app/data/app.db /app/data/app.db-wal /app/data/app.db-shm && chown -R 1000:1000 /app/data'

compose run -T --rm --no-deps web alembic upgrade head
compose run -T --rm --no-deps -e INITIAL_ADMIN_PASSWORD web \
  python -m app.maintenance bootstrap-admin
compose run -T --rm --no-deps web alembic check
compose run -T --rm --no-deps web python -m app.maintenance validate

compose run -T --rm --no-deps web python - <<'PY'
import sqlite3

from app.config import get_settings

empty_tables = (
    "admin_group_members",
    "admin_group_permissions",
    "admin_group_scopes",
    "admin_groups",
    "audit_logs",
    "blocks",
    "conversation_reads",
    "conversations",
    "dormitories",
    "dormitory_applications",
    "dormitory_members",
    "dormitory_result_members",
    "dormitory_result_snapshots",
    "dormitory_round_participants",
    "dormitory_selection_rounds",
    "grades",
    "messages",
    "reports",
    "roommate_cards",
    "sessions",
    "student_selection_group_members",
    "student_selection_groups",
)
with sqlite3.connect(get_settings().db_path) as database:
    users = database.execute(
        "SELECT login_identifier,account_type,must_change_password,status FROM users ORDER BY id"
    ).fetchall()
    nonempty = {
        table: database.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        for table in empty_tables
        if database.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    }
    homepage = database.execute(
        "SELECT COUNT(*) FROM system_settings WHERE key='homepage_markdown'"
    ).fetchone()[0]
if users != [("admin", "SUPER_ADMIN", 1, "ACTIVE")]:
    raise SystemExit(f"Unexpected initial users: {users!r}")
if nonempty:
    raise SystemExit(f"Fresh database contains business data: {nonempty!r}")
if homepage != 1:
    raise SystemExit("Default homepage content is missing")
print("Fresh database state verified")
PY

compose up -d --remove-orphans
if ! wait_for_healthy; then
  compose ps || true
  compose logs --tail=200 || true
  echo "Fresh database was initialized, but the application failed health checks" >&2
  exit 1
fi

echo "Production database reset completed for image $image_tag"
