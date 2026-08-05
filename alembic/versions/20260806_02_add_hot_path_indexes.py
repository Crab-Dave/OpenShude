"""Add indexes used by high-traffic application queries."""

from alembic import op

revision = "20260806_02"
down_revision = "20260806_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("idx_users_gender_status", "users", ["gender", "status"], if_not_exists=True)
    op.create_index(
        "idx_roommate_cards_status_updated",
        "roommate_cards",
        ["status", "updated_at", "id"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_conversations_student_a_activity",
        "conversations",
        ["student_a_id", "last_message_at", "id"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_conversations_student_b_activity",
        "conversations",
        ["student_b_id", "last_message_at", "id"],
        if_not_exists=True,
    )
    op.drop_index("idx_messages_conversation", table_name="messages", if_exists=True)
    op.create_index("idx_messages_conversation", "messages", ["conversation_id", "id"])
    op.create_index("idx_blocks_blocked_blocker", "blocks", ["blocked_id", "blocker_id"], if_not_exists=True)
    op.create_index("idx_reports_reporter_created", "reports", ["reporter_id", "created_at"], if_not_exists=True)
    op.create_index("idx_sessions_user", "sessions", ["user_id"], if_not_exists=True)
    op.create_index(
        "idx_dormitories_round_gender_status_created",
        "dormitories",
        ["selection_round_id", "gender", "status", "created_at", "id"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_dormitory_applications_applicant_round_created",
        "dormitory_applications",
        ["applicant_id", "selection_round_id", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_dormitory_result_members_source",
        "dormitory_result_members",
        ["source_user_id", "snapshot_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    raise RuntimeError("Index downgrade requires a verified database backup")
