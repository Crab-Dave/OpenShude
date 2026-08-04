import subprocess
import sys

from tests.conftest import login


def test_homepage_is_a_generated_anonymous_document(client):
    subprocess.run([sys.executable, "scripts/build_static_pages.py"], check=True)

    response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"
    assert "欢迎来到合住" in response.text
    assert "首页占位内容" in response.text
    assert "/app.js" not in response.text
    assert 'href="/login"' in response.text
    assert 'href="/roommates"' in response.text


def test_removed_homepage_apis_and_permission_are_not_available(client):
    login(client, "admin", "Admin123!")

    assert client.get("/api/public/homepage").status_code == 404
    assert client.get("/api/admin/homepage").status_code == 404
    assert client.post("/api/admin/homepage/preview", json={"markdown": "# 内容"}).status_code in (404, 405)
    assert client.put("/api/admin/homepage", json={"markdown": "# 内容"}).status_code in (404, 405)
    permissions = client.get("/api/admin/permissions").json()["permissions"]
    assert "HOMEPAGE_UPDATE" not in {permission["code"] for permission in permissions}


def test_application_routes_use_the_login_application_and_unknown_pages_are_404(client):
    login_page = client.get("/login")
    roommate_page = client.get("/roommates")

    assert login_page.status_code == 200 and "/app.js" in login_page.text
    assert roommate_page.status_code == 200 and "/app.js" in roommate_page.text
    assert client.get("/page-that-does-not-exist").status_code == 404
