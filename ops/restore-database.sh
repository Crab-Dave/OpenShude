#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir=${DEPLOY_DIR:-/opt/myapp}
backup_name=${1:-}
if [[ ! "$backup_name" =~ ^[A-Za-z0-9._-]+\.db$ ]]; then
  echo "Usage: $0 <backup-file.db>" >&2
  exit 2
fi

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
           -H 'Host: 39.96.36.207' http://127.0.0.1/api/health >/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

backup_path="/app/backups/$backup_name"
compose run --rm --no-deps web node ops/database-maintenance.js verify "$backup_path"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
safety_name="pre-restore-${timestamp}-${image_tag}.db"
safety_path="/app/backups/$safety_name"
compose run --rm --no-deps web node ops/database-maintenance.js \
  backup /app/data/app.db "$safety_path"

compose stop web
if ! compose run --rm --no-deps web node ops/database-maintenance.js \
  restore "$backup_path" /app/data/app.db; then
  if compose run --rm --no-deps web node ops/database-maintenance.js \
       restore "$safety_path" /app/data/app.db && \
     compose up -d --remove-orphans && wait_for_healthy; then
    compose run --rm --no-deps web node ops/database-maintenance.js prune /app/backups 10
    echo "Restore failed; the pre-restore database was reapplied" >&2
  else
    echo "Restore and automatic database rollback both failed" >&2
  fi
  exit 1
fi

compose up -d --remove-orphans
if wait_for_healthy; then
  compose run --rm --no-deps web node ops/database-maintenance.js prune /app/backups 10
  echo "Database restored from $backup_name"
  exit 0
fi

compose stop web
if compose run --rm --no-deps web node ops/database-maintenance.js \
     restore "$safety_path" /app/data/app.db && \
   compose up -d --remove-orphans && wait_for_healthy; then
  compose run --rm --no-deps web node ops/database-maintenance.js prune /app/backups 10
  echo "Restored database failed health checks; reverted to $safety_name" >&2
else
  echo "Restored database failed health checks and automatic rollback failed" >&2
fi
exit 1
