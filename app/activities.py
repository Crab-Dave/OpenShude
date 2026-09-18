from datetime import UTC, date, datetime, time, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from .common import active_admin_groups, all_rows, audit, clean_text, current_user, now, one, require_super_admin
from .database import get_db
from .dormitories import begin_immediate
from .errors import ApiError
from .markdown import markdown_summary, render_markdown
from .rate_limit import enforce_rate_limit
from .selection_groups import admin_selectable_groups, selectable_groups

router = APIRouter(prefix="/api/activities")
DB = Annotated[Session, Depends(get_db)]
SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")
ACTIVITY_NOT_FOUND = "活动不存在或暂不可访问"
UTC_OFFSET = "+00:00"
ACTIVITY_SELECT = """SELECT a.*,
  (SELECT COUNT(*) FROM activity_registrations r WHERE r.activity_id=a.id AND r.status='REGISTERED')
    AS registration_count,
  (SELECT status FROM activity_registrations r WHERE r.activity_id=a.id AND r.user_id=:viewer)
    AS current_registration_status
  FROM activities a"""


def request_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    if request.client and request.client.host not in ("127.0.0.1", "::1"):
        return request.client.host
    return forwarded or "local"


def enforce_activity_limit(request: Request, user_id: int, operation: str, limit: int) -> None:
    enforce_rate_limit(f"activity-{operation}-user", str(user_id), limit, 60, "ACTIVITY_RATE_LIMITED")
    enforce_rate_limit(f"activity-{operation}-ip", request_ip(request), limit * 5, 60, "ACTIVITY_RATE_LIMITED")


def require_active_account(user: dict) -> None:
    if user["status"] != "ACTIVE":
        raise ApiError(403, "ACCOUNT_UNAVAILABLE", "账号当前不可用")


def require_activity_version(body: dict, activity: dict) -> None:
    if type(body.get("version")) is not int or body["version"] != activity["version"]:
        raise ApiError(409, "ACTIVITY_EDIT_CONFLICT", "活动已被其他人修改，请重新加载")


def parse_timestamp(value: object) -> str:
    if not isinstance(value, str):
        raise ApiError(400, "INVALID_ACTIVITY_TIME", "活动时间无效")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", UTC_OFFSET))
    except ValueError as error:
        raise ApiError(400, "INVALID_ACTIVITY_TIME", "活动时间无效") from error
    if parsed.tzinfo is None:
        raise ApiError(400, "INVALID_ACTIVITY_TIME", "活动时间必须包含时区")
    return parsed.astimezone(UTC).isoformat(timespec="milliseconds").replace(UTC_OFFSET, "Z")


def parse_stored_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", UTC_OFFSET))


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ApiError(400, "INVALID_ACTIVITY_DATE", "日期格式无效") from error


def integer_ids(value: object) -> list[int]:
    return sorted({int(item) for item in value if str(item).isdigit()}) if isinstance(value, list) else []


def activity_row(db: Session, activity_id: int, viewer_id: int) -> dict | None:
    return one(db, ACTIVITY_SELECT + " WHERE a.id=:id", {"id": activity_id, "viewer": viewer_id})


def target_member_exists(db: Session, activity_id: int, user_id: int) -> bool:
    return (
        one(
            db,
            "SELECT 1 AS found FROM activity_target_members WHERE activity_id=:activity AND user_id=:user",
            {"activity": activity_id, "user": user_id},
        )
        is not None
    )


def activity_grade_ids(db: Session, activity_id: int) -> list[int]:
    return [
        row["grade_id"]
        for row in all_rows(
            db,
            "SELECT grade_id FROM activity_target_grades WHERE activity_id=:id ORDER BY grade_id",
            {"id": activity_id},
        )
    ]


def activity_group_rows(db: Session, activity_id: int) -> list[dict]:
    return all_rows(
        db,
        """SELECT id,source_group_id,group_name_snapshot FROM activity_target_groups
        WHERE activity_id=:id ORDER BY id""",
        {"id": activity_id},
    )


def activity_scope_grade_ids(db: Session, activity: dict) -> list[int]:
    return [
        row["grade_id"]
        for row in all_rows(
            db,
            "SELECT grade_id FROM activity_scope_grades WHERE activity_id=:id ORDER BY grade_id",
            {"id": activity["id"]},
        )
    ]


def group_covers(group: dict, permission: str, grade_ids: list[int]) -> bool:
    return permission in group["permissions"] and all(grade_id in group["gradeIds"] for grade_id in grade_ids)


def official_group_grant(
    db: Session,
    user: dict,
    group_id: int,
    grade_ids: list[int],
    importance: int,
) -> dict:
    organizer = one(db, "SELECT * FROM admin_groups WHERE id=:id AND status='ACTIVE'", {"id": group_id})
    if not organizer:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "资源不存在")
    if user["account_type"] == "SUPER_ADMIN":
        return {
            "permissionCode": "ACTIVITY_PUBLISH",
            "groupId": group_id,
            "scopeType": "GRADE",
            "scopeValue": ",".join(map(str, grade_ids)),
        }
    group = next((item for item in active_admin_groups(db, user["id"]) if item["id"] == group_id), None)
    if not group or not group_covers(group, "ACTIVITY_PUBLISH", grade_ids):
        raise ApiError(404, "RESOURCE_NOT_FOUND", "资源不存在")
    if importance > 3 and not group_covers(group, "ACTIVITY_IMPORTANCE_SET", grade_ids):
        raise ApiError(403, "ACTIVITY_IMPORTANCE_FORBIDDEN", "当前管理员组不能设置该重要程度")
    return {
        "permissionCode": "ACTIVITY_PUBLISH",
        "groupId": group_id,
        "scopeType": "GRADE",
        "scopeValue": ",".join(map(str, grade_ids)),
    }


def activity_manager_grant(
    db: Session, user: dict, activity: dict, permission: str = "ACTIVITY_PUBLISH"
) -> dict | None:
    if activity["organizer_type"] == "USER":
        if activity["created_by"] == user["id"]:
            return {"permissionCode": "SELF", "groupId": None, "scopeType": "", "scopeValue": ""}
        return None
    grade_ids = activity_scope_grade_ids(db, activity)
    if user["account_type"] == "SUPER_ADMIN":
        return {
            "permissionCode": permission,
            "groupId": activity["organizer_group_id"],
            "scopeType": "GRADE",
            "scopeValue": ",".join(map(str, grade_ids)),
        }
    group = next(
        (item for item in active_admin_groups(db, user["id"]) if item["id"] == activity["organizer_group_id"]),
        None,
    )
    if not group or not group_covers(group, permission, grade_ids):
        return None
    return {
        "permissionCode": permission,
        "groupId": group["id"],
        "scopeType": "GRADE",
        "scopeValue": ",".join(map(str, grade_ids)),
    }


def can_read_activity(db: Session, user: dict, activity: dict) -> bool:
    if activity["created_by"] == user["id"]:
        return True
    if activity["status"] != "DRAFT" and target_member_exists(db, activity["id"], user["id"]):
        return True
    if user["account_type"] == "SUPER_ADMIN":
        return True
    if activity["organizer_type"] != "ADMIN_GROUP":
        return False
    return (
        activity_manager_grant(db, user, activity, "ACTIVITY_READ") is not None
        or activity_manager_grant(db, user, activity) is not None
    )


def visible_activity(db: Session, user: dict, activity_id: int) -> dict:
    activity = activity_row(db, activity_id, user["id"])
    if not activity or not can_read_activity(db, user, activity):
        raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
    return activity


def validate_core_fields(body: dict) -> dict:
    title = clean_text(body.get("title"), 80, True)
    description = clean_text(body.get("descriptionMarkdown"), 5000)
    start_at = parse_timestamp(body.get("startAt"))
    end_at = parse_timestamp(body.get("endAt"))
    start = parse_stored_timestamp(start_at)
    end = parse_stored_timestamp(end_at)
    if end <= start:
        raise ApiError(400, "INVALID_ACTIVITY_TIME", "结束时间必须晚于开始时间")
    if end - start > timedelta(days=14):
        raise ApiError(400, "ACTIVITY_DURATION_TOO_LONG", "活动最长持续 14 天")
    if type(body.get("isAllDay", False)) is not bool:
        raise ApiError(400, "INVALID_ACTIVITY_ALL_DAY", "全天活动设置无效")
    capacity = body.get("capacity")
    importance = body.get("importance")
    if type(capacity) is not int or not 1 <= capacity <= 500:
        raise ApiError(400, "INVALID_ACTIVITY_CAPACITY", "活动容量必须为 1 至 500")
    if type(importance) is not int or not 1 <= importance <= 5:
        raise ApiError(400, "INVALID_ACTIVITY_IMPORTANCE", "活动重要程度无效")
    summary, _ = markdown_summary(description, 180)
    return {
        "title": title,
        "description_markdown": description,
        "description_html": render_markdown(description),
        "description_summary": summary,
        "start_at": start_at,
        "end_at": end_at,
        "is_all_day": int(body.get("isAllDay", False)),
        "location": clean_text(body.get("location"), 120, True),
        "capacity": capacity,
        "importance": importance,
    }


def validate_targets(db: Session, user: dict, body: dict, personal: bool) -> tuple[list[int], list[dict], list[int]]:
    grade_ids = integer_ids(body.get("targetGradeIds"))
    group_ids = integer_ids(body.get("targetGroupIds"))
    if not grade_ids and not group_ids:
        raise ApiError(400, "ACTIVITY_TARGET_REQUIRED", "请至少选择一个目标年级或群组")
    grades = all_rows(
        db,
        "SELECT id FROM grades WHERE status='ACTIVE' ORDER BY id",
    )
    if any(grade_id not in {grade["id"] for grade in grades} for grade_id in grade_ids):
        raise ApiError(400, "INVALID_ACTIVITY_TARGET", "目标年级无效")
    if personal and any(grade_id != user["grade_id"] for grade_id in grade_ids):
        raise ApiError(403, "ACTIVITY_TARGET_FORBIDDEN", "个人活动只能选择自己的年级")
    allowed_groups = (
        admin_selectable_groups(db, user["id"])
        if user["account_type"] == "SUPER_ADMIN"
        else selectable_groups(db, user["id"])
    )
    groups_by_id = {group["id"]: group for group in allowed_groups}
    if any(group_id not in groups_by_id for group_id in group_ids):
        raise ApiError(400, "INVALID_ACTIVITY_TARGET", "目标群组无效")
    selected_groups = [groups_by_id[group_id] for group_id in group_ids]
    audience_grade_ids = set(grade_ids)
    for group in selected_groups:
        members = all_rows(
            db,
            """SELECT u.id,u.grade_id,u.status FROM student_selection_group_members member
            JOIN users u ON u.id=member.user_id WHERE member.group_id=:group""",
            {"group": group["id"]},
        )
        if not members or any(
            member["status"] not in ("ACTIVE", "PENDING_ACTIVATION") or member["grade_id"] is None for member in members
        ):
            raise ApiError(400, "INVALID_ACTIVITY_TARGET", "目标群组包含不可用账号")
        audience_grade_ids.update(member["grade_id"] for member in members)
    return grade_ids, selected_groups, sorted(audience_grade_ids)


def write_scope_grades(db: Session, activity_id: int, grade_ids: list[int]) -> None:
    db.execute(text("DELETE FROM activity_scope_grades WHERE activity_id=:id"), {"id": activity_id})
    for grade_id in grade_ids:
        db.execute(
            text("INSERT INTO activity_scope_grades(activity_id,grade_id) VALUES(:activity,:grade)"),
            {"activity": activity_id, "grade": grade_id},
        )


def write_targets(
    db: Session,
    activity_id: int,
    grade_ids: list[int],
    groups: list[dict],
    scope_grade_ids: list[int],
) -> None:
    db.execute(text("DELETE FROM activity_target_grades WHERE activity_id=:id"), {"id": activity_id})
    db.execute(text("DELETE FROM activity_target_groups WHERE activity_id=:id"), {"id": activity_id})
    for grade_id in grade_ids:
        db.execute(
            text("INSERT INTO activity_target_grades(activity_id,grade_id) VALUES(:activity,:grade)"),
            {"activity": activity_id, "grade": grade_id},
        )
    for group in groups:
        db.execute(
            text(
                """INSERT INTO activity_target_groups(activity_id,source_group_id,group_name_snapshot)
                VALUES(:activity,:group,:name)"""
            ),
            {"activity": activity_id, "group": group["id"], "name": group["name"]},
        )
    write_scope_grades(db, activity_id, scope_grade_ids)


def expand_target_members(db: Session, user: dict, activity: dict) -> int:
    grade_ids = activity_grade_ids(db, activity["id"])
    target_groups = activity_group_rows(db, activity["id"])
    if any(group["source_group_id"] is None for group in target_groups):
        raise ApiError(400, "INVALID_ACTIVITY_TARGET", "目标群组已被删除")
    group_ids = [group["source_group_id"] for group in target_groups]
    allowed_group_ids = {
        group["id"]
        for group in (
            admin_selectable_groups(db, user["id"])
            if user["account_type"] == "SUPER_ADMIN"
            else selectable_groups(db, user["id"])
        )
    }
    if any(group_id not in allowed_group_ids for group_id in group_ids):
        raise ApiError(400, "INVALID_ACTIVITY_TARGET", "目标群组不可用")
    members: dict[int, dict] = {}
    for group_id in group_ids:
        rows = all_rows(
            db,
            """SELECT u.id,u.name,u.grade,u.grade_id,u.status FROM student_selection_group_members member
            JOIN users u ON u.id=member.user_id WHERE member.group_id=:group""",
            {"group": group_id},
        )
        if not rows or any(
            row["status"] not in ("ACTIVE", "PENDING_ACTIVATION") or row["grade_id"] is None for row in rows
        ):
            raise ApiError(400, "INVALID_ACTIVITY_TARGET", "目标群组包含不可用账号")
        members.update({row["id"]: row for row in rows})
    if grade_ids:
        placeholders = ",".join(f":grade{index}" for index in range(len(grade_ids)))
        params = {f"grade{index}": grade_id for index, grade_id in enumerate(grade_ids)}
        rows = all_rows(
            db,
            f"""SELECT id,name,grade,grade_id,status FROM users WHERE account_type='USER' AND status='ACTIVE'
            AND grade_id IN ({placeholders})""",
            params,
        )
        members.update({row["id"]: row for row in rows})
    if not members:
        raise ApiError(400, "ACTIVITY_TARGET_EMPTY", "目标人群中没有可用账号")
    db.execute(text("DELETE FROM activity_target_members WHERE activity_id=:id"), {"id": activity["id"]})
    for member in members.values():
        db.execute(
            text(
                """INSERT INTO activity_target_members
                (activity_id,user_id,participant_name_snapshot,grade_snapshot)
                VALUES(:activity,:user,:name,:grade)"""
            ),
            {
                "activity": activity["id"],
                "user": member["id"],
                "name": member["name"],
                "grade": member["grade"],
            },
        )
    write_scope_grades(
        db,
        activity["id"],
        sorted(set(grade_ids) | {member["grade_id"] for member in members.values()}),
    )
    return len(members)


def activity_summary(activity: dict) -> dict:
    return {
        "id": activity["id"],
        "title": activity["title"],
        "descriptionSummary": activity["description_summary"],
        "startAt": activity["start_at"],
        "endAt": activity["end_at"],
        "isAllDay": bool(activity["is_all_day"]),
        "location": activity["location"],
        "organizerType": activity["organizer_type"],
        "organizerName": activity["organizer_name_snapshot"],
        "capacity": activity["capacity"],
        "registrationCount": activity["registration_count"],
        "importance": activity["importance"],
        "status": activity["status"],
        "registered": activity["current_registration_status"] == "REGISTERED",
        "owner": activity["created_by"] == activity.get("viewer_id"),
    }


def activity_detail(db: Session, user: dict, activity: dict) -> dict:
    result = activity_summary({**activity, "viewer_id": user["id"]})
    result.update(
        {
            "descriptionMarkdown": activity["description_markdown"],
            "descriptionHtml": activity["description_html"],
            "organizerGroupId": activity["organizer_group_id"],
            "version": activity["version"],
            "cancelReason": activity["cancel_reason"],
            "createdAt": activity["created_at"],
            "updatedAt": activity["updated_at"],
            "publishedAt": activity["published_at"],
            "cancelledAt": activity["cancelled_at"],
            "targetGradeIds": activity_grade_ids(db, activity["id"]),
            "targetGroups": activity_group_rows(db, activity["id"]),
        }
    )
    manager = activity_manager_grant(db, user, activity)
    targeted = target_member_exists(db, activity["id"], user["id"])
    started = activity["start_at"] <= now()
    result["capabilities"] = {
        "canEdit": manager is not None and activity["status"] != "CANCELLED",
        "canCancel": manager is not None and activity["status"] != "CANCELLED",
        "canPublish": manager is not None and activity["status"] == "DRAFT",
        "canRegister": bool(
            user["account_type"] == "USER"
            and user["status"] == "ACTIVE"
            and targeted
            and activity["status"] == "PUBLISHED"
            and not started
            and activity["current_registration_status"] != "REGISTERED"
            and activity["registration_count"] < activity["capacity"]
        ),
    }
    return result


def activity_matches_filters(
    activity: dict,
    user: dict,
    filters: dict,
    keyword: str,
    location: str,
) -> bool:
    searchable = " ".join(
        (
            activity["title"],
            activity["description_summary"],
            activity["location"],
            activity["organizer_name_snapshot"],
        )
    ).casefold()
    if keyword and keyword not in searchable:
        return False
    if location and location not in activity["location"].casefold():
        return False
    if filters["activity_type"] == "official" and activity["organizer_type"] != "ADMIN_GROUP":
        return False
    if filters["activity_type"] == "personal" and activity["organizer_type"] != "USER":
        return False
    if filters["importances"] and activity["importance"] not in filters["importances"]:
        return False
    if filters["registration"] == "joined" and activity["current_registration_status"] != "REGISTERED":
        return False
    if filters["registration"] == "mine" and activity["created_by"] != user["id"]:
        return False
    return not (filters["registration"] == "available" and activity["registration_count"] >= activity["capacity"])


def filtered_activities(activities: list[dict], user: dict, filters: dict) -> list[dict]:
    keyword = filters["keyword"].casefold()
    location = filters["location"].casefold()
    return [activity for activity in activities if activity_matches_filters(activity, user, filters, keyword, location)]


def query_filters(keyword: str, activity_type: str, importance: str, registration: str, location: str) -> dict:
    keyword = clean_text(keyword, 80)
    location = clean_text(location, 120)
    if activity_type not in ("all", "official", "personal"):
        raise ApiError(400, "INVALID_ACTIVITY_FILTER", "活动类型筛选无效")
    if registration not in ("all", "joined", "mine", "available"):
        raise ApiError(400, "INVALID_ACTIVITY_FILTER", "报名状态筛选无效")
    importances = {int(value) for value in importance.split(",") if value.isdigit() and 1 <= int(value) <= 5}
    return {
        "keyword": keyword,
        "location": location,
        "activity_type": activity_type,
        "registration": registration,
        "importances": importances,
    }


def calendar_range(view: str, selected: date) -> tuple[datetime, datetime]:
    if view == "year":
        start = datetime(selected.year, 1, 1, tzinfo=SHANGHAI)
        end = datetime(selected.year + 1, 1, 1, tzinfo=SHANGHAI)
    elif view == "month":
        first = date(selected.year, selected.month, 1)
        start_date = first - timedelta(days=first.weekday())
        start = datetime.combine(start_date, time.min, SHANGHAI)
        end = start + timedelta(days=42)
    elif view == "week":
        start_date = selected - timedelta(days=selected.weekday())
        start = datetime.combine(start_date, time.min, SHANGHAI)
        end = start + timedelta(days=7)
    elif view == "day":
        start = datetime.combine(selected, time.min, SHANGHAI)
        end = start + timedelta(days=1)
    else:
        raise ApiError(400, "INVALID_ACTIVITY_VIEW", "日历视图无效")
    return start, end


def range_activities(db: Session, user: dict, start: datetime, end: datetime, filters: dict) -> list[dict]:
    visibility_sql = "1=1"
    if user["account_type"] != "SUPER_ADMIN":
        visibility_sql = """a.created_by=:viewer
        OR EXISTS (SELECT 1 FROM activity_target_members target
          WHERE target.activity_id=a.id AND target.user_id=:viewer)
        OR (a.organizer_type='ADMIN_GROUP' AND EXISTS (
          SELECT 1 FROM admin_group_members manager
          JOIN admin_groups admin_group ON admin_group.id=manager.group_id AND admin_group.status='ACTIVE'
          WHERE manager.user_id=:viewer AND manager.group_id=a.organizer_group_id
          AND EXISTS (SELECT 1 FROM admin_group_permissions permission
            WHERE permission.group_id=manager.group_id
            AND permission.permission_code IN ('ACTIVITY_READ','ACTIVITY_PUBLISH'))
          AND EXISTS (SELECT 1 FROM activity_scope_grades scope WHERE scope.activity_id=a.id)
          AND NOT EXISTS (
            SELECT 1 FROM activity_scope_grades target_scope WHERE target_scope.activity_id=a.id
            AND NOT EXISTS (SELECT 1 FROM admin_group_scopes manager_scope
              WHERE manager_scope.group_id=manager.group_id AND manager_scope.scope_type='GRADE'
              AND CAST(manager_scope.scope_value AS INTEGER)=target_scope.grade_id)
          )
        ))"""
    params = {
        "viewer": user["id"],
        "start": start.astimezone(UTC).isoformat(timespec="milliseconds").replace(UTC_OFFSET, "Z"),
        "end": end.astimezone(UTC).isoformat(timespec="milliseconds").replace(UTC_OFFSET, "Z"),
    }
    rows = all_rows(
        db,
        ACTIVITY_SELECT
        + f""" WHERE a.status='PUBLISHED' AND a.start_at<:end AND a.end_at>:start
        AND ({visibility_sql})
        ORDER BY a.is_all_day DESC,a.start_at,a.importance DESC,a.id DESC""",
        params,
    )
    return filtered_activities(rows, user, filters)


@router.post("/markdown/preview")
def activity_markdown_preview(request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    enforce_activity_limit(request, user["id"], "preview", 30)
    content = clean_text(body.get("content"), 5000)
    summary, truncated = markdown_summary(content, 180)
    return {"html": render_markdown(content), "summary": summary, "truncated": truncated}


@router.get("/calendar")
def activity_calendar(
    request: Request,
    db: DB,
    view: str = "month",
    date_value: Annotated[str, Query(alias="date")] = "",
    keyword: str = "",
    activity_type: Annotated[str, Query(alias="type")] = "all",
    importance: str = "",
    registration: str = "all",
    location: str = "",
) -> dict:
    user = current_user(request, db)
    enforce_activity_limit(request, user["id"], "read", 120)
    selected = parse_date(date_value) if date_value else datetime.now(SHANGHAI).date()
    start, end = calendar_range(view, selected)
    filters = query_filters(keyword, activity_type, importance, registration, location)
    activities = range_activities(db, user, start, end, filters)
    days = []
    current = start.date()
    while current < end.date():
        day_start = datetime.combine(current, time.min, SHANGHAI)
        day_end = day_start + timedelta(days=1)
        overlapping = [
            activity
            for activity in activities
            if parse_stored_timestamp(activity["start_at"]) < day_end.astimezone(UTC)
            and parse_stored_timestamp(activity["end_at"]) > day_start.astimezone(UTC)
        ]
        days.append(
            {
                "date": current.isoformat(),
                "count": len(overlapping),
                "score": sum(activity["importance"] for activity in overlapping),
                "activities": [activity_summary({**activity, "viewer_id": user["id"]}) for activity in overlapping[:3]],
            }
        )
        current += timedelta(days=1)
    return {
        "view": view,
        "date": selected.isoformat(),
        "rangeStart": start.date().isoformat(),
        "rangeEnd": (end.date() - timedelta(days=1)).isoformat(),
        "days": days,
        "activities": [activity_summary({**activity, "viewer_id": user["id"]}) for activity in activities]
        if view in ("week", "day")
        else [],
    }


@router.get("/day")
def activity_day(
    request: Request,
    db: DB,
    date_value: Annotated[str, Query(alias="date")],
    cursor: int = 0,
    keyword: str = "",
    activity_type: Annotated[str, Query(alias="type")] = "all",
    importance: str = "",
    registration: str = "all",
    location: str = "",
) -> dict:
    user = current_user(request, db)
    enforce_activity_limit(request, user["id"], "read", 120)
    selected = parse_date(date_value)
    start, end = calendar_range("day", selected)
    activities = range_activities(
        db,
        user,
        start,
        end,
        query_filters(keyword, activity_type, importance, registration, location),
    )
    offset = max(0, cursor)
    page = activities[offset : offset + 20]
    next_cursor = offset + 20 if offset + 20 < len(activities) else None
    return {
        "date": selected.isoformat(),
        "activities": [activity_summary({**activity, "viewer_id": user["id"]}) for activity in page],
        "nextCursor": next_cursor,
        "total": len(activities),
    }


@router.post("", status_code=201)
def create_activity(request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_active_account(user)
    enforce_activity_limit(request, user["id"], "write", 20)
    values = validate_core_fields(body)
    organizer_group_id = body.get("organizerGroupId")
    official = type(organizer_group_id) is int
    if not official and user["account_type"] != "USER":
        raise ApiError(403, "ACTIVITY_ORGANIZER_FORBIDDEN", "请选择有效的官方主办方")
    if not official and values["importance"] > 3:
        raise ApiError(403, "ACTIVITY_IMPORTANCE_FORBIDDEN", "个人活动最高可设为 III 级")
    grade_ids, groups, scope_grade_ids = validate_targets(db, user, body, not official)
    if official:
        grant = official_group_grant(db, user, organizer_group_id, scope_grade_ids, values["importance"])
        organizer = one(db, "SELECT name FROM admin_groups WHERE id=:id", {"id": organizer_group_id})
        organizer_name = organizer["name"]
        organizer_type = "ADMIN_GROUP"
        organizer_user_id = None
    else:
        grant = {"permissionCode": "SELF", "groupId": None, "scopeType": "", "scopeValue": ""}
        organizer_name = user["name"]
        organizer_type = "USER"
        organizer_user_id = user["id"]
        organizer_group_id = None
    timestamp = now()
    result = db.execute(
        text(
            """INSERT INTO activities(title,description_markdown,description_html,description_summary,start_at,end_at,
            is_all_day,location,organizer_type,organizer_user_id,organizer_group_id,organizer_name_snapshot,capacity,
            importance,status,version,created_by,created_at,updated_at)
            VALUES(:title,:description_markdown,:description_html,:description_summary,:start_at,:end_at,:is_all_day,
            :location,:organizer_type,:organizer_user_id,:organizer_group_id,:organizer_name_snapshot,:capacity,
            :importance,'DRAFT',1,:created_by,:now,:now)"""
        ),
        {
            **values,
            "organizer_type": organizer_type,
            "organizer_user_id": organizer_user_id,
            "organizer_group_id": organizer_group_id,
            "organizer_name_snapshot": organizer_name,
            "created_by": user["id"],
            "now": timestamp,
        },
    )
    write_targets(db, result.lastrowid, grade_ids, groups, scope_grade_ids)
    audit(
        db,
        user,
        request,
        "CREATE_ACTIVITY",
        "ACTIVITY",
        result.lastrowid,
        metadata={"targetGradeIds": grade_ids, "targetGroupIds": [group["id"] for group in groups]},
        grant=grant,
        after={"title": values["title"], "status": "DRAFT"},
    )
    db.commit()
    created = activity_row(db, result.lastrowid, user["id"])
    return {"activity": activity_detail(db, user, created)}


@router.get("/{activity_id}")
def get_activity(activity_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    enforce_activity_limit(request, user["id"], "read", 120)
    return {"activity": activity_detail(db, user, visible_activity(db, user, activity_id))}


@router.get("/{activity_id}/participants")
def activity_participants(activity_id: int, request: Request, db: DB, cursor: int = 0) -> dict:
    user = current_user(request, db)
    enforce_activity_limit(request, user["id"], "read", 120)
    visible_activity(db, user, activity_id)
    offset = max(0, cursor)
    rows = all_rows(
        db,
        """SELECT registration.id,registration.user_id,registration.participant_name_snapshot,
        registration.participant_grade_snapshot,card.id AS card_id,card.avatar_url,card.status AS card_status
        FROM activity_registrations registration LEFT JOIN roommate_cards card ON card.user_id=registration.user_id
        WHERE registration.activity_id=:activity AND registration.status='REGISTERED'
        ORDER BY registration.id LIMIT 21 OFFSET :offset""",
        {"activity": activity_id, "offset": offset},
    )
    participant_ids = [row["user_id"] for row in rows[:20] if row["user_id"] is not None]
    blocked_ids = set()
    if participant_ids:
        placeholders = ",".join(f":participant{index}" for index in range(len(participant_ids)))
        block_params = {"viewer": user["id"]}
        block_params.update(
            {f"participant{index}": participant_id for index, participant_id in enumerate(participant_ids)}
        )
        blocked_ids = {
            row["other_id"]
            for row in all_rows(
                db,
                f"""SELECT CASE WHEN blocker_id=:viewer THEN blocked_id ELSE blocker_id END AS other_id
                FROM blocks WHERE (blocker_id=:viewer AND blocked_id IN ({placeholders}))
                OR (blocked_id=:viewer AND blocker_id IN ({placeholders}))""",
                block_params,
            )
        }
    participants = []
    for row in rows[:20]:
        blocked = row["user_id"] is not None and row["user_id"] in blocked_ids
        if blocked or row["card_status"] != "PUBLISHED":
            participants.append({"name": "匿名同学", "grade": "", "avatarUrl": "", "cardId": None})
        else:
            participants.append(
                {
                    "name": row["participant_name_snapshot"],
                    "grade": row["participant_grade_snapshot"],
                    "avatarUrl": row["avatar_url"] or "",
                    "cardId": row["card_id"],
                }
            )
    return {"participants": participants, "nextCursor": offset + 20 if len(rows) > 20 else None}


@router.post("/{activity_id}/copy")
def copy_activity(activity_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_active_account(user)
    enforce_activity_limit(request, user["id"], "write", 20)
    activity = visible_activity(db, user, activity_id)
    duration = parse_stored_timestamp(activity["end_at"]) - parse_stored_timestamp(activity["start_at"])
    local_now = datetime.now(SHANGHAI)
    start = local_now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    personal = user["account_type"] == "USER"
    source_group_ids = [
        group["source_group_id"] for group in activity_group_rows(db, activity_id) if group["source_group_id"]
    ]
    if personal:
        allowed_groups = {group["id"] for group in selectable_groups(db, user["id"])}
        target_group_ids = [group_id for group_id in source_group_ids if group_id in allowed_groups]
        target_grade_ids = [user["grade_id"]] if user["grade_id"] else []
    else:
        target_group_ids = source_group_ids
        target_grade_ids = activity_grade_ids(db, activity_id)
    return {
        "template": {
            "sourceActivityId": activity_id,
            "title": activity["title"],
            "descriptionMarkdown": activity["description_markdown"],
            "startAt": start.isoformat(timespec="minutes"),
            "endAt": (start + duration).isoformat(timespec="minutes"),
            "isAllDay": bool(activity["is_all_day"]),
            "location": activity["location"],
            "capacity": activity["capacity"],
            "importance": min(activity["importance"], 3) if personal else activity["importance"],
            "targetGradeIds": target_grade_ids,
            "targetGroupIds": target_group_ids,
        }
    }


def updated_activity_targets(
    db: Session,
    user: dict,
    activity: dict,
    body: dict,
) -> tuple[bool, list[int], list[dict], list[int]]:
    targets_changed = "targetGradeIds" in body or "targetGroupIds" in body
    if targets_changed:
        grade_ids, groups, scope_grade_ids = validate_targets(db, user, body, activity["organizer_type"] == "USER")
        return True, grade_ids, groups, scope_grade_ids
    return False, activity_grade_ids(db, activity["id"]), [], activity_scope_grade_ids(db, activity)


@router.patch("/{activity_id}")
def update_activity(activity_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_active_account(user)
    enforce_activity_limit(request, user["id"], "write", 20)
    activity = activity_row(db, activity_id, user["id"])
    grant = activity_manager_grant(db, user, activity) if activity else None
    if not activity or not grant:
        raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
    if activity["status"] == "CANCELLED":
        raise ApiError(409, "ACTIVITY_CANCELLED", "已取消活动不能编辑")
    require_activity_version(body, activity)
    merged = {
        "title": body.get("title", activity["title"]),
        "descriptionMarkdown": body.get("descriptionMarkdown", activity["description_markdown"]),
        "startAt": body.get("startAt", activity["start_at"]),
        "endAt": body.get("endAt", activity["end_at"]),
        "isAllDay": body.get("isAllDay", bool(activity["is_all_day"])),
        "location": body.get("location", activity["location"]),
        "capacity": body.get("capacity", activity["capacity"]),
        "importance": body.get("importance", activity["importance"]),
    }
    values = validate_core_fields(merged)
    if values["capacity"] < activity["registration_count"]:
        raise ApiError(409, "ACTIVITY_CAPACITY_TOO_SMALL", "活动容量不能小于当前报名人数")
    targets_changed, grade_ids, groups, scope_grade_ids = updated_activity_targets(db, user, activity, body)
    if activity["organizer_type"] == "USER" and values["importance"] > 3:
        raise ApiError(403, "ACTIVITY_IMPORTANCE_FORBIDDEN", "个人活动最高可设为 III 级")
    if activity["organizer_type"] == "ADMIN_GROUP":
        grant = official_group_grant(db, user, activity["organizer_group_id"], scope_grade_ids, values["importance"])
    timestamp = now()
    db.execute(
        text(
            """UPDATE activities SET title=:title,description_markdown=:description_markdown,
            description_html=:description_html,description_summary=:description_summary,start_at=:start_at,end_at=:end_at,
            is_all_day=:is_all_day,location=:location,capacity=:capacity,importance=:importance,version=version+1,
            updated_at=:now WHERE id=:id"""
        ),
        {**values, "now": timestamp, "id": activity_id},
    )
    if targets_changed:
        write_targets(db, activity_id, grade_ids, groups, scope_grade_ids)
        if activity["status"] == "PUBLISHED":
            expand_target_members(db, user, {**activity, **values})
    audit(
        db,
        user,
        request,
        "UPDATE_ACTIVITY",
        "ACTIVITY",
        activity_id,
        metadata={"version": activity["version"] + 1},
        grant=grant,
        before={"title": activity["title"], "version": activity["version"]},
        after={"title": values["title"], "version": activity["version"] + 1},
    )
    db.commit()
    return {"activity": activity_detail(db, user, activity_row(db, activity_id, user["id"]))}


@router.post("/{activity_id}/publish")
def publish_activity(activity_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_active_account(user)
    enforce_activity_limit(request, user["id"], "write", 20)
    activity = activity_row(db, activity_id, user["id"])
    grant = activity_manager_grant(db, user, activity) if activity else None
    if not activity or not grant:
        raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
    if activity["status"] != "DRAFT":
        raise ApiError(409, "ACTIVITY_NOT_DRAFT", "只有草稿可以发布")
    require_activity_version(body, activity)
    if activity["start_at"] <= now():
        raise ApiError(409, "ACTIVITY_ALREADY_STARTED", "活动已经开始")
    member_count = expand_target_members(db, user, activity)
    if activity["organizer_type"] == "ADMIN_GROUP":
        grant = official_group_grant(
            db,
            user,
            activity["organizer_group_id"],
            activity_scope_grade_ids(db, activity),
            activity["importance"],
        )
    timestamp = now()
    db.execute(
        text(
            """UPDATE activities SET status='PUBLISHED',published_at=:now,updated_at=:now,version=version+1
            WHERE id=:id"""
        ),
        {"now": timestamp, "id": activity_id},
    )
    audit(
        db,
        user,
        request,
        "PUBLISH_ACTIVITY",
        "ACTIVITY",
        activity_id,
        metadata={"targetMemberCount": member_count, "version": activity["version"] + 1},
        grant=grant,
        before={"status": "DRAFT"},
        after={"status": "PUBLISHED"},
    )
    db.commit()
    return {"activity": activity_detail(db, user, activity_row(db, activity_id, user["id"]))}


@router.post("/{activity_id}/cancel")
def cancel_activity(activity_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_active_account(user)
    enforce_activity_limit(request, user["id"], "write", 20)
    activity = activity_row(db, activity_id, user["id"])
    grant = activity_manager_grant(db, user, activity) if activity else None
    if not activity or not grant:
        raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
    if activity["status"] == "CANCELLED":
        raise ApiError(409, "ACTIVITY_CANCELLED", "活动已经取消")
    if body.get("confirmed") is not True:
        raise ApiError(400, "ACTIVITY_CONFIRMATION_REQUIRED", "请确认取消活动")
    require_activity_version(body, activity)
    reason = clean_text(body.get("reason"), 500, activity["registration_count"] > 0)
    timestamp = now()
    db.execute(
        text(
            """UPDATE activities SET status='CANCELLED',cancel_reason=:reason,cancelled_at=:now,updated_at=:now,
            version=version+1 WHERE id=:id"""
        ),
        {"reason": reason, "now": timestamp, "id": activity_id},
    )
    audit(
        db,
        user,
        request,
        "CANCEL_ACTIVITY",
        "ACTIVITY",
        activity_id,
        reason,
        grant=grant,
        before={"status": activity["status"]},
        after={"status": "CANCELLED"},
    )
    db.commit()
    return {"activity": activity_detail(db, user, activity_row(db, activity_id, user["id"]))}


@router.delete("/{activity_id}")
def delete_activity(activity_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    grant = require_super_admin(user)
    enforce_activity_limit(request, user["id"], "write", 20)
    activity = activity_row(db, activity_id, user["id"])
    if not activity:
        raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
    if body.get("confirmed") is not True:
        raise ApiError(400, "ACTIVITY_CONFIRMATION_REQUIRED", "请确认永久删除活动")
    reason = clean_text(body.get("reason"), 500, True)
    audit(
        db,
        user,
        request,
        "DELETE_ACTIVITY",
        "ACTIVITY",
        activity_id,
        reason,
        grant=grant,
        before={"title": activity["title"], "status": activity["status"]},
    )
    db.execute(text("DELETE FROM activities WHERE id=:id"), {"id": activity_id})
    db.commit()
    return {"ok": True}


@router.post("/{activity_id}/register")
def register_activity(activity_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    if user["account_type"] != "USER":
        raise ApiError(403, "USER_ONLY", "仅普通用户可执行此操作")
    require_active_account(user)
    enforce_activity_limit(request, user["id"], "registration", 20)
    try:
        begin_immediate(db)
        activity = activity_row(db, activity_id, user["id"])
        if not activity or not can_read_activity(db, user, activity):
            raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
        if not target_member_exists(db, activity_id, user["id"]):
            raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
        if activity["status"] != "PUBLISHED":
            raise ApiError(409, "ACTIVITY_NOT_OPEN", "活动当前不能报名")
        if activity["start_at"] <= now():
            raise ApiError(409, "ACTIVITY_ALREADY_STARTED", "活动已经开始")
        existing = one(
            db,
            "SELECT * FROM activity_registrations WHERE activity_id=:activity AND user_id=:user",
            {"activity": activity_id, "user": user["id"]},
        )
        if existing and existing["status"] == "REGISTERED":
            raise ApiError(409, "ACTIVITY_ALREADY_REGISTERED", "你已经报名该活动")
        if activity["registration_count"] >= activity["capacity"]:
            raise ApiError(409, "ACTIVITY_FULL", "活动名额已满")
        timestamp = now()
        if existing:
            db.execute(
                text(
                    """UPDATE activity_registrations SET status='REGISTERED',registered_at=:now,cancelled_at=NULL
                    WHERE id=:id"""
                ),
                {"now": timestamp, "id": existing["id"]},
            )
        else:
            db.execute(
                text(
                    """INSERT INTO activity_registrations(activity_id,user_id,participant_name_snapshot,
                    participant_grade_snapshot,status,registered_at)
                    VALUES(:activity,:user,:name,:grade,'REGISTERED',:now)"""
                ),
                {
                    "activity": activity_id,
                    "user": user["id"],
                    "name": user["name"],
                    "grade": user["grade"],
                    "now": timestamp,
                },
            )
        audit(
            db,
            user,
            request,
            "REGISTER_ACTIVITY",
            "ACTIVITY",
            activity_id,
            grant={"permissionCode": "SELF"},
        )
        db.commit()
    except (IntegrityError, OperationalError) as error:
        db.rollback()
        raise ApiError(409, "ACTIVITY_REGISTRATION_CONFLICT", "报名状态已变化，请重试") from error
    latest = activity_row(db, activity_id, user["id"])
    return {"registered": True, "registrationCount": latest["registration_count"]}


@router.delete("/{activity_id}/registration")
def cancel_registration(activity_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    if user["account_type"] != "USER":
        raise ApiError(403, "USER_ONLY", "仅普通用户可执行此操作")
    require_active_account(user)
    enforce_activity_limit(request, user["id"], "registration", 20)
    try:
        begin_immediate(db)
        activity = activity_row(db, activity_id, user["id"])
        if not activity or not can_read_activity(db, user, activity):
            raise ApiError(404, "ACTIVITY_NOT_FOUND", ACTIVITY_NOT_FOUND)
        if activity["start_at"] <= now():
            raise ApiError(409, "ACTIVITY_ALREADY_STARTED", "活动开始后不能取消报名")
        registration = one(
            db,
            """SELECT * FROM activity_registrations
            WHERE activity_id=:activity AND user_id=:user AND status='REGISTERED'""",
            {"activity": activity_id, "user": user["id"]},
        )
        if not registration:
            raise ApiError(404, "ACTIVITY_REGISTRATION_NOT_FOUND", "报名记录不存在")
        db.execute(
            text("UPDATE activity_registrations SET status='CANCELLED',cancelled_at=:now WHERE id=:id"),
            {"now": now(), "id": registration["id"]},
        )
        audit(
            db,
            user,
            request,
            "CANCEL_ACTIVITY_REGISTRATION",
            "ACTIVITY",
            activity_id,
            grant={"permissionCode": "SELF"},
        )
        db.commit()
    except OperationalError as error:
        db.rollback()
        raise ApiError(409, "ACTIVITY_REGISTRATION_CONFLICT", "报名状态已变化，请重试") from error
    latest = activity_row(db, activity_id, user["id"])
    return {"registered": False, "registrationCount": latest["registration_count"]}
