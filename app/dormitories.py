import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from .common import all_rows, clean_text, current_user, now, one, require_user
from .database import get_db
from .errors import ApiError
from .rate_limit import enforce_rate_limit
from .student import conversation_for_user, has_block

router = APIRouter(prefix="/api")
DB = Annotated[Session, Depends(get_db)]
ROUND_PARTICIPANT_EXISTS = "SELECT 1 AS found FROM dormitory_round_participants WHERE round_id=:round AND user_id=:user"


def begin_immediate(db: Session) -> None:
    db.rollback()
    db.connection().exec_driver_sql("BEGIN IMMEDIATE")


def active_round(db: Session) -> dict | None:
    return one(
        db,
        """SELECT r.*,(SELECT COUNT(*) FROM dormitory_round_participants
      WHERE round_id=r.id) AS participant_count FROM dormitory_selection_rounds r
      WHERE r.status='OPEN' ORDER BY r.id DESC LIMIT 1""",
    )


def require_open_round(db: Session, user_id: int | None = None) -> dict:
    round_row = active_round(db)
    if not round_row:
        raise ApiError(403, "DORMITORY_SELECTION_CLOSED", "自由选宿舍阶段已关闭")
    if user_id and not one(
        db,
        ROUND_PARTICIPANT_EXISTS,
        {"round": round_row["id"], "user": user_id},
    ):
        raise ApiError(403, "ROUND_PARTICIPATION_REQUIRED", "你不在当前选宿舍轮次的参与名单中")
    return round_row


def student_round(db: Session, user_id: int, round_id: int | None = None, required: bool = True) -> dict | None:
    if round_id:
        result = one(
            db,
            """SELECT r.* FROM dormitory_selection_rounds r JOIN dormitory_round_participants p
          ON p.round_id=r.id WHERE r.id=:round AND p.user_id=:user AND r.status!='DRAFT'""",
            {"round": round_id, "user": user_id},
        )
    else:
        result = one(
            db,
            """SELECT r.* FROM dormitory_selection_rounds r JOIN dormitory_round_participants p
          ON p.round_id=r.id WHERE p.user_id=:user AND r.status!='DRAFT'
          ORDER BY CASE r.status WHEN 'OPEN' THEN 0 WHEN 'CLOSED' THEN 1 ELSE 2 END,r.id DESC LIMIT 1""",
            {"user": user_id},
        )
    if not result and required:
        raise ApiError(404, "DORMITORY_ROUND_NOT_FOUND", "选宿舍轮次不存在")
    return result


def current_dormitory(db: Session, user_id: int, round_id: int | None = None) -> dict | None:
    if round_id is None:
        current = active_round(db)
        round_id = current["id"] if current else None
    if not round_id:
        return None
    return one(
        db,
        """SELECT d.*,dm.role AS current_user_role,dm.joined_at FROM dormitories d
      JOIN dormitory_members dm ON dm.dormitory_id=d.id WHERE dm.user_id=:user
      AND dm.selection_round_id=:round LIMIT 1""",
        {"user": user_id, "round": round_id},
    )


def dormitory_details(db: Session, dormitory_id: int, viewer_id: int | None = None) -> dict | None:
    dormitories = dormitory_details_many(db, [dormitory_id], viewer_id)
    return dormitories[0] if dormitories else None


def dormitory_details_many(db: Session, dormitory_ids: list[int], viewer_id: int | None = None) -> list[dict]:
    if not dormitory_ids:
        return []
    unique_ids = list(dict.fromkeys(dormitory_ids))
    id_params = {f"id_{index}": value for index, value in enumerate(unique_ids)}
    placeholders = ",".join(f":{name}" for name in id_params)
    dormitories = all_rows(
        db,
        """SELECT d.*,u.name AS initiator_name,
      COUNT(dm.user_id) AS member_count,
      MAX(CASE WHEN dm.user_id=:viewer THEN dm.role END) AS current_user_role
      FROM dormitories d JOIN users u ON u.id=d.initiator_id
      LEFT JOIN dormitory_members dm ON dm.dormitory_id=d.id
      WHERE d.id IN ("""
        + placeholders
        + ") GROUP BY d.id",
        {**id_params, "viewer": viewer_id},
    )
    members = all_rows(
        db,
        """SELECT dm.dormitory_id,dm.user_id,dm.role,dm.joined_at,u.name,u.grade,c.avatar_url
      FROM dormitory_members dm JOIN users u ON u.id=dm.user_id LEFT JOIN roommate_cards c ON c.user_id=u.id
      WHERE dm.dormitory_id IN ("""
        + placeholders
        + ") ORDER BY dm.dormitory_id,dm.joined_at,dm.user_id",
        id_params,
    )
    applications = (
        all_rows(
            db,
            """SELECT a.*,u.name AS applicant_name,
      u.grade AS applicant_grade,c.avatar_url AS applicant_avatar FROM dormitory_applications a
      JOIN dormitories d ON d.id=a.dormitory_id JOIN users u ON u.id=a.applicant_id
      LEFT JOIN roommate_cards c ON c.user_id=u.id WHERE a.dormitory_id IN ("""
            + placeholders
            + ") AND d.initiator_id=:viewer AND a.status='PENDING' ORDER BY a.dormitory_id,a.created_at",
            {**id_params, "viewer": viewer_id},
        )
        if viewer_id is not None
        else []
    )
    by_id = {item["id"]: item for item in dormitories}
    for dormitory in dormitories:
        dormitory["members"] = []
        dormitory["pending_applications"] = []
    for member in members:
        by_id[member.pop("dormitory_id")]["members"].append(member)
    for application in applications:
        by_id[application["dormitory_id"]]["pending_applications"].append(application)
    return [by_id[dormitory_id] for dormitory_id in dormitory_ids if dormitory_id in by_id]


def archived_results(db: Session, round_id: int) -> list[dict]:
    dormitories = all_rows(
        db,
        """SELECT s.*,s.id AS snapshot_id,s.source_dormitory_id AS id,
      s.dormitory_name AS name,s.dormitory_status AS status,s.initiator_name_snapshot AS initiator_name,
      (SELECT COUNT(*) FROM dormitory_result_members WHERE snapshot_id=s.id) AS member_count
      FROM dormitory_result_snapshots s WHERE s.selection_round_id=:round ORDER BY s.id""",
        {"round": round_id},
    )
    if not dormitories:
        return []
    snapshot_params = {f"snapshot_{index}": item["snapshot_id"] for index, item in enumerate(dormitories)}
    placeholders = ",".join(f":{name}" for name in snapshot_params)
    members = all_rows(
        db,
        """SELECT snapshot_id,source_user_id AS user_id,
      login_identifier_snapshot AS login_identifier,name_snapshot AS name,grade_snapshot AS grade,
      gender_snapshot AS gender,major_snapshot AS major,member_role AS role,joined_at
      FROM dormitory_result_members WHERE snapshot_id IN ("""
        + placeholders
        + ") ORDER BY snapshot_id,joined_at,login_identifier_snapshot",
        snapshot_params,
    )
    by_snapshot = {item["snapshot_id"]: item for item in dormitories}
    for dormitory in dormitories:
        dormitory["members"] = []
    for member in members:
        by_snapshot[member.pop("snapshot_id")]["members"].append(member)
    return dormitories


def archived_result_for_student(db: Session, round_id: int, user_id: int) -> list[dict]:
    dormitory = one(
        db,
        """SELECT s.source_dormitory_id AS id,s.dormitory_code,s.dormitory_name AS name,
      s.building,s.room_number,s.capacity,s.dormitory_status AS status,
      s.initiator_user_id AS initiator_id,s.initiator_name_snapshot AS initiator_name,
      viewer.member_role AS current_user_role,
      (SELECT COUNT(*) FROM dormitory_result_members WHERE snapshot_id=s.id) AS member_count,
      s.id AS snapshot_id FROM dormitory_result_snapshots s
      JOIN dormitory_result_members viewer ON viewer.snapshot_id=s.id
      WHERE s.selection_round_id=:round AND viewer.source_user_id=:user""",
        {"round": round_id, "user": user_id},
    )
    if not dormitory:
        return []
    dormitory["members"] = all_rows(
        db,
        """SELECT source_user_id AS user_id,name_snapshot AS name,grade_snapshot AS grade,
      member_role AS role,joined_at FROM dormitory_result_members
      WHERE snapshot_id=:snapshot ORDER BY joined_at,source_user_id""",
        {"snapshot": dormitory.pop("snapshot_id")},
    )
    return [dormitory]


def current_result_for_student(db: Session, round_id: int, user_id: int) -> list[dict]:
    dormitory = one(
        db,
        """SELECT d.id,d.dormitory_code,d.name,d.building,d.room_number,d.capacity,d.status,
      d.initiator_id,u.name AS initiator_name,viewer.role AS current_user_role,
      (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id=d.id) AS member_count
      FROM dormitories d JOIN dormitory_members viewer ON viewer.dormitory_id=d.id
      JOIN users u ON u.id=d.initiator_id
      WHERE d.selection_round_id=:round AND viewer.user_id=:user""",
        {"round": round_id, "user": user_id},
    )
    if not dormitory:
        return []
    dormitory["members"] = all_rows(
        db,
        """SELECT dm.user_id,u.name,u.grade,dm.role,dm.joined_at,c.avatar_url
      FROM dormitory_members dm JOIN users u ON u.id=dm.user_id
      LEFT JOIN roommate_cards c ON c.user_id=u.id
      WHERE dm.dormitory_id=:dormitory ORDER BY dm.joined_at,dm.user_id""",
        {"dormitory": dormitory["id"]},
    )
    return [dormitory]


def generate_snapshot(db: Session, round_id: int) -> int:
    timestamp = now()
    db.execute(text("DELETE FROM dormitory_result_snapshots WHERE selection_round_id=:round"), {"round": round_id})
    dormitories = all_rows(
        db,
        """SELECT d.*,u.name AS initiator_name FROM dormitories d
      JOIN users u ON u.id=d.initiator_id WHERE d.selection_round_id=:round ORDER BY d.id""",
        {"round": round_id},
    )
    for dormitory in dormitories:
        result = db.execute(
            text("""INSERT INTO dormitory_result_snapshots(selection_round_id,source_dormitory_id,
          dormitory_code,dormitory_name,building,room_number,capacity,dormitory_status,management_grade_id,gender,
          initiator_user_id,initiator_name_snapshot,generated_at) VALUES(:round,:source,:code,:name,:building,:room,
          :capacity,:status,:grade,:gender,:initiator,:initiator_name,:generated)"""),
            {
                "round": round_id,
                "source": dormitory["id"],
                "code": dormitory["dormitory_code"],
                "name": dormitory["name"],
                "building": dormitory["building"],
                "room": dormitory["room_number"],
                "capacity": dormitory["capacity"],
                "status": dormitory["status"],
                "grade": dormitory["management_grade_id"],
                "gender": dormitory["gender"],
                "initiator": dormitory["initiator_id"],
                "initiator_name": dormitory["initiator_name"],
                "generated": timestamp,
            },
        )
        members = all_rows(
            db,
            """SELECT dm.user_id,dm.role,dm.joined_at,u.login_identifier,u.name,u.grade,u.gender,u.major
          FROM dormitory_members dm JOIN users u ON u.id=dm.user_id WHERE dm.dormitory_id=:id
          ORDER BY dm.joined_at,dm.user_id""",
            {"id": dormitory["id"]},
        )
        for member in members:
            db.execute(
                text("""INSERT INTO dormitory_result_members(snapshot_id,source_user_id,login_identifier_snapshot,
              name_snapshot,grade_snapshot,gender_snapshot,major_snapshot,member_role,joined_at)
              VALUES(:snapshot,:user,:login,:name,:grade,:gender,:major,:role,:joined)"""),
                {
                    "snapshot": result.lastrowid,
                    "user": member["user_id"],
                    "login": member["login_identifier"],
                    "name": member["name"],
                    "grade": member["grade"],
                    "gender": member["gender"],
                    "major": member["major"],
                    "role": member["role"],
                    "joined": member["joined_at"],
                },
            )
    return len(dormitories)


def refresh_status(db: Session, dormitory_id: int) -> None:
    dormitory = one(
        db,
        """SELECT d.capacity,d.status,(SELECT COUNT(*) FROM dormitory_members
      WHERE dormitory_id=d.id) AS member_count FROM dormitories d WHERE d.id=:id""",
        {"id": dormitory_id},
    )
    if not dormitory or dormitory["status"] == "CLOSED":
        return
    status = "FULL" if dormitory["member_count"] >= dormitory["capacity"] else "OPEN"
    db.execute(
        text("UPDATE dormitories SET status=:status,updated_at=:now WHERE id=:id"),
        {"status": status, "now": now(), "id": dormitory_id},
    )


def leave_dormitory(
    db: Session, user_id: int, round_id: int | None = None, reason: str = "成员退出宿舍"
) -> dict | None:
    dormitory = current_dormitory(db, user_id, round_id)
    if not dormitory:
        return None
    membership = one(
        db,
        "SELECT role FROM dormitory_members WHERE dormitory_id=:dormitory AND user_id=:user",
        {"dormitory": dormitory["id"], "user": user_id},
    )
    db.execute(
        text("DELETE FROM dormitory_members WHERE dormitory_id=:dormitory AND user_id=:user"),
        {"dormitory": dormitory["id"], "user": user_id},
    )
    if membership["role"] == "INITIATOR":
        successor = one(
            db,
            "SELECT user_id FROM dormitory_members WHERE dormitory_id=:id ORDER BY joined_at,user_id LIMIT 1",
            {"id": dormitory["id"]},
        )
        if successor:
            db.execute(
                text("UPDATE dormitory_members SET role='INITIATOR' WHERE dormitory_id=:id AND user_id=:user"),
                {"id": dormitory["id"], "user": successor["user_id"]},
            )
            db.execute(
                text("UPDATE dormitories SET initiator_id=:user,updated_at=:now WHERE id=:id"),
                {"user": successor["user_id"], "now": now(), "id": dormitory["id"]},
            )
        else:
            db.execute(
                text("""UPDATE messages SET message_type='TEXT',application_id=NULL,
              body='原宿舍已删除 · '||body WHERE application_id IN
              (SELECT id FROM dormitory_applications WHERE dormitory_id=:id)"""),
                {"id": dormitory["id"]},
            )
            db.execute(text("DELETE FROM dormitories WHERE id=:id"), {"id": dormitory["id"]})
            return {"dormitoryId": dormitory["id"], "reason": reason, "deleted": True}
    timestamp = now()
    db.execute(
        text("""UPDATE dormitory_applications SET status='CANCELLED',updated_at=:now,reviewed_at=:now
      WHERE applicant_id=:user AND status='PENDING'"""),
        {"now": timestamp, "user": user_id},
    )
    refresh_status(db, dormitory["id"])
    return {"dormitoryId": dormitory["id"], "reason": reason}


@router.get("/dormitory-selection")
def selection_status(request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    round_row = active_round(db)
    participating = bool(
        round_row
        and one(
            db,
            ROUND_PARTICIPANT_EXISTS,
            {"round": round_row["id"], "user": user["id"]},
        )
    )
    return {"open": participating, "round": round_row, "participating": participating}


@router.get("/dormitory-rounds")
def rounds(request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    return {
        "rounds": all_rows(
            db,
            """SELECT r.*,(SELECT COUNT(*) FROM dormitory_result_snapshots
      WHERE selection_round_id=r.id) AS result_count FROM dormitory_selection_rounds r
      JOIN dormitory_round_participants p ON p.round_id=r.id WHERE p.user_id=:user AND r.status!='DRAFT'
      ORDER BY r.id DESC""",
            {"user": user["id"]},
        )
    }


@router.get("/dormitory-rounds/{round_id}/results")
def round_results(round_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    round_row = student_round(db, user["id"], round_id)
    dormitories = (
        archived_result_for_student(db, round_id, user["id"])
        if round_row["status"] == "ARCHIVED"
        else current_result_for_student(db, round_id, user["id"])
    )
    return {"round": round_row, "dormitories": dormitories}


@router.get("/dormitories")
def dormitories(
    request: Request,
    db: DB,
    round_id: Annotated[int | None, Query(alias="roundId")] = None,
    search: Annotated[str, Query(max_length=100)] = "",
    limit: Annotated[int, Query(ge=1, le=15)] = 15,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    user = current_user(request, db)
    require_user(user)
    round_row = student_round(db, user["id"], round_id, False)
    if not round_row:
        return {"open": False, "round": None, "dormitories": [], "total": 0}
    conditions = [
        "d.selection_round_id=:round",
        "d.gender=:gender",
        "d.status IN('OPEN','FULL','CLOSED')",
    ]
    parameters = {"round": round_row["id"], "gender": user["gender"], "viewer": user["id"]}
    if search.strip():
        conditions.append(
            """EXISTS(SELECT 1 FROM dormitory_members searched_members
            JOIN users searched_users ON searched_users.id=searched_members.user_id
            WHERE searched_members.dormitory_id=d.id AND instr(lower(searched_users.name),:search)>0)"""
        )
        parameters["search"] = search.strip().lower()
    where = " AND ".join(conditions)
    total = one(db, f"SELECT COUNT(*) AS total FROM dormitories d WHERE {where}", parameters)["total"]
    rows = all_rows(
        db,
        f"""SELECT d.id FROM dormitories d LEFT JOIN dormitory_members viewer
      ON viewer.dormitory_id=d.id AND viewer.user_id=:viewer WHERE {where}
      ORDER BY CASE WHEN viewer.user_id IS NULL THEN 1 ELSE 0 END,d.created_at DESC,d.id DESC
      LIMIT :limit OFFSET :offset""",
        {**parameters, "limit": limit, "offset": offset},
    )
    result = dormitory_details_many(db, [row["id"] for row in rows], user["id"])
    return {
        "open": round_row["status"] == "OPEN",
        "round": round_row,
        "dormitories": result,
        "total": total,
    }


@router.get("/me/dormitory")
def my_dormitory(request: Request, db: DB, round_id: Annotated[int | None, Query(alias="roundId")] = None) -> dict:
    user = current_user(request, db)
    require_user(user)
    round_row = student_round(db, user["id"], round_id, False)
    if not round_row:
        return {"open": False, "round": None, "dormitory": None, "applications": []}
    dormitory = current_dormitory(db, user["id"], round_row["id"])
    applications = all_rows(
        db,
        """SELECT a.*,d.name AS dormitory_name,d.dormitory_code,r.name AS selection_round_name
      FROM dormitory_applications a JOIN dormitories d ON d.id=a.dormitory_id
      JOIN dormitory_selection_rounds r ON r.id=a.selection_round_id WHERE a.applicant_id=:user
      AND a.selection_round_id=:round ORDER BY a.created_at DESC""",
        {"user": user["id"], "round": round_row["id"]},
    )
    return {
        "open": round_row["status"] == "OPEN",
        "round": round_row,
        "dormitory": dormitory_details(db, dormitory["id"], user["id"]) if dormitory else None,
        "applications": applications,
    }


@router.post("/dormitories", status_code=201)
def create_dormitory(request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    name = clean_text(body.get("name"), 40, True)
    if user["gender"] not in ("MALE", "FEMALE"):
        raise ApiError(409, "GENDER_REQUIRED", "请联系管理员补充性别信息")
    begin_immediate(db)
    try:
        round_row = require_open_round(db, user["id"])
        if current_dormitory(db, user["id"], round_row["id"]):
            raise ApiError(409, "ALREADY_IN_DORMITORY", "你在本轮已经加入一个宿舍")
        timestamp = now()
        code = f"R{datetime.now(UTC).year}-{secrets.token_hex(3).upper()}"
        result = db.execute(
            text("""INSERT INTO dormitories(selection_round_id,dormitory_code,name,building,
          room_number,capacity,initiator_id,management_grade_id,gender,created_at,updated_at)
          VALUES(:round,:code,:name,'','',4,:user,:grade,:gender,:now,:now)"""),
            {
                "round": round_row["id"],
                "code": code,
                "name": name,
                "user": user["id"],
                "grade": user["grade_id"],
                "gender": user["gender"],
                "now": timestamp,
            },
        )
        db.execute(
            text("""INSERT INTO dormitory_members(selection_round_id,dormitory_id,user_id,role,joined_at)
          VALUES(:round,:dormitory,:user,'INITIATOR',:now)"""),
            {"round": round_row["id"], "dormitory": result.lastrowid, "user": user["id"], "now": timestamp},
        )
        db.commit()
    except (IntegrityError, OperationalError) as error:
        db.rollback()
        raise ApiError(409, "DORMITORY_CONFLICT", "宿舍状态已变化，请刷新后重试") from error
    return {"dormitory": dormitory_details(db, result.lastrowid, user["id"])}


@router.get("/dormitories/{dormitory_id}")
def dormitory_detail(dormitory_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    dormitory = dormitory_details(db, dormitory_id, user["id"])
    if not dormitory:
        raise ApiError(404, "DORMITORY_NOT_FOUND", "宿舍不存在")
    if dormitory["gender"] != user["gender"]:
        raise ApiError(404, "DORMITORY_NOT_FOUND", "宿舍不存在")
    round_row = student_round(db, user["id"], dormitory["selection_round_id"])
    return {"open": round_row["status"] == "OPEN", "round": round_row, "dormitory": dormitory}


@router.post("/conversations/{conversation_id}/dormitory-applications", status_code=201)
def apply_dormitory(conversation_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    conversation = conversation_for_user(db, conversation_id, user["id"])
    note = clean_text(body.get("note"), 300)
    try:
        dormitory_id = int(body.get("dormitoryId"))
    except (TypeError, ValueError):
        dormitory_id = 0
    ip_address = request.client.host if request.client else "unknown"
    enforce_rate_limit(
        "dormitory-application", f"{user['id']}:{dormitory_id}", 3, 60, "DORMITORY_APPLICATION_RATE_LIMITED"
    )
    enforce_rate_limit("dormitory-application-user", str(user["id"]), 10, 60, "DORMITORY_APPLICATION_RATE_LIMITED")
    enforce_rate_limit("dormitory-application-ip", ip_address, 30, 60, "DORMITORY_APPLICATION_RATE_LIMITED")
    begin_immediate(db)
    round_row = require_open_round(db, user["id"])
    if current_dormitory(db, user["id"], round_row["id"]):
        raise ApiError(409, "ALREADY_IN_DORMITORY", "你在本轮已经加入一个宿舍")
    dormitory = dormitory_details(db, dormitory_id, user["id"])
    if (
        not dormitory
        or dormitory["selection_round_id"] != round_row["id"]
        or dormitory["status"] != "OPEN"
        or dormitory["member_count"] >= dormitory["capacity"]
    ):
        raise ApiError(409, "DORMITORY_UNAVAILABLE", "宿舍当前不可申请")
    if dormitory["gender"] != user["gender"]:
        raise ApiError(403, "SAME_GENDER_REQUIRED", "只能申请加入同性别宿舍")
    other_id = (
        conversation["student_b_id"] if conversation["student_a_id"] == user["id"] else conversation["student_a_id"]
    )
    if other_id != dormitory["initiator_id"]:
        raise ApiError(403, "INITIATOR_CONVERSATION_REQUIRED", "申请必须发送给宿舍发起人")
    if has_block(db, user["id"], other_id):
        raise ApiError(403, "USER_BLOCKED", "当前无法发送申请")
    if one(
        db,
        "SELECT 1 AS found FROM dormitory_applications WHERE dormitory_id=:dormitory AND applicant_id=:user AND status='PENDING'",
        {"dormitory": dormitory_id, "user": user["id"]},
    ):
        raise ApiError(409, "APPLICATION_EXISTS", "你已提交过待审核申请")
    timestamp = now()
    result = db.execute(
        text("""INSERT INTO dormitory_applications(selection_round_id,dormitory_id,applicant_id,
      conversation_id,note,status,created_at,updated_at) VALUES(:round,:dormitory,:user,:conversation,:note,'PENDING',:now,:now)"""),
        {
            "round": round_row["id"],
            "dormitory": dormitory_id,
            "user": user["id"],
            "conversation": conversation_id,
            "note": note,
            "now": timestamp,
        },
    )
    message = db.execute(
        text("""INSERT INTO messages(conversation_id,sender_id,body,message_type,application_id,created_at)
      VALUES(:conversation,:user,:body,'DORMITORY_APPLICATION',:application,:now)"""),
        {
            "conversation": conversation_id,
            "user": user["id"],
            "body": note or f"申请加入 {dormitory['name']}",
            "application": result.lastrowid,
            "now": timestamp,
        },
    )
    db.execute(
        text("UPDATE dormitory_applications SET message_id=:message WHERE id=:id"),
        {"message": message.lastrowid, "id": result.lastrowid},
    )
    db.execute(
        text("UPDATE conversations SET last_message_at=:now WHERE id=:id"), {"now": timestamp, "id": conversation_id}
    )
    db.commit()
    return {"application": one(db, "SELECT * FROM dormitory_applications WHERE id=:id", {"id": result.lastrowid})}


def approve_application(db: Session, application: dict, round_id: int, application_id: int) -> None:
    if application["dormitory_status"] != "OPEN" or application["member_count"] >= application["capacity"]:
        raise ApiError(409, "DORMITORY_FULL", "宿舍已满员")
    if not one(db, ROUND_PARTICIPANT_EXISTS, {"round": round_id, "user": application["applicant_id"]}):
        raise ApiError(409, "APPLICANT_NOT_PARTICIPATING", "申请人不在本轮参与名单中")
    if current_dormitory(db, application["applicant_id"], round_id):
        raise ApiError(409, "APPLICANT_JOINED_OTHER", "申请人已加入其他宿舍")
    if application["applicant_gender"] != application["dormitory_gender"]:
        raise ApiError(409, "SAME_GENDER_REQUIRED", "申请人与宿舍性别不一致")
    db.execute(
        text("""INSERT INTO dormitory_members(selection_round_id,dormitory_id,user_id,role,joined_at)
      VALUES(:round,:dormitory,:user,'MEMBER',:now)"""),
        {
            "round": round_id,
            "dormitory": application["dormitory_id"],
            "user": application["applicant_id"],
            "now": now(),
        },
    )
    db.execute(
        text("""UPDATE dormitory_applications SET status='CANCELLED',updated_at=:now WHERE selection_round_id=:round
      AND applicant_id=:user AND status='PENDING' AND id!=:id"""),
        {"now": now(), "round": round_id, "user": application["applicant_id"], "id": application_id},
    )


@router.post("/dormitory-applications/{application_id}/{action}")
def review_application(application_id: int, action: str, request: Request, db: DB) -> dict:
    if action not in ("approve", "reject"):
        raise ApiError(404, "NOT_FOUND", "接口不存在")
    user = current_user(request, db)
    require_user(user)
    begin_immediate(db)
    round_row = require_open_round(db, user["id"])
    application = one(
        db,
        """SELECT a.*,d.initiator_id,d.capacity,d.status AS dormitory_status,
      d.gender AS dormitory_gender,applicant.gender AS applicant_gender,
      (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id=d.id) AS member_count
      FROM dormitory_applications a JOIN dormitories d ON d.id=a.dormitory_id
      JOIN users applicant ON applicant.id=a.applicant_id WHERE a.id=:id""",
        {"id": application_id},
    )
    if not application or application["initiator_id"] != user["id"]:
        raise ApiError(403, "INITIATOR_ONLY", "仅宿舍发起人可以审核申请")
    if application["selection_round_id"] != round_row["id"]:
        raise ApiError(409, "ROUND_NOT_OPEN", "该申请所属轮次已经结束")
    if application["status"] != "PENDING":
        raise ApiError(409, "APPLICATION_REVIEWED", "申请已处理")
    if action == "approve":
        approve_application(db, application, round_row["id"], application_id)
    timestamp = now()
    db.execute(
        text("""UPDATE dormitory_applications SET status=:status,reviewed_by=:reviewer,
      reviewed_at=:now,updated_at=:now WHERE id=:id"""),
        {
            "status": "APPROVED" if action == "approve" else "REJECTED",
            "reviewer": user["id"],
            "now": timestamp,
            "id": application_id,
        },
    )
    refresh_status(db, application["dormitory_id"])
    db.commit()
    return {"dormitory": dormitory_details(db, application["dormitory_id"], user["id"])}


@router.delete("/dormitories/{dormitory_id}/members/{member_id}")
def remove_member(dormitory_id: int, member_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    begin_immediate(db)
    round_row = require_open_round(db, user["id"])
    dormitory = dormitory_details(db, dormitory_id, user["id"])
    if not dormitory or dormitory["initiator_id"] != user["id"]:
        raise ApiError(403, "INITIATOR_ONLY", "仅宿舍发起人可以移除成员")
    if dormitory["selection_round_id"] != round_row["id"]:
        raise ApiError(409, "ROUND_NOT_OPEN", "该宿舍所属轮次已经结束")
    if member_id == user["id"]:
        raise ApiError(400, "USE_LEAVE_ENDPOINT", "发起人请使用退出宿舍")
    result = db.execute(
        text("DELETE FROM dormitory_members WHERE dormitory_id=:dormitory AND user_id=:user"),
        {"dormitory": dormitory_id, "user": member_id},
    )
    if not result.rowcount:
        raise ApiError(404, "MEMBER_NOT_FOUND", "宿舍成员不存在")
    refresh_status(db, dormitory_id)
    db.commit()
    return {"dormitory": dormitory_details(db, dormitory_id, user["id"])}


@router.post("/me/dormitory/leave")
def leave(request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    begin_immediate(db)
    round_row = require_open_round(db, user["id"])
    result = leave_dormitory(db, user["id"], round_row["id"])
    if not result:
        raise ApiError(404, "DORMITORY_NOT_FOUND", "你尚未加入宿舍")
    db.commit()
    return {"ok": True}
