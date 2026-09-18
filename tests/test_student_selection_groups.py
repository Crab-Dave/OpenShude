from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database import SessionLocal
from tests.conftest import login


def test_user_manages_own_group_and_names_are_scoped_by_owner(client: TestClient):
    login(client, "2026001")
    candidates = client.get("/api/student-selection-groups/candidates")
    assert candidates.status_code == 200
    assert candidates.json()["candidates"]
    assert "login_identifier" not in candidates.json()["candidates"][0]

    created = client.post(
        "/api/student-selection-groups",
        json={"name": "周末活动搭子", "description": "活动目标人群", "memberIds": [2, 3]},
    )
    assert created.status_code == 201, created.text
    group = created.json()["group"]
    assert {member["id"] for member in group["members"]} == {2, 3}
    assert group["owned"] is True
    assert group["source"] == "OWN"
    assert "created_by" not in group
    assert all("login_identifier" not in member for member in group["members"])

    other = TestClient(client.app)
    login(other, "2026002")
    denied = other.patch(
        f"/api/student-selection-groups/{group['id']}",
        json={"name": "越权修改", "description": "", "memberIds": [3]},
    )
    assert denied.status_code == 404
    assert other.delete(f"/api/student-selection-groups/{group['id']}").status_code == 404
    duplicate_for_other_owner = other.post(
        "/api/student-selection-groups",
        json={"name": "周末活动搭子", "description": "同名但不同所有者", "memberIds": [2]},
    )
    assert duplicate_for_other_owner.status_code == 201
    assert group["id"] not in {item["id"] for item in other.get("/api/student-selection-groups").json()["groups"]}
    other.close()

    updated = client.patch(
        f"/api/student-selection-groups/{group['id']}",
        json={"name": "周末运动搭子", "description": "更新说明", "memberIds": [2, 4]},
    )
    assert updated.status_code == 200
    assert updated.json()["group"]["name"] == "周末运动搭子"
    assert {member["id"] for member in updated.json()["group"]["members"]} == {2, 4}
    assert client.delete(f"/api/student-selection-groups/{group['id']}").json() == {"ok": True}

    with SessionLocal() as db:
        actions = (
            db.execute(
                text(
                    """SELECT action FROM audit_logs WHERE target_type='STUDENT_SELECTION_GROUP'
                AND admin_id=2 ORDER BY id"""
                )
            )
            .scalars()
            .all()
        )
    assert actions == [
        "CREATE_STUDENT_SELECTION_GROUP",
        "UPDATE_STUDENT_SELECTION_GROUP",
        "DELETE_STUDENT_SELECTION_GROUP",
    ]


def test_admin_and_user_groups_share_storage_and_card_export(client: TestClient):
    login(client, "2026001")
    own = client.post(
        "/api/student-selection-groups",
        json={"name": "导出群组", "description": "普通用户创建", "memberIds": [2, 3]},
    ).json()["group"]

    admin = TestClient(client.app)
    login(admin, "admin", "Admin123!")
    shared = admin.post(
        "/api/admin/student-selection-groups",
        json={"name": "管理员共享群组", "description": "共享活动目标", "memberIds": [3, 4], "isPublic": True},
    )
    assert shared.status_code == 201, shared.text
    admin_groups = admin.get("/api/admin/student-selection-groups").json()["groups"]
    own_from_admin = next(group for group in admin_groups if group["id"] == own["id"])
    assert own_from_admin["created_by"] == 2
    assert "login_identifier" in own_from_admin["members"][0]
    private_update = admin.patch(
        f"/api/admin/student-selection-groups/{own['id']}",
        json={
            "name": own["name"],
            "description": own["description"],
            "memberIds": [2, 3],
            "isPublic": True,
            "reason": "维护个人群组",
        },
    )
    assert private_update.status_code == 200
    assert private_update.json()["group"]["is_public"] == 0
    export = admin.post("/api/admin/roommate-cards/export", json={"groupIds": [own["id"]]})
    assert export.status_code == 200
    admin.close()

    visible = client.get("/api/student-selection-groups").json()["groups"]
    shared_for_user = next(group for group in visible if group["id"] == shared.json()["group"]["id"])
    assert shared_for_user["owned"] is False
    assert shared_for_user["source"] == "ADMIN"
    assert shared_for_user["is_public"] == 1
    assert (
        client.patch(
            f"/api/student-selection-groups/{shared_for_user['id']}",
            json={"name": "不能修改", "description": "", "memberIds": [2]},
        ).status_code
        == 404
    )


def test_group_candidates_and_members_require_active_users(client: TestClient):
    with SessionLocal.begin() as db:
        db.execute(text("UPDATE users SET status='BANNED' WHERE id=3"))
    login(client, "2026001")
    candidates = client.get("/api/student-selection-groups/candidates").json()["candidates"]
    assert 3 not in {candidate["id"] for candidate in candidates}
    invalid = client.post(
        "/api/student-selection-groups",
        json={"name": "异常成员", "description": "", "memberIds": [3]},
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "INVALID_SELECTION_GROUP_MEMBER"


def test_admin_private_group_is_hidden_until_published(client: TestClient):
    admin = TestClient(client.app)
    login(admin, "admin", "Admin123!")
    private = admin.post(
        "/api/admin/student-selection-groups",
        json={"name": "管理员内部群组", "description": "暂不公开", "memberIds": [3], "isPublic": False},
    ).json()["group"]

    login(client, "2026001")
    assert private["id"] not in {group["id"] for group in client.get("/api/student-selection-groups").json()["groups"]}

    published = admin.patch(
        f"/api/admin/student-selection-groups/{private['id']}",
        json={
            "name": private["name"],
            "description": private["description"],
            "memberIds": [3],
            "isPublic": True,
            "reason": "开放活动选择",
        },
    )
    assert published.status_code == 200
    assert published.json()["group"]["is_public"] == 1
    assert private["id"] in {group["id"] for group in client.get("/api/student-selection-groups").json()["groups"]}
    admin.close()
