"""Remove database-backed homepage content."""

import sqlalchemy as sa

from alembic import op

revision = "20260804_01"
down_revision = "20260801_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("system_settings")


def downgrade() -> None:
    op.create_table(
        "system_settings",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
    )
