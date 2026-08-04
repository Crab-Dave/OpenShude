import io
import json
import re
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from sqlalchemy import text
from sqlalchemy.orm import Session

from .common import (
    PERMISSIONS,
    active_admin_groups,
    all_rows,
    audit,
    authorize,
    authorized_grade_ids,
    clean_text,
    current_user,
    is_effective_group_admin,
    now,
    one,
    require_management,
    require_super_admin,
)
from .database import get_db
from .dormitories import (
    active_round,
    archived_results,
    begin_immediate,
    current_dormitory,
    dormitory_details,
    generate_snapshot,
    leave_dormitory,
)
from .errors import ApiError
from .security import hash_password
from .student import CARD_SELECT, card_by_id

router = APIRouter(prefix="/api/admin")
DB = Annotated[Session, Depends(get_db)]
ADMIN_GROUP_BY_ID = "SELECT * FROM admin_groups WHERE id=:id"
USER_BY_ID = "SELECT * FROM users WHERE id=:id"
SELECTION_GROUP_BY_ID = "SELECT * FROM student_selection_groups WHERE id=:id"
DORMITORY_ROUND_BY_ID = "SELECT * FROM dormitory_selection_rounds WHERE id=:id"
PERMISSION_DENIED_MESSAGE = "当前账号缺少所需管理权限"
NOT_FOUND_MESSAGE = "接口不存在"
USER_NOT_FOUND_MESSAGE = "用户账号不存在"
DORMITORY_ROUND_NOT_FOUND_MESSAGE = "选宿舍轮次不存在"


def admin_user(request: Request, db: Session) -> dict:
    user = current_user(request, db)
    require_management(db, user)
    return user


def spreadsheet_text(value: object) -> str:
    result = ILLEGAL_CHARACTERS_RE.sub("", str(value or ""))
    return f"'{result}" if result.startswith(("=", "+", "-", "@")) else result


def grade_filter(db: Session, admin: dict, rows: list[dict], permission: str, field: str = "grade_id") -> list[dict]:
    grade_ids = authorized_grade_ids(db, admin, permission)
    if grade_ids is None:
        return rows
    if not grade_ids:
        raise ApiError(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE)
    return [row for row in rows if row.get(field) is not None and int(row[field]) in grade_ids]


def grade_by_text(db: Session, value: object, create: bool = False) -> dict | None:
    grade_text = clean_text(value, 20, True)
    grade = one(
        db, "SELECT * FROM grades WHERE (code=:value OR name=:value) AND status='ACTIVE'", {"value": grade_text}
    )
    if not grade and create:
        timestamp = now()
        result = db.execute(
            text("INSERT INTO grades(code,name,created_at,updated_at) VALUES(:value,:value,:now,:now)"),
            {"value": grade_text, "now": timestamp},
        )
        grade = one(db, "SELECT * FROM grades WHERE id=:id", {"id": result.lastrowid})
    return grade


def group_details(db: Session, group: dict) -> dict:
    return {
        **group,
        "permissions": [
            row["permission_code"]
            for row in all_rows(
                db,
                "SELECT permission_code FROM admin_group_permissions WHERE group_id=:id ORDER BY permission_code",
                {"id": group["id"]},
            )
        ],
        "scopes": all_rows(
            db,
            """SELECT s.scope_type,s.scope_value,g.name AS grade_name FROM admin_group_scopes s
          LEFT JOIN grades g ON s.scope_type='GRADE' AND g.id=CAST(s.scope_value AS INTEGER)
          WHERE s.group_id=:id ORDER BY s.scope_type,s.scope_value""",
            {"id": group["id"]},
        ),
        "members": all_rows(
            db,
            """SELECT u.id,u.login_identifier,u.name,u.grade,u.status FROM admin_group_members m
          JOIN users u ON u.id=m.user_id WHERE m.group_id=:id ORDER BY u.name,u.id""",
            {"id": group["id"]},
        ),
    }


def selection_group_details(db: Session, group: dict) -> dict:
    return {
        **group,
        "members": all_rows(
            db,
            """SELECT u.id,u.login_identifier,u.name,u.grade,u.status
      FROM student_selection_group_members m JOIN users u ON u.id=m.user_id
      WHERE m.group_id=:id ORDER BY u.name,u.id""",
            {"id": group["id"]},
        ),
    }


def report_rows(db: Session) -> list[dict]:
    return all_rows(
        db,
        """SELECT r.*,reporter.name AS reporter_name,handler.name AS handler_name,
      CASE r.target_type WHEN 'ROOMMATE_CARD' THEN (SELECT u.grade_id FROM roommate_cards c JOIN users u
        ON u.id=c.user_id WHERE c.id=r.target_id) WHEN 'MESSAGE' THEN (SELECT u.grade_id FROM messages m
        JOIN users u ON u.id=m.sender_id WHERE m.id=r.target_id) END AS target_grade_id
      FROM reports r JOIN users reporter ON reporter.id=r.reporter_id LEFT JOIN users handler ON handler.id=r.handled_by
      ORDER BY CASE r.status WHEN 'PENDING' THEN 0 ELSE 1 END,r.id DESC""",
    )


def valid_user_ids(db: Session, values: object, statuses: bool = False) -> list[int]:
    if not isinstance(values, list):
        return []
    ids = sorted({int(value) for value in values if str(value).isdigit()})
    for user_id in ids:
        suffix = " AND status IN('ACTIVE','PENDING_ACTIVATION')" if statuses else ""
        if not one(db, f"SELECT 1 AS found FROM users WHERE id=:id AND account_type='USER'{suffix}", {"id": user_id}):
            raise ApiError(
                400,
                "INVALID_SELECTION_GROUP_MEMBER" if statuses else "INVALID_ROUND_PARTICIPANT",
                "群组成员包含无效学生" if statuses else "参与名单包含无效学生",
            )
    return ids


@router.get("/overview")
def overview(request: Request, db: DB) -> dict:
    admin = admin_user(request, db)
    current = active_round(db) or one(
        db, "SELECT * FROM dormitory_selection_rounds WHERE status!='DRAFT' ORDER BY id DESC LIMIT 1"
    )
    round_id = current["id"] if current else -1

    def count(permission: str, sql: str, field: str = "grade_id") -> int:
        ids = authorized_grade_ids(db, admin, permission)
        rows = all_rows(db, sql, {"round": round_id})
        return len(rows) if ids is None else len([row for row in rows if row.get(field) in ids])

    reports = report_rows(db)
    report_ids = authorized_grade_ids(db, admin, "REPORT_READ")
    pending_reports = [
        row
        for row in reports
        if row["status"] == "PENDING" and (report_ids is None or row["target_grade_id"] in report_ids)
    ]
    return {
        "counts": {
            "students": count("USER_READ", "SELECT grade_id FROM users WHERE account_type='USER'"),
            "activeStudents": count(
                "USER_READ", "SELECT grade_id FROM users WHERE account_type='USER' AND status='ACTIVE'"
            ),
            "publishedCards": count(
                "CARD_READ",
                "SELECT u.grade_id FROM roommate_cards c JOIN users u ON u.id=c.user_id WHERE c.status='PUBLISHED'",
            ),
            "pendingReports": len(pending_reports),
            "dormitories": count(
                "DORMITORY_READ",
                "SELECT management_grade_id FROM dormitories WHERE selection_round_id=:round AND status IN('OPEN','FULL')",
                "management_grade_id",
            ),
            "dormitoryMembers": count(
                "DORMITORY_READ",
                "SELECT d.management_grade_id FROM dormitory_members m JOIN dormitories d ON d.id=m.dormitory_id WHERE d.selection_round_id=:round",
                "management_grade_id",
            ),
            "dormitorySelectionOpen": bool(current and current["status"] == "OPEN"),
            "currentRound": current,
        }
    }


@router.get("/permissions")
def permissions(request: Request, db: DB) -> dict:
    require_super_admin(admin_user(request, db))
    return {"permissions": [{"code": code, "name": name} for code, name in PERMISSIONS.items()]}


@router.get("/grades")
def grades(request: Request, db: DB) -> dict:
    admin = admin_user(request, db)
    rows = all_rows(db, "SELECT id,code,name,status FROM grades WHERE status='ACTIVE' ORDER BY code")
    if admin["account_type"] != "SUPER_ADMIN":
        allowed = {grade for group in active_admin_groups(db, admin["id"]) for grade in group["gradeIds"]}
        rows = [grade for grade in rows if grade["id"] in allowed]
    return {"grades": rows}


@router.get("/admin-groups")
def admin_groups(request: Request, db: DB) -> dict:
    require_super_admin(admin_user(request, db))
    rows = all_rows(
        db,
        """SELECT g.*,creator.name AS created_by_name FROM admin_groups g
      LEFT JOIN users creator ON creator.id=g.created_by ORDER BY g.id DESC""",
    )
    return {"groups": [group_details(db, group) for group in rows]}


@router.post("/admin-groups", status_code=201)
def create_admin_group(request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    code = clean_text(body.get("code"), 40, True).upper()
    name = clean_text(body.get("name"), 80, True)
    description = clean_text(body.get("description"), 500)
    if not re.match(r"^[A-Z][A-Z0-9_]{1,39}$", code):
        raise ApiError(400, "INVALID_GROUP_CODE", "组编码只能使用大写字母、数字和下划线")
    if one(db, "SELECT 1 AS found FROM admin_groups WHERE code=:code", {"code": code}):
        raise ApiError(409, "DUPLICATE_GROUP_CODE", "管理员组编码已存在")
    timestamp = now()
    result = db.execute(
        text("""INSERT INTO admin_groups(code,name,description,status,created_by,created_at,updated_at)
      VALUES(:code,:name,:description,'ACTIVE',:admin,:now,:now)"""),
        {"code": code, "name": name, "description": description, "admin": admin["id"], "now": timestamp},
    )
    audit(
        db,
        admin,
        request,
        "CREATE_ADMIN_GROUP",
        "ADMIN_GROUP",
        result.lastrowid,
        grant=grant,
        after={"code": code, "name": name, "description": description, "status": "ACTIVE"},
    )
    db.commit()
    return {"group": group_details(db, one(db, ADMIN_GROUP_BY_ID, {"id": result.lastrowid}))}


def configure_group_permissions(db: Session, group_id: int, body: dict, admin_id: int) -> tuple[list, list]:
    supplied = body.get("permissions")
    values = sorted(set(supplied)) if isinstance(supplied, list) else []
    if any(value not in PERMISSIONS for value in values):
        raise ApiError(400, "INVALID_PERMISSION", "包含不受支持的权限编码")
    before = [
        row["permission_code"]
        for row in all_rows(
            db,
            "SELECT permission_code FROM admin_group_permissions WHERE group_id=:id ORDER BY permission_code",
            {"id": group_id},
        )
    ]
    db.execute(text("DELETE FROM admin_group_permissions WHERE group_id=:id"), {"id": group_id})
    for value in values:
        db.execute(
            text(
                "INSERT INTO admin_group_permissions(group_id,permission_code,created_by,created_at) VALUES(:group,:value,:admin,:now)"
            ),
            {"group": group_id, "value": value, "admin": admin_id, "now": now()},
        )
    return before, values


def configure_group_scopes(db: Session, group_id: int, body: dict, admin_id: int) -> tuple[list, list]:
    try:
        values = sorted({int(value) for value in body.get("gradeIds", [])})
    except (TypeError, ValueError):
        values = []
    if any(
        not one(db, "SELECT 1 AS found FROM grades WHERE id=:id AND status='ACTIVE'", {"id": value}) for value in values
    ):
        raise ApiError(400, "INVALID_GRADE_SCOPE", "包含无效的年级范围")
    before = [
        int(row["scope_value"])
        for row in all_rows(
            db,
            "SELECT scope_value FROM admin_group_scopes WHERE group_id=:id AND scope_type='GRADE' ORDER BY scope_value",
            {"id": group_id},
        )
    ]
    db.execute(text("DELETE FROM admin_group_scopes WHERE group_id=:id"), {"id": group_id})
    for value in values:
        db.execute(
            text(
                "INSERT INTO admin_group_scopes(group_id,scope_type,scope_value,created_by,created_at) VALUES(:group,'GRADE',:value,:admin,:now)"
            ),
            {"group": group_id, "value": str(value), "admin": admin_id, "now": now()},
        )
    return before, values


def configure_group_members(db: Session, group_id: int, body: dict, admin_id: int) -> tuple[list, list]:
    try:
        values = sorted({int(value) for value in body.get("userIds", [])})
    except (TypeError, ValueError):
        values = []
    if any(
        not one(db, "SELECT 1 AS found FROM users WHERE id=:id AND account_type='USER'", {"id": value})
        for value in values
    ):
        raise ApiError(400, "INVALID_GROUP_MEMBER", "管理员组成员必须是普通用户")
    before = [
        row["user_id"]
        for row in all_rows(
            db, "SELECT user_id FROM admin_group_members WHERE group_id=:id ORDER BY user_id", {"id": group_id}
        )
    ]
    db.execute(text("DELETE FROM admin_group_members WHERE group_id=:id"), {"id": group_id})
    for value in values:
        db.execute(
            text(
                "INSERT INTO admin_group_members(group_id,user_id,created_by,created_at) VALUES(:group,:value,:admin,:now)"
            ),
            {"group": group_id, "value": value, "admin": admin_id, "now": now()},
        )
    for value in set(before + values):
        db.execute(text("UPDATE users SET authorization_version=authorization_version+1 WHERE id=:id"), {"id": value})
    return before, values


@router.put("/admin-groups/{group_id}")
def configure_admin_group(group_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    name = clean_text(body.get("name"), 80, True)
    description = clean_text(body.get("description"), 500)
    status = body.get("status")
    reason = clean_text(body.get("reason"), 200, True)
    if status not in ("ACTIVE", "DISABLED"):
        raise ApiError(400, "INVALID_GROUP_STATUS", "管理员组状态无效")
    begin_immediate(db)
    group = one(db, ADMIN_GROUP_BY_ID, {"id": group_id})
    if not group:
        raise ApiError(404, "ADMIN_GROUP_NOT_FOUND", "管理员组不存在")
    before = group_details(db, group)
    configure_group_permissions(db, group_id, body, admin["id"])
    configure_group_scopes(db, group_id, body, admin["id"])
    configure_group_members(db, group_id, body, admin["id"])
    db.execute(
        text("UPDATE admin_groups SET name=:name,description=:description,status=:status,updated_at=:now WHERE id=:id"),
        {"name": name, "description": description, "status": status, "now": now(), "id": group_id},
    )
    after = group_details(db, one(db, ADMIN_GROUP_BY_ID, {"id": group_id}))
    audit(
        db,
        admin,
        request,
        "UPDATE_ADMIN_GROUP",
        "ADMIN_GROUP",
        group_id,
        reason,
        grant=grant,
        before=before,
        after=after,
    )
    db.commit()
    return {"group": after}


@router.get("/users")
def users(request: Request, db: DB, search: str = "") -> dict:
    admin = admin_user(request, db)
    rows = all_rows(
        db,
        """SELECT u.id,u.login_identifier,u.account_type,u.name,u.grade,u.grade_id,u.gender,u.major,
      u.email,u.status,u.last_login_at,u.created_at,c.status AS card_status FROM users u
      LEFT JOIN roommate_cards c ON c.user_id=u.id ORDER BY u.id DESC""",
    )
    if admin["account_type"] != "SUPER_ADMIN":
        rows = grade_filter(db, admin, [item for item in rows if item["account_type"] == "USER"], "USER_READ")
    if search.strip():
        rows = [row for row in rows if search.strip().lower() in row["name"].lower()]
    return {
        "users": [
            {**item, "is_group_admin": item["account_type"] == "USER" and is_effective_group_admin(db, item["id"])}
            for item in rows
        ]
    }


@router.get("/users/export")
def export_users(request: Request, db: DB) -> StreamingResponse:
    admin = admin_user(request, db)
    grade_ids = authorized_grade_ids(db, admin, "USER_EXPORT")
    if grade_ids is not None and not grade_ids:
        raise ApiError(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE)
    rows = all_rows(
        db,
        """SELECT u.login_identifier,u.name,u.grade,u.grade_id,u.gender,u.major,u.status,
      u.last_login_at,u.created_at,c.clothing_size,c.status AS card_status FROM users u
      LEFT JOIN roommate_cards c ON c.user_id=u.id WHERE u.account_type='USER'
      ORDER BY u.grade,u.login_identifier""",
    )
    if grade_ids is not None:
        rows = [row for row in rows if row["grade_id"] in grade_ids]

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "用户信息"
    sheet.append(
        ["登录标识", "姓名", "年级", "性别", "专业", "院服尺码", "账号状态", "卡片状态", "最近登录", "创建时间"]
    )
    gender_labels = {"MALE": "男", "FEMALE": "女", "UNSPECIFIED": "未设置"}
    status_labels = {
        "PENDING_ACTIVATION": "待激活",
        "ACTIVE": "正常",
        "SUSPENDED": "已停用",
        "BANNED": "已封禁",
    }
    card_status_labels = {"DRAFT": "草稿", "PUBLISHED": "已发布", "HIDDEN": "已隐藏"}
    for row in rows:
        sheet.append(
            [
                spreadsheet_text(row["login_identifier"]),
                spreadsheet_text(row["name"]),
                spreadsheet_text(row["grade"]),
                gender_labels.get(row["gender"], row["gender"]),
                spreadsheet_text(row["major"]),
                spreadsheet_text(row["clothing_size"]),
                status_labels.get(row["status"], row["status"]),
                card_status_labels.get(row["card_status"], row["card_status"] or "未创建"),
                row["last_login_at"] or "",
                row["created_at"],
            ]
        )
    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)

    if admin["account_type"] == "SUPER_ADMIN":
        grant = {
            "permissionCode": "USER_EXPORT",
            "groupId": None,
            "scopeType": "GRADE",
            "scopeValue": ",".join(map(str, sorted({row["grade_id"] for row in rows if row["grade_id"]}))),
        }
        group_ids = []
    else:
        groups = [group for group in active_admin_groups(db, admin["id"]) if "USER_EXPORT" in group["permissions"]]
        grant = {
            "permissionCode": "USER_EXPORT",
            "groupId": groups[0]["id"] if len(groups) == 1 else None,
            "scopeType": "GRADE",
            "scopeValue": ",".join(map(str, grade_ids)),
        }
        group_ids = [group["id"] for group in groups]
    audit(
        db,
        admin,
        request,
        "EXPORT_USERS",
        "USER_COLLECTION",
        "all",
        metadata={"count": len(rows), "groupIds": group_ids},
        grant=grant,
    )
    db.commit()
    filename = f"users-{date.today().isoformat()}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/users/import")
def import_users(request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    accounts = body.get("accounts", [])[:200] if isinstance(body.get("accounts"), list) else []
    if not accounts:
        raise ApiError(400, "EMPTY_IMPORT", "没有可导入的账号")
    created, failed = [], []
    for index, item in enumerate(accounts):
        item = item if isinstance(item, dict) else {}
        try:
            login = clean_text(item.get("loginIdentifier"), 100, True)
            name = clean_text(item.get("name"), 40, True)
            grade = grade_by_text(db, item.get("grade"), admin["account_type"] == "SUPER_ADMIN")
            if not grade:
                raise ApiError(404, "GRADE_NOT_FOUND", "年级不在授权范围内")
            grant = authorize(db, admin, "USER_IMPORT", grade["id"])
            major = clean_text(item.get("major"), 80, True)
            gender = item.get("gender")
            if gender not in ("MALE", "FEMALE"):
                raise ApiError(400, "INVALID_GENDER", "性别必须为男或女")
            if one(db, "SELECT 1 AS found FROM users WHERE login_identifier=:login", {"login": login}):
                raise ApiError(409, "DUPLICATE_LOGIN", "登录标识已存在")
            initial_password = login
            password = hash_password(initial_password)
            timestamp = now()
            result = db.execute(
                text("""INSERT INTO users(login_identifier,password_hash,password_salt,role,account_type,
              must_change_password,name,grade,grade_id,gender,major,status,imported_by,created_at,updated_at)
              VALUES(:login,:hash,:salt,'STUDENT','USER',1,:name,:grade,:grade_id,:gender,:major,
              'PENDING_ACTIVATION',:admin,:now,:now)"""),
                {
                    "login": login,
                    "hash": password.hash,
                    "salt": password.salt,
                    "name": name,
                    "grade": grade["name"],
                    "grade_id": grade["id"],
                    "gender": gender,
                    "major": major,
                    "admin": admin["id"],
                    "now": timestamp,
                },
            )
            created.append(
                {
                    "id": result.lastrowid,
                    "loginIdentifier": login,
                    "name": name,
                    "grade": grade["name"],
                    "gender": gender,
                    "major": major,
                    "initialPassword": initial_password,
                }
            )
            audit(
                db,
                admin,
                request,
                "IMPORT_USER",
                "USER",
                result.lastrowid,
                grant=grant,
                after={
                    "loginIdentifier": login,
                    "name": name,
                    "grade": grade["name"],
                    "gender": gender,
                    "major": major,
                },
            )
            db.commit()
        except ApiError as error:
            db.rollback()
            failed.append(
                {"row": index + 1, "loginIdentifier": item.get("loginIdentifier", ""), "reason": error.message}
            )
    return {"created": created, "failed": failed}


def protected_account(db: Session, admin: dict, account: dict) -> None:
    if admin["account_type"] != "SUPER_ADMIN" and (
        account["id"] == admin["id"] or account["account_type"] != "USER" or is_effective_group_admin(db, account["id"])
    ):
        raise ApiError(403, "PROTECTED_ADMIN_ACCOUNT", "组管理员不能修改自己或其他管理员账号")


@router.post("/users/{user_id}/password-reset")
def reset_user_password(user_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    reason = clean_text(body.get("reason"), 200, True)
    begin_immediate(db)
    account = one(db, USER_BY_ID, {"id": user_id})
    if not account:
        raise ApiError(404, "USER_NOT_FOUND", USER_NOT_FOUND_MESSAGE)
    if account["id"] == admin["id"]:
        raise ApiError(403, "SELF_PASSWORD_RESET_FORBIDDEN", "请在账号设置中修改自己的密码")
    protected_account(db, admin, account)
    grant = (
        require_super_admin(admin)
        if admin["account_type"] == "SUPER_ADMIN"
        else authorize(db, admin, "USER_PASSWORD_RESET", account["grade_id"])
    )
    password = hash_password(account["login_identifier"])
    db.execute(
        text("""UPDATE users SET password_hash=:hash,password_salt=:salt,must_change_password=1,
      updated_at=:now WHERE id=:id"""),
        {"hash": password.hash, "salt": password.salt, "now": now(), "id": account["id"]},
    )
    revoked_sessions = db.execute(text("DELETE FROM sessions WHERE user_id=:id"), {"id": account["id"]}).rowcount
    audit(
        db,
        admin,
        request,
        "RESET_USER_PASSWORD",
        "USER",
        account["id"],
        reason,
        metadata={"sessionsRevoked": revoked_sessions},
        grant=grant,
        before={"mustChangePassword": bool(account["must_change_password"])},
        after={"mustChangePassword": True},
    )
    db.commit()
    return {"ok": True}


@router.patch("/users/login-identifiers")
def update_login_identifiers(request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    supplied = body.get("changes")
    if not isinstance(supplied, list) or not supplied or len(supplied) > 200:
        raise ApiError(400, "INVALID_LOGIN_IDENTIFIER_BATCH", "每次必须提交 1 至 200 条登录标识变更")
    reason = clean_text(body.get("reason"), 200, True)
    changes = []
    for item in supplied:
        item = item if isinstance(item, dict) else {}
        old_login = clean_text(item.get("oldLoginIdentifier"), 100, True)
        new_login = clean_text(item.get("newLoginIdentifier"), 100, True)
        if old_login == new_login:
            raise ApiError(400, "UNCHANGED_LOGIN_IDENTIFIER", "新旧登录标识不能相同")
        changes.append({"old": old_login, "new": new_login})
    if len({item["old"] for item in changes}) != len(changes):
        raise ApiError(400, "DUPLICATE_OLD_LOGIN_IDENTIFIER", "原登录标识不能重复")
    if len({item["new"] for item in changes}) != len(changes):
        raise ApiError(400, "DUPLICATE_NEW_LOGIN_IDENTIFIER", "新登录标识不能重复")

    begin_immediate(db)
    prepared = []
    for change in changes:
        account = one(db, "SELECT * FROM users WHERE login_identifier=:login", {"login": change["old"]})
        if not account or account["account_type"] != "USER":
            raise ApiError(404, "USER_NOT_FOUND", USER_NOT_FOUND_MESSAGE)
        protected_account(db, admin, account)
        grant = authorize(db, admin, "USER_LOGIN_IDENTIFIER_UPDATE", account["grade_id"])
        if one(db, "SELECT 1 AS found FROM users WHERE login_identifier=:login", {"login": change["new"]}):
            raise ApiError(409, "DUPLICATE_LOGIN", "新登录标识已存在")
        prepared.append((change, account, grant))

    timestamp = now()
    updated = []
    for change, account, grant in prepared:
        values = {"login": change["new"], "now": timestamp, "id": account["id"]}
        if account["must_change_password"]:
            password = hash_password(change["new"])
            values.update({"hash": password.hash, "salt": password.salt})
            db.execute(
                text("""UPDATE users SET login_identifier=:login,password_hash=:hash,password_salt=:salt,
              updated_at=:now WHERE id=:id"""),
                values,
            )
        else:
            db.execute(
                text("UPDATE users SET login_identifier=:login,updated_at=:now WHERE id=:id"),
                values,
            )
        db.execute(text("DELETE FROM sessions WHERE user_id=:id"), {"id": account["id"]})
        audit(
            db,
            admin,
            request,
            "UPDATE_LOGIN_IDENTIFIER",
            "USER",
            account["id"],
            reason,
            grant=grant,
            before={"loginIdentifier": change["old"]},
            after={"loginIdentifier": change["new"]},
        )
        updated.append(
            {
                "id": account["id"],
                "name": account["name"],
                "oldLoginIdentifier": change["old"],
                "newLoginIdentifier": change["new"],
                "initialPasswordReset": bool(account["must_change_password"]),
            }
        )
    db.commit()
    return {"updated": updated}


@router.patch("/users/{user_id}/identity")
def update_identity(user_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    name = clean_text(body.get("name"), 40, True)
    target_grade = grade_by_text(db, body.get("grade"), admin["account_type"] == "SUPER_ADMIN")
    if not target_grade:
        raise ApiError(404, "GRADE_NOT_FOUND", "年级不在授权范围内")
    major = clean_text(body.get("major"), 80, True)
    gender = body.get("gender")
    if gender not in ("MALE", "FEMALE"):
        raise ApiError(400, "INVALID_GENDER", "性别必须为男或女")
    account = one(db, USER_BY_ID, {"id": user_id})
    if not account:
        raise ApiError(404, "USER_NOT_FOUND", USER_NOT_FOUND_MESSAGE)
    protected_account(db, admin, account)
    grant = (
        require_super_admin(admin)
        if admin["account_type"] == "SUPER_ADMIN"
        else authorize(db, admin, "USER_IDENTITY_UPDATE", [account["grade_id"], target_grade["id"]])
    )
    if account["gender"] != gender and current_dormitory(db, user_id):
        raise ApiError(409, "USER_IN_DORMITORY", "该学生已加入宿舍，请退出后再修改性别")
    db.execute(
        text("""UPDATE users SET name=:name,grade=:grade,grade_id=:grade_id,gender=:gender,
      major=:major,updated_at=:now WHERE id=:id"""),
        {
            "name": name,
            "grade": target_grade["name"],
            "grade_id": target_grade["id"],
            "gender": gender,
            "major": major,
            "now": now(),
            "id": user_id,
        },
    )
    before = {field: account[field] for field in ("name", "grade", "grade_id", "gender", "major")}
    after = {
        "name": name,
        "grade": target_grade["name"],
        "grade_id": target_grade["id"],
        "gender": gender,
        "major": major,
    }
    audit(
        db,
        admin,
        request,
        "UPDATE_IDENTITY",
        "USER",
        user_id,
        clean_text(body.get("reason"), 200),
        grant=grant,
        before=before,
        after=after,
    )
    db.commit()
    return {"ok": True}


def effective_super_admin_count(db: Session) -> int:
    return one(
        db,
        """SELECT COUNT(*) AS count FROM users WHERE account_type='SUPER_ADMIN'
      AND status IN('ACTIVE','PENDING_ACTIVATION')""",
    )["count"]


@router.patch("/users/{user_id}/status")
def update_user_status(user_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    status = body.get("status")
    if status not in ("ACTIVE", "SUSPENDED", "BANNED"):
        raise ApiError(400, "INVALID_STATUS", "账号状态无效")
    account = one(db, USER_BY_ID, {"id": user_id})
    if not account:
        raise ApiError(404, "USER_NOT_FOUND", USER_NOT_FOUND_MESSAGE)
    protected_account(db, admin, account)
    grant = (
        require_super_admin(admin)
        if admin["account_type"] == "SUPER_ADMIN"
        else authorize(db, admin, "USER_STATUS_UPDATE", account["grade_id"])
    )
    begin_immediate(db)
    account = one(db, USER_BY_ID, {"id": user_id})
    if (
        account["account_type"] == "SUPER_ADMIN"
        and account["status"] in ("ACTIVE", "PENDING_ACTIVATION")
        and status != "ACTIVE"
        and effective_super_admin_count(db) <= 1
    ):
        raise ApiError(409, "LAST_SUPER_ADMIN", "不能停用最后一个有效超级管理员")
    if status != "ACTIVE":
        leave_dormitory(db, user_id, reason=f"账号状态变更为 {status}")
    db.execute(
        text("UPDATE users SET status=:status,updated_at=:now WHERE id=:id"),
        {"status": status, "now": now(), "id": user_id},
    )
    if status != "ACTIVE":
        db.execute(text("DELETE FROM sessions WHERE user_id=:id"), {"id": user_id})
    audit(
        db,
        admin,
        request,
        "UPDATE_USER_STATUS",
        "USER",
        user_id,
        clean_text(body.get("reason"), 200, True),
        grant=grant,
        before={"status": account["status"]},
        after={"status": status},
    )
    db.commit()
    return {"ok": True}


@router.patch("/users/{user_id}/account-type")
def update_account_type(user_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    account_type = body.get("accountType")
    if account_type not in ("USER", "SUPER_ADMIN"):
        raise ApiError(400, "INVALID_ACCOUNT_TYPE", "账号类型无效")
    begin_immediate(db)
    account = one(db, USER_BY_ID, {"id": user_id})
    if not account:
        raise ApiError(404, "USER_NOT_FOUND", USER_NOT_FOUND_MESSAGE)
    if account["account_type"] == "SUPER_ADMIN" and account_type == "USER":
        if effective_super_admin_count(db) <= 1 and account["status"] in ("ACTIVE", "PENDING_ACTIVATION"):
            raise ApiError(409, "LAST_SUPER_ADMIN", "不能降级最后一个有效超级管理员")
        if not account["grade_id"]:
            raise ApiError(409, "GRADE_REQUIRED", "降级前必须为账号设置年级")
    db.execute(
        text("""UPDATE users SET account_type=:type,authorization_version=authorization_version+1,
      updated_at=:now WHERE id=:id"""),
        {"type": account_type, "now": now(), "id": user_id},
    )
    if account_type == "SUPER_ADMIN":
        db.execute(text("DELETE FROM admin_group_members WHERE user_id=:id"), {"id": user_id})
    audit(
        db,
        admin,
        request,
        "UPDATE_ACCOUNT_TYPE",
        "USER",
        user_id,
        clean_text(body.get("reason"), 200, True),
        grant=grant,
        before={"accountType": account["account_type"]},
        after={"accountType": account_type},
    )
    db.commit()
    return {"ok": True}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    begin_immediate(db)
    account = one(db, USER_BY_ID, {"id": user_id})
    if not account:
        raise ApiError(404, "USER_NOT_FOUND", USER_NOT_FOUND_MESSAGE)
    if (
        account["account_type"] == "SUPER_ADMIN"
        and effective_super_admin_count(db) <= 1
        and account["status"] in ("ACTIVE", "PENDING_ACTIVATION")
    ):
        raise ApiError(409, "LAST_SUPER_ADMIN", "不能删除最后一个有效超级管理员")
    if body.get("confirmation") != account["login_identifier"]:
        raise ApiError(400, "CONFIRMATION_REQUIRED", "请输入该账号的登录标识确认删除")
    if one(
        db,
        """SELECT 1 AS found FROM dormitory_members m JOIN dormitory_selection_rounds r
      ON r.id=m.selection_round_id WHERE m.user_id=:id AND r.status='CLOSED' LIMIT 1""",
        {"id": user_id},
    ):
        raise ApiError(409, "UNARCHIVED_DORMITORY_RESULT", "该用户存在尚未归档的宿舍结果，请先归档对应轮次")
    reason = clean_text(body.get("reason"), 200, True)
    audit(
        db,
        admin,
        request,
        "DELETE_USER_PERMANENTLY",
        "USER",
        user_id,
        reason,
        grant=grant,
        before={
            "loginIdentifier": account["login_identifier"],
            "name": account["name"],
            "accountType": account["account_type"],
        },
    )
    leave_dormitory(db, user_id, reason="管理员永久删除账号")
    nullable = (
        ("users", "imported_by"),
        ("admin_groups", "created_by"),
        ("admin_group_members", "created_by"),
        ("admin_group_permissions", "created_by"),
        ("admin_group_scopes", "created_by"),
        ("reports", "handled_by"),
        ("dormitory_applications", "reviewed_by"),
        ("dormitory_selection_rounds", "created_by"),
        ("dormitory_round_participants", "added_by"),
        ("audit_logs", "admin_id"),
    )
    for table_name, column in nullable:
        db.execute(text(f"UPDATE {table_name} SET {column}=NULL WHERE {column}=:id"), {"id": user_id})
    db.execute(text("DELETE FROM users WHERE id=:id"), {"id": user_id})
    db.commit()
    return {"ok": True}


@router.get("/roommate-cards")
def admin_cards(request: Request, db: DB, search: str = "") -> dict:
    admin = admin_user(request, db)
    cards = grade_filter(db, admin, all_rows(db, CARD_SELECT + " ORDER BY c.updated_at DESC"), "CARD_READ")
    if search.strip():
        cards = [card for card in cards if search.strip().lower() in card["name"].lower()]
    return {"cards": cards}


@router.post("/roommate-cards/{card_id}/{action}")
def moderate_card(card_id: int, action: str, request: Request, body: dict, db: DB) -> dict:
    if action not in ("hide", "restore"):
        raise ApiError(404, "NOT_FOUND", NOT_FOUND_MESSAGE)
    admin = admin_user(request, db)
    card = card_by_id(db, card_id)
    if not card:
        raise ApiError(404, "CARD_NOT_FOUND", "室友卡片不存在")
    grant = authorize(db, admin, "CARD_MODERATE", card["grade_id"])
    reason = clean_text(body.get("reason"), 200, action == "hide")
    status = "HIDDEN" if action == "hide" else "PUBLISHED"
    db.execute(
        text("UPDATE roommate_cards SET status=:status,hidden_reason=:reason,updated_at=:now WHERE id=:id"),
        {"status": status, "reason": reason if action == "hide" else None, "now": now(), "id": card_id},
    )
    audit(
        db,
        admin,
        request,
        "HIDE_CARD" if action == "hide" else "RESTORE_CARD",
        "ROOMMATE_CARD",
        card_id,
        reason,
        grant=grant,
        before={"status": card["status"]},
        after={"status": status},
    )
    db.commit()
    return {"card": card_by_id(db, card_id)}


@router.get("/student-selection-groups")
def selection_groups(request: Request, db: DB, search: str = "") -> dict:
    require_super_admin(admin_user(request, db))
    groups = [
        selection_group_details(db, group)
        for group in all_rows(db, "SELECT * FROM student_selection_groups ORDER BY name,id")
    ]
    if search.strip():
        value = search.strip().lower()
        groups = [
            group
            for group in groups
            if value in group["name"].lower() or any(value in member["name"].lower() for member in group["members"])
        ]
    return {"groups": groups}


def validate_selection_group(db: Session, body: dict) -> tuple[str, str, list[int]]:
    name = clean_text(body.get("name"), 80, True)
    description = clean_text(body.get("description"), 500)
    member_ids = valid_user_ids(db, body.get("memberIds"), True)
    if not member_ids:
        raise ApiError(400, "SELECTION_GROUP_MEMBERS_REQUIRED", "请至少选择一名学生")
    return name, description, member_ids


@router.post("/student-selection-groups", status_code=201)
def create_selection_group(request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    name, description, member_ids = validate_selection_group(db, body)
    if one(db, "SELECT 1 AS found FROM student_selection_groups WHERE name=:name", {"name": name}):
        raise ApiError(409, "DUPLICATE_SELECTION_GROUP_NAME", "预设群组名称已存在")
    timestamp = now()
    result = db.execute(
        text(
            "INSERT INTO student_selection_groups(name,description,created_by,created_at,updated_at) VALUES(:name,:description,:admin,:now,:now)"
        ),
        {"name": name, "description": description, "admin": admin["id"], "now": timestamp},
    )
    for user_id in member_ids:
        db.execute(
            text("INSERT INTO student_selection_group_members(group_id,user_id,created_at) VALUES(:group,:user,:now)"),
            {"group": result.lastrowid, "user": user_id, "now": timestamp},
        )
    audit(
        db,
        admin,
        request,
        "CREATE_STUDENT_SELECTION_GROUP",
        "STUDENT_SELECTION_GROUP",
        result.lastrowid,
        clean_text(body.get("reason"), 200),
        {"memberCount": len(member_ids)},
        grant,
        after={"name": name, "description": description},
    )
    db.commit()
    return {"group": selection_group_details(db, one(db, SELECTION_GROUP_BY_ID, {"id": result.lastrowid}))}


@router.patch("/student-selection-groups/{group_id}")
def update_selection_group(group_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    before = one(db, SELECTION_GROUP_BY_ID, {"id": group_id})
    if not before:
        raise ApiError(404, "SELECTION_GROUP_NOT_FOUND", "预设群组不存在")
    name, description, member_ids = validate_selection_group(db, body)
    reason = clean_text(body.get("reason"), 200, True)
    if one(
        db,
        "SELECT 1 AS found FROM student_selection_groups WHERE name=:name AND id!=:id",
        {"name": name, "id": group_id},
    ):
        raise ApiError(409, "DUPLICATE_SELECTION_GROUP_NAME", "预设群组名称已存在")
    db.execute(
        text("UPDATE student_selection_groups SET name=:name,description=:description,updated_at=:now WHERE id=:id"),
        {"name": name, "description": description, "now": now(), "id": group_id},
    )
    db.execute(text("DELETE FROM student_selection_group_members WHERE group_id=:id"), {"id": group_id})
    for user_id in member_ids:
        db.execute(
            text("INSERT INTO student_selection_group_members(group_id,user_id,created_at) VALUES(:group,:user,:now)"),
            {"group": group_id, "user": user_id, "now": now()},
        )
    audit(
        db,
        admin,
        request,
        "UPDATE_STUDENT_SELECTION_GROUP",
        "STUDENT_SELECTION_GROUP",
        group_id,
        reason,
        {"memberCount": len(member_ids)},
        grant,
        before=before,
        after={"name": name, "description": description},
    )
    db.commit()
    return {"group": selection_group_details(db, one(db, SELECTION_GROUP_BY_ID, {"id": group_id}))}


@router.delete("/student-selection-groups/{group_id}")
def delete_selection_group(group_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    group = one(db, SELECTION_GROUP_BY_ID, {"id": group_id})
    if not group:
        raise ApiError(404, "SELECTION_GROUP_NOT_FOUND", "预设群组不存在")
    reason = clean_text(body.get("reason"), 200, True)
    audit(
        db,
        admin,
        request,
        "DELETE_STUDENT_SELECTION_GROUP",
        "STUDENT_SELECTION_GROUP",
        group_id,
        reason,
        grant=grant,
        before=group,
    )
    db.execute(text("DELETE FROM student_selection_groups WHERE id=:id"), {"id": group_id})
    db.commit()
    return {"ok": True}


def validate_round_body(db: Session, body: dict) -> tuple[str, str, str | None, str | None, list[int]]:
    name = clean_text(body.get("name"), 80, True)
    description = clean_text(body.get("description"), 500)
    starts_at = clean_text(body.get("startsAt"), 40) or None
    ends_at = clean_text(body.get("endsAt"), 40) or None
    participant_ids = valid_user_ids(db, body.get("participantIds"))
    if not participant_ids:
        raise ApiError(400, "ROUND_PARTICIPANTS_REQUIRED", "请至少选择一名参与学生")
    return name, description, starts_at, ends_at, participant_ids


@router.get("/dormitory-rounds")
def admin_rounds(request: Request, db: DB) -> dict:
    admin = admin_user(request, db)
    if admin["account_type"] != "SUPER_ADMIN" and not authorized_grade_ids(db, admin, "DORMITORY_READ"):
        raise ApiError(403, "PERMISSION_DENIED", "当前账号缺少查看宿舍的权限")
    where = "" if admin["account_type"] == "SUPER_ADMIN" else "WHERE r.status!='DRAFT'"
    rows = all_rows(
        db,
        f"""SELECT r.*,
      (SELECT COUNT(*) FROM dormitory_round_participants WHERE round_id=r.id) AS participant_count,
      (SELECT COUNT(*) FROM dormitories WHERE selection_round_id=r.id) AS dormitory_count,
      (SELECT COUNT(*) FROM dormitory_result_snapshots WHERE selection_round_id=r.id) AS result_count
      FROM dormitory_selection_rounds r {where} ORDER BY r.id DESC""",
    )
    if admin["account_type"] == "SUPER_ADMIN":
        for round_row in rows:
            round_row["participantIds"] = [
                item["user_id"]
                for item in all_rows(
                    db,
                    "SELECT user_id FROM dormitory_round_participants WHERE round_id=:id ORDER BY user_id",
                    {"id": round_row["id"]},
                )
            ]
    return {"rounds": rows}


@router.post("/dormitory-rounds", status_code=201)
def create_round(request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    code = clean_text(body.get("code"), 40, True).upper()
    if not re.match(r"^[A-Z0-9][A-Z0-9_-]{1,39}$", code):
        raise ApiError(400, "INVALID_ROUND_CODE", "轮次编码只能使用大写字母、数字、下划线和连字符")
    name, description, starts_at, ends_at, participant_ids = validate_round_body(db, body)
    if one(db, "SELECT 1 AS found FROM dormitory_selection_rounds WHERE code=:code", {"code": code}):
        raise ApiError(409, "DUPLICATE_ROUND_CODE", "轮次编码已存在")
    timestamp = now()
    result = db.execute(
        text("""INSERT INTO dormitory_selection_rounds(code,name,description,status,starts_at,ends_at,
      created_by,created_at,updated_at) VALUES(:code,:name,:description,'DRAFT',:starts,:ends,:admin,:now,:now)"""),
        {
            "code": code,
            "name": name,
            "description": description,
            "starts": starts_at,
            "ends": ends_at,
            "admin": admin["id"],
            "now": timestamp,
        },
    )
    for user_id in participant_ids:
        db.execute(
            text(
                "INSERT INTO dormitory_round_participants(round_id,user_id,added_by,created_at) VALUES(:round,:user,:admin,:now)"
            ),
            {"round": result.lastrowid, "user": user_id, "admin": admin["id"], "now": timestamp},
        )
    audit(
        db,
        admin,
        request,
        "CREATE_DORMITORY_ROUND",
        "DORMITORY_ROUND",
        result.lastrowid,
        clean_text(body.get("reason"), 200),
        {"participantCount": len(participant_ids)},
        grant,
        after={"code": code, "name": name, "status": "DRAFT"},
    )
    db.commit()
    return {"round": one(db, DORMITORY_ROUND_BY_ID, {"id": result.lastrowid})}


@router.patch("/dormitory-rounds/{round_id}")
def update_round(round_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    before = one(db, DORMITORY_ROUND_BY_ID, {"id": round_id})
    if not before:
        raise ApiError(404, "DORMITORY_ROUND_NOT_FOUND", DORMITORY_ROUND_NOT_FOUND_MESSAGE)
    if before["status"] != "DRAFT":
        raise ApiError(409, "ROUND_NOT_EDITABLE", "只有草稿轮次可以修改配置")
    name, description, starts_at, ends_at, participant_ids = validate_round_body(db, body)
    db.execute(
        text("""UPDATE dormitory_selection_rounds SET name=:name,description=:description,
      starts_at=:starts,ends_at=:ends,updated_at=:now WHERE id=:id"""),
        {"name": name, "description": description, "starts": starts_at, "ends": ends_at, "now": now(), "id": round_id},
    )
    db.execute(text("DELETE FROM dormitory_round_participants WHERE round_id=:id"), {"id": round_id})
    for user_id in participant_ids:
        db.execute(
            text(
                "INSERT INTO dormitory_round_participants(round_id,user_id,added_by,created_at) VALUES(:round,:user,:admin,:now)"
            ),
            {"round": round_id, "user": user_id, "admin": admin["id"], "now": now()},
        )
    audit(
        db,
        admin,
        request,
        "UPDATE_DORMITORY_ROUND",
        "DORMITORY_ROUND",
        round_id,
        clean_text(body.get("reason"), 200, True),
        {"participantCount": len(participant_ids)},
        grant,
        before=before,
        after={"name": name, "description": description, "startsAt": starts_at, "endsAt": ends_at},
    )
    db.commit()
    return {"round": one(db, DORMITORY_ROUND_BY_ID, {"id": round_id})}


@router.post("/dormitory-rounds/{round_id}/{action}")
def transition_round(round_id: int, action: str, request: Request, body: dict, db: DB) -> dict:
    if action not in ("open", "close", "archive"):
        raise ApiError(404, "NOT_FOUND", NOT_FOUND_MESSAGE)
    admin = admin_user(request, db)
    grant = require_super_admin(admin)
    reason = clean_text(body.get("reason"), 200, True)
    begin_immediate(db)
    round_row = one(db, DORMITORY_ROUND_BY_ID, {"id": round_id})
    if not round_row:
        raise ApiError(404, "DORMITORY_ROUND_NOT_FOUND", DORMITORY_ROUND_NOT_FOUND_MESSAGE)
    required = {"open": "DRAFT", "close": "OPEN", "archive": "CLOSED"}[action]
    if round_row["status"] != required:
        raise ApiError(409, "INVALID_ROUND_TRANSITION", "当前轮次状态不能执行该操作")
    timestamp = now()
    snapshot_count = 0
    if action == "open":
        if active_round(db):
            raise ApiError(409, "ROUND_ALREADY_OPEN", "已有正在进行的选宿舍轮次")
        db.execute(
            text("UPDATE dormitory_selection_rounds SET status='OPEN',opened_at=:now,updated_at=:now WHERE id=:id"),
            {"now": timestamp, "id": round_id},
        )
    elif action == "close":
        db.execute(
            text("UPDATE dormitory_selection_rounds SET status='CLOSED',closed_at=:now,updated_at=:now WHERE id=:id"),
            {"now": timestamp, "id": round_id},
        )
        db.execute(
            text("""UPDATE dormitory_applications SET status='CANCELLED',reviewed_at=:now,updated_at=:now
          WHERE selection_round_id=:id AND status='PENDING'"""),
            {"now": timestamp, "id": round_id},
        )
    else:
        snapshot_count = generate_snapshot(db, round_id)
        db.execute(
            text(
                "UPDATE dormitory_selection_rounds SET status='ARCHIVED',archived_at=:now,updated_at=:now WHERE id=:id"
            ),
            {"now": timestamp, "id": round_id},
        )
    status = {"open": "OPEN", "close": "CLOSED", "archive": "ARCHIVED"}[action]
    audit(
        db,
        admin,
        request,
        f"{action.upper()}_DORMITORY_ROUND",
        "DORMITORY_ROUND",
        round_id,
        reason,
        {"snapshotCount": snapshot_count},
        grant,
        before={"status": round_row["status"]},
        after={"status": status},
    )
    db.commit()
    return {
        "round": one(db, DORMITORY_ROUND_BY_ID, {"id": round_id}),
        "snapshotCount": snapshot_count,
    }


def selected_admin_round(db: Session, round_id: int | None) -> dict:
    round_row = (
        one(db, DORMITORY_ROUND_BY_ID, {"id": round_id})
        if round_id
        else (
            active_round(db)
            or one(db, "SELECT * FROM dormitory_selection_rounds WHERE status!='DRAFT' ORDER BY id DESC LIMIT 1")
        )
    )
    if not round_row:
        raise ApiError(404, "DORMITORY_ROUND_NOT_FOUND", DORMITORY_ROUND_NOT_FOUND_MESSAGE)
    return round_row


def dormitories_for_round(db: Session, round_row: dict) -> list[dict]:
    if round_row["status"] == "ARCHIVED":
        return archived_results(db, round_row["id"])
    return [
        dormitory_details(db, row["id"])
        for row in all_rows(
            db,
            "SELECT id FROM dormitories WHERE selection_round_id=:round ORDER BY id DESC",
            {"round": round_row["id"]},
        )
    ]


@router.get("/dormitories")
def admin_dormitories(
    request: Request,
    db: DB,
    round_id: Annotated[int | None, Query(alias="roundId")] = None,
    search: str = "",
) -> dict:
    admin = admin_user(request, db)
    round_row = selected_admin_round(db, round_id)
    rows = grade_filter(db, admin, dormitories_for_round(db, round_row), "DORMITORY_READ", "management_grade_id")
    if search.strip():
        value = search.strip().lower()
        rows = [row for row in rows if any(value in member["name"].lower() for member in row["members"])]
    return {"open": round_row["status"] == "OPEN", "round": round_row, "dormitories": rows}


def workbook_bytes(dormitories: list[dict]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "宿舍列表"
    sheet.append(
        [
            "宿舍编号",
            "宿舍名称",
            "性别",
            "楼栋",
            "房间号",
            "状态",
            "人数",
            "发起人",
            "成员 1",
            "成员 2",
            "成员 3",
            "成员 4",
            "创建时间",
        ]
    )
    status_labels = {"OPEN": "可申请", "FULL": "已满员", "CLOSED": "已关闭"}
    for dormitory in dormitories:
        members = sorted(dormitory["members"], key=lambda member: member["role"] != "INITIATOR")
        member_names = [f"{member['name']}（{member['grade']}）" for member in members]
        sheet.append(
            [
                spreadsheet_text(dormitory["dormitory_code"]),
                spreadsheet_text(dormitory["name"]),
                "男" if dormitory["gender"] == "MALE" else "女",
                spreadsheet_text(dormitory["building"] or "待分配"),
                spreadsheet_text(dormitory["room_number"] or "待分配"),
                status_labels.get(dormitory["status"], dormitory["status"]),
                f"{dormitory['member_count']}/{dormitory['capacity']}",
                spreadsheet_text(dormitory["initiator_name"]),
                *[spreadsheet_text(value) for value in (member_names + [""] * 4)[:4]],
                dormitory.get("created_at", ""),
            ]
        )
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


@router.get("/dormitories/export")
def export_dormitories(
    request: Request, db: DB, round_id: Annotated[int | None, Query(alias="roundId")] = None
) -> StreamingResponse:
    admin = admin_user(request, db)
    round_row = selected_admin_round(db, round_id)
    grade_ids = authorized_grade_ids(db, admin, "DORMITORY_EXPORT")
    if grade_ids is not None and not grade_ids:
        raise ApiError(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE)
    dormitories = [
        item
        for item in dormitories_for_round(db, round_row)
        if grade_ids is None or item["management_grade_id"] in grade_ids
    ]
    if admin["account_type"] == "SUPER_ADMIN":
        grant = {
            "permissionCode": "DORMITORY_EXPORT",
            "groupId": None,
            "scopeType": "GRADE",
            "scopeValue": ",".join(
                map(str, sorted({item["management_grade_id"] for item in dormitories if item["management_grade_id"]}))
            ),
        }
    else:
        group = next(
            group for group in active_admin_groups(db, admin["id"]) if "DORMITORY_EXPORT" in group["permissions"]
        )
        grant = {
            "permissionCode": "DORMITORY_EXPORT",
            "groupId": group["id"],
            "scopeType": "GRADE",
            "scopeValue": ",".join(map(str, group["gradeIds"])),
        }
    audit(
        db,
        admin,
        request,
        "EXPORT_DORMITORIES",
        "DORMITORY_ROUND",
        round_row["id"],
        metadata={"count": len(dormitories), "roundCode": round_row["code"]},
        grant=grant,
    )
    db.commit()
    filename = f"dormitories-{round_row['code']}-{date.today().isoformat()}.xlsx"
    return StreamingResponse(
        io.BytesIO(workbook_bytes(dormitories)),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.patch("/dormitories/{dormitory_id}/location")
def assign_location(dormitory_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    building = clean_text(body.get("building"), 40, True)
    room_number = clean_text(body.get("roomNumber"), 20, True)
    dormitory = one(db, "SELECT * FROM dormitories WHERE id=:id", {"id": dormitory_id})
    if not dormitory:
        raise ApiError(404, "DORMITORY_NOT_FOUND", "宿舍不存在")
    round_row = one(
        db, "SELECT status FROM dormitory_selection_rounds WHERE id=:id", {"id": dormitory["selection_round_id"]}
    )
    if round_row and round_row["status"] == "ARCHIVED":
        raise ApiError(409, "ROUND_ARCHIVED", "归档轮次不能再修改宿舍")
    grant = authorize(db, admin, "DORMITORY_LOCATION_ASSIGN", dormitory["management_grade_id"])
    db.execute(
        text("UPDATE dormitories SET building=:building,room_number=:room,updated_at=:now WHERE id=:id"),
        {"building": building, "room": room_number, "now": now(), "id": dormitory_id},
    )
    audit(
        db,
        admin,
        request,
        "ASSIGN_DORMITORY_LOCATION",
        "DORMITORY",
        dormitory_id,
        clean_text(body.get("reason"), 200, True),
        grant=grant,
        before={"building": dormitory["building"], "roomNumber": dormitory["room_number"]},
        after={"building": building, "roomNumber": room_number},
    )
    db.commit()
    return {"dormitory": dormitory_details(db, dormitory_id)}


@router.post("/dormitories/{dormitory_id}/close")
def close_dormitory(dormitory_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    reason = clean_text(body.get("reason"), 200, True)
    dormitory = one(db, "SELECT * FROM dormitories WHERE id=:id", {"id": dormitory_id})
    if not dormitory:
        raise ApiError(404, "DORMITORY_NOT_FOUND", "宿舍不存在")
    round_row = one(
        db, "SELECT status FROM dormitory_selection_rounds WHERE id=:id", {"id": dormitory["selection_round_id"]}
    )
    if round_row and round_row["status"] == "ARCHIVED":
        raise ApiError(409, "ROUND_ARCHIVED", "归档轮次不能再修改宿舍")
    grant = authorize(db, admin, "DORMITORY_CLOSE", dormitory["management_grade_id"])
    timestamp = now()
    db.execute(
        text("UPDATE dormitories SET status='CLOSED',updated_at=:now WHERE id=:id"),
        {"now": timestamp, "id": dormitory_id},
    )
    db.execute(
        text(
            "UPDATE dormitory_applications SET status='CANCELLED',updated_at=:now WHERE dormitory_id=:id AND status='PENDING'"
        ),
        {"now": timestamp, "id": dormitory_id},
    )
    audit(
        db,
        admin,
        request,
        "CLOSE_DORMITORY",
        "DORMITORY",
        dormitory_id,
        reason,
        grant=grant,
        before={"status": dormitory["status"]},
        after={"status": "CLOSED"},
    )
    db.commit()
    return {"dormitory": dormitory_details(db, dormitory_id)}


@router.get("/reports")
def reports(request: Request, db: DB, search: str = "") -> dict:
    admin = admin_user(request, db)
    rows = grade_filter(db, admin, report_rows(db), "REPORT_READ", "target_grade_id")
    if search.strip():
        rows = [row for row in rows if search.strip().lower() in row["reporter_name"].lower()]
    for report in rows:
        report["snapshot"] = json.loads(report["snapshot"] or "{}")
    return {"reports": rows}


@router.post("/reports/{report_id}/resolve")
def resolve_report(report_id: int, request: Request, body: dict, db: DB) -> dict:
    admin = admin_user(request, db)
    status = "REJECTED" if body.get("status") == "REJECTED" else "RESOLVED"
    resolution = clean_text(body.get("resolution"), 500, True)
    report = next((item for item in report_rows(db) if item["id"] == report_id), None)
    if not report:
        raise ApiError(404, "REPORT_NOT_FOUND", "举报不存在")
    grant = authorize(db, admin, "REPORT_RESOLVE", report["target_grade_id"])
    db.execute(
        text("UPDATE reports SET status=:status,resolution=:resolution,handled_by=:admin,handled_at=:now WHERE id=:id"),
        {"status": status, "resolution": resolution, "admin": admin["id"], "now": now(), "id": report_id},
    )
    audit(
        db,
        admin,
        request,
        "RESOLVE_REPORT",
        "REPORT",
        report_id,
        resolution,
        grant=grant,
        before={"status": report["status"]},
        after={"status": status},
    )
    db.commit()
    return {"ok": True}


@router.get("/audit-logs")
def audit_logs(request: Request, db: DB, search: str = "") -> dict:
    admin = admin_user(request, db)
    logs = all_rows(
        db,
        """SELECT a.*,COALESCE(NULLIF(a.admin_name_snapshot,''),u.name) AS admin_name
      FROM audit_logs a LEFT JOIN users u ON u.id=a.admin_id ORDER BY a.id DESC LIMIT 500""",
    )
    if admin["account_type"] != "SUPER_ADMIN":
        grade_ids = authorized_grade_ids(db, admin, "AUDIT_READ_SCOPED")
        if not grade_ids:
            raise ApiError(403, "PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE)
        logs = [
            log
            for log in logs
            if log["scope_type"] == "GRADE"
            and any(value.isdigit() and int(value) in grade_ids for value in str(log["scope_value"]).split(","))
        ]
    if search.strip():
        logs = [log for log in logs if search.strip().lower() in (log["admin_name"] or "").lower()]
    for log in logs[:200]:
        log["metadata"] = json.loads(log["metadata"] or "{}")
        log["before_snapshot"] = json.loads(log["before_snapshot"] or "{}")
        log["after_snapshot"] = json.loads(log["after_snapshot"] or "{}")
    return {"logs": logs[:200]}
