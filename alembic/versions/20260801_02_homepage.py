"""Add public homepage content."""

import sqlalchemy as sa

from alembic import op

revision = "20260801_02"
down_revision = "20260801_01"
branch_labels = None
depends_on = None

DEFAULT_HOMEPAGE = """# 欢迎来到合住

这里是校内室友双选系统。你可以阅读首页通知，登录后完善室友卡片、联系同学并参与当前选宿舍轮次。

## 使用提示

- 请如实填写个人信息，尊重他人的生活习惯和沟通边界。
- 私信与组队信息仅供本系统内部使用。
- 如遇账号或内容问题，请联系系统管理员。
"""


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("system_settings")}
    if "revision" not in columns:
        op.add_column("system_settings", sa.Column("revision", sa.Integer(), nullable=False, server_default="1"))
    bind.execute(
        sa.text("""INSERT OR IGNORE INTO system_settings(key,value,updated_at,revision)
        VALUES('homepage_markdown',:value,:updated,1)"""),
        {"value": DEFAULT_HOMEPAGE, "updated": "2026-08-01T00:00:00.000Z"},
    )


def downgrade() -> None:
    op.drop_column("system_settings", "revision")
