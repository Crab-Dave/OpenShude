"""Add shared group ownership and activity plaza data."""

import sqlalchemy as sa

from alembic import op

revision = "20260917_01"
down_revision = "20260903_01"
branch_labels = None
depends_on = None
USERS_ID = "users.id"
GRADES_ID = "grades.id"
ACTIVITIES_ID = "activities.id"
SET_NULL = "SET NULL"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    unique_constraints = inspector.get_unique_constraints("student_selection_groups")
    if any(constraint["column_names"] == ["name"] for constraint in unique_constraints):
        naming_convention = {"uq": "uq_%(table_name)s_%(column_0_name)s"}
        with op.batch_alter_table(
            "student_selection_groups",
            recreate="always",
            naming_convention=naming_convention,
        ) as batch:
            batch.drop_constraint("uq_student_selection_groups_name", type_="unique")
            batch.create_unique_constraint(
                "uq_student_selection_groups_owner_name",
                ["created_by", "name"],
            )

    activity_tables = {
        "activities",
        "activity_target_grades",
        "activity_target_groups",
        "activity_target_members",
        "activity_registrations",
    }
    if activity_tables <= set(sa.inspect(bind).get_table_names()):
        return

    op.create_table(
        "activities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description_markdown", sa.Text(), nullable=False, server_default=""),
        sa.Column("description_html", sa.Text(), nullable=False, server_default=""),
        sa.Column("description_summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("start_at", sa.Text(), nullable=False),
        sa.Column("end_at", sa.Text(), nullable=False),
        sa.Column("is_all_day", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("location", sa.Text(), nullable=False),
        sa.Column("organizer_type", sa.Text(), nullable=False),
        sa.Column("organizer_user_id", sa.Integer(), sa.ForeignKey(USERS_ID, ondelete=SET_NULL)),
        sa.Column("organizer_group_id", sa.Integer(), sa.ForeignKey("admin_groups.id", ondelete=SET_NULL)),
        sa.Column("organizer_name_snapshot", sa.Text(), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("importance", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="DRAFT"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("cancel_reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey(USERS_ID, ondelete=SET_NULL)),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("published_at", sa.Text()),
        sa.Column("cancelled_at", sa.Text()),
        sa.CheckConstraint("end_at > start_at"),
        sa.CheckConstraint("is_all_day IN (0,1)"),
        sa.CheckConstraint("organizer_type IN ('USER','ADMIN_GROUP')"),
        sa.CheckConstraint(
            "(organizer_type='USER' AND organizer_group_id IS NULL) OR "
            "(organizer_type='ADMIN_GROUP' AND organizer_user_id IS NULL)"
        ),
        sa.CheckConstraint("capacity BETWEEN 1 AND 500"),
        sa.CheckConstraint("importance BETWEEN 1 AND 5"),
        sa.CheckConstraint("status IN ('DRAFT','PUBLISHED','CANCELLED')"),
        sa.CheckConstraint("version > 0"),
    )
    op.create_index("idx_activities_status_time", "activities", ["status", "start_at", "end_at"])
    op.create_index("idx_activities_organizer_user", "activities", ["organizer_user_id", "status"])
    op.create_index("idx_activities_organizer_group", "activities", ["organizer_group_id", "status"])

    op.create_table(
        "activity_target_grades",
        sa.Column(
            "activity_id",
            sa.Integer(),
            sa.ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("grade_id", sa.Integer(), sa.ForeignKey(GRADES_ID), primary_key=True),
    )
    op.create_table(
        "activity_target_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("activity_id", sa.Integer(), sa.ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"), nullable=False),
        sa.Column(
            "source_group_id",
            sa.Integer(),
            sa.ForeignKey("student_selection_groups.id", ondelete=SET_NULL),
        ),
        sa.Column("group_name_snapshot", sa.Text(), nullable=False),
        sa.UniqueConstraint("activity_id", "source_group_id"),
    )
    op.create_index(
        "idx_activity_target_groups_activity",
        "activity_target_groups",
        ["activity_id", "id"],
    )
    op.create_table(
        "activity_target_members",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("activity_id", sa.Integer(), sa.ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey(USERS_ID, ondelete=SET_NULL)),
        sa.Column("participant_name_snapshot", sa.Text(), nullable=False),
        sa.Column("grade_snapshot", sa.Text(), nullable=False),
        sa.UniqueConstraint("activity_id", "user_id"),
    )
    op.create_index(
        "idx_activity_target_members_user",
        "activity_target_members",
        ["user_id", "activity_id"],
    )
    op.create_table(
        "activity_registrations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("activity_id", sa.Integer(), sa.ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey(USERS_ID, ondelete=SET_NULL)),
        sa.Column("participant_name_snapshot", sa.Text(), nullable=False),
        sa.Column("participant_grade_snapshot", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="REGISTERED"),
        sa.Column("registered_at", sa.Text(), nullable=False),
        sa.Column("cancelled_at", sa.Text()),
        sa.UniqueConstraint("activity_id", "user_id"),
        sa.CheckConstraint("status IN ('REGISTERED','CANCELLED')"),
    )
    op.create_index(
        "idx_activity_registrations_activity_status",
        "activity_registrations",
        ["activity_id", "status", "id"],
    )
    op.create_index(
        "idx_activity_registrations_user_status",
        "activity_registrations",
        ["user_id", "status", "activity_id"],
    )


def downgrade() -> None:
    raise RuntimeError("Activity plaza rollback requires a verified database backup")
