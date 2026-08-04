import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import text

from app.common import now
from app.database import SessionLocal
from tests.conftest import login


def test_auth_security_and_card_contract(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.post("/api/auth/login", json={"loginIdentifier": "none", "password": "bad"}).status_code == 401
    me = login(client, "2026001")
    assert me["user"]["name"] == "林夏"
    assert client.post("/api/me/deactivate", json={"confirmation": "注销账号"}).status_code == 405
    cards = client.get("/api/roommate-cards", params={"gender": "FEMALE", "search": "林"}).json()["cards"]
    assert len(cards) == 1
    assert cards[0]["is_own"] is True
    assert cards[0]["clothing_size"] == "L"
    card = client.get(f"/api/roommate-cards/{cards[0]['id']}").json()["card"]
    assert card["one_sentence_intro"] == "一句话介绍"
    assert card["clothing_size"] == "L"
    other_cards = client.get("/api/roommate-cards", params={"gender": "FEMALE"}).json()["cards"]
    other_card = next(item for item in other_cards if not item["is_own"])
    assert "clothing_size" not in other_card
    assert "clothing_size" not in client.get(f"/api/roommate-cards/{other_card['id']}").json()["card"]
    invalid_origin = client.put(
        "/api/me/roommate-card", json={"name": "不可修改"}, headers={"Origin": "http://evil.example"}
    )
    assert invalid_origin.status_code == 403
    read_only = client.put("/api/me/roommate-card", json={"name": "不可修改"})
    assert read_only.status_code == 403
    invalid_avatar = client.put("/api/me/roommate-card", json={"avatar_url": "data:image/png;base64,not-base64"})
    assert invalid_avatar.status_code == 400
    assert invalid_avatar.json()["error"]["code"] == "INVALID_AVATAR"
    permanent = client.post("/api/me/roommate-card/unpublish")
    assert permanent.status_code == 409
    headers = client.get("/api/me").headers
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in headers["content-security-policy"]


def test_roommate_cards_are_loaded_in_batches_of_fifteen(client):
    with SessionLocal.begin() as db:
        for index in range(20):
            user_id = db.execute(
                text("""INSERT INTO users(login_identifier,password_hash,password_salt,role,account_type,
                  authorization_version,must_change_password,name,grade,grade_id,gender,major,status,created_at,updated_at)
                  SELECT :login,password_hash,password_salt,role,account_type,authorization_version,
                  must_change_password,:name,grade,grade_id,gender,major,status,created_at,updated_at
                  FROM users WHERE id=3 RETURNING id"""),
                {"login": f"page-{index:02d}", "name": f"分页用户{index:02d}"},
            ).scalar_one()
            db.execute(
                text("""INSERT INTO roommate_cards(user_id,avatar_url,origin_city,one_sentence_intro,status,
                  published_at,created_at,updated_at)
                  VALUES(:user,'/assets/avatar-1.png','深圳','分页测试卡片','PUBLISHED',:now,:now,:now)"""),
                {"user": user_id, "now": now()},
            )

    login(client, "2026001")
    filters = {"gender": "FEMALE", "availability": "ALL", "search": "分页用户"}
    first = client.get("/api/roommate-cards", params=filters).json()
    second = client.get("/api/roommate-cards", params={**filters, "offset": 15}).json()

    assert first["total"] == second["total"] == 20
    assert len(first["cards"]) == 15
    assert len(second["cards"]) == 5
    assert {card["id"] for card in first["cards"]}.isdisjoint(card["id"] for card in second["cards"])
    assert first["grades"] == ["2026级", "2025级"]
    oversized = client.get("/api/roommate-cards", params={**filters, "limit": 16})
    assert oversized.status_code == 400
    assert oversized.json()["error"]["code"] == "INVALID_REQUEST"


def test_existing_session_csrf_body_limit_host_and_login_rate_limit(client):
    raw_token = "existing-node-session-token"
    with SessionLocal.begin() as db:
        db.execute(
            text("""INSERT INTO sessions(token_hash,csrf_token,user_id,expires_at,created_at)
              VALUES(:hash,'existing-csrf',2,'2099-01-01T00:00:00.000Z',:now)"""),
            {"hash": hashlib.sha256(raw_token.encode()).hexdigest(), "now": now()},
        )
    client.cookies.set("session", raw_token)
    assert client.get("/api/me").status_code == 200
    assert client.post("/api/me/dormitory/leave").status_code == 403
    too_large = client.put(
        "/api/me/roommate-card",
        content=b"x" * (4 * 1024 * 1024 + 1),
        headers={"content-type": "application/json", "x-csrf-token": "existing-csrf"},
    )
    assert too_large.status_code == 413
    assert too_large.json()["error"]["code"] == "BODY_TOO_LARGE"
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 400
    anonymous = TestClient(client.app)
    for _ in range(10):
        assert (
            anonymous.post("/api/auth/login", json={"loginIdentifier": "missing", "password": "bad"}).status_code == 401
        )
    assert (
        anonymous.post("/api/auth/login", json={"loginIdentifier": "2026001", "password": "Student123!"}).status_code
        == 200
    )
    limited = anonymous.post("/api/auth/login", json={"loginIdentifier": "missing", "password": "bad"})
    assert limited.status_code == 429


def test_messaging_blocking_and_reports(client):
    login(client, "2026001")
    conversation = client.post("/api/users/3/conversations").json()["conversation"]
    sent = client.post(f"/api/conversations/{conversation['id']}/messages", json={"body": "你好"})
    assert sent.status_code == 201
    assert client.get(f"/api/conversations/{conversation['id']}/messages").json()["messages"][0]["body"] == "你好"
    assert (
        client.post(
            f"/api/conversations/{conversation['id']}/read", json={"lastMessageId": sent.json()["message"]["id"]}
        ).status_code
        == 200
    )
    assert client.post("/api/users/3/blocks").status_code == 200
    assert (
        client.post(f"/api/conversations/{conversation['id']}/messages", json={"body": "不可发送"}).status_code == 403
    )
    assert client.delete("/api/users/3/blocks").status_code == 200
    report = client.post(
        "/api/reports", json={"targetType": "MESSAGE", "targetId": sent.json()["message"]["id"], "reason": "测试"}
    )
    assert report.status_code == 201


def test_message_pagination_does_not_mark_concurrent_messages_read(client):
    login(client, "2026001")
    conversation = client.post("/api/users/3/conversations").json()["conversation"]
    with SessionLocal.begin() as db:
        for index in range(202):
            db.execute(
                text("""INSERT INTO messages(conversation_id,sender_id,body,created_at)
                  VALUES(:conversation,3,:body,:now)"""),
                {"conversation": conversation["id"], "body": f"消息 {index}", "now": now()},
            )

    latest = client.get(f"/api/conversations/{conversation['id']}/messages").json()
    assert len(latest["messages"]) == 50
    assert latest["hasMore"] is True
    assert latest["messages"][0]["body"] == "消息 152"
    earlier = client.get(
        f"/api/conversations/{conversation['id']}/messages", params={"beforeId": latest["nextBeforeId"]}
    ).json()
    assert len(earlier["messages"]) == 50
    assert earlier["messages"][-1]["body"] == "消息 151"

    with SessionLocal.begin() as db:
        concurrent_message_id = db.execute(
            text("""INSERT INTO messages(conversation_id,sender_id,body,created_at)
              VALUES(:conversation,3,'并发新消息',:now) RETURNING id"""),
            {"conversation": conversation["id"], "now": now()},
        ).scalar_one()
    last_displayed_id = latest["messages"][-1]["id"]
    read = client.post(f"/api/conversations/{conversation['id']}/read", json={"lastMessageId": last_displayed_id})
    assert read.status_code == 200
    assert read.json()["lastReadMessageId"] == last_displayed_id
    assert concurrent_message_id > last_displayed_id
    assert client.get("/api/conversations").json()["conversations"][0]["unread_count"] == 1
    invalid = client.post(f"/api/conversations/{conversation['id']}/read", json={"lastMessageId": 999999})
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "INVALID_READ_CURSOR"


def test_dormitory_workflow_and_same_gender(client):
    login(client, "2026001")
    created = client.post("/api/dormitories", json={"name": "女生测试宿舍"})
    assert created.status_code == 201, created.text
    dormitory = created.json()["dormitory"]
    assert dormitory["capacity"] == 4
    assert dormitory["building"] == ""

    applicant = TestClient(client.app)
    login(applicant, "2026002")
    conversation = applicant.post("/api/users/2/conversations").json()["conversation"]
    application = applicant.post(
        f"/api/conversations/{conversation['id']}/dormitory-applications",
        json={"dormitoryId": dormitory["id"], "note": "申请加入"},
    )
    assert application.status_code == 201, application.text
    application_id = application.json()["application"]["id"]
    approved = client.post(f"/api/dormitory-applications/{application_id}/approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["dormitory"]["member_count"] == 2

    male = TestClient(client.app)
    login(male, "2026004")
    male_conversation = male.post("/api/users/2/conversations").json()["conversation"]
    denied = male.post(
        f"/api/conversations/{male_conversation['id']}/dormitory-applications",
        json={"dormitoryId": dormitory["id"]},
    )
    assert denied.status_code == 403
    assert applicant.post("/api/me/dormitory/leave").status_code == 200
    assert client.post("/api/me/dormitory/leave").status_code == 200
    with SessionLocal() as db:
        assert db.execute(text("SELECT COUNT(*) FROM dormitories")).scalar_one() == 0


def test_student_round_results_only_include_own_dormitory(client):
    login(client, "2026001")
    own_dormitory = client.post("/api/dormitories", json={"name": "我的宿舍"}).json()["dormitory"]
    other_student = TestClient(client.app)
    login(other_student, "2026002")
    other_dormitory = other_student.post("/api/dormitories", json={"name": "其他宿舍"}).json()["dormitory"]

    current_results = client.get("/api/dormitory-rounds/1/results")
    assert current_results.status_code == 200
    assert [item["id"] for item in current_results.json()["dormitories"]] == [own_dormitory["id"]]
    assert other_dormitory["id"] not in {item["id"] for item in current_results.json()["dormitories"]}

    admin = TestClient(client.app)
    login(admin, "admin", "Admin123!")
    assert admin.post("/api/admin/dormitory-rounds/1/close", json={"reason": "测试归档"}).status_code == 200
    assert admin.post("/api/admin/dormitory-rounds/1/archive", json={"reason": "测试归档"}).status_code == 200

    archived_results = client.get("/api/dormitory-rounds/1/results")
    assert archived_results.status_code == 200
    payload = archived_results.json()
    assert [item["id"] for item in payload["dormitories"]] == [own_dormitory["id"]]
    assert "login_identifier" not in json.dumps(payload)

    with SessionLocal.begin() as db:
        db.execute(text("DELETE FROM dormitory_round_participants WHERE round_id=1 AND user_id=8"))
    nonparticipant = TestClient(client.app)
    login(nonparticipant, "2026007")
    assert nonparticipant.get("/api/dormitory-rounds/1/results").status_code == 404


def test_admin_rounds_scoped_permissions_and_export(client):
    login(client, "admin", "Admin123!")
    users = client.get("/api/admin/users").json()["users"]
    group_admin = next(user for user in users if user["login_identifier"] == "2026001")
    group = client.post("/api/admin/admin-groups", json={"code": "GRADE_2026", "name": "2026 管理"}).json()["group"]
    for section, body in (
        (
            "permissions",
            {"permissions": ["USER_READ", "USER_EXPORT", "CARD_READ", "DORMITORY_READ", "DORMITORY_EXPORT"]},
        ),
        ("scopes", {"gradeIds": [1]}),
        ("members", {"userIds": [group_admin["id"]]}),
    ):
        response = client.put(f"/api/admin/admin-groups/{group['id']}/{section}", json=body)
        assert response.status_code == 200, response.text

    scoped = TestClient(client.app)
    login(scoped, "2026001")
    scoped_users = scoped.get("/api/admin/users").json()["users"]
    assert scoped_users
    assert all(user["grade_id"] == 1 for user in scoped_users)
    scoped_cards = scoped.get("/api/admin/roommate-cards").json()["cards"]
    assert scoped_cards
    assert all(card["grade_id"] == 1 and card["clothing_size"] == "L" for card in scoped_cards)
    with SessionLocal.begin() as db:
        db.execute(text("UPDATE users SET major='=1+1' WHERE id=2"))
    user_export = scoped.get("/api/admin/users/export")
    assert user_export.status_code == 200
    assert user_export.headers["content-disposition"].startswith('attachment; filename="users-')
    sheet = load_workbook(BytesIO(user_export.content), read_only=True).active
    export_rows = list(sheet.values)
    assert export_rows[0] == (
        "登录标识",
        "姓名",
        "年级",
        "性别",
        "专业",
        "院服尺码",
        "账号状态",
        "卡片状态",
        "最近登录",
        "创建时间",
    )
    assert all(row[2] == "2026级" and row[5] == "L" for row in export_rows[1:])
    assert next(row for row in export_rows[1:] if row[0] == "2026001")[4] == "'=1+1"
    assert "2026003" not in {row[0] for row in export_rows[1:]}
    with SessionLocal() as db:
        export_audit = db.execute(
            text("SELECT permission_code,scope_value FROM audit_logs WHERE action='EXPORT_USERS'")
        ).one()
        assert export_audit == ("USER_EXPORT", "1")
    export = scoped.get("/api/admin/dormitories/export")
    assert export.status_code == 200
    assert export.content.startswith(b"PK")
    assert (
        scoped.post(
            "/api/admin/dormitory-rounds", json={"code": "NO", "name": "无权", "participantIds": [2]}
        ).status_code
        == 403
    )

    closed = client.post("/api/admin/dormitory-rounds/1/close", json={"reason": "截止"})
    assert closed.status_code == 200
    archived = client.post("/api/admin/dormitory-rounds/1/archive", json={"reason": "归档"})
    assert archived.status_code == 200
    second = client.post(
        "/api/admin/dormitory-rounds",
        json={"code": "ROUND_TWO", "name": "第二轮", "participantIds": [2, 3, 4, 5, 6]},
    )
    assert second.status_code == 201
    opened = client.post(f"/api/admin/dormitory-rounds/{second.json()['round']['id']}/open", json={"reason": "开放"})
    assert opened.status_code == 200


def test_imported_user_must_change_temporary_password(client):
    login(client, "admin", "Admin123!")
    imported = client.post(
        "/api/admin/users/import",
        json={
            "accounts": [
                {
                    "loginIdentifier": "formal-001",
                    "name": "正式用户",
                    "grade": "2026级",
                    "gender": "FEMALE",
                    "major": "计算机科学",
                }
            ]
        },
    )
    assert imported.status_code == 200
    account = imported.json()["created"][0]
    assert account["initialPassword"] == "formal-001"
    renamed = client.patch(
        "/api/admin/users/login-identifiers",
        json={
            "changes": [{"oldLoginIdentifier": "formal-001", "newLoginIdentifier": "student-001"}],
            "reason": "换为正式学号",
        },
    )
    assert renamed.status_code == 200
    assert renamed.json()["updated"][0]["initialPasswordReset"] is True

    student = TestClient(client.app)
    assert (
        student.post("/api/auth/login", json={"loginIdentifier": "formal-001", "password": "formal-001"}).status_code
        == 401
    )
    session = login(student, "student-001", "student-001")
    assert session["user"]["mustChangePassword"] is True
    blocked = student.get("/api/roommate-cards", params={"gender": "FEMALE"})
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"
    changed = student.patch(
        "/api/me/password",
        json={"currentPassword": "student-001", "newPassword": "FormalPassword123!"},
    )
    assert changed.status_code == 200
    assert student.get("/api/roommate-cards", params={"gender": "FEMALE"}).status_code == 200


def test_password_change_revokes_other_sessions(client):
    current_device = TestClient(client.app)
    other_device = TestClient(client.app)
    login(current_device, "2026001")
    login(other_device, "2026001")

    changed = current_device.patch(
        "/api/me/password",
        json={"currentPassword": "Student123!", "newPassword": "UpdatedPassword123!"},
    )

    assert changed.status_code == 200
    assert current_device.get("/api/me").status_code == 200
    assert other_device.get("/api/me").status_code == 401


def test_super_admin_password_reset_revokes_sessions_and_requires_password_change(client):
    student = TestClient(client.app)
    login(student, "2026002")
    login(client, "admin", "Admin123!")

    missing_reason = client.post("/api/admin/users/3/password-reset", json={})
    assert missing_reason.status_code == 400
    assert missing_reason.json()["error"]["code"] == "FIELD_REQUIRED"
    own_account = client.post("/api/admin/users/1/password-reset", json={"reason": "不能重置自己"})
    assert own_account.status_code == 403
    assert own_account.json()["error"]["code"] == "SELF_PASSWORD_RESET_FORBIDDEN"

    reset = client.post("/api/admin/users/3/password-reset", json={"reason": "学生忘记密码"})
    assert reset.status_code == 200
    assert reset.json() == {"ok": True}
    assert student.get("/api/me").status_code == 401
    assert (
        student.post("/api/auth/login", json={"loginIdentifier": "2026002", "password": "Student123!"}).status_code
        == 401
    )
    session = login(student, "2026002", "2026002")
    assert session["user"]["mustChangePassword"] is True
    assert student.get("/api/roommate-cards", params={"gender": "FEMALE"}).status_code == 403
    changed = student.patch(
        "/api/me/password",
        json={"currentPassword": "2026002", "newPassword": "ResetPassword123!"},
    )
    assert changed.status_code == 200

    with SessionLocal() as db:
        audit_row = db.execute(
            text("""SELECT reason,permission_code,scope_type,metadata,before_snapshot,after_snapshot
              FROM audit_logs WHERE action='RESET_USER_PASSWORD'""")
        ).one()
        assert audit_row[0:3] == ("学生忘记密码", "SUPER_ADMIN", "")
        audit_snapshots = "".join(audit_row[3:])
        assert "2026002" not in audit_snapshots
        assert "Student123!" not in audit_snapshots
        assert "password_hash" not in audit_snapshots


def test_scoped_admin_can_only_reset_passwords_in_authorized_grades(client):
    login(client, "admin", "Admin123!")
    group = client.post("/api/admin/admin-groups", json={"code": "PASSWORD_2026", "name": "2026 密码重置"}).json()[
        "group"
    ]
    for section, body in (
        ("permissions", {"permissions": ["USER_READ", "USER_PASSWORD_RESET"]}),
        ("scopes", {"gradeIds": [1]}),
        ("members", {"userIds": [2, 7]}),
    ):
        assert client.put(f"/api/admin/admin-groups/{group['id']}/{section}", json=body).status_code == 200

    scoped = TestClient(client.app)
    login(scoped, "2026001")
    self_reset = scoped.post("/api/admin/users/2/password-reset", json={"reason": "不能重置自己"})
    assert self_reset.status_code == 403
    assert self_reset.json()["error"]["code"] == "SELF_PASSWORD_RESET_FORBIDDEN"
    protected_admin = scoped.post("/api/admin/users/7/password-reset", json={"reason": "不能重置其他管理员"})
    assert protected_admin.status_code == 403
    assert protected_admin.json()["error"]["code"] == "PROTECTED_ADMIN_ACCOUNT"
    assert scoped.post("/api/admin/users/4/password-reset", json={"reason": "超出年级"}).status_code == 404
    assert scoped.post("/api/admin/users/3/password-reset", json={"reason": "授权范围内"}).status_code == 200

    student = TestClient(client.app)
    assert login(student, "2026002", "2026002")["user"]["mustChangePassword"] is True
    with SessionLocal() as db:
        grant = db.execute(
            text("""SELECT permission_code,scope_type,scope_value FROM audit_logs
              WHERE action='RESET_USER_PASSWORD'""")
        ).one()
        assert grant == ("USER_PASSWORD_RESET", "GRADE", "1")


def test_batch_update_login_identifiers_is_atomic_and_revokes_sessions(client):
    first_student = TestClient(client.app)
    login(first_student, "2026001")
    login(client, "admin", "Admin123!")

    renamed = client.patch(
        "/api/admin/users/login-identifiers",
        json={
            "changes": [
                {"oldLoginIdentifier": "2026001", "newLoginIdentifier": "S2026001"},
                {"oldLoginIdentifier": "2026002", "newLoginIdentifier": "S2026002"},
            ],
            "reason": "临时编号换为正式学号",
        },
    )
    assert renamed.status_code == 200
    assert [item["newLoginIdentifier"] for item in renamed.json()["updated"]] == ["S2026001", "S2026002"]
    assert all(item["initialPasswordReset"] is False for item in renamed.json()["updated"])
    assert first_student.get("/api/me").status_code == 401
    assert (
        first_student.post(
            "/api/auth/login", json={"loginIdentifier": "2026001", "password": "Student123!"}
        ).status_code
        == 401
    )
    login(first_student, "S2026001")

    conflict = client.patch(
        "/api/admin/users/login-identifiers",
        json={
            "changes": [
                {"oldLoginIdentifier": "S2026001", "newLoginIdentifier": "S2026001-next"},
                {"oldLoginIdentifier": "2026003", "newLoginIdentifier": "S2026002"},
            ],
            "reason": "验证整批回滚",
        },
    )
    assert conflict.status_code == 409
    with SessionLocal() as db:
        assert db.execute(text("SELECT login_identifier FROM users WHERE id=2")).scalar_one() == "S2026001"
        assert db.execute(text("SELECT COUNT(*) FROM roommate_cards WHERE user_id IN(2,3)")).scalar_one() == 2
        assert (
            db.execute(text("SELECT COUNT(*) FROM audit_logs WHERE action='UPDATE_LOGIN_IDENTIFIER'")).scalar_one() == 2
        )


def test_scoped_permissions_cannot_be_combined_across_groups(client):
    login(client, "admin", "Admin123!")
    for code, permissions, grades in (
        ("IDENTITY_2026", ["USER_IDENTITY_UPDATE", "USER_LOGIN_IDENTIFIER_UPDATE"], [1]),
        ("READ_2025", ["USER_READ"], [2]),
    ):
        group = client.post("/api/admin/admin-groups", json={"code": code, "name": code}).json()["group"]
        assert (
            client.put(
                f"/api/admin/admin-groups/{group['id']}/permissions", json={"permissions": permissions}
            ).status_code
            == 200
        )
        assert client.put(f"/api/admin/admin-groups/{group['id']}/scopes", json={"gradeIds": grades}).status_code == 200
        assert client.put(f"/api/admin/admin-groups/{group['id']}/members", json={"userIds": [2]}).status_code == 200

    scoped = TestClient(client.app)
    login(scoped, "2026001")
    assert scoped.get("/api/admin/users/export").status_code == 403
    cross_scope = scoped.patch(
        "/api/admin/users/3/identity",
        json={"name": "江晚", "grade": "2025级", "gender": "FEMALE", "major": "设计", "reason": "不能拼接"},
    )
    assert cross_scope.status_code == 404
    self_update = scoped.patch(
        "/api/admin/users/2/identity",
        json={"name": "林夏", "grade": "2026级", "gender": "FEMALE", "major": "计算机科学", "reason": "不能管理自己"},
    )
    assert self_update.status_code == 403
    assert self_update.json()["error"]["code"] == "PROTECTED_ADMIN_ACCOUNT"
    renamed = scoped.patch(
        "/api/admin/users/login-identifiers",
        json={
            "changes": [{"oldLoginIdentifier": "2026002", "newLoginIdentifier": "official-002"}],
            "reason": "换正式学号",
        },
    )
    assert renamed.status_code == 200
    cross_scope_rename = scoped.patch(
        "/api/admin/users/login-identifiers",
        json={
            "changes": [
                {"oldLoginIdentifier": "official-002", "newLoginIdentifier": "official-002-next"},
                {"oldLoginIdentifier": "2026003", "newLoginIdentifier": "official-003"},
            ],
            "reason": "不能跨年级",
        },
    )
    assert cross_scope_rename.status_code == 404
    with SessionLocal() as db:
        assert db.execute(text("SELECT login_identifier FROM users WHERE id=3")).scalar_one() == "official-002"

    assert (
        client.patch("/api/admin/users/1/status", json={"status": "SUSPENDED", "reason": "最后管理员"}).status_code
        == 409
    )
    assert (
        client.patch(
            "/api/admin/users/1/account-type", json={"accountType": "USER", "reason": "最后管理员"}
        ).status_code
        == 409
    )
    assert (
        client.request(
            "DELETE", "/api/admin/users/1", json={"confirmation": "admin", "reason": "最后管理员"}
        ).status_code
        == 409
    )


def test_only_one_round_can_open_under_concurrency(client):
    login(client, "admin", "Admin123!")
    assert client.post("/api/admin/dormitory-rounds/1/close", json={"reason": "准备并发"}).status_code == 200
    round_ids = []
    for code in ("PARALLEL_A", "PARALLEL_B"):
        result = client.post("/api/admin/dormitory-rounds", json={"code": code, "name": code, "participantIds": [2, 3]})
        round_ids.append(result.json()["round"]["id"])

    cookie = client.cookies.get("session")
    csrf = client.headers["x-csrf-token"]

    def open_round(round_id):
        with TestClient(client.app) as parallel:
            parallel.cookies.set("session", cookie)
            return parallel.post(
                f"/api/admin/dormitory-rounds/{round_id}/open", json={"reason": "并发"}, headers={"x-csrf-token": csrf}
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = sorted(executor.map(open_round, round_ids))
    assert statuses == [200, 409]
    with SessionLocal() as db:
        assert db.execute(text("SELECT COUNT(*) FROM dormitory_selection_rounds WHERE status='OPEN'")).scalar_one() == 1


def test_concurrent_approvals_never_overfill_a_dormitory(client):
    login(client, "2026001")
    dormitory = client.post("/api/dormitories", json={"name": "并发审批宿舍"}).json()["dormitory"]

    def apply(identifier, user_id):
        applicant = TestClient(client.app)
        login(applicant, identifier)
        conversation = applicant.post("/api/users/2/conversations").json()["conversation"]
        response = applicant.post(
            f"/api/conversations/{conversation['id']}/dormitory-applications",
            json={"dormitoryId": dormitory["id"]},
        )
        return response.json()["application"]["id"]

    first = apply("2026002", 3)
    second = apply("2026003", 4)
    assert client.post(f"/api/dormitory-applications/{first}/approve").status_code == 200
    assert client.post(f"/api/dormitory-applications/{second}/approve").status_code == 200
    pending_ids = [apply("2026006", 7), apply("2026007", 8)]
    cookie = client.cookies.get("session")
    csrf = client.headers["x-csrf-token"]

    def approve(application_id):
        with TestClient(client.app) as parallel:
            parallel.cookies.set("session", cookie)
            return parallel.post(
                f"/api/dormitory-applications/{application_id}/approve",
                headers={"x-csrf-token": csrf},
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = sorted(executor.map(approve, pending_ids))
    assert statuses == [200, 409]
    with SessionLocal() as db:
        count = db.execute(
            text("SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id=:id"), {"id": dormitory["id"]}
        ).scalar_one()
        assert count == 4
