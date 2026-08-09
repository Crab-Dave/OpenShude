"""Add treehole posts, comments, anonymous participants and author grades."""

import sqlalchemy as sa

from alembic import op

revision = "20260809_01"
down_revision = "20260807_02"
branch_labels = None
depends_on = None

REPORT_TARGET_CHECK = "target_type IN ('ROOMMATE_CARD','MESSAGE','TREEHOLE_POST','TREEHOLE_COMMENT')"
USER_ID = "users.id"
SET_NULL = "SET NULL"


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _reports_support_treehole() -> bool:
    sql = (
        op.get_bind()
        .exec_driver_sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='reports'")
        .scalar_one()
    )
    return "TREEHOLE_POST" in sql and "TREEHOLE_COMMENT" in sql


def _rebuild_reports() -> None:
    bind = op.get_bind()
    bind.exec_driver_sql(
        f"""
        CREATE TABLE reports_treehole_new (
          id INTEGER NOT NULL PRIMARY KEY,
          reporter_id INTEGER NOT NULL,
          target_type TEXT NOT NULL CHECK ({REPORT_TARGET_CHECK}),
          target_id INTEGER NOT NULL,
          reason TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          snapshot TEXT NOT NULL DEFAULT '{{}}',
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED','REJECTED')),
          handled_by INTEGER,
          resolution TEXT,
          created_at TEXT NOT NULL,
          handled_at TEXT,
          FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(handled_by) REFERENCES users(id)
        )
        """
    )
    bind.exec_driver_sql(
        """INSERT INTO reports_treehole_new
        (id,reporter_id,target_type,target_id,reason,description,snapshot,status,handled_by,resolution,created_at,handled_at)
        SELECT id,reporter_id,target_type,target_id,reason,description,snapshot,status,handled_by,resolution,created_at,handled_at
        FROM reports"""
    )
    bind.exec_driver_sql("DROP TABLE reports")
    bind.exec_driver_sql("ALTER TABLE reports_treehole_new RENAME TO reports")


def _create_report_indexes() -> None:
    op.create_index("idx_reports_reporter_created", "reports", ["reporter_id", "created_at"], if_not_exists=True)
    op.create_index("idx_reports_target", "reports", ["target_type", "target_id"], if_not_exists=True)
    op.create_index("idx_reports_status_created", "reports", ["status", "created_at"], if_not_exists=True)
    op.create_index(
        "idx_pending_reporter_target",
        "reports",
        ["reporter_id", "target_type", "target_id"],
        unique=True,
        sqlite_where=sa.text("status = 'PENDING'"),
        if_not_exists=True,
    )


def upgrade() -> None:
    tables = _tables()
    if "reports" in tables and not _reports_support_treehole():
        _rebuild_reports()
    _create_report_indexes()

    if "treehole_author_grades" not in tables:
        op.create_table(
            "treehole_author_grades",
            sa.Column("grade_id", sa.Integer(), sa.ForeignKey("grades.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey(USER_ID, ondelete=SET_NULL)),
            sa.Column("created_at", sa.Text(), nullable=False),
        )
    if "treehole_posts" not in tables:
        op.create_table(
            "treehole_posts",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("author_id", sa.Integer(), sa.ForeignKey(USER_ID, ondelete=SET_NULL)),
            sa.Column("management_grade_id", sa.Integer(), sa.ForeignKey("grades.id"), nullable=False),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("visibility", sa.Text(), nullable=False, server_default="PRIVATE"),
            sa.Column("moderation_status", sa.Text(), nullable=False, server_default="NORMAL"),
            sa.Column("moderation_reason", sa.Text(), nullable=False, server_default=""),
            sa.Column("moderated_by", sa.Integer(), sa.ForeignKey(USER_ID, ondelete=SET_NULL)),
            sa.Column("moderated_at", sa.Text()),
            sa.Column("reviewed_at", sa.Text()),
            sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey(USER_ID, ondelete=SET_NULL)),
            sa.Column("published_at", sa.Text()),
            sa.Column("withdrawn_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.CheckConstraint("visibility IN ('PRIVATE','PUBLIC','WITHDRAWN')"),
            sa.CheckConstraint("moderation_status IN ('NORMAL','HIDDEN','DELETED')"),
        )
        op.create_index(
            "idx_treehole_posts_public",
            "treehole_posts",
            ["visibility", "moderation_status", "published_at", "id"],
        )
        op.create_index("idx_treehole_posts_author_updated", "treehole_posts", ["author_id", "updated_at", "id"])
        op.create_index(
            "idx_treehole_posts_management",
            "treehole_posts",
            ["management_grade_id", "visibility", "moderation_status", "created_at", "id"],
        )
    if "treehole_comments" not in tables:
        op.create_table(
            "treehole_comments",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("post_id", sa.Integer(), sa.ForeignKey("treehole_posts.id", ondelete="CASCADE"), nullable=False),
            sa.Column(
                "participant_id",
                sa.Integer(),
                sa.ForeignKey("treehole_participants.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("parent_comment_id", sa.Integer(), sa.ForeignKey("treehole_comments.id", ondelete=SET_NULL)),
            sa.Column(
                "reply_to_participant_id",
                sa.Integer(),
                sa.ForeignKey("treehole_participants.id", ondelete=SET_NULL),
            ),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("is_official", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("moderation_status", sa.Text(), nullable=False, server_default="NORMAL"),
            sa.Column("moderation_reason", sa.Text(), nullable=False, server_default=""),
            sa.Column("moderated_by", sa.Integer(), sa.ForeignKey(USER_ID, ondelete=SET_NULL)),
            sa.Column("moderated_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("deleted_at", sa.Text()),
            sa.CheckConstraint("is_official IN (0,1)"),
            sa.CheckConstraint("moderation_status IN ('NORMAL','HIDDEN','DELETED')"),
        )
        op.create_index("idx_treehole_comments_post_created", "treehole_comments", ["post_id", "created_at", "id"])
    if "treehole_participants" not in tables:
        op.create_table(
            "treehole_participants",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("post_id", sa.Integer(), sa.ForeignKey("treehole_posts.id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey(USER_ID, ondelete=SET_NULL)),
            sa.Column("alias_number", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.UniqueConstraint("post_id", "user_id"),
            sa.UniqueConstraint("post_id", "alias_number"),
            sa.CheckConstraint("alias_number > 0"),
        )


def downgrade() -> None:
    raise RuntimeError("Treehole rollback requires a verified database backup")
