from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.common import now
from app.database import SessionLocal
from tests.conftest import login


def activity_body(**overrides) -> dict:
    body = {
        "title": "十月校园活动",
        "descriptionMarkdown": "欢迎参加。",
        "startAt": "2026-10-10T14:00:00+08:00",
        "endAt": "2026-10-10T16:00:00+08:00",
        "isAllDay": False,
        "location": "大学生活动中心 201",
        "capacity": 20,
        "importance": 2,
        "targetGradeIds": [1],
        "targetGroupIds": [],
    }
    body.update(overrides)
    return body


def create_activity(client: TestClient, **overrides) -> dict:
    response = client.post("/api/activities", json=activity_body(**overrides))
    assert response.status_code == 201, response.text
    return response.json()["activity"]


def publish_activity(client: TestClient, activity: dict) -> dict:
    response = client.post(f"/api/activities/{activity['id']}/publish", json={"version": activity["version"]})
    assert response.status_code == 200, response.text
    return response.json()["activity"]


def test_group_target_snapshot_visibility_registration_and_markdown(client: TestClient):
    login(client, "2026001")
    group = client.post(
        "/api/student-selection-groups",
        json={"name": "定向活动群组", "description": "发布快照验收", "memberIds": [3]},
    ).json()["group"]
    activity = create_activity(
        client,
        descriptionMarkdown="**欢迎**<script>alert(1)</script>[危险链接](javascript:alert(1))",
        targetGradeIds=[],
        targetGroupIds=[group["id"]],
    )
    assert "<script" not in activity["descriptionHtml"]
    assert 'href="javascript:' not in activity["descriptionHtml"]
    published = publish_activity(client, activity)
    assert published["status"] == "PUBLISHED"
    assert published["version"] == 2

    target = TestClient(client.app)
    login(target, "2026002")
    assert target.get(f"/api/activities/{activity['id']}").status_code == 200
    hidden = TestClient(client.app)
    login(hidden, "2026003")
    assert hidden.get(f"/api/activities/{activity['id']}").status_code == 404
    assert hidden.post(f"/api/activities/{activity['id']}/register").status_code == 404

    changed = client.patch(
        f"/api/student-selection-groups/{group['id']}",
        json={"name": group["name"], "description": "成员已调整", "memberIds": [4]},
    )
    assert changed.status_code == 200
    assert target.get(f"/api/activities/{activity['id']}").status_code == 200
    assert hidden.get(f"/api/activities/{activity['id']}").status_code == 404
    assert client.delete(f"/api/student-selection-groups/{group['id']}").status_code == 200
    assert target.get(f"/api/activities/{activity['id']}").status_code == 200

    calendar = target.get("/api/activities/calendar?view=month&date=2026-10-10").json()
    october_tenth = next(day for day in calendar["days"] if day["date"] == "2026-10-10")
    assert october_tenth["count"] == 1
    assert october_tenth["score"] == 2
    hidden_day = hidden.get("/api/activities/calendar?view=month&date=2026-10-10").json()
    assert next(day for day in hidden_day["days"] if day["date"] == "2026-10-10")["count"] == 0

    registered = target.post(f"/api/activities/{activity['id']}/register")
    assert registered.status_code == 200
    assert registered.json() == {"registered": True, "registrationCount": 1}
    participants = target.get(f"/api/activities/{activity['id']}/participants").json()["participants"]
    assert participants[0]["name"] == "江晚"
    assert target.delete(f"/api/activities/{activity['id']}/registration").json() == {
        "registered": False,
        "registrationCount": 0,
    }
    assert target.post(f"/api/activities/{activity['id']}/register").status_code == 200
    template = target.post(f"/api/activities/{activity['id']}/copy").json()["template"]
    assert template["sourceActivityId"] == activity["id"]
    assert template["targetGradeIds"] == [1]
    assert template["targetGroupIds"] == []

    cancelled = client.post(
        f"/api/activities/{activity['id']}/cancel",
        json={"version": published["version"], "confirmed": True, "reason": "场地临时关闭"},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["activity"]["status"] == "CANCELLED"
    assert target.post(f"/api/activities/{activity['id']}/register").status_code == 409
    target.close()
    hidden.close()


def test_activity_edit_conflict_capacity_and_cancel_confirmation(client: TestClient):
    login(client, "2026001")
    activity = publish_activity(client, create_activity(client, capacity=2))
    first = TestClient(client.app)
    second = TestClient(client.app)
    login(first, "2026002")
    login(second, "2026004")
    assert first.post(f"/api/activities/{activity['id']}/register").status_code == 200
    assert second.post(f"/api/activities/{activity['id']}/register").status_code == 200

    too_small = client.patch(
        f"/api/activities/{activity['id']}",
        json={"version": activity["version"], "capacity": 1},
    )
    assert too_small.status_code == 409
    assert too_small.json()["error"]["code"] == "ACTIVITY_CAPACITY_TOO_SMALL"
    edited = client.patch(
        f"/api/activities/{activity['id']}",
        json={"version": activity["version"], "title": "更新后的活动名称"},
    )
    assert edited.status_code == 200
    assert edited.json()["activity"]["version"] == activity["version"] + 1
    stale = client.patch(
        f"/api/activities/{activity['id']}",
        json={"version": activity["version"], "title": "覆盖更新"},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "ACTIVITY_EDIT_CONFLICT"
    unconfirmed = client.post(
        f"/api/activities/{activity['id']}/cancel",
        json={"version": activity["version"] + 1, "confirmed": False, "reason": "测试"},
    )
    assert unconfirmed.status_code == 400
    first.close()
    second.close()


def test_last_activity_seat_is_concurrency_safe(client: TestClient):
    login(client, "2026001")
    activity = publish_activity(client, create_activity(client, capacity=1))
    first = TestClient(client.app)
    second = TestClient(client.app)
    login(first, "2026002")
    login(second, "2026004")

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda participant: participant.post(f"/api/activities/{activity['id']}/register"),
                (first, second),
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 409]
    rejected = next(response for response in responses if response.status_code == 409)
    assert rejected.json()["error"]["code"] == "ACTIVITY_FULL"
    detail = client.get(f"/api/activities/{activity['id']}").json()["activity"]
    assert detail["registrationCount"] == 1
    first.close()
    second.close()


def test_draft_cannot_publish_after_target_group_deletion(client: TestClient):
    login(client, "2026001")
    group = client.post(
        "/api/student-selection-groups",
        json={"name": "临时目标群组", "description": "", "memberIds": [3]},
    ).json()["group"]
    activity = create_activity(client, targetGradeIds=[], targetGroupIds=[group["id"]])
    assert client.delete(f"/api/student-selection-groups/{group['id']}").status_code == 200
    publish = client.post(f"/api/activities/{activity['id']}/publish", json={"version": activity["version"]})
    assert publish.status_code == 400
    assert publish.json()["error"]["code"] == "INVALID_ACTIVITY_TARGET"


def test_official_activity_uses_one_active_admin_group_and_revokes_immediately(client: TestClient):
    timestamp = now()
    with SessionLocal.begin() as db:
        result = db.execute(
            text(
                """INSERT INTO admin_groups(code,name,description,status,created_by,created_at,updated_at)
                VALUES('ACTIVITY_TEAM','活动工作组','','ACTIVE',1,:now,:now)"""
            ),
            {"now": timestamp},
        )
        group_id = result.lastrowid
        db.execute(
            text("INSERT INTO admin_group_members(group_id,user_id,created_by,created_at) VALUES(:group,2,1,:now)"),
            {"group": group_id, "now": timestamp},
        )
        for permission in ("ACTIVITY_READ", "ACTIVITY_PUBLISH", "ACTIVITY_IMPORTANCE_SET"):
            db.execute(
                text(
                    """INSERT INTO admin_group_permissions(group_id,permission_code,created_by,created_at)
                    VALUES(:group,:permission,1,:now)"""
                ),
                {"group": group_id, "permission": permission, "now": timestamp},
            )
        db.execute(
            text(
                """INSERT INTO admin_group_scopes(group_id,scope_type,scope_value,created_by,created_at)
                VALUES(:group,'GRADE','1',1,:now)"""
            ),
            {"group": group_id, "now": timestamp},
        )

    login(client, "2026001")
    official = create_activity(client, organizerGroupId=group_id, importance=4)
    assert official["organizerType"] == "ADMIN_GROUP"
    with SessionLocal.begin() as db:
        db.execute(
            text(
                "DELETE FROM admin_group_permissions WHERE group_id=:group AND permission_code='ACTIVITY_PUBLISH'"
            ),
            {"group": group_id},
        )
    revoked = client.post(f"/api/activities/{official['id']}/publish", json={"version": official["version"]})
    assert revoked.status_code == 404
    detail = client.get(f"/api/activities/{official['id']}").json()["activity"]
    assert detail["capabilities"]["canPublish"] is False


def test_markdown_preview_audit_and_permanent_delete(client: TestClient):
    login(client, "2026001")
    preview = client.post(
        "/api/activities/markdown/preview",
        json={"content": "# 标题\n<script>alert(1)</script> [站点](https://example.com)"},
    )
    assert preview.status_code == 200
    assert "<script" not in preview.json()["html"]
    assert 'rel="noopener noreferrer nofollow"' in preview.json()["html"]
    activity = create_activity(client)

    admin = TestClient(client.app)
    login(admin, "admin", "Admin123!")
    deleted = admin.request(
        "DELETE",
        f"/api/activities/{activity['id']}",
        json={"confirmed": True, "reason": "清理测试活动"},
    )
    assert deleted.status_code == 200
    assert client.get(f"/api/activities/{activity['id']}").status_code == 404
    with SessionLocal() as db:
        actions = db.execute(
            text("SELECT action FROM audit_logs WHERE target_type='ACTIVITY' ORDER BY id")
        ).scalars().all()
    assert actions == ["CREATE_ACTIVITY", "DELETE_ACTIVITY"]
    admin.close()


def test_calendar_counts_visible_published_cross_day_activities_only(client: TestClient):
    login(client, "2026001")
    create_activity(
        client,
        title="同日草稿",
        startAt="2026-10-31T12:00:00+08:00",
        endAt="2026-10-31T13:00:00+08:00",
    )
    cross_day = publish_activity(
        client,
        create_activity(
            client,
            title="跨月活动",
            startAt="2026-10-31T23:00:00+08:00",
            endAt="2026-11-01T01:00:00+08:00",
            importance=3,
        ),
    )
    calendar = client.get("/api/activities/calendar?view=month&date=2026-10-31").json()
    october = next(day for day in calendar["days"] if day["date"] == "2026-10-31")
    november = next(day for day in calendar["days"] if day["date"] == "2026-11-01")
    assert (october["count"], october["score"]) == (1, 3)
    assert (november["count"], november["score"]) == (1, 3)
    cancelled = client.post(
        f"/api/activities/{cross_day['id']}/cancel",
        json={"version": cross_day["version"], "confirmed": True, "reason": ""},
    )
    assert cancelled.status_code == 200
    refreshed = client.get("/api/activities/calendar?view=month&date=2026-10-31").json()
    assert next(day for day in refreshed["days"] if day["date"] == "2026-10-31")["count"] == 0
