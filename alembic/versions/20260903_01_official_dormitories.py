"""Add official dormitories, members, and content revisions."""

import sqlalchemy as sa

from alembic import op

revision = "20260903_01"
down_revision = "20260809_01"
branch_labels = None
depends_on = None
USERS_ID = "users.id"
SET_NULL = "SET NULL"
NORMAL_STATUS_SQL = "'NORMAL'"


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "official_dormitories" not in tables:
        op.create_table(
            "official_dormitories",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("dormitory_code", sa.Text(), nullable=False, unique=True),
            sa.Column("nickname", sa.Text(), nullable=False, server_default=""),
            sa.Column("nickname_status", sa.Text(), nullable=False, server_default="NORMAL"),
            sa.Column("description_markdown", sa.Text(), nullable=False, server_default=""),
            sa.Column("description_status", sa.Text(), nullable=False, server_default="NORMAL"),
            sa.Column("rules_markdown", sa.Text(), nullable=False, server_default=""),
            sa.Column("rules_status", sa.Text(), nullable=False, server_default="NORMAL"),
            sa.Column("management_grade_id", sa.Integer(), sa.ForeignKey("grades.id"), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey(USERS_ID, ondelete=SET_NULL)),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.CheckConstraint(f"nickname_status IN ({NORMAL_STATUS_SQL},'HIDDEN')"),
            sa.CheckConstraint(f"description_status IN ({NORMAL_STATUS_SQL},'HIDDEN')"),
            sa.CheckConstraint(f"rules_status IN ({NORMAL_STATUS_SQL},'HIDDEN')"),
            sa.CheckConstraint("version > 0"),
        )
        op.create_index("idx_official_dormitories_updated", "official_dormitories", ["updated_at", "id"])
        op.create_index("idx_official_dormitories_grade", "official_dormitories", ["management_grade_id", "id"])
    if "official_dormitory_members" not in tables:
        op.create_table(
            "official_dormitory_members",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "official_dormitory_id",
                sa.Integer(),
                sa.ForeignKey("official_dormitories.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey(USERS_ID, ondelete=SET_NULL)),
            sa.Column("role", sa.Text(), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("imported_login_identifier", sa.Text(), nullable=False),
            sa.Column("name_snapshot", sa.Text(), nullable=False),
            sa.Column("grade_snapshot", sa.Text(), nullable=False),
            sa.Column("major_snapshot", sa.Text(), nullable=False, server_default=""),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.UniqueConstraint("official_dormitory_id", "position"),
            sa.UniqueConstraint("official_dormitory_id", "user_id"),
            sa.CheckConstraint("role IN ('LEADER','MEMBER')"),
            sa.CheckConstraint("position BETWEEN 1 AND 4"),
        )
        op.create_index(
            "idx_official_dormitory_members_user",
            "official_dormitory_members",
            ["user_id", "official_dormitory_id"],
        )
        op.create_index(
            "idx_official_dormitory_single_leader",
            "official_dormitory_members",
            ["official_dormitory_id"],
            unique=True,
            sqlite_where=sa.text("role = 'LEADER'"),
        )
    if "official_dormitory_revisions" not in tables:
        op.create_table(
            "official_dormitory_revisions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "official_dormitory_id",
                sa.Integer(),
                sa.ForeignKey("official_dormitories.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("field_name", sa.Text(), nullable=False),
            sa.Column("previous_value", sa.Text(), nullable=False),
            sa.Column("new_value", sa.Text(), nullable=False),
            sa.Column("from_version", sa.Integer(), nullable=False),
            sa.Column("to_version", sa.Integer(), nullable=False),
            sa.Column("edited_by", sa.Integer(), sa.ForeignKey(USERS_ID, ondelete=SET_NULL)),
            sa.Column("editor_name_snapshot", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.CheckConstraint("field_name IN ('NICKNAME','DESCRIPTION','RULES')"),
            sa.CheckConstraint("to_version > from_version"),
        )
        op.create_index(
            "idx_official_dormitory_revisions_dormitory",
            "official_dormitory_revisions",
            ["official_dormitory_id", "id"],
        )


def downgrade() -> None:
    raise RuntimeError("Official dormitory rollback requires a verified database backup")
