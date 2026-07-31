from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database import SessionLocal
from tests.conftest import login


def test_public_homepage_is_anonymous_and_does_not_expose_source_or_updater(client):
    response = client.get("/api/public/homepage")
    assert response.status_code == 200
    content = response.json()
    assert set(content) == {"html", "updatedAt", "revision"}
    assert "欢迎来到合住" in content["html"]
    assert "markdown" not in content
    assert "updatedBy" not in content


def test_homepage_permissions_preview_publish_conflict_and_revocation(client):
    login(client, "admin", "Admin123!")
    group = client.post("/api/admin/admin-groups", json={"code": "HOME_EDITORS", "name": "首页编辑"}).json()["group"]
    assert (
        client.put(
            f"/api/admin/admin-groups/{group['id']}/permissions", json={"permissions": ["HOMEPAGE_UPDATE"]}
        ).status_code
        == 200
    )
    assert client.put(f"/api/admin/admin-groups/{group['id']}/members", json={"userIds": [2]}).status_code == 200

    editor = TestClient(client.app)
    login(editor, "2026001")
    initial = editor.get("/api/admin/homepage")
    assert initial.status_code == 200
    assert initial.json()["revision"] == 0

    source = "# 新首页\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))\n\n**正文**"
    preview = editor.post("/api/admin/homepage/preview", json={"markdown": source})
    assert preview.status_code == 200
    assert "<script" not in preview.json()["html"]
    assert 'href="javascript:' not in preview.json()["html"]
    assert editor.get("/api/public/homepage").json()["revision"] == 0

    published = editor.put(
        "/api/admin/homepage",
        json={"markdown": source, "reason": "更新迎新通知", "expectedRevision": 0},
    )
    assert published.status_code == 200
    assert published.json()["revision"] == 1
    public = editor.get("/api/public/homepage").json()
    assert "markdown" not in public
    assert "<script" not in public["html"]
    assert 'href="javascript:' not in public["html"]
    stale = editor.put(
        "/api/admin/homepage",
        json={"markdown": "# 旧内容", "reason": "并发测试", "expectedRevision": 0},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "CONTENT_VERSION_CONFLICT"

    with SessionLocal() as db:
        audit = (
            db.execute(
                text("""SELECT permission_code,scope_type,scope_value,before_snapshot,after_snapshot
            FROM audit_logs WHERE action='UPDATE_HOMEPAGE'""")
            )
            .mappings()
            .one()
        )
        assert audit["permission_code"] == "HOMEPAGE_UPDATE"
        assert (audit["scope_type"], audit["scope_value"]) == ("GLOBAL", "HOMEPAGE")
        assert "新首页" not in audit["after_snapshot"]
        assert "sha256" in audit["before_snapshot"]

    assert client.put(f"/api/admin/admin-groups/{group['id']}/permissions", json={"permissions": []}).status_code == 200
    assert editor.get("/api/admin/homepage").status_code == 403


def test_homepage_rejects_unauthorized_csrf_and_oversized_content(client):
    login(client, "2026002")
    assert client.get("/api/admin/homepage").status_code == 403

    admin = TestClient(client.app)
    login(admin, "admin", "Admin123!")
    csrf = admin.headers.pop("x-csrf-token")
    assert admin.post("/api/admin/homepage/preview", json={"markdown": "# 预览"}).status_code == 403
    admin.headers["x-csrf-token"] = csrf
    oversized = admin.post("/api/admin/homepage/preview", json={"markdown": "字" * 100_001})
    assert oversized.status_code == 400
    assert oversized.json()["error"]["code"] == "FIELD_TOO_LONG"


def test_super_admin_can_publish_homepage(client):
    login(client, "admin", "Admin123!")
    result = client.put(
        "/api/admin/homepage",
        json={"markdown": "# 管理员公告", "reason": "发布公告", "expectedRevision": 0},
    )
    assert result.status_code == 200
    assert result.json()["revision"] == 1
