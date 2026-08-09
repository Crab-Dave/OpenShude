from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database import SessionLocal
from tests.conftest import login


def test_admin_report_list_prunes_only_expired_treehole_snapshots(client: TestClient):
    with SessionLocal.begin() as db:
        reports = (
            ("TREEHOLE_POST", "RESOLVED", "2025-01-01T00:00:00.000Z"),
            ("TREEHOLE_COMMENT", "RESOLVED", "2099-01-01T00:00:00.000Z"),
            ("TREEHOLE_POST", "PENDING", None),
            ("ROOMMATE_CARD", "RESOLVED", "2025-01-01T00:00:00.000Z"),
        )
        for index, (target_type, status, handled_at) in enumerate(reports, start=1):
            db.execute(
                text(
                    """INSERT INTO reports(reporter_id,target_type,target_id,reason,snapshot,status,
                    handled_at,created_at) VALUES(2,:type,:target,'test',:snapshot,:status,:handled,:created)"""
                ),
                {
                    "type": target_type,
                    "target": index,
                    "snapshot": f'{{"marker":{index}}}',
                    "status": status,
                    "handled": handled_at,
                    "created": "2025-01-01T00:00:00.000Z",
                },
            )

    login(client, "admin", "Admin123!")
    response = client.get("/api/admin/reports")
    assert response.status_code == 200
    snapshots = {report["target_id"]: report["snapshot"] for report in response.json()["reports"]}
    assert snapshots == {
        1: {},
        2: {"marker": 2},
        3: {"marker": 3},
        4: {"marker": 4},
    }
