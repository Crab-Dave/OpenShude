"""Enforce current check constraints on upgraded legacy databases."""

import re

from alembic import op

revision = "20260805_01"
down_revision = "20260804_01"
branch_labels = None
depends_on = None

TABLE_CHECKS = {
    "users": (
        ("ck_users_role", "role IN ('STUDENT','ADMIN')"),
        ("ck_users_account_type", "account_type IN ('USER','SUPER_ADMIN')"),
        ("ck_users_must_change_password", "must_change_password IN (0,1)"),
        ("ck_users_gender", "gender IN ('MALE','FEMALE','UNSPECIFIED')"),
        ("ck_users_status", "status IN ('PENDING_ACTIVATION','ACTIVE','SUSPENDED','BANNED')"),
    ),
    "roommate_cards": (("ck_roommate_cards_status", "status IN ('DRAFT','PUBLISHED','HIDDEN')"),),
    "conversations": (("ck_conversations_student_order", "student_a_id < student_b_id"),),
    "reports": (
        ("ck_reports_target_type", "target_type IN ('ROOMMATE_CARD','MESSAGE')"),
        ("ck_reports_status", "status IN ('PENDING','RESOLVED','REJECTED')"),
    ),
    "dormitory_selection_rounds": (
        ("ck_dormitory_selection_rounds_status", "status IN ('DRAFT','OPEN','CLOSED','ARCHIVED')"),
    ),
    "dormitories": (
        ("ck_dormitories_capacity", "capacity = 4"),
        ("ck_dormitories_gender", "gender IN ('MALE','FEMALE')"),
        ("ck_dormitories_status", "status IN ('OPEN','FULL','CLOSED')"),
    ),
    "dormitory_members": (("ck_dormitory_members_role", "role IN ('INITIATOR','MEMBER')"),),
    "dormitory_applications": (
        ("ck_dormitory_applications_status", "status IN ('PENDING','APPROVED','REJECTED','CANCELLED')"),
    ),
    "grades": (("ck_grades_status", "status IN ('ACTIVE','DISABLED')"),),
    "admin_groups": (("ck_admin_groups_status", "status IN ('ACTIVE','DISABLED')"),),
}


def normalized(value: str) -> str:
    return re.sub(r"\s+", "", value).upper()


def upgrade() -> None:
    bind = op.get_bind()
    bind.exec_driver_sql("PRAGMA foreign_keys=OFF")
    if bind.exec_driver_sql("PRAGMA foreign_keys").scalar() != 0:
        raise RuntimeError("Foreign keys must be disabled while rebuilding SQLite tables")
    try:
        for table, checks in TABLE_CHECKS.items():
            create_sql = bind.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).scalar_one()
            current_sql = normalized(create_sql)
            missing = [(name, condition) for name, condition in checks if normalized(condition) not in current_sql]
            if not missing:
                continue
            with op.batch_alter_table(table, recreate="always") as batch:
                for name, condition in missing:
                    batch.create_check_constraint(name, condition)
        violations = bind.exec_driver_sql("PRAGMA foreign_key_check").all()
        if violations:
            raise RuntimeError(f"Foreign key violations after rebuilding constrained tables: {violations}")
    finally:
        bind.exec_driver_sql("PRAGMA foreign_keys=ON")


def downgrade() -> None:
    raise RuntimeError(
        "Database rollback must restore a verified backup; schema downgrade is intentionally unsupported"
    )
