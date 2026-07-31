import sqlite3

import pytest
from alembic.config import Config
from sqlalchemy import inspect

from alembic import command
from app.config import get_settings
from app.database import Base, create_database_engine
from app.maintenance import backup, configured_backup_path, restore, validate_database, verify
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
        assert database.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "20260801_01"


def test_models_map_all_current_tables():
    assert len(Base.metadata.tables) == 24
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
