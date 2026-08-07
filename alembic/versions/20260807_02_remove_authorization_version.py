"""Remove the unused authorization version column."""

import sqlalchemy as sa

from alembic import op

revision = "20260807_02"
down_revision = "20260807_01"
branch_labels = None
depends_on = None


def _columns() -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns("users")}


def upgrade() -> None:
    if "authorization_version" in _columns():
        op.drop_column("users", "authorization_version")


def downgrade() -> None:
    if "authorization_version" not in _columns():
        op.add_column(
            "users",
            sa.Column("authorization_version", sa.Integer(), nullable=False, server_default="1"),
        )
