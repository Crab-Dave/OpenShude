"""Replace long-lived sessions with rotating access and refresh tokens."""

import sqlalchemy as sa

from alembic import op

revision = "20260807_01"
down_revision = "20260806_02"
branch_labels = None
depends_on = None

SESSION_COLUMNS = {
    "id",
    "user_id",
    "access_token_hash",
    "access_expires_at",
    "csrf_token_hash",
    "refresh_expires_at",
    "created_at",
    "refreshed_at",
}


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _session_columns() -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}


def _create_sessions() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("access_token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("access_expires_at", sa.Text(), nullable=False),
        sa.Column("csrf_token_hash", sa.Text(), nullable=False),
        sa.Column("refresh_expires_at", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("refreshed_at", sa.Text(), nullable=False),
    )
    op.create_index("idx_sessions_user", "sessions", ["user_id"])
    op.create_index("idx_sessions_refresh_expiry", "sessions", ["refresh_expires_at"])


def _create_refresh_tokens() -> None:
    op.create_table(
        "refresh_tokens",
        sa.Column("token_hash", sa.Text(), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("consumed_at", sa.Text()),
        sa.Column("replaced_by_hash", sa.Text()),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index("idx_refresh_tokens_session", "refresh_tokens", ["session_id"])


def upgrade() -> None:
    tables = _tables()
    if "sessions" not in tables:
        _create_sessions()
    elif _session_columns() != SESSION_COLUMNS:
        op.drop_table("sessions")
        _create_sessions()
    if "refresh_tokens" not in _tables():
        _create_refresh_tokens()


def downgrade() -> None:
    if "refresh_tokens" in _tables():
        op.drop_table("refresh_tokens")
    if "sessions" in _tables():
        op.drop_table("sessions")
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.Text(), primary_key=True),
        sa.Column("csrf_token", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index("idx_sessions_user", "sessions", ["user_id"])
