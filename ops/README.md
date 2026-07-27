# Database operations

Production deploys create a verified SQLite backup before replacing an existing
application container. Backups and their SHA-256 files are stored in the
external `openshude-backups` volume; the newest 10 backups are retained.

List the available backups on the server:

```bash
cd /opt/myapp
IMAGE_TAG=$(<.deployed-image-tag) docker compose -f compose.prod.yml run -T --rm --no-deps web \
  sh -c 'ls -1 /app/backups/*.db'
```

Create a manual backup before a sensitive operation such as data import:

```bash
cd /opt/myapp
image_tag=$(<.deployed-image-tag)
backup="/app/backups/manual-$(date -u +%Y%m%dT%H%M%SZ)-${image_tag}.db"
IMAGE_TAG="$image_tag" docker compose -f compose.prod.yml run -T --rm --no-deps web \
  node ops/database-maintenance.js backup /app/data/app.db "$backup"
```

Restore one of those backups:

```bash
cd /opt/myapp
./restore-database.sh predeploy-YYYYMMDDTHHMMSSZ-COMMIT.db
```

The restore command verifies the checksum and SQLite integrity, creates a
pre-restore safety backup, stops the application, restores the selected file,
and reverts automatically if health checks fail.

Before importing formal user data, create a fresh backup, perform a restore
rehearsal, and copy a verified backup outside this server. The current volume
protects deployments and operator mistakes, but not loss of the server itself.
