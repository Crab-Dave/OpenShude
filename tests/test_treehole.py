from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.common import now
from app.database import SessionLocal
from app.main import app
from tests.conftest import login


def configure_author_grade(client: TestClient) -> None:
    login(client, "admin", "Admin123!")
    response = client.put(
        "/api/admin/treehole/author-grades",
        json={"gradeIds": [1], "reason": "开放 2026 级树洞"},
    )
    assert response.status_code == 200, response.text


def create_reviewed_post(client: TestClient) -> int:
    login(client, "2026001")
    created = client.post(
        "/api/treehole/posts",
        json={"title": "关于大学生活的疑问", "content": "我想知道应该怎样平衡学习、社团活动和休息时间。"},
    )
    assert created.status_code == 201, created.text
    post_id = created.json()["post"]["id"]
    login(client, "admin", "Admin123!")
    replied = client.post(
        f"/api/admin/treehole/posts/{post_id}/comments",
        json={"content": "可以先记录一周的时间使用情况，再逐步调整优先级。"},
    )
    assert replied.status_code == 201, replied.text
    return post_id


def test_private_review_publish_and_anonymous_public_discussion(client: TestClient):
    login(client, "2026001")
    ineligible = client.post(
        "/api/treehole/posts", json={"title": "尚未开放", "content": "当前年级还没有配置发帖资格。"}
    )
    assert ineligible.status_code == 403
    assert ineligible.json()["error"]["code"] == "TREEHOLE_AUTHOR_INELIGIBLE"

    configure_author_grade(client)
    login(client, "2026001")
    created = client.post(
        "/api/treehole/posts",
        json={"title": "如何适应新的环境", "content": "刚进入大学有一些不适应，希望听听大家的建议。"},
    )
    assert created.status_code == 201
    post_id = created.json()["post"]["id"]
    assert created.json()["post"]["visibility"] == "PRIVATE"
    own_comment = client.post(f"/api/treehole/posts/{post_id}/comments", json={"content": "补充一些具体情况。"})
    assert own_comment.status_code == 201

    login(client, "2026002")
    assert client.get(f"/api/treehole/posts/{post_id}").status_code == 404

    login(client, "admin", "Admin123!")
    official = client.post(
        f"/api/admin/treehole/posts/{post_id}/comments",
        json={"content": "适应需要时间，可以从建立稳定作息和认识身边同学开始。"},
    )
    assert official.status_code == 201
    with SessionLocal() as db:
        assert (
            db.execute(
                text("SELECT COUNT(*) FROM audit_logs WHERE action='REPLY_TREEHOLE_POST' AND target_id=:id"),
                {"id": str(post_id)},
            ).scalar_one()
            == 1
        )

    login(client, "2026001")
    frozen = client.patch(
        f"/api/treehole/posts/{post_id}",
        json={"title": "试图改写", "content": "管理员回复以后不能再修改原来的上下文。"},
    )
    assert frozen.status_code == 409
    published = client.post(f"/api/treehole/posts/{post_id}/publish")
    assert published.status_code == 200

    login(client, "2026002")
    listing = client.get("/api/treehole/posts").json()
    assert [post["id"] for post in listing["posts"]] == [post_id]
    assert not any(key in listing["posts"][0] for key in ("author_id", "author_name", "name", "grade"))
    detail = client.get(f"/api/treehole/posts/{post_id}").json()["post"]
    serialized = str(detail)
    assert all(value not in serialized for value in ("林夏", "系统管理员", "2026001", "计算机科学"))
    assert [(item["aliasNumber"], item["isOfficial"]) for item in detail["comments"]] == [(1, False), (2, True)]

    public_comment = client.post(f"/api/treehole/posts/{post_id}/comments", json={"content": "我也经历过类似阶段。"})
    assert public_comment.status_code == 201
    reply = client.post(
        f"/api/treehole/comments/{public_comment.json()['commentId']}/replies",
        json={"content": "谢谢你的分享。"},
    )
    assert reply.status_code == 201
    aliases = client.get(f"/api/treehole/posts/{post_id}").json()["post"]["comments"]
    assert [item["aliasNumber"] for item in aliases[-2:]] == [3, 3]

    report = client.post(
        "/api/reports",
        json={"targetType": "TREEHOLE_COMMENT", "targetId": public_comment.json()["commentId"], "reason": "其他"},
    )
    assert report.status_code == 201
    duplicate = client.post(
        "/api/reports",
        json={"targetType": "TREEHOLE_COMMENT", "targetId": public_comment.json()["commentId"], "reason": "其他"},
    )
    assert duplicate.status_code == 409

    login(client, "2026001")
    assert client.post(f"/api/treehole/posts/{post_id}/withdraw").status_code == 200
    login(client, "2026002")
    assert client.get(f"/api/treehole/posts/{post_id}").status_code == 404
    login(client, "admin", "Admin123!")
    restored = client.post(
        f"/api/admin/treehole/posts/{post_id}/moderation",
        json={"action": "restore-withdrawn", "reason": "作者申请重新公开"},
    )
    assert restored.status_code == 200
    login(client, "2026001")
    assert client.post(f"/api/treehole/posts/{post_id}/publish").status_code == 200


def test_scoped_permissions_and_author_grade_configuration(client: TestClient):
    configure_author_grade(client)
    post_id = create_reviewed_post(client)
    timestamp = now()
    with SessionLocal.begin() as db:
        db.execute(
            text(
                """INSERT INTO admin_groups(id,code,name,status,created_by,created_at,updated_at)
                VALUES(10,'TREEHOLE_2025','2025 级树洞回复','ACTIVE',1,:now,:now)"""
            ),
            {"now": timestamp},
        )
        db.execute(text("INSERT INTO admin_group_members VALUES(10,4,1,:now)"), {"now": timestamp})
        db.execute(
            text("INSERT INTO admin_group_permissions VALUES(10,'TREEHOLE_PRIVATE_REPLY',1,:now)"),
            {"now": timestamp},
        )
        db.execute(text("INSERT INTO admin_group_scopes VALUES(10,'GRADE','2',1,:now)"), {"now": timestamp})

    login(client, "2026003")
    out_of_scope = client.post(
        f"/api/admin/treehole/posts/{post_id}/comments",
        json={"content": "不能跨年级回复。"},
    )
    assert out_of_scope.status_code == 404
    assert client.get(f"/api/admin/treehole/posts/{post_id}").status_code == 404
    assert (
        client.put("/api/admin/treehole/author-grades", json={"gradeIds": [2], "reason": "越权配置"}).status_code == 403
    )

    with SessionLocal.begin() as db:
        db.execute(text("UPDATE admin_group_scopes SET scope_value='1' WHERE group_id=10"))
    assert client.get(f"/api/admin/treehole/posts/{post_id}").status_code == 200
    with SessionLocal.begin() as db:
        db.execute(text("UPDATE admin_groups SET status='DISABLED' WHERE id=10"))
    assert client.get("/api/admin/treehole/private-posts").status_code == 403


def test_moderation_hides_content_and_preserves_audit(client: TestClient):
    configure_author_grade(client)
    post_id = create_reviewed_post(client)
    login(client, "2026001")
    assert client.post(f"/api/treehole/posts/{post_id}/publish").status_code == 200
    login(client, "2026002")
    comment_id = client.post(
        f"/api/treehole/posts/{post_id}/comments", json={"content": "这是一条需要治理的测试评论。"}
    ).json()["commentId"]

    login(client, "admin", "Admin123!")
    hidden = client.post(
        f"/api/admin/treehole/posts/{post_id}/moderation",
        json={"action": "hide", "reason": "检查隐私信息"},
    )
    assert hidden.status_code == 200
    login(client, "2026001")
    hidden_detail = client.get(f"/api/treehole/posts/{post_id}").json()["post"]
    assert hidden_detail["title"] is None
    assert hidden_detail["comments"] == []
    login(client, "2026002")
    assert client.get(f"/api/treehole/posts/{post_id}").status_code == 404

    login(client, "admin", "Admin123!")
    assert (
        client.post(
            f"/api/admin/treehole/posts/{post_id}/moderation",
            json={"action": "restore", "reason": "确认可以恢复"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/admin/treehole/comments/{comment_id}/moderation",
            json={"action": "hide", "reason": "评论包含不当内容"},
        ).status_code
        == 200
    )
    login(client, "2026001")
    hidden_comment = next(
        item
        for item in client.get(f"/api/treehole/posts/{post_id}").json()["post"]["comments"]
        if item["id"] == comment_id
    )
    assert hidden_comment["content"] is None

    login(client, "admin", "Admin123!")
    assert (
        client.post(
            f"/api/admin/treehole/comments/{comment_id}/moderation",
            json={"action": "restore", "reason": "复核后恢复"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/admin/treehole/posts/{post_id}/moderation",
            json={"action": "delete", "reason": "作者申请删除敏感内容"},
        ).status_code
        == 200
    )
    with SessionLocal() as db:
        post = db.execute(
            text("SELECT title,content,moderation_status FROM treehole_posts WHERE id=:id"), {"id": post_id}
        ).one()
        assert tuple(post) == ("[已删除]", "", "DELETED")
        assert db.execute(text("SELECT COUNT(*) FROM audit_logs WHERE target_type LIKE 'TREEHOLE_%'")).scalar_one() >= 5


def test_public_pagination_and_concurrent_alias_assignment(client: TestClient):
    configure_author_grade(client)
    post_id = create_reviewed_post(client)
    login(client, "2026001")
    assert client.post(f"/api/treehole/posts/{post_id}/publish").status_code == 200
    timestamp = now()
    with SessionLocal.begin() as db:
        for index in range(20):
            extra_id = db.execute(
                text(
                    """INSERT INTO treehole_posts(author_id,management_grade_id,title,content,visibility,
                    moderation_status,reviewed_at,published_at,created_at,updated_at)
                    VALUES(2,1,:title,:content,'PUBLIC','NORMAL',:now,:published,:now,:now) RETURNING id"""
                ),
                {
                    "title": f"分页帖子 {index:02d}",
                    "content": "用于验证服务端分页的公开树洞内容。",
                    "now": timestamp,
                    "published": f"2026-08-09T00:{index:02d}:00.000Z",
                },
            ).scalar_one()
            db.execute(
                text(
                    "INSERT INTO treehole_participants(post_id,user_id,alias_number,created_at) VALUES(:post,2,1,:now)"
                ),
                {"post": extra_id, "now": timestamp},
            )
    first = client.get("/api/treehole/posts").json()
    second = client.get("/api/treehole/posts", params={"cursor": first["nextCursor"]}).json()
    assert len(first["posts"]) == 15
    assert len(second["posts"]) == 6
    assert {item["id"] for item in first["posts"]}.isdisjoint(item["id"] for item in second["posts"])

    def comment_as(concurrent_client: TestClient, identifier: str) -> int:
        response = concurrent_client.post(
            f"/api/treehole/posts/{post_id}/comments", json={"content": f"来自 {identifier} 的并发评论。"}
        )
        assert response.status_code == 201, response.text
        return response.json()["commentId"]

    with TestClient(app) as first_client, TestClient(app) as second_client, TestClient(app) as third_client:
        concurrent_clients = (first_client, second_client, third_client)
        identifiers = ("2026002", "2026006", "2026007")
        for concurrent_client, identifier in zip(concurrent_clients, identifiers, strict=True):
            login(concurrent_client, identifier)
        with ThreadPoolExecutor(max_workers=3) as executor:
            comment_ids = list(executor.map(comment_as, concurrent_clients, identifiers))
    assert len(set(comment_ids)) == 3
    with SessionLocal() as db:
        aliases = (
            db.execute(
                text("SELECT alias_number FROM treehole_participants WHERE post_id=:post ORDER BY alias_number"),
                {"post": post_id},
            )
            .scalars()
            .all()
        )
    assert aliases == [1, 2, 3, 4, 5]


def test_admin_treehole_queues_use_server_pagination_and_default_to_waiting_posts(client: TestClient):
    configure_author_grade(client)
    timestamp = now()
    with SessionLocal.begin() as db:
        for index in range(33):
            db.execute(
                text(
                    """INSERT INTO treehole_posts(author_id,management_grade_id,title,content,reviewed_at,
                    created_at,updated_at) VALUES(2,1,:title,:content,:reviewed,:now,:now)"""
                ),
                {
                    "title": f"管理队列分页 {index:02d}",
                    "content": "用于验证管理队列不会一次返回全部树洞内容。",
                    "reviewed": timestamp if index == 32 else None,
                    "now": timestamp,
                },
            )

    login(client, "admin", "Admin123!")
    first = client.get("/api/admin/treehole/private-posts").json()
    second = client.get("/api/admin/treehole/private-posts", params={"before_id": first["nextBeforeId"]}).json()
    assert len(first["posts"]) == 30
    assert len(second["posts"]) == 2
    assert all(post["reviewed_at"] is None for post in first["posts"] + second["posts"])
    assert second["nextBeforeId"] is None

    content_first = client.get("/api/admin/treehole/content").json()
    content_second = client.get(
        "/api/admin/treehole/content", params={"before_id": content_first["nextBeforeId"]}
    ).json()
    assert len(content_first["posts"]) == 30
    assert len(content_second["posts"]) == 3
