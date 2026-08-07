"""Create the current schema and migrate legacy Node databases."""

import sqlalchemy as sa

from alembic import op
from app import models  # noqa: F401
from app.database import Base

revision = "20260801_01"
down_revision = None
branch_labels = None
depends_on = None
EMPTY_TEXT_COLUMN = "TEXT NOT NULL DEFAULT ''"
DORMITORY_ROUND_REFERENCE = "INTEGER REFERENCES dormitory_selection_rounds(id)"


def _columns(bind, table: str) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_columns(table)}


def _add_missing(bind, table: str, definitions: list[tuple[str, str]]) -> set[str]:
    existing = _columns(bind, table)
    for name, definition in definitions:
        if name not in existing:
            bind.exec_driver_sql(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {definition}')
    return existing


def upgrade() -> None:
    bind = op.get_bind()
    original_tables = set(sa.inspect(bind).get_table_names())
    Base.metadata.create_all(bind, checkfirst=True)
    if "system_settings" not in sa.inspect(bind).get_table_names():
        op.create_table(
            "system_settings",
            sa.Column("key", sa.Text(), primary_key=True),
            sa.Column("value", sa.Text(), nullable=False),
            sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id")),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
    if "users" not in original_tables:
        return

    old_users = _add_missing(
        bind,
        "users",
        [
            ("gender", "TEXT NOT NULL DEFAULT 'UNSPECIFIED'"),
            ("major", EMPTY_TEXT_COLUMN),
            ("account_type", "TEXT NOT NULL DEFAULT 'USER'"),
            ("must_change_password", "INTEGER NOT NULL DEFAULT 0"),
            ("grade_id", "INTEGER REFERENCES grades(id)"),
        ],
    )
    if "account_type" not in old_users:
        bind.exec_driver_sql("UPDATE users SET account_type=CASE role WHEN 'ADMIN' THEN 'SUPER_ADMIN' ELSE 'USER' END")
    _add_missing(
        bind,
        "messages",
        [
            ("message_type", "TEXT NOT NULL DEFAULT 'TEXT'"),
            ("application_id", "INTEGER"),
        ],
    )
    _add_missing(
        bind,
        "roommate_cards",
        [
            (name, EMPTY_TEXT_COLUMN)
            for name in (
                "origin_province",
                "origin_city",
                "clothing_size",
                "wake_up_time",
                "sleep_time",
                "nap_habit",
                "personal_cleanliness",
                "roommate_cleanliness",
                "common_space_maintenance",
                "unacceptable_hygiene",
                "one_sentence_intro",
                "personality_text",
                "roommate_personality_text",
                "interests_text",
                "gaming_self",
                "gaming_roommate",
                "keyboard_noise_text",
                "media_noise_text",
            )
        ],
    )
    _add_missing(
        bind,
        "dormitories",
        [
            ("gender", "TEXT NOT NULL DEFAULT 'UNSPECIFIED'"),
            ("management_grade_id", "INTEGER REFERENCES grades(id)"),
            ("selection_round_id", DORMITORY_ROUND_REFERENCE),
        ],
    )
    _add_missing(bind, "dormitory_members", [("selection_round_id", DORMITORY_ROUND_REFERENCE)])
    _add_missing(bind, "dormitory_applications", [("selection_round_id", DORMITORY_ROUND_REFERENCE)])
    _add_missing(
        bind,
        "audit_logs",
        [
            ("admin_name_snapshot", EMPTY_TEXT_COLUMN),
            ("user_agent", EMPTY_TEXT_COLUMN),
            ("request_id", EMPTY_TEXT_COLUMN),
            ("permission_code", EMPTY_TEXT_COLUMN),
            ("grant_group_id", "INTEGER REFERENCES admin_groups(id)"),
            ("scope_type", EMPTY_TEXT_COLUMN),
            ("scope_value", EMPTY_TEXT_COLUMN),
            ("result", "TEXT NOT NULL DEFAULT 'SUCCESS'"),
            ("before_snapshot", "TEXT NOT NULL DEFAULT '{}'"),
            ("after_snapshot", "TEXT NOT NULL DEFAULT '{}'"),
        ],
    )

    timestamp = "2026-08-01T00:00:00.000Z"
    bind.execute(
        sa.text("""INSERT OR IGNORE INTO grades(code,name,created_at,updated_at)
      SELECT DISTINCT grade,grade,:now,:now FROM users WHERE account_type='USER' AND grade NOT IN ('','-')"""),
        {"now": timestamp},
    )
    bind.exec_driver_sql("""UPDATE users SET grade_id=(SELECT id FROM grades WHERE code=users.grade)
      WHERE account_type='USER' AND grade_id IS NULL""")
    bind.execute(
        sa.text("""INSERT OR IGNORE INTO system_settings(key,value,updated_at)
      VALUES('dormitory_selection_open','true',:now)"""),
        {"now": timestamp},
    )
    initial = bind.execute(sa.text("SELECT id FROM dormitory_selection_rounds ORDER BY id LIMIT 1")).mappings().first()
    created = initial is None
    if created:
        selection_open = (
            bind.execute(sa.text("SELECT value FROM system_settings WHERE key='dormitory_selection_open'")).scalar()
            == "true"
        )
        admin_id = bind.execute(
            sa.text("SELECT id FROM users WHERE account_type='SUPER_ADMIN' ORDER BY id LIMIT 1")
        ).scalar()
        result = bind.execute(
            sa.text("""INSERT INTO dormitory_selection_rounds
          (code,name,description,status,created_by,opened_at,closed_at,created_at,updated_at)
          VALUES('LEGACY_INITIAL','默认选宿舍轮次','由原自由选宿舍阶段迁移生成',:status,:admin,:opened,:closed,:now,:now)"""),
            {
                "status": "OPEN" if selection_open else "CLOSED",
                "admin": admin_id,
                "opened": timestamp if selection_open else None,
                "closed": None if selection_open else timestamp,
                "now": timestamp,
            },
        )
        initial = {"id": result.lastrowid}
    round_id = initial["id"]
    bind.execute(
        sa.text("UPDATE dormitories SET selection_round_id=:round WHERE selection_round_id IS NULL"),
        {"round": round_id},
    )
    bind.exec_driver_sql("""UPDATE dormitory_members SET selection_round_id=(SELECT selection_round_id FROM dormitories
      WHERE id=dormitory_members.dormitory_id) WHERE selection_round_id IS NULL""")
    bind.exec_driver_sql("""UPDATE dormitory_applications SET selection_round_id=(SELECT selection_round_id FROM dormitories
      WHERE id=dormitory_applications.dormitory_id) WHERE selection_round_id IS NULL""")
    bind.exec_driver_sql("DROP INDEX IF EXISTS idx_dormitory_member_user")
    bind.exec_driver_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_dormitory_member_round_user ON dormitory_members(selection_round_id,user_id)"
    )
    if created:
        bind.execute(
            sa.text("""INSERT OR IGNORE INTO dormitory_round_participants(round_id,user_id,added_by,created_at)
          SELECT :round,id,:admin,:now FROM users WHERE account_type='USER'"""),
            {"round": round_id, "admin": admin_id, "now": timestamp},
        )
    bind.exec_driver_sql("UPDATE dormitories SET capacity=4")
    bind.exec_driver_sql("""UPDATE dormitories SET management_grade_id=(SELECT grade_id FROM users WHERE id=initiator_id)
      WHERE management_grade_id IS NULL""")
    bind.exec_driver_sql("UPDATE roommate_cards SET status='PUBLISHED' WHERE status='ROOMMATE_CONFIRMED'")
    bind.exec_driver_sql("UPDATE roommate_cards SET personal_cleanliness='BASIC' WHERE personal_cleanliness='REGULAR'")
    bind.exec_driver_sql("UPDATE roommate_cards SET roommate_cleanliness='BASIC' WHERE roommate_cleanliness='REGULAR'")
    bind.exec_driver_sql(
        "UPDATE roommate_cards SET common_space_maintenance='CLEAN_TOGETHER' WHERE common_space_maintenance='ASSIGNED'"
    )
    bind.exec_driver_sql("""UPDATE roommate_cards SET one_sentence_intro=substr(personality_text,1,100)
      WHERE one_sentence_intro='' AND personality_text!=''""")
    bind.exec_driver_sql("""UPDATE users SET major=COALESCE(NULLIF((SELECT department FROM roommate_cards
      WHERE user_id=users.id),''),major) WHERE major=''""")
    bind.exec_driver_sql(
        """UPDATE dormitories SET gender=COALESCE((SELECT gender FROM users WHERE id=initiator_id),gender)"""
    )


def downgrade() -> None:
    raise RuntimeError(
        "Database rollback must restore a verified backup; schema downgrade is intentionally unsupported"
    )
