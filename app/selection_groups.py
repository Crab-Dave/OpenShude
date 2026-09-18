from sqlalchemy.orm import Session

from .common import all_rows, clean_text, one
from .errors import ApiError

SELECTION_GROUP_BY_ID = "SELECT * FROM student_selection_groups WHERE id=:id"


def selection_group_details(db: Session, group: dict, include_login_identifier: bool = False) -> dict:
    fields = "u.id,u.name,u.grade,u.major,u.status"
    if include_login_identifier:
        fields = "u.id,u.login_identifier,u.name,u.grade,u.major,u.status"
    return {
        **group,
        "members": all_rows(
            db,
            f"""SELECT {fields} FROM student_selection_group_members m JOIN users u ON u.id=m.user_id
            WHERE m.group_id=:id ORDER BY u.name,u.id""",
            {"id": group["id"]},
        ),
    }


def validate_selection_group(db: Session, body: dict) -> tuple[str, str, list[int]]:
    name = clean_text(body.get("name"), 80, True)
    description = clean_text(body.get("description"), 500)
    values = body.get("memberIds")
    member_ids = sorted({int(value) for value in values if str(value).isdigit()}) if isinstance(values, list) else []
    if not member_ids:
        raise ApiError(400, "SELECTION_GROUP_MEMBERS_REQUIRED", "请至少选择一名学生")
    for user_id in member_ids:
        if not one(
            db,
            """SELECT 1 AS found FROM users WHERE id=:id AND account_type='USER'
            AND status IN('ACTIVE','PENDING_ACTIVATION')""",
            {"id": user_id},
        ):
            raise ApiError(400, "INVALID_SELECTION_GROUP_MEMBER", "群组成员包含无效学生")
    return name, description, member_ids


def selection_group_name_exists(db: Session, owner_id: int | None, name: str, exclude_id: int = 0) -> bool:
    return (
        one(
            db,
            """SELECT 1 AS found FROM student_selection_groups
            WHERE created_by IS :owner AND name=:name AND id!=:exclude""",
            {"owner": owner_id, "name": name, "exclude": exclude_id},
        )
        is not None
    )


def selectable_groups(db: Session, user_id: int) -> list[dict]:
    return all_rows(
        db,
        """SELECT g.*,CASE WHEN g.created_by=:user THEN 'OWN' ELSE 'ADMIN' END AS source
        FROM student_selection_groups g JOIN users creator ON creator.id=g.created_by
        WHERE g.created_by=:user OR (creator.account_type='SUPER_ADMIN' AND g.is_public=1)
        ORDER BY CASE WHEN g.created_by=:user THEN 0 ELSE 1 END,g.name,g.id""",
        {"user": user_id},
    )


def admin_selectable_groups(db: Session, admin_id: int) -> list[dict]:
    return all_rows(
        db,
        """SELECT g.*,CASE WHEN g.created_by=:admin THEN 'OWN' ELSE 'ADMIN' END AS source
        FROM student_selection_groups g JOIN users creator ON creator.id=g.created_by
        WHERE creator.account_type='SUPER_ADMIN'
        ORDER BY CASE WHEN g.created_by=:admin THEN 0 ELSE 1 END,g.name,g.id""",
        {"admin": admin_id},
    )
