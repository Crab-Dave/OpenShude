"""Add public visibility to student selection groups.

Revision ID: 20260918_01
Revises: 20260917_01
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260918_01"
down_revision: str | None = "20260917_01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _columns() -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns("student_selection_groups")}


def upgrade() -> None:
    if "is_public" not in _columns():
        op.add_column(
            "student_selection_groups",
            sa.Column("is_public", sa.Integer(), nullable=False, server_default=sa.text("0")),
        )


def downgrade() -> None:
    if "is_public" in _columns():
        with op.batch_alter_table("student_selection_groups") as batch:
            batch.drop_column("is_public")
