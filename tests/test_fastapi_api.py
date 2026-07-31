import hashlib
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.common import now
from app.database import SessionLocal
from tests.conftest import login


def test_auth_security_and_card_contract(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.post("/api/auth/login", json={"loginIdentifier": "none", "password": "bad"}).status_code == 401
    me = login(client, "2026001")
    assert me["user"]["name"] == "林夏"
    cards = client.get("/api/roommate-cards", params={"gender": "FEMALE", "search": "林"}).json()["cards"]
    assert len(cards) == 1
    assert cards[0]["is_own"] is True
    card = client.get(f"/api/roommate-cards/{cards[0]['id']}").json()["card"]
    assert card["one_sentence_intro"] == "一句话介绍"
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
    assert client.post(f"/api/conversations/{conversation['id']}/read").status_code == 200
    assert client.post("/api/users/3/blocks").status_code == 200
    assert (
        client.post(f"/api/conversations/{conversation['id']}/messages", json={"body": "不可发送"}).status_code == 403
    )
    assert client.delete("/api/users/3/blocks").status_code == 200
    report = client.post(
        "/api/reports", json={"targetType": "MESSAGE", "targetId": sent.json()["message"]["id"], "reason": "测试"}
    )
    assert report.status_code == 201


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


def test_admin_rounds_scoped_permissions_and_export(client):
    login(client, "admin", "Admin123!")
    users = client.get("/api/admin/users").json()["users"]
    group_admin = next(user for user in users if user["login_identifier"] == "2026001")
    group = client.post("/api/admin/admin-groups", json={"code": "GRADE_2026", "name": "2026 管理"}).json()["group"]
    for section, body in (
        ("permissions", {"permissions": ["USER_READ", "DORMITORY_READ", "DORMITORY_EXPORT"]}),
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


def test_scoped_permissions_cannot_be_combined_across_groups(client):
    login(client, "admin", "Admin123!")
    for code, permissions, grades in (
        ("IDENTITY_2026", ["USER_IDENTITY_UPDATE"], [1]),
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
