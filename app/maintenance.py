import argparse
import hashlib
import json
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path

from .common import now
from .config import get_settings
from .security import hash_password

QUICK_CHECK = "PRAGMA quick_check"
FOREIGN_KEY_CHECK = "PRAGMA foreign_key_check"
BACKUP_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.db")
REQUIRED_CHECKS = {
    "users": (
        "role IN ('STUDENT','ADMIN')",
        "account_type IN ('USER','SUPER_ADMIN')",
        "must_change_password IN (0,1)",
        "gender IN ('MALE','FEMALE','UNSPECIFIED')",
        "status IN ('PENDING_ACTIVATION','ACTIVE','SUSPENDED','BANNED')",
    ),
    "roommate_cards": ("status IN ('DRAFT','PUBLISHED','HIDDEN')",),
    "conversations": ("student_a_id < student_b_id",),
    "reports": ("target_type IN ('ROOMMATE_CARD','MESSAGE')", "status IN ('PENDING','RESOLVED','REJECTED')"),
    "dormitory_selection_rounds": ("status IN ('DRAFT','OPEN','CLOSED','ARCHIVED')",),
    "dormitories": ("capacity = 4", "gender IN ('MALE','FEMALE')", "status IN ('OPEN','FULL','CLOSED')"),
    "dormitory_members": ("role IN ('INITIATOR','MEMBER')",),
    "dormitory_applications": ("status IN ('PENDING','APPROVED','REJECTED','CANCELLED')",),
    "grades": ("status IN ('ACTIVE','DISABLED')",),
    "admin_groups": ("status IN ('ACTIVE','DISABLED')",),
}


def configured_backup_path(directory: Path, filename: str) -> Path:
    if not BACKUP_NAME.fullmatch(filename):
        raise RuntimeError("Backup filename must contain only letters, numbers, dots, underscores, or hyphens")
    root = directory.resolve()
    candidate = (root / filename).resolve()
    if not candidate.is_relative_to(root):
        raise RuntimeError("Backup file must remain inside the configured backup directory")
    return candidate


def checksum(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(filename: Path) -> str:
    if not filename.is_file():
        raise RuntimeError(f"Database file does not exist: {filename}")
    checksum_file = Path(f"{filename}.sha256")
    if not checksum_file.is_file():
        raise RuntimeError(f"Checksum file does not exist: {checksum_file}")
    expected = checksum_file.read_text(encoding="ascii").split()[0]
    actual = checksum(filename)
    if expected != actual:
        raise RuntimeError(f"Checksum mismatch for {filename}")
    with closing(sqlite3.connect(f"file:{filename.as_posix()}?mode=ro", uri=True)) as database:
        checks = database.execute(QUICK_CHECK).fetchall()
        foreign_keys = database.execute(FOREIGN_KEY_CHECK).fetchall()
    if not checks or any(row[0] != "ok" for row in checks):
        raise RuntimeError(f"SQLite quick_check failed for {filename}")
    if foreign_keys:
        raise RuntimeError(f"SQLite foreign_key_check failed for {filename}")
    return actual


def backup(source: Path, target: Path) -> str:
    if not source.is_file():
        raise RuntimeError(f"Source database does not exist: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    checksum_file = Path(f"{target}.sha256")
    if target.exists() or checksum_file.exists():
        raise RuntimeError(f"Backup target already exists: {target}")
    temporary = Path(f"{target}.tmp")
    temporary_checksum = Path(f"{temporary}.sha256")
    temporary.unlink(missing_ok=True)
    temporary_checksum.unlink(missing_ok=True)
    try:
        with closing(sqlite3.connect(source)) as source_db, closing(sqlite3.connect(temporary)) as target_db:
            source_db.execute("PRAGMA busy_timeout=10000")
            source_db.backup(target_db)
        digest = checksum(temporary)
        temporary_checksum.write_text(f"{digest}  {target.name}\n", encoding="ascii")
        verify(temporary)
        temporary.replace(target)
        temporary_checksum.replace(checksum_file)
        return digest
    finally:
        temporary.unlink(missing_ok=True)
        temporary_checksum.unlink(missing_ok=True)


def restore(source: Path, target: Path) -> str:
    expected = verify(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(f"{target}.restore.tmp")
    temporary.unlink(missing_ok=True)
    try:
        with source.open("rb") as input_file, temporary.open("xb") as output_file:
            while chunk := input_file.read(1024 * 1024):
                output_file.write(chunk)
            output_file.flush()
            os.fsync(output_file.fileno())
        if checksum(temporary) != expected:
            raise RuntimeError("Restored temporary database checksum mismatch")
        Path(f"{target}-wal").unlink(missing_ok=True)
        Path(f"{target}-shm").unlink(missing_ok=True)
        temporary.replace(target)
        with closing(sqlite3.connect(f"file:{target.as_posix()}?mode=ro", uri=True)) as database:
            if any(row[0] != "ok" for row in database.execute(QUICK_CHECK)):
                raise RuntimeError(f"SQLite quick_check failed after restoring {target}")
            if database.execute(FOREIGN_KEY_CHECK).fetchall():
                raise RuntimeError(f"SQLite foreign_key_check failed after restoring {target}")
        return expected
    finally:
        temporary.unlink(missing_ok=True)


def prune(directory: Path, retain: int) -> int:
    if retain < 1:
        raise RuntimeError("Retention count must be a positive integer")
    if not directory.exists():
        return 0
    backups = sorted(directory.glob("*.db"), key=lambda item: item.stat().st_mtime, reverse=True)
    for filename in backups[retain:]:
        filename.unlink()
        Path(f"{filename}.sha256").unlink(missing_ok=True)
    return min(len(backups), retain)


def validate_database(filename: Path) -> dict:
    required = {
        "users",
        "roommate_cards",
        "sessions",
        "dormitory_selection_rounds",
        "dormitories",
        "dormitory_members",
        "dormitory_result_snapshots",
        "alembic_version",
    } | set(REQUIRED_CHECKS)
    with closing(sqlite3.connect(filename)) as database:
        database.row_factory = sqlite3.Row
        quick_check = [row[0] for row in database.execute(QUICK_CHECK)]
        foreign_keys = database.execute(FOREIGN_KEY_CHECK).fetchall()
        tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        table_sql = {
            row[0]: re.sub(r"\s+", "", row[1]).upper()
            for row in database.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")
        }
        missing_checks = [
            f"{table}: {condition}"
            for table, conditions in REQUIRED_CHECKS.items()
            for condition in conditions
            if table in tables and re.sub(r"\s+", "", condition).upper() not in table_sql[table]
        ]
        open_rounds = database.execute(
            "SELECT COUNT(*) FROM dormitory_selection_rounds WHERE status='OPEN'"
        ).fetchone()[0]
        oversized = database.execute("""SELECT COUNT(*) FROM (SELECT dormitory_id FROM dormitory_members
          GROUP BY dormitory_id HAVING COUNT(*)>4)""").fetchone()[0]
        duplicate_memberships = database.execute("""SELECT COUNT(*) FROM (SELECT selection_round_id,user_id
          FROM dormitory_members GROUP BY selection_round_id,user_id HAVING COUNT(*)>1)""").fetchone()[0]
    missing = sorted(required - tables)
    if (
        quick_check != ["ok"]
        or foreign_keys
        or missing
        or missing_checks
        or open_rounds > 1
        or oversized
        or duplicate_memberships
    ):
        raise RuntimeError(
            "Database validation failed: "
            + json.dumps(
                {
                    "quickCheck": quick_check,
                    "foreignKeyErrors": len(foreign_keys),
                    "missingTables": missing,
                    "missingChecks": missing_checks,
                    "openRounds": open_rounds,
                    "oversizedDormitories": oversized,
                    "duplicateMemberships": duplicate_memberships,
                }
            )
        )
    return {"status": "ok", "openRounds": open_rounds}


def bootstrap_admin(filename: Path, password: str) -> bool:
    with closing(sqlite3.connect(filename)) as database:
        if database.execute("SELECT 1 FROM users WHERE account_type='SUPER_ADMIN' LIMIT 1").fetchone():
            return False
        if len(password) < 12:
            raise RuntimeError("Initial administrator password must contain at least 12 characters")
        password_hash = hash_password(password)
        timestamp = now()
        database.execute(
            """INSERT INTO users(login_identifier,password_hash,password_salt,role,account_type,
          must_change_password,name,grade,gender,major,status,created_at,updated_at)
          VALUES('admin',?,?,'ADMIN','SUPER_ADMIN',1,'系统管理员','-','UNSPECIFIED','','ACTIVE',?,?)""",
            (password_hash.hash, password_hash.salt, timestamp, timestamp),
        )
        database.commit()
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    backup_parser = subparsers.add_parser("backup")
    backup_parser.add_argument("filename")
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("filename")
    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("filename")
    prune_parser = subparsers.add_parser("prune")
    prune_parser.add_argument("retain", type=int)
    subparsers.add_parser("validate")
    subparsers.add_parser("bootstrap-admin")
    args = parser.parse_args()
    settings = get_settings()
    database = settings.db_path.resolve()
    backup_directory = settings.backup_dir.resolve()

    if args.command == "backup":
        target = configured_backup_path(backup_directory, args.filename)
        result = {
            "operation": "backup",
            "filename": args.filename,
            "sha256": backup(database, target),
        }
    elif args.command == "verify":
        source = configured_backup_path(backup_directory, args.filename)
        result = {"operation": "verify", "filename": args.filename, "sha256": verify(source)}
    elif args.command == "restore":
        source = configured_backup_path(backup_directory, args.filename)
        result = {
            "operation": "restore",
            "filename": args.filename,
            "sha256": restore(source, database),
        }
    elif args.command == "prune":
        result = {
            "operation": "prune",
            "retained": prune(backup_directory, args.retain),
        }
    elif args.command == "validate":
        result = {"operation": "validate", **validate_database(database)}
    else:
        password = os.environ.get("INITIAL_ADMIN_PASSWORD", "")
        result = {"operation": "bootstrap-admin", "created": bootstrap_admin(database, password)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
