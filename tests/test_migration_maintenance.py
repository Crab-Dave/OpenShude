import sqlite3

import pytest
from alembic.config import Config
from sqlalchemy import inspect

from alembic import command
from app.config import get_settings
from app.database import Base, create_database_engine
from app.maintenance import backup, bootstrap_admin, configured_backup_path, restore, validate_database, verify
from app.security import hash_password, verify_password


def test_scrypt_is_compatible_with_existing_passwords():
    password = hash_password("Student123!", "0123456789abcdef0123456789abcdef")
    assert password.hash == (
        "63844310c78969aec038ea626497e5fc31ed3fb9c69c1dd5478f54da81102ec4"
        "ad2442a4f305a4f14a7eac4600391647b78bff9e86bb5c98889bfbd61c30c65d"
    )
    assert verify_password("Student123!", password.salt, password.hash)


def test_alembic_upgrades_a_legacy_database(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.db"
    password = hash_password("Admin123!")
    with sqlite3.connect(legacy) as database:
        database.executescript("""CREATE TABLE users(
          id INTEGER PRIMARY KEY,login_identifier TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,role TEXT NOT NULL,name TEXT NOT NULL,grade TEXT NOT NULL,
          email TEXT,status TEXT NOT NULL,imported_by INTEGER,deactivated_at TEXT,last_login_at TEXT,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,gender TEXT NOT NULL DEFAULT 'UNSPECIFIED',
          major TEXT NOT NULL DEFAULT '');""")
        database.execute(
            """INSERT INTO users(login_identifier,password_hash,password_salt,role,name,grade,status,
          created_at,updated_at,gender,major) VALUES('admin',?,?,'ADMIN','旧管理员','-','ACTIVE','2026-01-01Z',
          '2026-01-01Z','UNSPECIFIED','')""",
            (password.hash, password.salt),
        )
        database.execute(
            """INSERT INTO users(login_identifier,password_hash,password_salt,role,name,grade,status,
          created_at,updated_at,gender,major) VALUES('legacy-student',?,?,'STUDENT','旧学生','2026级','ACTIVE',
          '2026-01-01Z','2026-01-01Z','FEMALE','计算机')""",
            (password.hash, password.salt),
        )
        database.executescript("""CREATE TABLE dormitories(
          id INTEGER PRIMARY KEY,dormitory_code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
          building TEXT NOT NULL DEFAULT '',room_number TEXT NOT NULL DEFAULT '',capacity INTEGER NOT NULL DEFAULT 4,
          initiator_id INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'OPEN',
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
          INSERT INTO dormitories(dormitory_code,name,capacity,initiator_id,status,created_at,updated_at)
          VALUES('LEGACY-DORM','旧宿舍',6,2,'OPEN','2026-01-01Z','2026-01-01Z');""")
    monkeypatch.setenv("DB_PATH", str(legacy))
    get_settings.cache_clear()
    command.upgrade(Config("alembic.ini"), "head")
    get_settings.cache_clear()
    with sqlite3.connect(legacy) as database:
        columns = {row[1] for row in database.execute("PRAGMA table_info(users)")}
        assert {"account_type", "grade_id", "must_change_password"} <= columns
        assert (
            database.execute("SELECT account_type FROM users WHERE login_identifier='admin'").fetchone()[0]
            == "SUPER_ADMIN"
        )
        assert database.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "20260805_01"
        assert (
            database.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='system_settings'"
            ).fetchone()[0]
            == 0
        )
        assert database.execute("SELECT capacity FROM dormitories WHERE id=1").fetchone()[0] == 4
        with pytest.raises(sqlite3.IntegrityError):
            database.execute("UPDATE users SET account_type='UNSUPPORTED' WHERE id=2")
        with pytest.raises(sqlite3.IntegrityError):
            database.execute("UPDATE dormitories SET capacity=5 WHERE id=1")
        assert validate_database(legacy)["status"] == "ok"


def test_static_page_migration_removes_existing_database_content(tmp_path, monkeypatch):
    database_path = tmp_path / "homepage.db"
    monkeypatch.setenv("DB_PATH", str(database_path))
    get_settings.cache_clear()
    config = Config("alembic.ini")
    command.upgrade(config, "20260801_01")
    with sqlite3.connect(database_path) as database:
        database.execute(
            "INSERT INTO system_settings(key,value,updated_at) VALUES('homepage_markdown','保留正文','2026-01-01Z')"
        )
    command.upgrade(config, "head")
    get_settings.cache_clear()
    with sqlite3.connect(database_path) as database:
        assert (
            database.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='system_settings'"
            ).fetchone()[0]
            == 0
        )


def test_validation_reports_missing_constrained_tables_once(tmp_path, monkeypatch):
    database_path = tmp_path / "missing-table.db"
    monkeypatch.setenv("DB_PATH", str(database_path))
    get_settings.cache_clear()
    command.upgrade(Config("alembic.ini"), "head")
    with sqlite3.connect(database_path) as database:
        database.execute("DROP TABLE reports")

    with pytest.raises(RuntimeError) as validation_error:
        validate_database(database_path)
    assert '"reports"' in str(validation_error.value)
    assert "reports:" not in str(validation_error.value)


def test_fresh_production_database_bootstrap(tmp_path, monkeypatch):
    database_path = tmp_path / "fresh-production.db"
    monkeypatch.setenv("DB_PATH", str(database_path))
    get_settings.cache_clear()
    command.upgrade(Config("alembic.ini"), "head")
    assert bootstrap_admin(database_path, "OneTimeAdminPassword123!") is True
    assert bootstrap_admin(database_path, "UnusedAdminPassword123!") is False
    assert validate_database(database_path) == {"status": "ok", "openRounds": 0}

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
    with sqlite3.connect(database_path) as database:
        user = database.execute(
            "SELECT login_identifier,account_type,must_change_password,status,password_salt,password_hash FROM users"
        ).fetchone()
        assert user[:4] == ("admin", "SUPER_ADMIN", 1, "ACTIVE")
        assert verify_password("OneTimeAdminPassword123!", user[4], user[5])
        assert all(database.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == 0 for table in empty_tables)
        assert (
            database.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='system_settings'"
            ).fetchone()[0]
            == 0
        )


def test_models_map_all_current_tables():
    assert len(Base.metadata.tables) == 23
    database_engine = create_database_engine()
    try:
        tables = set(inspect(database_engine).get_table_names())
        assert set(Base.metadata.tables).issubset(tables)
    finally:
        database_engine.dispose()


def test_backup_verify_restore_round_trip(tmp_path):
    source = tmp_path / "source.db"
    target = tmp_path / "backup.db"
    restored = tmp_path / "restored.db"
    with sqlite3.connect(source) as database:
        database.execute("CREATE TABLE values_table(value TEXT NOT NULL)")
        database.execute("INSERT INTO values_table VALUES('保留的数据')")
    digest = backup(source, target)
    assert verify(target) == digest
    assert restore(target, restored) == digest
    with sqlite3.connect(restored) as database:
        assert database.execute("SELECT value FROM values_table").fetchone()[0] == "保留的数据"


def test_backup_rejects_foreign_key_violations(tmp_path):
    source = tmp_path / "invalid.db"
    with sqlite3.connect(source) as database:
        database.executescript(
            "CREATE TABLE parent(id INTEGER PRIMARY KEY);"
            "CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));"
            "INSERT INTO child VALUES(999);"
        )
    with pytest.raises(RuntimeError, match="foreign_key_check"):
        backup(source, tmp_path / "invalid-backup.db")


def test_configured_backup_path_rejects_directory_escape(tmp_path):
    assert configured_backup_path(tmp_path, "daily-20260801.db") == tmp_path / "daily-20260801.db"
    for filename in ("../escape.db", "nested/escape.db", "backup.sqlite"):
        with pytest.raises(RuntimeError):
            configured_backup_path(tmp_path, filename)


def test_current_database_validation():
    assert validate_database(get_settings().db_path)["status"] == "ok"
