import json
import uuid
from datetime import UTC, datetime

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from .errors import ApiError
from .security import token_hash

PERMISSIONS = {
    "USER_READ": "查看用户",
    "USER_IMPORT": "导入普通用户",
    "USER_EXPORT": "导出用户信息",
    "USER_LOGIN_IDENTIFIER_UPDATE": "批量修改登录标识",
    "USER_IDENTITY_UPDATE": "修改用户身份信息",
    "USER_STATUS_UPDATE": "修改用户状态",
    "CARD_READ": "查看卡片",
    "CARD_MODERATE": "隐藏或恢复卡片",
    "DORMITORY_READ": "查看宿舍",
    "DORMITORY_LOCATION_ASSIGN": "分配宿舍位置",
    "DORMITORY_CLOSE": "关闭宿舍",
    "DORMITORY_EXPORT": "导出宿舍列表",
    "REPORT_READ": "查看举报",
    "REPORT_RESOLVE": "处理举报",
    "AUDIT_READ_SCOPED": "查看范围内审计日志",
}


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def one(db: Session, sql: str, params: dict | None = None) -> dict | None:
    row = db.execute(text(sql), params or {}).mappings().first()
    return dict(row) if row else None


def all_rows(db: Session, sql: str, params: dict | None = None) -> list[dict]:
    return [dict(row) for row in db.execute(text(sql), params or {}).mappings().all()]


def clean_text(value: object, maximum: int, required: bool = False) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if required and not result:
        raise ApiError(400, "FIELD_REQUIRED", "请完整填写必填信息")
    if len(result) > maximum:
        raise ApiError(400, "FIELD_TOO_LONG", f"内容不能超过 {maximum} 个字")
    return result


def authenticate(request: Request, db: Session, require_csrf: bool | None = None) -> dict:
    token = request.cookies.get("session")
    if not token:
        raise ApiError(401, "UNAUTHORIZED", "请先登录")
    user = one(
        db,
        """
        SELECT s.token_hash, s.csrf_token, s.expires_at,
          u.id, u.login_identifier, u.account_type, u.authorization_version,
          u.must_change_password, u.name, u.grade, u.grade_id, u.gender, u.major, u.status
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = :token
        """,
        {"token": token_hash(token)},
    )
    if not user or user["expires_at"] <= now():
        raise ApiError(401, "SESSION_EXPIRED", "登录已过期")
    if user["status"] not in ("ACTIVE", "PENDING_ACTIVATION"):
        raise ApiError(403, "ACCOUNT_UNAVAILABLE", "账号当前不可用")
    check_csrf = request.method not in ("GET", "HEAD", "OPTIONS") if require_csrf is None else require_csrf
    if check_csrf and request.headers.get("x-csrf-token") != user["csrf_token"]:
        raise ApiError(403, "INVALID_CSRF_TOKEN", "请求校验失败，请刷新后重试")
    return user


def current_user(request: Request, db: Session) -> dict:
    user = authenticate(request, db)
    if user["must_change_password"] and request.url.path != "/api/me/password":
        raise ApiError(403, "PASSWORD_CHANGE_REQUIRED", "首次登录后必须先修改初始密码")
    return user


def require_user(user: dict) -> None:
    if user["account_type"] != "USER":
        raise ApiError(403, "USER_ONLY", "仅普通用户可执行此操作")


def active_admin_groups(db: Session, user_id: int) -> list[dict]:
    groups = all_rows(
        db,
        """SELECT g.id, g.code, g.name, g.description FROM admin_groups g
        JOIN admin_group_members m ON m.group_id = g.id
        WHERE m.user_id = :user_id AND g.status = 'ACTIVE' ORDER BY g.id""",
        {"user_id": user_id},
    )
    for group in groups:
        group["permissions"] = [
            row["permission_code"]
            for row in all_rows(
                db,
                "SELECT permission_code FROM admin_group_permissions WHERE group_id=:id ORDER BY permission_code",
                {"id": group["id"]},
            )
        ]
        group["gradeIds"] = [
            int(row["scope_value"])
            for row in all_rows(
                db,
                """SELECT scope_value FROM admin_group_scopes
                WHERE group_id=:id AND scope_type='GRADE' ORDER BY scope_value""",
                {"id": group["id"]},
            )
        ]
    return groups


def management_profile(db: Session, user: dict) -> dict:
    super_admin = user["account_type"] == "SUPER_ADMIN"
    groups = [] if super_admin else active_admin_groups(db, user["id"])
    permissions = list(PERMISSIONS) if super_admin else sorted({p for group in groups for p in group["permissions"]})
    return {
        "isSuperAdmin": super_admin,
        "canManage": super_admin or bool(groups),
        "permissions": permissions,
        "groups": groups,
    }


def require_management(db: Session, user: dict) -> None:
    if not management_profile(db, user)["canManage"]:
        raise ApiError(403, "MANAGEMENT_FORBIDDEN", "当前账号没有管理权限")


def require_super_admin(user: dict) -> dict:
    if user["account_type"] != "SUPER_ADMIN":
        raise ApiError(403, "SUPER_ADMIN_ONLY", "仅超级管理员可执行此操作")
    return {"permissionCode": "SUPER_ADMIN", "groupId": None, "scopeType": "", "scopeValue": ""}


def authorize(db: Session, user: dict, permission: str, grade_ids: int | list[int] | None) -> dict:
    target_ids = sorted(
        {int(item) for item in ([grade_ids] if isinstance(grade_ids, int) else grade_ids or []) if item}
    )
    if user["account_type"] == "SUPER_ADMIN":
        return {
            "permissionCode": permission,
            "groupId": None,
            "scopeType": "GRADE" if target_ids else "",
            "scopeValue": ",".join(map(str, target_ids)),
        }
    candidates = [group for group in active_admin_groups(db, user["id"]) if permission in group["permissions"]]
    if not candidates:
        raise ApiError(403, "PERMISSION_DENIED", "当前账号缺少所需管理权限")
    group = next((item for item in candidates if target_ids and all(i in item["gradeIds"] for i in target_ids)), None)
    if not group:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "资源不存在")
    return {
        "permissionCode": permission,
        "groupId": group["id"],
        "scopeType": "GRADE",
        "scopeValue": ",".join(map(str, target_ids)),
    }


def authorize_global(db: Session, user: dict, permission: str, resource: str) -> dict:
    if user["account_type"] == "SUPER_ADMIN":
        return {
            "permissionCode": permission,
            "groupId": None,
            "scopeType": "GLOBAL",
            "scopeValue": resource,
        }
    group = next(
        (item for item in active_admin_groups(db, user["id"]) if permission in item["permissions"]),
        None,
    )
    if not group:
        raise ApiError(403, "PERMISSION_DENIED", "当前账号缺少所需管理权限")
    return {
        "permissionCode": permission,
        "groupId": group["id"],
        "scopeType": "GLOBAL",
        "scopeValue": resource,
    }


def authorized_grade_ids(db: Session, user: dict, permission: str) -> list[int] | None:
    if user["account_type"] == "SUPER_ADMIN":
        return None
    return sorted(
        {
            grade
            for group in active_admin_groups(db, user["id"])
            if permission in group["permissions"]
            for grade in group["gradeIds"]
        }
    )


def is_effective_group_admin(db: Session, user_id: int) -> bool:
    return (
        one(
            db,
            """SELECT 1 AS found FROM admin_group_members m JOIN admin_groups g ON g.id=m.group_id
      WHERE m.user_id=:id AND g.status='ACTIVE' LIMIT 1""",
            {"id": user_id},
        )
        is not None
    )


def audit(
    db: Session,
    admin: dict,
    request: Request,
    action: str,
    target_type: str,
    target_id: object,
    reason: str = "",
    metadata: dict | None = None,
    grant: dict | None = None,
    before: dict | None = None,
    after: dict | None = None,
    result: str = "SUCCESS",
) -> None:
    grant = grant or {}
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    ip_address = request.client.host if request.client else ""
    if request.client and request.client.host in ("127.0.0.1", "::1"):
        ip_address = forwarded
    db.execute(
        text("""INSERT INTO audit_logs (
          admin_id,admin_name_snapshot,action,target_type,target_id,reason,metadata,ip_address,user_agent,
          request_id,permission_code,grant_group_id,scope_type,scope_value,result,before_snapshot,after_snapshot,created_at
        ) VALUES (:admin_id,:admin_name,:action,:target_type,:target_id,:reason,:metadata,:ip,:ua,:request_id,
          :permission,:group_id,:scope_type,:scope_value,:result,:before,:after,:created_at)"""),
        {
            "admin_id": admin["id"],
            "admin_name": admin["name"],
            "action": action,
            "target_type": target_type,
            "target_id": str(target_id),
            "reason": reason,
            "metadata": json.dumps(metadata or {}, ensure_ascii=False),
            "ip": ip_address,
            "ua": request.headers.get("user-agent", "")[:500],
            "request_id": request.headers.get("x-request-id") or str(uuid.uuid4()),
            "permission": grant.get("permissionCode", ""),
            "group_id": grant.get("groupId"),
            "scope_type": grant.get("scopeType", ""),
            "scope_value": grant.get("scopeValue", ""),
            "result": result,
            "before": json.dumps(before or {}, ensure_ascii=False),
            "after": json.dumps(after or {}, ensure_ascii=False),
            "created_at": now(),
        },
    )
