import base64
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from .common import all_rows, clean_text, current_user, now, one, require_user
from .config import get_settings
from .database import get_db
from .errors import ApiError
from .rate_limit import enforce_rate_limit

router = APIRouter(prefix="/api")
DB = Annotated[Session, Depends(get_db)]
MESSAGE_PAGE_SIZE = 50
CARD_NOT_FOUND_MESSAGE = "室友卡片不存在"
AVATAR_SIGNATURES = {
    "data:image/png;base64": lambda data: data.startswith(b"\x89PNG\r\n\x1a\n"),
    "data:image/jpeg;base64": lambda data: data.startswith(b"\xff\xd8\xff"),
    "data:image/webp;base64": lambda data: data.startswith(b"RIFF") and data[8:12] == b"WEBP",
}
AVATAR_URL_PATTERN = re.compile(r"^/api/avatars/(?P<digest>[0-9a-f]{64})\.(?P<extension>png|jpg|webp)$")
AVATAR_MIME_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}

CARD_SELECT = """
SELECT c.id,c.user_id,c.avatar_url,c.origin_province,c.origin_city,c.clothing_size,
 c.summer_temp_min,c.summer_temp_max,c.winter_temp_min,c.winter_temp_max,
 c.wake_up_time,c.sleep_time,c.nap_habit,c.personal_cleanliness,c.roommate_cleanliness,
 c.common_space_maintenance,c.unacceptable_hygiene,c.one_sentence_intro,c.personality_text,
 c.roommate_personality_text,c.interests_text,c.gaming_self,c.gaming_roommate,c.keyboard_noise_text,
 c.media_noise_text,c.self_acknowledged_shortcoming,c.additional_note,c.status,c.hidden_reason,
 c.published_at,c.created_at,c.updated_at,u.name,u.grade,u.grade_id,u.gender,u.major,u.status AS user_status,
 MAX(1,(SELECT COUNT(*) FROM dormitory_members peers WHERE peers.dormitory_id=(
   SELECT own.dormitory_id FROM dormitory_members own WHERE own.user_id=c.user_id
   AND own.selection_round_id=(SELECT id FROM dormitory_selection_rounds WHERE status='OPEN' ORDER BY id DESC LIMIT 1)
   LIMIT 1))) AS team_member_count
FROM roommate_cards c JOIN users u ON u.id=c.user_id
"""


def card_by_user(db: Session, user_id: int) -> dict | None:
    return one(db, CARD_SELECT + " WHERE c.user_id=:id", {"id": user_id})


def card_by_id(db: Session, card_id: int) -> dict | None:
    return one(db, CARD_SELECT + " WHERE c.id=:id", {"id": card_id})


def card_for_student(card: dict, user_id: int) -> dict:
    result = dict(card)
    if card["user_id"] != user_id:
        result.pop("clothing_size", None)
    return result


def has_block(db: Session, first: int, second: int) -> bool:
    return (
        one(
            db,
            """SELECT 1 AS found FROM blocks WHERE
      (blocker_id=:a AND blocked_id=:b) OR (blocker_id=:b AND blocked_id=:a)""",
            {"a": first, "b": second},
        )
        is not None
    )


def conversation_for_user(db: Session, conversation_id: int, user_id: int) -> dict:
    conversation = one(
        db,
        """SELECT * FROM conversations WHERE id=:id
      AND (student_a_id=:user OR student_b_id=:user)""",
        {"id": conversation_id, "user": user_id},
    )
    if not conversation:
        raise ApiError(404, "CONVERSATION_NOT_FOUND", "会话不存在")
    return conversation


def number(value: object) -> int | float | None:
    if value in ("", None):
        return None
    try:
        result = float(value)
        return int(result) if result.is_integer() else result
    except (TypeError, ValueError):
        return None


def validated_avatar(value: object) -> str:
    avatar = clean_text(value, 3_000_000)
    if not avatar or avatar.startswith("/assets/") or AVATAR_URL_PATTERN.fullmatch(avatar):
        return avatar
    header, separator, encoded = avatar.partition(",")
    mime = header.lower()
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except ValueError:
        decoded = b""
    if not separator or mime not in AVATAR_SIGNATURES or not AVATAR_SIGNATURES[mime](decoded):
        raise ApiError(400, "INVALID_AVATAR", "头像格式不受支持")
    if len(decoded) > 2 * 1024 * 1024:
        raise ApiError(413, "AVATAR_TOO_LARGE", "头像不能超过 2 MB")
    return avatar


def store_avatar(avatar: str) -> str:
    header, _, encoded = avatar.partition(",")
    decoded = base64.b64decode(encoded, validate=True)
    extension = {
        "data:image/png;base64": "png",
        "data:image/jpeg;base64": "jpg",
        "data:image/webp;base64": "webp",
    }[header.lower()]
    digest = hashlib.sha256(decoded).hexdigest()
    directory = Path(get_settings().avatar_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{digest}.{extension}"
    if not target.exists():
        try:
            with target.open("xb") as output:
                output.write(decoded)
        except FileExistsError:
            pass
    return f"/api/avatars/{digest}.{extension}"


def card_input(body: dict) -> dict:
    if any(field in body for field in ("name", "grade", "gender", "major")):
        raise ApiError(403, "IDENTITY_FIELDS_READ_ONLY", "姓名、年级、性别和专业只能由管理员修改")

    avatar = validated_avatar(body.get("avatar_url"))
    clothing = clean_text(body.get("clothing_size"), 8)
    if clothing and clothing not in ("S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"):
        raise ApiError(400, "INVALID_CLOTHING_SIZE", "院服尺码无效")
    personal = clean_text(body.get("personal_cleanliness"), 20)
    roommate = clean_text(body.get("roommate_cleanliness"), 20)
    if any(value and value not in ("BASIC", "TIDY", "STRICT") for value in (personal, roommate)):
        raise ApiError(400, "INVALID_CLEANLINESS", "宿舍整洁选项无效")
    common = clean_text(body.get("common_space_maintenance"), 20)
    if common and common not in ("USABLE", "RESTORE", "CLEAN_TOGETHER", "NEGOTIABLE"):
        raise ApiError(400, "INVALID_COMMON_SPACE_MAINTENANCE", "公共空间维护选项无效")
    limits = {
        "origin_province": 30,
        "origin_city": 30,
        "wake_up_time": 120,
        "sleep_time": 120,
        "nap_habit": 120,
        "unacceptable_hygiene": 300,
        "one_sentence_intro": 100,
        "personality_text": 300,
        "roommate_personality_text": 300,
        "interests_text": 400,
        "gaming_self": 300,
        "gaming_roommate": 300,
        "keyboard_noise_text": 300,
        "media_noise_text": 300,
        "self_acknowledged_shortcoming": 200,
        "additional_note": 500,
    }
    result = {field: clean_text(body.get(field), maximum) for field, maximum in limits.items()}
    result.update(
        {
            "avatar_url": avatar,
            "clothing_size": clothing,
            "personal_cleanliness": personal,
            "roommate_cleanliness": roommate,
            "common_space_maintenance": common,
        }
    )
    for field in ("summer_temp_min", "summer_temp_max", "winter_temp_min", "winter_temp_max"):
        result[field] = number(body.get(field))
    return result


@router.get("/avatars/{filename}")
def avatar_file(filename: str, request: Request, db: DB) -> FileResponse:
    require_user(current_user(request, db))
    match = AVATAR_URL_PATTERN.fullmatch(f"/api/avatars/{filename}")
    if not match:
        raise ApiError(404, "AVATAR_NOT_FOUND", "头像不存在")
    avatar_root = Path(get_settings().avatar_dir).resolve()
    target = (avatar_root / filename).resolve()
    if not target.is_relative_to(avatar_root):
        raise ApiError(404, "AVATAR_NOT_FOUND", "头像不存在")
    if target.is_symlink() or not target.is_file():
        raise ApiError(404, "AVATAR_NOT_FOUND", "头像不存在")
    return FileResponse(target, media_type=AVATAR_MIME_TYPES[match["extension"]])


def validate_publish(card: dict) -> None:
    temperatures = [
        card.get(field) for field in ("summer_temp_min", "summer_temp_max", "winter_temp_min", "winter_temp_max")
    ]
    if any(not isinstance(value, (int, float)) or value < 10 or value > 35 for value in temperatures):
        raise ApiError(400, "INVALID_TEMPERATURE", "空调温度需填写 10 至 35°C 的有效范围")
    if temperatures[0] > temperatures[1] or temperatures[2] > temperatures[3]:
        raise ApiError(400, "INVALID_TEMPERATURE_RANGE", "温度下限不能高于上限")
    fields = (
        "major",
        "avatar_url",
        "origin_province",
        "origin_city",
        "clothing_size",
        "wake_up_time",
        "sleep_time",
        "nap_habit",
        "personal_cleanliness",
        "roommate_cleanliness",
        "common_space_maintenance",
        "one_sentence_intro",
        "personality_text",
        "roommate_personality_text",
        "interests_text",
        "gaming_self",
        "gaming_roommate",
        "keyboard_noise_text",
        "media_noise_text",
        "self_acknowledged_shortcoming",
    )
    if any(not card.get(field) for field in fields):
        raise ApiError(400, "CARD_INCOMPLETE", "请完整填写所有必填字段后再发布")


def get_or_create_conversation(db: Session, user_id: int, other_id: int) -> dict:
    first, second = sorted((user_id, other_id))
    conversation = one(
        db, "SELECT * FROM conversations WHERE student_a_id=:a AND student_b_id=:b", {"a": first, "b": second}
    )
    if not conversation:
        result = db.execute(
            text("INSERT INTO conversations(student_a_id,student_b_id,created_at) VALUES(:a,:b,:now)"),
            {"a": first, "b": second, "now": now()},
        )
        db.commit()
        conversation = one(db, "SELECT * FROM conversations WHERE id=:id", {"id": result.lastrowid})
    return conversation


@router.get("/me/roommate-card")
def my_card(request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    return {"card": card_by_user(db, user["id"])}


@router.put("/me/roommate-card")
def save_card(request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    values = card_input(body)
    existing = one(db, "SELECT * FROM roommate_cards WHERE user_id=:id", {"id": user["id"]})
    if existing and existing["status"] == "PUBLISHED":
        validate_publish({**values, "major": user["major"]})
    if values["avatar_url"].startswith("data:"):
        values["avatar_url"] = store_avatar(values["avatar_url"])
    timestamp = now()
    if existing:
        assignments = ",".join(f"{field}=:{field}" for field in values)
        db.execute(
            text(f"UPDATE roommate_cards SET {assignments},updated_at=:updated_at WHERE user_id=:user_id"),
            {**values, "updated_at": timestamp, "user_id": user["id"]},
        )
    else:
        fields = ",".join(values)
        placeholders = ",".join(f":{field}" for field in values)
        db.execute(
            text(
                f"INSERT INTO roommate_cards(user_id,{fields},status,created_at,updated_at) VALUES(:user_id,{placeholders},'DRAFT',:created_at,:updated_at)"
            ),
            {**values, "user_id": user["id"], "created_at": timestamp, "updated_at": timestamp},
        )
    db.commit()
    return {"card": card_by_user(db, user["id"])}


@router.post("/me/roommate-card/publish")
def publish_card(request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    card = card_by_user(db, user["id"])
    if not card:
        raise ApiError(400, "CARD_NOT_FOUND", "请先填写室友卡片")
    if card["status"] == "HIDDEN":
        raise ApiError(403, "CARD_HIDDEN", "卡片已被管理员隐藏")
    validate_publish(card)
    timestamp = now()
    db.execute(
        text(
            "UPDATE roommate_cards SET status='PUBLISHED',published_at=COALESCE(published_at,:now),updated_at=:now WHERE user_id=:id"
        ),
        {"now": timestamp, "id": user["id"]},
    )
    db.commit()
    return {"card": card_by_user(db, user["id"])}


@router.post("/me/roommate-card/unpublish")
def unpublish_card(request: Request, db: DB) -> None:
    current_user(request, db)
    raise ApiError(409, "CARD_PUBLICATION_PERMANENT", "卡片首次发布后不能取消发布，只能继续修改")


@router.get("/roommate-cards")
def cards(
    request: Request,
    db: DB,
    search: str = "",
    grade: str = "",
    availability: str = "",
    gender: str = "",
    limit: Annotated[int, Query(ge=1, le=15)] = 15,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    user = current_user(request, db)
    require_user(user)
    selected_gender = gender if gender in ("MALE", "FEMALE") else user["gender"]
    conditions = [
        "u.status='ACTIVE'",
        "u.gender=:gender",
        "c.status='PUBLISHED'",
        """NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=:user AND b.blocked_id=u.id)
        OR (b.blocker_id=u.id AND b.blocked_id=:user))""",
    ]
    parameters: dict = {"gender": selected_gender, "user": user["id"]}
    lowered = search.strip().lower()
    if lowered:
        conditions.append("instr(lower(u.name),:search)>0")
        parameters["search"] = lowered
    if grade:
        conditions.append("u.grade=:grade")
        parameters["grade"] = grade
    visible_cards = "SELECT * FROM (" + CARD_SELECT + " WHERE " + " AND ".join(conditions) + ") AS visible_cards"
    if availability == "AVAILABLE":
        visible_cards += " WHERE team_member_count<4"
    total = one(db, f"SELECT COUNT(*) AS total FROM ({visible_cards}) AS matching_cards", parameters)["total"]
    rows = all_rows(
        db,
        visible_cards
        + """ ORDER BY CASE WHEN user_id=:user THEN 0 ELSE 1 END,updated_at DESC,id DESC
      LIMIT :limit OFFSET :offset""",
        {**parameters, "limit": limit, "offset": offset},
    )
    grades = all_rows(
        db,
        "SELECT name FROM grades WHERE status='ACTIVE' ORDER BY name DESC",
    )
    result = [{**card_for_student(card, user["id"]), "is_own": card["user_id"] == user["id"]} for card in rows]
    return {"cards": result, "total": total, "grades": [item["name"] for item in grades]}


@router.get("/roommate-cards/{card_id}")
def card_detail(card_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    card = card_by_id(db, card_id)
    if not card or card["user_status"] != "ACTIVE" or card["status"] != "PUBLISHED":
        raise ApiError(404, "CARD_NOT_FOUND", CARD_NOT_FOUND_MESSAGE)
    if has_block(db, user["id"], card["user_id"]):
        raise ApiError(403, "USER_BLOCKED", "无法查看该用户")
    return {"card": card_for_student(card, user["id"])}


@router.post("/roommate-cards/{card_id}/conversations")
def conversation_from_card(card_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    card = card_by_id(db, card_id)
    if not card or card["user_id"] == user["id"] or card["user_status"] != "ACTIVE" or card["status"] != "PUBLISHED":
        raise ApiError(404, "CARD_NOT_FOUND", CARD_NOT_FOUND_MESSAGE)
    if has_block(db, user["id"], card["user_id"]):
        raise ApiError(403, "USER_BLOCKED", "无法与该用户联系")
    return {"conversation": get_or_create_conversation(db, user["id"], card["user_id"])}


@router.post("/users/{other_id}/conversations")
def conversation_from_user(other_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    other = one(db, "SELECT id,status,account_type FROM users WHERE id=:id", {"id": other_id})
    if not other or other["account_type"] != "USER" or other["status"] != "ACTIVE" or other_id == user["id"]:
        raise ApiError(404, "USER_NOT_FOUND", "学生账号不存在")
    if has_block(db, user["id"], other_id):
        raise ApiError(403, "USER_BLOCKED", "无法与该用户联系")
    return {"conversation": get_or_create_conversation(db, user["id"], other_id)}


@router.get("/conversations")
def conversations(request: Request, db: DB, search: Annotated[str, Query()] = "") -> dict:
    user = current_user(request, db)
    require_user(user)
    rows = all_rows(
        db,
        """SELECT co.*,
      CASE WHEN co.student_a_id=:user THEN co.student_b_id ELSE co.student_a_id END AS other_user_id,
      u.name AS other_name,u.grade AS other_grade,u.status AS other_status,rc.avatar_url AS other_avatar,
      (SELECT body FROM messages WHERE conversation_id=co.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=co.id AND m.sender_id!=:user
        AND m.id>COALESCE((SELECT last_read_message_id FROM conversation_reads
          WHERE conversation_id=co.id AND user_id=:user),0)) AS unread_count
      FROM conversations co JOIN users u ON u.id=CASE WHEN co.student_a_id=:user THEN co.student_b_id ELSE co.student_a_id END
      LEFT JOIN roommate_cards rc ON rc.user_id=u.id WHERE co.student_a_id=:user OR co.student_b_id=:user
      ORDER BY COALESCE(co.last_message_at,co.created_at) DESC""",
        {"user": user["id"]},
    )
    if search.strip():
        rows = [row for row in rows if search.strip().lower() in row["other_name"].lower()]
    return {"conversations": rows}


@router.get("/conversations/{conversation_id}/messages")
def messages(
    conversation_id: int,
    request: Request,
    db: DB,
    before_id: Annotated[int | None, Query(alias="beforeId", gt=0)] = None,
) -> dict:
    user = current_user(request, db)
    require_user(user)
    conversation = conversation_for_user(db, conversation_id, user["id"])
    rows = all_rows(
        db,
        """SELECT m.*,u.name AS sender_name,a.status AS application_status,
      a.note AS application_note,d.id AS dormitory_id,d.name AS dormitory_name,d.dormitory_code,
      d.capacity AS dormitory_capacity,r.name AS selection_round_name,r.status AS selection_round_status,
      (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id=d.id) AS dormitory_member_count
      FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN dormitory_applications a ON a.id=m.application_id
      LEFT JOIN dormitories d ON d.id=a.dormitory_id LEFT JOIN dormitory_selection_rounds r ON r.id=a.selection_round_id
      WHERE m.conversation_id=:id AND (:before IS NULL OR m.id<:before)
      ORDER BY m.id DESC LIMIT :limit""",
        {"id": conversation_id, "before": before_id, "limit": MESSAGE_PAGE_SIZE + 1},
    )
    has_more = len(rows) > MESSAGE_PAGE_SIZE
    rows = list(reversed(rows[:MESSAGE_PAGE_SIZE]))
    return {
        "conversation": conversation,
        "messages": rows,
        "hasMore": has_more,
        "nextBeforeId": rows[0]["id"] if has_more else None,
    }


@router.post("/conversations/{conversation_id}/messages", status_code=201)
def send_message(conversation_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    conversation = conversation_for_user(db, conversation_id, user["id"])
    other_id = (
        conversation["student_b_id"] if conversation["student_a_id"] == user["id"] else conversation["student_a_id"]
    )
    if has_block(db, user["id"], other_id):
        raise ApiError(403, "USER_BLOCKED", "当前无法发送消息")
    ip_address = request.client.host if request.client else "unknown"
    enforce_rate_limit("message-conversation", f"{user['id']}:{conversation_id}", 10, 10, "MESSAGE_RATE_LIMITED")
    enforce_rate_limit("message-user", str(user["id"]), 30, 60, "MESSAGE_RATE_LIMITED")
    enforce_rate_limit("message-ip", ip_address, 120, 60, "MESSAGE_RATE_LIMITED")
    message_body = clean_text(body.get("body"), 2000, True)
    timestamp = now()
    result = db.execute(
        text(
            "INSERT INTO messages(conversation_id,sender_id,body,created_at) VALUES(:conversation,:sender,:body,:now)"
        ),
        {"conversation": conversation_id, "sender": user["id"], "body": message_body, "now": timestamp},
    )
    db.execute(
        text("UPDATE conversations SET last_message_at=:now WHERE id=:id"), {"now": timestamp, "id": conversation_id}
    )
    db.commit()
    return {
        "message": {
            "id": result.lastrowid,
            "conversation_id": conversation_id,
            "sender_id": user["id"],
            "body": message_body,
            "created_at": timestamp,
        }
    }


@router.post("/conversations/{conversation_id}/read")
def mark_read(conversation_id: int, request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    conversation_for_user(db, conversation_id, user["id"])
    try:
        last_message_id = int(body.get("lastMessageId"))
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_READ_CURSOR", "已读位置无效") from None
    if not one(
        db,
        "SELECT 1 AS found FROM messages WHERE id=:message AND conversation_id=:conversation",
        {"message": last_message_id, "conversation": conversation_id},
    ):
        raise ApiError(400, "INVALID_READ_CURSOR", "已读位置无效")
    db.execute(
        text("""INSERT INTO conversation_reads(conversation_id,user_id,last_read_message_id,updated_at)
      VALUES(:conversation,:user,:message,:now) ON CONFLICT(conversation_id,user_id) DO UPDATE SET
      last_read_message_id=MAX(COALESCE(conversation_reads.last_read_message_id,0),excluded.last_read_message_id),
      updated_at=excluded.updated_at"""),
        {"conversation": conversation_id, "user": user["id"], "message": last_message_id, "now": now()},
    )
    db.commit()
    return {"ok": True, "lastReadMessageId": last_message_id}


@router.post("/users/{blocked_id}/blocks")
def block_user(blocked_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    if blocked_id == user["id"]:
        raise ApiError(400, "INVALID_TARGET", "不能拉黑自己")
    target = one(
        db,
        "SELECT id FROM users WHERE id=:id AND account_type='USER' AND status='ACTIVE'",
        {"id": blocked_id},
    )
    if not target:
        raise ApiError(404, "USER_NOT_FOUND", "学生账号不存在")
    timestamp = now()
    db.execute(
        text("INSERT OR IGNORE INTO blocks(blocker_id,blocked_id,created_at) VALUES(:user,:blocked,:now)"),
        {"user": user["id"], "blocked": blocked_id, "now": timestamp},
    )
    db.execute(
        text("""UPDATE dormitory_applications SET status='CANCELLED',updated_at=:now WHERE status='PENDING' AND
      ((applicant_id=:user AND dormitory_id IN(SELECT id FROM dormitories WHERE initiator_id=:blocked)) OR
       (applicant_id=:blocked AND dormitory_id IN(SELECT id FROM dormitories WHERE initiator_id=:user)))"""),
        {"now": timestamp, "user": user["id"], "blocked": blocked_id},
    )
    db.commit()
    return {"ok": True}


@router.delete("/users/{blocked_id}/blocks")
def unblock_user(blocked_id: int, request: Request, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    db.execute(
        text("DELETE FROM blocks WHERE blocker_id=:user AND blocked_id=:blocked"),
        {"user": user["id"], "blocked": blocked_id},
    )
    db.commit()
    return {"ok": True}


@router.get("/blocks")
def blocks(request: Request, db: DB, search: str = "") -> dict:
    user = current_user(request, db)
    require_user(user)
    rows = all_rows(
        db,
        """SELECT b.blocked_id AS user_id,b.created_at,u.name,u.grade,c.avatar_url
      FROM blocks b JOIN users u ON u.id=b.blocked_id LEFT JOIN roommate_cards c ON c.user_id=u.id
      WHERE b.blocker_id=:user ORDER BY b.created_at DESC""",
        {"user": user["id"]},
    )
    if search.strip():
        rows = [row for row in rows if search.strip().lower() in row["name"].lower()]
    return {"blocks": rows}


@router.post("/reports", status_code=201)
def report(request: Request, body: dict, db: DB) -> dict:
    user = current_user(request, db)
    require_user(user)
    ip_address = request.client.host if request.client else "unknown"
    enforce_rate_limit("report-user", str(user["id"]), 5, 60, "REPORT_RATE_LIMITED")
    enforce_rate_limit("report-ip", ip_address, 30, 60, "REPORT_RATE_LIMITED")
    today = datetime.now(UTC).date().isoformat()
    submitted_today = one(
        db,
        "SELECT COUNT(*) AS total FROM reports WHERE reporter_id=:user AND created_at>=:today",
        {"user": user["id"], "today": today},
    )["total"]
    if submitted_today >= 10:
        raise ApiError(429, "REPORT_DAILY_LIMIT_REACHED", "今日举报次数已达上限")
    target_type = body.get("targetType")
    try:
        target_id = int(body.get("targetId"))
    except (TypeError, ValueError):
        target_id = 0
    if target_type not in ("ROOMMATE_CARD", "MESSAGE") or not target_id:
        raise ApiError(400, "INVALID_REPORT_TARGET", "举报对象无效")
    if target_type == "ROOMMATE_CARD":
        card = card_by_id(db, target_id)
        if not card:
            raise ApiError(404, "CARD_NOT_FOUND", CARD_NOT_FOUND_MESSAGE)
        snapshot = {
            "name": card["name"],
            "additional_note": card["additional_note"],
            "personality_note": card.get("personality_note"),
        }
    else:
        snapshot = one(
            db,
            """SELECT m.id,m.body,m.sender_id,m.conversation_id FROM messages m
          JOIN conversations c ON c.id=m.conversation_id WHERE m.id=:id
          AND (c.student_a_id=:user OR c.student_b_id=:user)""",
            {"id": target_id, "user": user["id"]},
        )
        if not snapshot:
            raise ApiError(404, "MESSAGE_NOT_FOUND", "消息不存在")
    result = db.execute(
        text("""INSERT INTO reports(reporter_id,target_type,target_id,reason,description,snapshot,created_at)
      VALUES(:reporter,:type,:target,:reason,:description,:snapshot,:now)"""),
        {
            "reporter": user["id"],
            "type": target_type,
            "target": target_id,
            "reason": clean_text(body.get("reason"), 50, True),
            "description": clean_text(body.get("description"), 500),
            "snapshot": json.dumps(snapshot, ensure_ascii=False),
            "now": now(),
        },
    )
    db.commit()
    return {"reportId": result.lastrowid}
