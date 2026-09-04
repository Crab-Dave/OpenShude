from datetime import UTC, date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from .common import (
    active_admin_groups,
    all_rows,
    audit,
    authorize,
    authorized_grade_ids,
    current_user,
    now,
    one,
    require_management,
    require_super_admin,
    require_user,
)
from .config import get_settings
from .database import get_db
from .errors import ApiError
from .markdown import markdown_summary, render_markdown
from .rate_limit import enforce_rate_limit

router = APIRouter(prefix="/api/treehole")
admin_router = APIRouter(prefix="/api/admin/treehole")
DB = Annotated[Session, Depends(get_db)]
POST_NOT_FOUND = "树洞帖子不存在"
COMMENT_NOT_FOUND = "评论不存在"


def prune_treehole_report_snapshots(db: Session) -> int:
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().treehole_report_retention_days)
    result = db.execute(
        text(
            """UPDATE reports SET snapshot='{}' WHERE target_type IN ('TREEHOLE_POST','TREEHOLE_COMMENT')
            AND status IN ('RESOLVED','REJECTED') AND handled_at IS NOT NULL AND handled_at<:cutoff AND snapshot<>'{}'"""
        ),
        {"cutoff": cutoff.isoformat(timespec="milliseconds").replace("+00:00", "Z")},
    )
    return result.rowcount


def validated_text(value: object, minimum: int, maximum: int, field: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if len(result) < minimum:
        raise ApiError(400, "FIELD_REQUIRED", f"{field}至少需要 {minimum} 个字")
    if len(result) > maximum:
        raise ApiError(400, "FIELD_TOO_LONG", f"{field}不能超过 {maximum} 个字")
    return result


def active_student(user: dict) -> None:
    require_user(user)
    if user["status"] != "ACTIVE":
        raise ApiError(403, "ACCOUNT_UNAVAILABLE", "账号当前不可发布内容")


def post_by_id(db: Session, post_id: int) -> dict | None:
    return one(
        db,
        """SELECT p.*,u.name AS author_name,u.grade AS author_grade
        FROM treehole_posts p LEFT JOIN users u ON u.id=p.author_id WHERE p.id=:id""",
        {"id": post_id},
    )


def can_read_post(post: dict, user: dict) -> bool:
    return post["author_id"] == user["id"] or (post["visibility"] == "PUBLIC" and post["moderation_status"] == "NORMAL")


def participant_for_user(db: Session, post_id: int, user_id: int) -> dict:
    timestamp = now()
    db.execute(
        text(
            """INSERT INTO treehole_participants(post_id,user_id,alias_number,created_at)
            SELECT :post,:user,COALESCE(MAX(alias_number),0)+1,:created
            FROM treehole_participants WHERE post_id=:post
            ON CONFLICT(post_id,user_id) DO NOTHING"""
        ),
        {"post": post_id, "user": user_id, "created": timestamp},
    )
    participant = one(
        db,
        "SELECT id,alias_number,user_id FROM treehole_participants WHERE post_id=:post AND user_id=:user",
        {"post": post_id, "user": user_id},
    )
    if not participant:
        raise ApiError(409, "ALIAS_ASSIGNMENT_CONFLICT", "匿名编号分配冲突，请重试")
    return participant


def comments_for_post(db: Session, post_id: int, user_id: int, management: bool = False) -> list[dict]:
    rows = all_rows(
        db,
        """SELECT c.*,participant.alias_number,participant.user_id,
          target.alias_number AS reply_to_alias_number,u.name AS author_name
        FROM treehole_comments c
        JOIN treehole_participants participant ON participant.id=c.participant_id
        LEFT JOIN treehole_participants target ON target.id=c.reply_to_participant_id
        LEFT JOIN users u ON u.id=participant.user_id
        WHERE c.post_id=:post ORDER BY c.created_at,c.id""",
        {"post": post_id},
    )
    comments = []
    for row in rows:
        unavailable = row["moderation_status"] != "NORMAL"
        comment = {
            "id": row["id"],
            "parentCommentId": row["parent_comment_id"],
            "aliasNumber": row["alias_number"],
            "replyToAliasNumber": row["reply_to_alias_number"],
            "content": None if unavailable and not management else row["content"],
            "isOfficial": bool(row["is_official"]),
            "moderationStatus": row["moderation_status"],
            "createdAt": row["created_at"],
            "isOwn": row["user_id"] == user_id,
            "canDelete": row["user_id"] == user_id and not row["is_official"] and row["moderation_status"] == "NORMAL",
        }
        if management:
            comment["authorName"] = row["author_name"] or "已删除账号"
            comment["moderationReason"] = row["moderation_reason"]
        comments.append(comment)
    return comments


def post_payload(db: Session, post: dict, user: dict, management: bool = False) -> dict:
    own = post["author_id"] == user["id"]
    unavailable = post["moderation_status"] != "NORMAL"
    content = None if unavailable and not management else post["content"]
    payload = {
        "id": post["id"],
        "title": None if unavailable and not management else post["title"],
        "content": content,
        "contentHtml": render_markdown(content) if content is not None else None,
        "visibility": post["visibility"],
        "moderationStatus": post["moderation_status"],
        "reviewedAt": post["reviewed_at"],
        "publishedAt": post["published_at"],
        "withdrawnAt": post["withdrawn_at"],
        "createdAt": post["created_at"],
        "updatedAt": post["updated_at"],
        "isOwn": own,
        "canEdit": own
        and post["visibility"] == "PRIVATE"
        and post["moderation_status"] == "NORMAL"
        and not post["reviewed_at"],
        "canPublish": own
        and post["visibility"] == "PRIVATE"
        and post["moderation_status"] == "NORMAL"
        and bool(post["reviewed_at"]),
        "canWithdraw": own and post["visibility"] in ("PRIVATE", "PUBLIC") and post["moderation_status"] == "NORMAL",
        "moderationReason": post["moderation_reason"] if own or management else "",
        "comments": [] if unavailable and not management else comments_for_post(db, post["id"], user["id"], management),
    }
    if management:
        payload["author"] = {
            "name": post["author_name"] or "已删除账号",
            "grade": post["author_grade"] or "-",
        }
        payload["managementGradeId"] = post["management_grade_id"]
    return payload


def parse_cursor(cursor: str) -> tuple[str, int] | None:
    if not cursor:
        return None
    try:
        published_at, post_id = cursor.rsplit("|", 1)
        parsed_id = int(post_id)
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_CURSOR", "分页游标无效") from None
    if not published_at or parsed_id <= 0:
        raise ApiError(400, "INVALID_CURSOR", "分页游标无效")
    return published_at, parsed_id


def scope_sql(grade_ids: list[int] | None, params: dict) -> str:
    if grade_ids is None:
        return "1=1"
    if not grade_ids:
        raise ApiError(403, "PERMISSION_DENIED", "当前账号缺少所需管理权限")
    placeholders = []
    for index, grade_id in enumerate(grade_ids):
        key = f"grade_{index}"
        params[key] = grade_id
        placeholders.append(f":{key}")
    return f"p.management_grade_id IN ({','.join(placeholders)})"


def any_treehole_grant(db: Session, user: dict, grade_id: int) -> dict:
    permissions = ("TREEHOLE_PRIVATE_REPLY", "TREEHOLE_MODERATE")
    if user["account_type"] == "SUPER_ADMIN":
        return {
            "permissionCode": permissions[0],
            "groupId": None,
            "scopeType": "GRADE",
            "scopeValue": str(grade_id),
        }
    groups = active_admin_groups(db, user["id"])
    has_permission = any(permission in group["permissions"] for group in groups for permission in permissions)
    for group in groups:
        permission = next((item for item in permissions if item in group["permissions"]), None)
        if permission and grade_id in group["gradeIds"]:
            return {
                "permissionCode": permission,
                "groupId": group["id"],
                "scopeType": "GRADE",
                "scopeValue": str(grade_id),
            }
    if has_permission:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "资源不存在")
    raise ApiError(403, "PERMISSION_DENIED", "当前账号缺少所需管理权限")


def add_comment(
    db: Session,
    post: dict,
    user: dict,
    content: str,
    parent_comment_id: int | None = None,
    reply_to_participant_id: int | None = None,
    official: bool = False,
) -> int:
    participant = participant_for_user(db, post["id"], user["id"])
    timestamp = now()
    comment_id = db.execute(
        text(
            """INSERT INTO treehole_comments(post_id,participant_id,parent_comment_id,reply_to_participant_id,
              content,is_official,created_at)
            VALUES(:post,:participant,:parent,:reply_to,:content,:official,:created) RETURNING id"""
        ),
        {
            "post": post["id"],
            "participant": participant["id"],
            "parent": parent_comment_id,
            "reply_to": reply_to_participant_id,
            "content": content,
            "official": 1 if official else 0,
            "created": timestamp,
        },
    ).scalar_one()
    db.execute(text("UPDATE treehole_posts SET updated_at=:now WHERE id=:id"), {"now": timestamp, "id": post["id"]})
    return comment_id


def enforce_comment_rate(request: Request, user_id: int) -> None:
    ip_address = request.client.host if request.client else "unknown"
    enforce_rate_limit("treehole-comment-minute-user", str(user_id), 10, 60, "TREEHOLE_COMMENT_RATE_LIMITED")
    enforce_rate_limit("treehole-comment-hour-user", str(user_id), 100, 3600, "TREEHOLE_COMMENT_RATE_LIMITED")
    enforce_rate_limit("treehole-comment-minute-ip", ip_address, 60, 60, "TREEHOLE_COMMENT_RATE_LIMITED")


def enforce_management_rate(request: Request, user_id: int) -> None:
    ip_address = request.client.host if request.client else "unknown"
    enforce_rate_limit("treehole-management-user", str(user_id), 30, 60, "TREEHOLE_MANAGEMENT_RATE_LIMITED")
    enforce_rate_limit("treehole-management-ip", ip_address, 120, 60, "TREEHOLE_MANAGEMENT_RATE_LIMITED")


@router.post("/markdown/preview")
def preview_markdown(request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    ip_address = request.client.host if request.client else "unknown"
    enforce_rate_limit("treehole-preview-user", str(user["id"]), 30, 60, "TREEHOLE_PREVIEW_RATE_LIMITED")
    enforce_rate_limit("treehole-preview-ip", ip_address, 120, 60, "TREEHOLE_PREVIEW_RATE_LIMITED")
    content = validated_text(body.get("content"), 0, 5000, "正文")
    return {"html": render_markdown(content) if content else ""}


@router.get("/posts")
def public_posts(
    request: Request,
    db: DB,
    cursor: str = "",
    limit: Annotated[int, Query(ge=1, le=50)] = 15,
) -> dict:
    user = current_user(request, db)
    parsed_cursor = parse_cursor(cursor)
    params: dict = {"limit": limit + 1}
    cursor_clause = ""
    if parsed_cursor:
        params.update({"cursor_time": parsed_cursor[0], "cursor_id": parsed_cursor[1]})
        cursor_clause = "AND (p.published_at<:cursor_time OR (p.published_at=:cursor_time AND p.id<:cursor_id))"
    rows = all_rows(
        db,
        f"""SELECT p.id,p.title,p.content AS summary,p.published_at,p.updated_at,
          COALESCE(comment_counts.total,0) AS comment_count
        FROM treehole_posts p LEFT JOIN (
          SELECT post_id,COUNT(*) AS total FROM treehole_comments
          WHERE moderation_status='NORMAL' GROUP BY post_id
        ) comment_counts ON comment_counts.post_id=p.id
        WHERE p.visibility='PUBLIC' AND p.moderation_status='NORMAL' {cursor_clause}
        ORDER BY p.published_at DESC,p.id DESC LIMIT :limit""",
        params,
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    for row in rows:
        row["summary"], row["summaryTruncated"] = markdown_summary(row["summary"], 220)
    next_cursor = f"{rows[-1]['published_at']}|{rows[-1]['id']}" if has_more and rows else None
    eligible = bool(
        user["account_type"] == "USER"
        and user["status"] == "ACTIVE"
        and user["grade_id"]
        and one(db, "SELECT 1 AS found FROM treehole_author_grades WHERE grade_id=:id", {"id": user["grade_id"]})
    )
    return {"posts": rows, "nextCursor": next_cursor, "canCreate": eligible}


@router.get("/posts/mine")
def my_posts(request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    rows = all_rows(
        db,
        """SELECT p.id,p.title,p.visibility,p.moderation_status,p.moderation_reason,p.reviewed_at,
          p.published_at,p.withdrawn_at,p.created_at,p.updated_at,
          (SELECT COUNT(*) FROM treehole_comments c WHERE c.post_id=p.id AND c.moderation_status='NORMAL') AS comment_count
        FROM treehole_posts p WHERE p.author_id=:user ORDER BY p.updated_at DESC,p.id DESC""",
        {"user": user["id"]},
    )
    return {"posts": rows}


@router.post("/posts", status_code=201)
def create_post(request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    if not user["grade_id"] or not one(
        db, "SELECT 1 AS found FROM treehole_author_grades WHERE grade_id=:grade", {"grade": user["grade_id"]}
    ):
        raise ApiError(403, "TREEHOLE_AUTHOR_INELIGIBLE", "当前年级不在新生发帖范围内")
    ip_address = request.client.host if request.client else "unknown"
    enforce_rate_limit("treehole-post-user", str(user["id"]), 5, 3600, "TREEHOLE_POST_RATE_LIMITED")
    enforce_rate_limit("treehole-post-ip", ip_address, 30, 3600, "TREEHOLE_POST_RATE_LIMITED")
    title = validated_text(body.get("title"), 2, 80, "标题")
    content = validated_text(body.get("content"), 10, 5000, "正文")
    timestamp = now()
    post_id = db.execute(
        text(
            """INSERT INTO treehole_posts(author_id,management_grade_id,title,content,created_at,updated_at)
            VALUES(:author,:grade,:title,:content,:created,:created) RETURNING id"""
        ),
        {
            "author": user["id"],
            "grade": user["grade_id"],
            "title": title,
            "content": content,
            "created": timestamp,
        },
    ).scalar_one()
    db.execute(
        text(
            """INSERT INTO treehole_participants(post_id,user_id,alias_number,created_at)
            VALUES(:post,:user,1,:created)"""
        ),
        {"post": post_id, "user": user["id"], "created": timestamp},
    )
    db.commit()
    return {"post": post_payload(db, post_by_id(db, post_id), user)}


@router.get("/posts/{post_id}")
def post_detail(post_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    post = post_by_id(db, post_id)
    if not post or not can_read_post(post, user):
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    return {"post": post_payload(db, post, user)}


@router.patch("/posts/{post_id}")
def edit_post(post_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    post = post_by_id(db, post_id)
    if not post or post["author_id"] != user["id"]:
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    if post["visibility"] != "PRIVATE" or post["moderation_status"] != "NORMAL" or post["reviewed_at"]:
        raise ApiError(409, "TREEHOLE_POST_NOT_EDITABLE", "管理员回复后不能再修改原文，请通过评论补充")
    db.execute(
        text("UPDATE treehole_posts SET title=:title,content=:content,updated_at=:now WHERE id=:id"),
        {
            "title": validated_text(body.get("title"), 2, 80, "标题"),
            "content": validated_text(body.get("content"), 10, 5000, "正文"),
            "now": now(),
            "id": post_id,
        },
    )
    db.commit()
    return {"post": post_payload(db, post_by_id(db, post_id), user)}


@router.post("/posts/{post_id}/publish")
def publish_post(post_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    post = post_by_id(db, post_id)
    if not post or post["author_id"] != user["id"]:
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    if post["visibility"] != "PRIVATE" or post["moderation_status"] != "NORMAL" or not post["reviewed_at"]:
        raise ApiError(409, "TREEHOLE_POST_NOT_PUBLISHABLE", "帖子需要先收到管理员正式回复")
    timestamp = now()
    result = db.execute(
        text(
            """UPDATE treehole_posts SET visibility='PUBLIC',published_at=COALESCE(published_at,:now),updated_at=:now
            WHERE id=:id AND visibility='PRIVATE' AND moderation_status='NORMAL' AND reviewed_at IS NOT NULL"""
        ),
        {"now": timestamp, "id": post_id},
    )
    if result.rowcount != 1:
        db.rollback()
        raise ApiError(409, "TREEHOLE_POST_STATE_CHANGED", "帖子状态已变化，请刷新后重试")
    db.commit()
    return {"post": post_payload(db, post_by_id(db, post_id), user)}


@router.post("/posts/{post_id}/withdraw")
def withdraw_post(post_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    post = post_by_id(db, post_id)
    if not post or post["author_id"] != user["id"]:
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    if post["visibility"] not in ("PRIVATE", "PUBLIC") or post["moderation_status"] != "NORMAL":
        raise ApiError(409, "TREEHOLE_POST_NOT_WITHDRAWABLE", "当前帖子不能撤回")
    timestamp = now()
    db.execute(
        text("UPDATE treehole_posts SET visibility='WITHDRAWN',withdrawn_at=:now,updated_at=:now WHERE id=:id"),
        {"now": timestamp, "id": post_id},
    )
    db.commit()
    return {"post": post_payload(db, post_by_id(db, post_id), user)}


@router.post("/posts/{post_id}/comments", status_code=201)
def create_comment(post_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    post = post_by_id(db, post_id)
    if not post or not can_read_post(post, user):
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    if post["moderation_status"] != "NORMAL" or post["visibility"] == "WITHDRAWN":
        raise ApiError(409, "TREEHOLE_COMMENTS_CLOSED", "当前帖子不能继续评论")
    if post["visibility"] == "PRIVATE" and post["author_id"] != user["id"]:
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    enforce_comment_rate(request, user["id"])
    comment_id = add_comment(db, post, user, validated_text(body.get("content"), 1, 2000, "评论"))
    db.commit()
    return {"commentId": comment_id}


@router.post("/comments/{comment_id}/replies", status_code=201)
def create_reply(comment_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    target = one(
        db,
        """SELECT c.*,COALESCE(c.parent_comment_id,c.id) AS root_comment_id
        FROM treehole_comments c WHERE c.id=:id""",
        {"id": comment_id},
    )
    post = post_by_id(db, target["post_id"]) if target else None
    if (
        not target
        or target["moderation_status"] != "NORMAL"
        or not post
        or not can_read_post(post, user)
        or post["moderation_status"] != "NORMAL"
        or post["visibility"] == "WITHDRAWN"
    ):
        raise ApiError(404, "TREEHOLE_COMMENT_NOT_FOUND", COMMENT_NOT_FOUND)
    enforce_comment_rate(request, user["id"])
    reply_id = add_comment(
        db,
        post,
        user,
        validated_text(body.get("content"), 1, 2000, "回复"),
        target["root_comment_id"],
        target["participant_id"],
    )
    db.commit()
    return {"commentId": reply_id}


@router.delete("/comments/{comment_id}")
def delete_own_comment(comment_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    active_student(user)
    comment = one(
        db,
        """SELECT c.*,participant.user_id FROM treehole_comments c
        JOIN treehole_participants participant ON participant.id=c.participant_id WHERE c.id=:id""",
        {"id": comment_id},
    )
    if not comment or comment["user_id"] != user["id"]:
        raise ApiError(404, "TREEHOLE_COMMENT_NOT_FOUND", COMMENT_NOT_FOUND)
    if comment["is_official"]:
        raise ApiError(409, "OFFICIAL_COMMENT_IMMUTABLE", "正式管理员回复只能通过内容治理处理")
    if comment["moderation_status"] != "NORMAL":
        raise ApiError(409, "TREEHOLE_COMMENT_NOT_DELETABLE", "评论已经不可用")
    timestamp = now()
    db.execute(
        text(
            """UPDATE treehole_comments SET content='',moderation_status='DELETED',
            moderation_reason='作者主动删除',deleted_at=:now WHERE id=:id"""
        ),
        {"now": timestamp, "id": comment_id},
    )
    db.execute(
        text("UPDATE treehole_posts SET updated_at=:now WHERE id=:post"),
        {"now": timestamp, "post": comment["post_id"]},
    )
    db.commit()
    return {"ok": True}


def treehole_report_snapshot(db: Session, user: dict, target_type: str, target_id: int) -> dict:
    if target_type == "TREEHOLE_POST":
        post = post_by_id(db, target_id)
        if not post or not can_read_post(post, user) or post["moderation_status"] != "NORMAL":
            raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
        return {"postId": post["id"], "title": post["title"], "content": post["content"]}
    comment = one(
        db,
        """SELECT c.*,participant.alias_number FROM treehole_comments c
        JOIN treehole_participants participant ON participant.id=c.participant_id WHERE c.id=:id""",
        {"id": target_id},
    )
    post = post_by_id(db, comment["post_id"]) if comment else None
    if (
        not comment
        or comment["moderation_status"] != "NORMAL"
        or not post
        or not can_read_post(post, user)
        or post["moderation_status"] != "NORMAL"
    ):
        raise ApiError(404, "TREEHOLE_COMMENT_NOT_FOUND", COMMENT_NOT_FOUND)
    return {
        "postId": post["id"],
        "commentId": comment["id"],
        "aliasNumber": comment["alias_number"],
        "isOfficial": bool(comment["is_official"]),
        "content": comment["content"],
    }


def admin_user(request: Request, db: Session) -> dict:
    user = current_user(request, db)
    require_management(db, user)
    return user


@admin_router.get("/author-grades")
def author_grades(request: Request, db: DB) -> dict:
    admin = admin_user(request, db)
    require_super_admin(admin)
    grades = all_rows(
        db,
        """SELECT g.id,g.code,g.name,g.status,CASE WHEN configured.grade_id IS NULL THEN 0 ELSE 1 END AS selected
        FROM grades g LEFT JOIN treehole_author_grades configured ON configured.grade_id=g.id
        ORDER BY g.id DESC""",
    )
    return {"grades": grades}


@admin_router.put("/author-grades")
def configure_author_grades(request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    supplied = body.get("gradeIds")
    if not isinstance(supplied, list):
        raise ApiError(400, "INVALID_GRADE_SELECTION", "请选择允许发帖的新生年级")
    grade_ids = sorted({int(value) for value in supplied if str(value).isdigit()})
    if len(grade_ids) != len(set(map(str, supplied))):
        raise ApiError(400, "INVALID_GRADE_SELECTION", "年级列表包含无效或重复值")
    if grade_ids:
        placeholders = ",".join(f":grade_{index}" for index in range(len(grade_ids)))
        params = {f"grade_{index}": grade_id for index, grade_id in enumerate(grade_ids)}
        valid = all_rows(db, f"SELECT id FROM grades WHERE status='ACTIVE' AND id IN ({placeholders})", params)
        if sorted(item["id"] for item in valid) != grade_ids:
            raise ApiError(400, "INVALID_GRADE_SELECTION", "只能选择有效年级")
    reason = validated_text(body.get("reason"), 1, 200, "操作原因")
    before = [row["grade_id"] for row in all_rows(db, "SELECT grade_id FROM treehole_author_grades ORDER BY grade_id")]
    db.execute(text("DELETE FROM treehole_author_grades"))
    timestamp = now()
    for grade_id in grade_ids:
        db.execute(
            text(
                """INSERT INTO treehole_author_grades(grade_id,created_by,created_at)
                VALUES(:grade,:admin,:created)"""
            ),
            {"grade": grade_id, "admin": admin["id"], "created": timestamp},
        )
    audit(
        db,
        admin,
        request,
        "CONFIGURE_TREEHOLE_AUTHOR_GRADES",
        "TREEHOLE_CONFIG",
        "AUTHOR_GRADES",
        reason,
        grant=grant,
        before={"gradeIds": before},
        after={"gradeIds": grade_ids},
    )
    db.commit()
    return {"gradeIds": grade_ids}


@admin_router.get("/private-posts")
def private_posts(
    request: Request,
    db: DB,
    status: str = "WAITING",
    grade_id: Annotated[int, Query(ge=0)] = 0,
    before_id: int = 0,
    limit: Annotated[int, Query(ge=1, le=50)] = 30,
) -> dict:
    admin = admin_user(request, db)
    params: dict = {"limit": limit + 1}
    scope = scope_sql(authorized_grade_ids(db, admin, "TREEHOLE_PRIVATE_REPLY"), params)
    status_clause = ""
    if status == "WAITING":
        status_clause = "AND p.reviewed_at IS NULL"
    elif status == "REVIEWED":
        status_clause = "AND p.reviewed_at IS NOT NULL"
    elif status != "ALL":
        raise ApiError(400, "INVALID_TREEHOLE_FILTER", "私密帖子状态筛选无效")
    cursor_clause = "AND p.id<:before_id" if before_id > 0 else ""
    if before_id > 0:
        params["before_id"] = before_id
    grade_clause = ""
    if grade_id:
        grade_clause = "AND p.management_grade_id=:selected_grade"
        params["selected_grade"] = grade_id
    rows = all_rows(
        db,
        f"""SELECT p.id,p.title,p.content,p.reviewed_at,p.created_at,p.updated_at,
          p.management_grade_id,u.name AS author_name,u.grade AS author_grade,
          (SELECT COUNT(*) FROM treehole_comments c WHERE c.post_id=p.id AND c.moderation_status='NORMAL') AS comment_count
        FROM treehole_posts p LEFT JOIN users u ON u.id=p.author_id
        WHERE p.visibility='PRIVATE' AND p.moderation_status='NORMAL' AND {scope}
        {status_clause} {grade_clause} {cursor_clause} ORDER BY p.id DESC LIMIT :limit""",
        params,
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    for row in rows:
        row["summary"], row["summaryTruncated"] = markdown_summary(row["content"], 180)
    return {"posts": rows, "nextBeforeId": rows[-1]["id"] if has_more and rows else None}


def optional_enum_filter(value: str, allowed: tuple[str, ...], column: str, key: str, params: dict) -> str:
    if value == "ALL":
        return ""
    if value not in allowed:
        raise ApiError(400, "INVALID_TREEHOLE_FILTER", "筛选条件无效")
    params[key] = value
    return f"{column}=:{key}"


def content_date_filters(date_from: str, date_to: str, alias: str, params: dict) -> list[str]:
    try:
        start = date.fromisoformat(date_from) if date_from else None
        end = date.fromisoformat(date_to) if date_to else None
    except ValueError:
        raise ApiError(400, "INVALID_TREEHOLE_FILTER", "时间筛选无效") from None
    if start and end and start > end:
        raise ApiError(400, "INVALID_TREEHOLE_FILTER", "开始日期不能晚于结束日期")
    filters = []
    if start:
        filters.append(f"{alias}.created_at>=:date_from")
        params["date_from"] = f"{start.isoformat()}T00:00:00.000Z"
    if end:
        filters.append(f"{alias}.created_at<:date_to")
        params["date_to"] = f"{(end + timedelta(days=1)).isoformat()}T00:00:00.000Z"
    return filters


@admin_router.get("/content")
def managed_content(
    request: Request,
    db: DB,
    visibility: str = "ALL",
    moderation_status: str = "ALL",
    content_type: str = "POST",
    grade_id: Annotated[int, Query(ge=0)] = 0,
    date_from: str = "",
    date_to: str = "",
    before_id: int = 0,
    limit: Annotated[int, Query(ge=1, le=50)] = 30,
) -> dict:
    admin = admin_user(request, db)
    params: dict = {"limit": limit + 1}
    scope = scope_sql(authorized_grade_ids(db, admin, "TREEHOLE_MODERATE"), params)
    if content_type not in ("POST", "COMMENT"):
        raise ApiError(400, "INVALID_TREEHOLE_FILTER", "内容类型筛选无效")
    content_alias = "p" if content_type == "POST" else "c"
    filters = [
        optional_enum_filter(visibility, ("PRIVATE", "PUBLIC", "WITHDRAWN"), "p.visibility", "visibility", params),
        optional_enum_filter(
            moderation_status,
            ("NORMAL", "HIDDEN", "DELETED"),
            f"{content_alias}.moderation_status",
            "moderation_status",
            params,
        ),
    ]
    filters = [item for item in filters if item]
    if grade_id:
        filters.append("p.management_grade_id=:selected_grade")
        params["selected_grade"] = grade_id
    filters.extend(content_date_filters(date_from, date_to, content_alias, params))
    if before_id > 0:
        filters.append(f"{content_alias}.id<:before_id")
        params["before_id"] = before_id
    filter_sql = " AND ".join(filters) if filters else "1=1"
    if content_type == "POST":
        query = f"""SELECT p.id,p.id AS post_id,'POST' AS content_type,p.title,p.content,p.visibility,
          p.moderation_status,p.moderation_reason,p.reviewed_at,p.published_at,p.created_at,p.updated_at,
          p.management_grade_id,u.name AS author_name,u.grade AS author_grade
        FROM treehole_posts p LEFT JOIN users u ON u.id=p.author_id
        WHERE {scope} AND {filter_sql} ORDER BY p.id DESC LIMIT :limit"""
    else:
        query = f"""SELECT c.id,c.post_id,'COMMENT' AS content_type,p.title,c.content,p.visibility,
          c.moderation_status,c.moderation_reason,NULL AS reviewed_at,NULL AS published_at,c.created_at,
          c.created_at AS updated_at,p.management_grade_id,u.name AS author_name,u.grade AS author_grade
        FROM treehole_comments c JOIN treehole_posts p ON p.id=c.post_id
        JOIN treehole_participants participant ON participant.id=c.participant_id
        LEFT JOIN users u ON u.id=participant.user_id
        WHERE {scope} AND {filter_sql} ORDER BY c.id DESC LIMIT :limit"""
    rows = all_rows(db, query, params)
    has_more = len(rows) > limit
    rows = rows[:limit]
    for row in rows:
        if row["content_type"] == "POST":
            row["summary"], row["summaryTruncated"] = markdown_summary(row["content"], 180)
        else:
            summary = " ".join((row["content"] or "").split())
            row["summary"], row["summaryTruncated"] = summary[:180], len(summary) > 180
    return {"posts": rows, "nextBeforeId": rows[-1]["id"] if has_more and rows else None}


@admin_router.get("/posts/{post_id}")
def admin_post_detail(post_id: int, request: Request, db: DB) -> dict:
    admin = admin_user(request, db)
    post = post_by_id(db, post_id)
    if not post:
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    any_treehole_grant(db, admin, post["management_grade_id"])
    return {"post": post_payload(db, post, admin, True)}


@admin_router.post("/posts/{post_id}/comments", status_code=201)
def official_comment(post_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    post = post_by_id(db, post_id)
    if not post:
        raise ApiError(404, "TREEHOLE_POST_NOT_FOUND", POST_NOT_FOUND)
    grant = authorize(db, admin, "TREEHOLE_PRIVATE_REPLY", post["management_grade_id"])
    if post["moderation_status"] != "NORMAL" or post["visibility"] == "WITHDRAWN":
        raise ApiError(409, "TREEHOLE_COMMENTS_CLOSED", "当前帖子不能继续回复")
    enforce_management_rate(request, admin["id"])
    content = validated_text(body.get("content"), 1, 2000, "回复")
    comment_id = add_comment(db, post, admin, content, official=True)
    timestamp = now()
    db.execute(
        text(
            """UPDATE treehole_posts SET reviewed_at=COALESCE(reviewed_at,:now),
            reviewed_by=COALESCE(reviewed_by,:admin),updated_at=:now WHERE id=:id"""
        ),
        {"now": timestamp, "admin": admin["id"], "id": post_id},
    )
    audit(
        db,
        admin,
        request,
        "REPLY_TREEHOLE_POST",
        "TREEHOLE_POST",
        post_id,
        grant=grant,
        metadata={"commentId": comment_id, "contentLength": len(content)},
    )
    db.commit()
    return {"commentId": comment_id}


def moderate_comment(
    db: Session,
    comment: dict,
    post: dict,
    action: str,
    reason: str,
    admin_id: int,
    timestamp: str,
) -> tuple[dict, dict]:
    if action == "restore-withdrawn":
        raise ApiError(400, "INVALID_MODERATION_ACTION", "评论不支持该操作")
    if action in ("hide", "restore") and post["moderation_status"] != "NORMAL":
        raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "请先恢复帖子再治理评论")
    current = comment["moderation_status"]
    if action == "hide" and current != "NORMAL":
        raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "只有正常评论可以隐藏")
    if action == "restore" and current != "HIDDEN":
        raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "只有隐藏评论可以恢复")
    if action == "delete" and current == "DELETED":
        raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "评论已经删除")
    status = {"hide": "HIDDEN", "restore": "NORMAL", "delete": "DELETED"}[action]
    db.execute(
        text(
            """UPDATE treehole_comments SET moderation_status=:status,
            moderation_reason=:reason,moderated_by=:admin,moderated_at=:now,
            content=CASE WHEN :status='DELETED' THEN '' ELSE content END,
            deleted_at=CASE WHEN :status='DELETED' THEN :now ELSE deleted_at END WHERE id=:id"""
        ),
        {
            "status": status,
            "reason": "" if action == "restore" else reason,
            "admin": admin_id,
            "now": timestamp,
            "id": comment["id"],
        },
    )
    return {"moderationStatus": current}, {"moderationStatus": status}


def moderate_post(
    db: Session,
    post: dict,
    action: str,
    reason: str,
    admin_id: int,
    timestamp: str,
) -> tuple[dict, dict]:
    current = post["moderation_status"]
    if action == "restore-withdrawn":
        if post["visibility"] != "WITHDRAWN" or current != "NORMAL":
            raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "只有正常的已撤回帖子可以恢复")
        db.execute(
            text("UPDATE treehole_posts SET visibility='PRIVATE',withdrawn_at=NULL,updated_at=:now WHERE id=:id"),
            {"now": timestamp, "id": post["id"]},
        )
        return (
            {"visibility": "WITHDRAWN", "moderationStatus": current},
            {"visibility": "PRIVATE", "moderationStatus": current},
        )
    if action == "hide" and current != "NORMAL":
        raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "只有正常帖子可以隐藏")
    if action == "restore" and current != "HIDDEN":
        raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "只有隐藏帖子可以恢复")
    if action == "delete" and current == "DELETED":
        raise ApiError(409, "TREEHOLE_CONTENT_STATE_CONFLICT", "帖子已经删除")
    status = {"hide": "HIDDEN", "restore": "NORMAL", "delete": "DELETED"}[action]
    db.execute(
        text(
            """UPDATE treehole_posts SET moderation_status=:status,
            moderation_reason=:reason,moderated_by=:admin,moderated_at=:now,
            title=CASE WHEN :status='DELETED' THEN '[已删除]' ELSE title END,
            content=CASE WHEN :status='DELETED' THEN '' ELSE content END,updated_at=:now WHERE id=:id"""
        ),
        {
            "status": status,
            "reason": "" if action == "restore" else reason,
            "admin": admin_id,
            "now": timestamp,
            "id": post["id"],
        },
    )
    if status == "DELETED":
        db.execute(
            text(
                """UPDATE treehole_comments SET content='',moderation_status='DELETED',
                moderation_reason=:reason,moderated_by=:admin,moderated_at=:now,deleted_at=:now
                WHERE post_id=:post"""
            ),
            {"reason": reason, "admin": admin_id, "now": timestamp, "post": post["id"]},
        )
    return (
        {"visibility": post["visibility"], "moderationStatus": current},
        {"visibility": post["visibility"], "moderationStatus": status},
    )


@admin_router.post("/{target_type}/{target_id}/moderation")
def moderate_treehole(target_type: str, target_id: int, request: Request, body: dict, db: DB) -> dict:
    if target_type not in ("posts", "comments"):
        raise ApiError(404, "NOT_FOUND", "接口不存在")
    admin = admin_user(request, db)
    comment = None
    if target_type == "posts":
        post = post_by_id(db, target_id)
    else:
        comment = one(db, "SELECT * FROM treehole_comments WHERE id=:id", {"id": target_id})
        post = post_by_id(db, comment["post_id"]) if comment else None
    if not post or (target_type == "comments" and not comment):
        raise ApiError(404, "TREEHOLE_CONTENT_NOT_FOUND", "树洞内容不存在")
    grant = authorize(db, admin, "TREEHOLE_MODERATE", post["management_grade_id"])
    action = body.get("action")
    if action not in ("hide", "restore", "delete", "restore-withdrawn"):
        raise ApiError(400, "INVALID_MODERATION_ACTION", "治理操作无效")
    enforce_management_rate(request, admin["id"])
    reason = validated_text(body.get("reason"), 1, 200, "操作原因")
    timestamp = now()
    if target_type == "comments":
        before, after = moderate_comment(db, comment, post, action, reason, admin["id"], timestamp)
        audit_target = "TREEHOLE_COMMENT"
    else:
        before, after = moderate_post(db, post, action, reason, admin["id"], timestamp)
        audit_target = "TREEHOLE_POST"
    audit(
        db,
        admin,
        request,
        f"{action.upper().replace('-', '_')}_TREEHOLE_{'POST' if target_type == 'posts' else 'COMMENT'}",
        audit_target,
        target_id,
        reason,
        grant=grant,
        before=before,
        after=after,
    )
    db.commit()
    return {"ok": True}
