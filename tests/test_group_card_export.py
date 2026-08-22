import json
from io import BytesIO

from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import text

from app.database import SessionLocal
from tests.conftest import login


def create_selection_group(client: TestClient) -> dict:
    response = client.post(
        "/api/admin/student-selection-groups",
        json={
            "name": "2026/测试群组",
            "description": "卡片导出验收",
            "memberIds": [2, 3],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["group"]


def test_super_admin_exports_complete_group_cards_and_audit(client: TestClient):
    login(client, "admin", "Admin123!")
    group = create_selection_group(client)
    with SessionLocal.begin() as db:
        db.execute(
            text(
                """UPDATE roommate_cards SET status='HIDDEN',one_sentence_intro='=1+1',
                personal_cleanliness='STRICT',roommate_cleanliness='TIDY',
                common_space_maintenance='CLEAN_TOGETHER' WHERE user_id=2"""
            )
        )
        db.execute(text("DELETE FROM roommate_cards WHERE user_id=3"))

    response = client.get(f"/api/admin/student-selection-groups/{group['id']}/cards/export")
    assert response.status_code == 200
    assert response.content.startswith(b"PK")
    disposition = response.headers["content-disposition"]
    assert f'filename="group-{group["id"]}-cards-' in disposition
    assert "filename*=UTF-8''2026%2F" not in disposition
    assert "%E6%B5%8B%E8%AF%95%E7%BE%A4%E7%BB%84-cards-" in disposition

    sheet = load_workbook(BytesIO(response.content), read_only=True).active
    assert sheet.title == "2026_测试群组"
    rows = list(sheet.values)
    assert rows[0][:7] == ("登录标识", "姓名", "年级", "性别", "专业", "账号状态", "卡片状态")
    assert len(rows) == 3
    by_login = {row[0]: row for row in rows[1:]}
    hidden = by_login["2026001"]
    no_card = by_login["2026002"]
    assert hidden[6] == "已隐藏"
    assert hidden[10] == "L"
    assert hidden[11] == "'=1+1"
    assert hidden[23:26] == (
        "长期保持整洁，物品及时归位",
        "大部分时间整齐，物品不过度堆积",
        "共同制定定期打扫计划，保持较高整洁度",
    )
    assert no_card[6] == "未创建"
    assert all(value in (None, "") for value in no_card[7:])

    with SessionLocal() as db:
        log = db.execute(
            text(
                """SELECT target_id,permission_code,metadata,before_snapshot,after_snapshot
                FROM audit_logs WHERE action='EXPORT_STUDENT_GROUP_CARDS'"""
            )
        ).one()
    assert log[0] == str(group["id"])
    assert log[1] == "SUPER_ADMIN"
    assert json.loads(log[2]) == {"groupName": "2026/测试群组", "memberCount": 2, "cardCount": 1}
    assert log[3:] == ("{}", "{}")


def test_group_card_export_rejects_missing_group_and_non_super_admin(client: TestClient):
    login(client, "admin", "Admin123!")
    group = create_selection_group(client)
    assert client.get("/api/admin/student-selection-groups/999/cards/export").status_code == 404

    users = client.get("/api/admin/users").json()["users"]
    member = next(user for user in users if user["login_identifier"] == "2026001")
    admin_group = client.post("/api/admin/admin-groups", json={"code": "CARD_READER", "name": "卡片管理员"}).json()[
        "group"
    ]
    configured = client.put(
        f"/api/admin/admin-groups/{admin_group['id']}",
        json={
            "name": admin_group["name"],
            "description": "",
            "status": "ACTIVE",
            "permissions": ["CARD_READ"],
            "gradeIds": [1],
            "userIds": [member["id"]],
            "reason": "权限边界验收",
        },
    )
    assert configured.status_code == 200
    scoped = TestClient(client.app)
    login(scoped, "2026001")
    forbidden = scoped.get(f"/api/admin/student-selection-groups/{group['id']}/cards/export")
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "SUPER_ADMIN_ONLY"
