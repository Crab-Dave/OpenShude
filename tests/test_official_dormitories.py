import io
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import event, text

from app.common import now
from app.database import SessionLocal, engine
from tests.conftest import login

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
HEADERS = (
    "宿舍编号",
    "成员1登录标识（宿舍长）",
    "成员2登录标识",
    "成员3登录标识",
    "成员4登录标识",
)


def workbook_bytes(rows: list[tuple[str, ...]]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(HEADERS)
    for row in rows:
        sheet.append(row)
    output = io.BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


def import_headers(file_hash: str = "") -> dict:
    result = {"Content-Type": XLSX_MEDIA_TYPE, "X-File-Name": "official-dormitories.xlsx"}
    if file_hash:
        result["X-File-SHA256"] = file_hash
    return result


def import_dormitories(client: TestClient, rows: list[tuple[str, ...]]) -> dict:
    content = workbook_bytes(rows)
    preview = client.post(
        "/api/admin/official-dormitories/import/preview",
        content=content,
        headers=import_headers(),
    )
    assert preview.status_code == 200, preview.text
    result = client.post(
        "/api/admin/official-dormitories/import/confirm",
        content=content,
        headers=import_headers(preview.json()["sha256"]),
    )
    assert result.status_code == 200, result.text
    return result.json()


def test_import_is_atomic_idempotent_and_isolated_from_selection_dormitories(client: TestClient):
    login(client, "admin", "Admin123!")
    rows = [("1023", "2026001", "2026002", "2026006", "2026007")]
    assert import_dormitories(client, rows) == {"created": 1, "skipped": 0}
    assert import_dormitories(client, rows) == {"created": 0, "skipped": 1}
    with SessionLocal() as db:
        assert db.execute(text("SELECT COUNT(*) FROM official_dormitories")).scalar_one() == 1
        assert db.execute(text("SELECT COUNT(*) FROM official_dormitory_members")).scalar_one() == 4
        assert db.execute(text("SELECT COUNT(*) FROM dormitories")).scalar_one() == 0
        assert db.execute(text("SELECT COUNT(*) FROM official_dormitory_members WHERE role='LEADER'")).scalar_one() == 1

    changed = workbook_bytes([("1023", "2026002", "2026001")])
    preview = client.post("/api/admin/official-dormitories/import/preview", content=changed, headers=import_headers())
    assert preview.status_code == 409
    with SessionLocal() as db:
        leader = db.execute(
            text(
                """SELECT user.login_identifier FROM official_dormitory_members member
                JOIN users user ON user.id=member.user_id WHERE member.role='LEADER'"""
            )
        ).scalar_one()
        assert leader == "2026001"


def test_import_validates_workbook_accounts_grades_and_hash(client: TestClient):
    login(client, "admin", "Admin123!")
    cross_grade = workbook_bytes([("X-1", "2026001", "2026003")])
    response = client.post(
        "/api/admin/official-dormitories/import/preview",
        content=cross_grade,
        headers=import_headers(),
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "DORMITORY_IMPORT_GRADE_MISMATCH"

    missing = workbook_bytes([("X-2", "not-found")])
    assert (
        client.post("/api/admin/official-dormitories/import/preview", content=missing, headers=import_headers()).json()[
            "error"
        ]["code"]
        == "DORMITORY_IMPORT_USER_NOT_FOUND"
    )

    valid = workbook_bytes([("X-3", "2026001")])
    preview = client.post(
        "/api/admin/official-dormitories/import/preview", content=valid, headers=import_headers()
    ).json()
    changed = workbook_bytes([("X-4", "2026001")])
    mismatch = client.post(
        "/api/admin/official-dormitories/import/confirm",
        content=changed,
        headers=import_headers(preview["sha256"]),
    )
    assert mismatch.status_code == 409
    with SessionLocal() as db:
        assert db.execute(text("SELECT COUNT(*) FROM official_dormitories")).scalar_one() == 0


def test_import_rejects_unsafe_workbook_content(client: TestClient):
    login(client, "admin", "Admin123!")
    wrong_media_type = client.post(
        "/api/admin/official-dormitories/import/preview",
        content=workbook_bytes([("X-0", "2026001")]),
        headers={"Content-Type": "application/octet-stream", "X-File-Name": "official-dormitories.xlsx"},
    )
    assert wrong_media_type.status_code == 415
    formula = workbook_bytes([("X-1", "=2026001")])
    response = client.post("/api/admin/official-dormitories/import/preview", content=formula, headers=import_headers())
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_DORMITORY_IMPORT"

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(HEADERS)
    sheet.append(("X-2", "2026001"))
    sheet["B2"].hyperlink = "https://example.com/hidden"
    linked = io.BytesIO()
    workbook.save(linked)
    workbook.close()
    response = client.post(
        "/api/admin/official-dormitories/import/preview", content=linked.getvalue(), headers=import_headers()
    )
    assert response.status_code == 400

    safe = workbook_bytes([("X-3", "2026001")])
    embedded = io.BytesIO()
    with ZipFile(io.BytesIO(safe)) as source, ZipFile(embedded, "w", ZIP_DEFLATED) as target:
        for entry in source.infolist():
            target.writestr(entry, source.read(entry.filename))
        target.writestr("xl/externalLinks/externalLink1.xml", "<externalLink/>")
    response = client.post(
        "/api/admin/official-dormitories/import/preview", content=embedded.getvalue(), headers=import_headers()
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_DORMITORY_IMPORT_FILE"

    too_large = b"x" * (2 * 1024 * 1024 + 1)
    response = client.post(
        "/api/admin/official-dormitories/import/preview", content=too_large, headers=import_headers()
    )
    assert response.status_code == 413


def test_members_edit_safe_markdown_and_conflicts_are_rejected(client: TestClient):
    login(client, "admin", "Admin123!")
    import_dormitories(client, [("1023", "2026001", "2026002")])
    login(client, "2026001")
    mine = client.get("/api/official-dormitories/mine").json()["dormitories"]
    assert [item["dormitoryCode"] for item in mine] == ["1023"]
    dormitory_id = mine[0]["id"]
    markdown = "## 四驱兄弟\n\n**互相尊重**\n\n<script>alert(1)</script>\n[危险](javascript:alert(1))"
    updated = client.patch(
        f"/api/official-dormitories/{dormitory_id}",
        json={"version": 1, "nickname": "四驱兄弟", "description": markdown, "rules": "- 保持安静"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["version"] == 2
    conflict = client.patch(f"/api/official-dormitories/{dormitory_id}", json={"version": 1, "nickname": "旧版本"})
    assert conflict.status_code == 409

    detail = client.get(f"/api/official-dormitories/{dormitory_id}").json()["dormitory"]
    assert detail["displayName"] == "1023·四驱兄弟"
    assert "<h2>" in detail["descriptionHtml"]
    assert "<strong>" in detail["descriptionHtml"]
    assert "<script" not in detail["descriptionHtml"]
    assert 'href="javascript:' not in detail["descriptionHtml"]
    assert detail["descriptionMarkdown"] == markdown
    assert detail["descriptionSummary"].startswith("四驱兄弟 互相尊重")
    assert detail["rulesSummary"] == "保持安静"
    assert detail["canEdit"] is True
    with SessionLocal() as db:
        revisions = db.execute(
            text("SELECT field_name,from_version,to_version FROM official_dormitory_revisions ORDER BY id")
        ).all()
        assert revisions == [("NICKNAME", 1, 2), ("DESCRIPTION", 1, 2), ("RULES", 1, 2)]

    login(client, "2026004")
    visitor = client.get(f"/api/official-dormitories/{dormitory_id}").json()["dormitory"]
    assert visitor["descriptionMarkdown"] is None
    assert visitor["canEdit"] is False
    assert (
        client.patch(f"/api/official-dormitories/{dormitory_id}", json={"version": 2, "nickname": "越权"}).status_code
        == 404
    )


def test_students_can_belong_to_multiple_dormitories_and_transfer_leader(client: TestClient):
    login(client, "admin", "Admin123!")
    import_dormitories(
        client,
        [("A-101", "2026001", "2026002"), ("A-102", "2026006", "2026001")],
    )
    login(client, "2026001")
    mine = client.get("/api/official-dormitories/mine").json()["dormitories"]
    assert {item["dormitoryCode"] for item in mine} == {"A-101", "A-102"}
    led = next(item for item in mine if item["dormitoryCode"] == "A-101")
    detail = client.get(f"/api/official-dormitories/{led['id']}").json()["dormitory"]
    target = next(member for member in detail["members"] if member["name"] == "江晚")
    transferred = client.post(
        f"/api/official-dormitories/{led['id']}/leader-transfer",
        json={"targetMemberId": target["memberId"], "version": detail["version"]},
    )
    assert transferred.status_code == 200
    assert (
        client.post(
            f"/api/official-dormitories/{led['id']}/leader-transfer",
            json={"targetMemberId": target["memberId"], "version": detail["version"]},
        ).status_code
        == 409
    )
    current = client.get(f"/api/official-dormitories/{led['id']}").json()["dormitory"]
    assert next(member for member in current["members"] if member["role"] == "LEADER")["name"] == "江晚"


def test_visiting_search_and_member_cards_respect_blocks_and_publication(client: TestClient):
    login(client, "admin", "Admin123!")
    import_dormitories(client, [("A-201", "2026001", "2026002")])
    login(client, "2026004")
    listing = client.get("/api/official-dormitories", params={"search": "林夏"}).json()["dormitories"]
    assert len(listing) == 1
    dormitory_id = listing[0]["id"]
    assert all(member["visible"] for member in listing[0]["members"])
    assert all("loginIdentifier" not in member for member in listing[0]["members"])
    assert all("clothingSize" not in member for member in listing[0]["members"])
    invalid_cursor = client.get("/api/official-dormitories", params={"cursor": "***"})
    assert invalid_cursor.status_code == 400
    assert invalid_cursor.json()["error"]["code"] == "INVALID_DORMITORY_CURSOR"

    assert client.post("/api/users/2/blocks").status_code == 200
    assert client.get("/api/official-dormitories", params={"search": "林夏"}).json()["dormitories"] == []
    detail = client.get(f"/api/official-dormitories/{dormitory_id}").json()["dormitory"]
    hidden = next(member for member in detail["members"] if not member["visible"])
    assert set(hidden) == {"position", "role", "visible", "leaderPending"}

    with SessionLocal.begin() as db:
        db.execute(text("UPDATE roommate_cards SET status='DRAFT' WHERE user_id=3"))
    detail = client.get(f"/api/official-dormitories/{dormitory_id}").json()["dormitory"]
    assert all(not member["visible"] for member in detail["members"])


def test_scoped_admin_can_correct_and_moderate_official_dormitory(client: TestClient):
    login(client, "admin", "Admin123!")
    import_dormitories(client, [("A-301", "2026001", "2026002")])
    renamed = client.patch(
        "/api/admin/users/login-identifiers",
        json={
            "changes": [{"oldLoginIdentifier": "2026002", "newLoginIdentifier": "S2026002"}],
            "reason": "开学后更新学号",
        },
    )
    assert renamed.status_code == 200
    with SessionLocal.begin() as db:
        timestamp = now()
        db.execute(
            text(
                """INSERT INTO admin_groups(id,code,name,status,created_by,created_at,updated_at)
                VALUES(20,'OFFICIAL_2026','正式宿舍管理员','ACTIVE',1,:now,:now)"""
            ),
            {"now": timestamp},
        )
        db.execute(text("INSERT INTO admin_group_members VALUES(20,6,1,:now)"), {"now": timestamp})
        for permission in (
            "OFFICIAL_DORMITORY_READ",
            "OFFICIAL_DORMITORY_MEMBER_UPDATE",
            "OFFICIAL_DORMITORY_MODERATE",
        ):
            db.execute(
                text("INSERT INTO admin_group_permissions VALUES(20,:permission,1,:now)"),
                {"permission": permission, "now": timestamp},
            )
        db.execute(text("INSERT INTO admin_group_scopes VALUES(20,'GRADE','1',1,:now)"), {"now": timestamp})
    login(client, "2026005")
    dormitory = client.get("/api/admin/official-dormitories").json()["dormitories"][0]
    detail = client.get(f"/api/admin/official-dormitories/{dormitory['id']}").json()["dormitory"]
    renamed_member = next(member for member in detail["members"] if member["name"] == "江晚")
    assert renamed_member["loginIdentifier"] == "S2026002"
    assert renamed_member["importedLoginIdentifier"] == "2026002"
    missing_confirmation = client.put(
        f"/api/admin/official-dormitories/{dormitory['id']}/members",
        json={
            "version": dormitory["version"],
            "loginIdentifiers": ["S2026002", "2026001", "2026006"],
            "reason": "修正学校名单",
        },
    )
    assert missing_confirmation.status_code == 400
    assert missing_confirmation.json()["error"]["code"] == "CONFIRMATION_REQUIRED"
    corrected = client.put(
        f"/api/admin/official-dormitories/{dormitory['id']}/members",
        json={
            "version": dormitory["version"],
            "loginIdentifiers": ["S2026002", "2026001", "2026006"],
            "confirmation": dormitory["dormitory_code"],
            "reason": "修正学校名单",
        },
    )
    assert corrected.status_code == 200, corrected.text
    moderated = client.post(
        f"/api/admin/official-dormitories/{dormitory['id']}/content-moderation",
        json={"field": "nickname", "action": "HIDE", "reason": "内容不合适"},
    )
    assert moderated.status_code == 200
    login(client, "2026001")
    detail = client.get(f"/api/official-dormitories/{dormitory['id']}").json()["dormitory"]
    assert detail["nicknameHidden"] is True


def test_hidden_nickname_is_not_searchable(client: TestClient):
    login(client, "admin", "Admin123!")
    import_dormitories(client, [("A-350", "2026001", "2026002")])
    with SessionLocal.begin() as db:
        db.execute(
            text(
                "UPDATE official_dormitories SET nickname='隐私昵称', nickname_status='HIDDEN' WHERE dormitory_code='A-350'"
            )
        )
    login(client, "2026004")
    assert client.get("/api/official-dormitories", params={"search": "隐私昵称"}).json()["dormitories"] == []


def test_permanent_user_deletion_preserves_membership_and_transfers_leader(client: TestClient):
    login(client, "admin", "Admin123!")
    import_dormitories(client, [("A-401", "2026001", "2026002"), ("A-402", "2026001")])
    deleted = client.request(
        "DELETE",
        "/api/admin/users/2",
        json={"confirmation": "2026001", "reason": "正式清理测试账号"},
    )
    assert deleted.status_code == 200, deleted.text
    with SessionLocal() as db:
        members = db.execute(
            text(
                """SELECT dormitory.dormitory_code,member.user_id,member.role,member.name_snapshot
                FROM official_dormitory_members member JOIN official_dormitories dormitory
                ON dormitory.id=member.official_dormitory_id ORDER BY dormitory.dormitory_code,member.position"""
            )
        ).all()
        assert members == [
            ("A-401", None, "MEMBER", "林夏"),
            ("A-401", 3, "LEADER", "江晚"),
            ("A-402", None, "LEADER", "林夏"),
        ]
        pending_id = db.execute(text("SELECT id FROM official_dormitories WHERE dormitory_code='A-402'")).scalar_one()
    admin_detail = client.get(f"/api/admin/official-dormitories/{pending_id}").json()["dormitory"]
    assert admin_detail["members"][0]["leaderPending"] is True
    login(client, "2026004")
    visitor_detail = client.get(f"/api/official-dormitories/{pending_id}").json()["dormitory"]
    assert visitor_detail["members"] == [{"position": 1, "role": "LEADER", "visible": False, "leaderPending": True}]
    login(client, "2026002")
    own_id = next(
        item["id"]
        for item in client.get("/api/official-dormitories/mine").json()["dormitories"]
        if item["dormitoryCode"] == "A-401"
    )
    own_detail = client.get(f"/api/official-dormitories/{own_id}").json()["dormitory"]
    deleted_member = next(member for member in own_detail["members"] if member["position"] == 1)
    assert deleted_member["name"] == "已删除账号"
    assert deleted_member["grade"] == "-"
    assert deleted_member["major"] == "-"


def test_official_dormitory_first_page_uses_constant_queries_at_target_capacity(client: TestClient):
    timestamp = now()
    dormitories = [
        {
            "id": dormitory_id,
            "code": f"CAPACITY-{dormitory_id:04d}",
            "grade": 1,
            "admin": 1,
            "now": timestamp,
        }
        for dormitory_id in range(1, 2001)
    ]
    members = [
        {
            "id": (dormitory_id - 1) * 4 + position,
            "dormitory": dormitory_id,
            "user": user_id,
            "role": "LEADER" if position == 1 else "MEMBER",
            "position": position,
            "login": f"202600{login_number}",
            "name": f"容量成员{login_number}",
            "now": timestamp,
        }
        for dormitory_id in range(1, 2001)
        for position, (user_id, login_number) in enumerate(((2, 1), (3, 2), (7, 6), (8, 7)), 1)
    ]
    with SessionLocal.begin() as db:
        db.execute(
            text(
                """INSERT INTO official_dormitories(
                id,dormitory_code,management_grade_id,created_by,created_at,updated_at)
                VALUES(:id,:code,:grade,:admin,:now,:now)"""
            ),
            dormitories,
        )
        db.execute(
            text(
                """INSERT INTO official_dormitory_members(
                id,official_dormitory_id,user_id,role,position,imported_login_identifier,
                name_snapshot,grade_snapshot,major_snapshot,created_at)
                VALUES(:id,:dormitory,:user,:role,:position,:login,:name,'2026级','',:now)"""
            ),
            members,
        )
    login(client, "2026004")
    statements = []

    def capture_query(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture_query)
    try:
        response = client.get("/api/official-dormitories")
    finally:
        event.remove(engine, "before_cursor_execute", capture_query)
    assert response.status_code == 200
    data = response.json()
    assert len(data["dormitories"]) == 15
    assert data["nextCursor"]
    assert len([statement for statement in statements if statement.lstrip().upper().startswith("SELECT")]) <= 5
