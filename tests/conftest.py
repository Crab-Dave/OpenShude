import os
from pathlib import Path

os.environ["DB_PATH"] = "tests/fastapi-test.db"
os.environ["ENVIRONMENT"] = "test"
os.environ["DOCS_ENABLED"] = "true"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import models  # noqa: F401
from app.auth import _login_failures
from app.common import now
from app.database import Base, SessionLocal, engine
from app.main import app
from app.security import hash_password


@pytest.fixture(autouse=True)
def reset_database():
    engine.dispose()
    Path("tests/fastapi-test.db").unlink(missing_ok=True)
    Path("tests/fastapi-test.db-shm").unlink(missing_ok=True)
    Path("tests/fastapi-test.db-wal").unlink(missing_ok=True)
    Base.metadata.create_all(engine)
    timestamp = now()
    with SessionLocal.begin() as db:
        db.execute(text("CREATE TABLE alembic_version(version_num VARCHAR(32) NOT NULL PRIMARY KEY)"))
        db.execute(text("INSERT INTO alembic_version VALUES('20260801_02')"))
        db.execute(
            text(
                "INSERT INTO grades(id,code,name,status,created_at,updated_at) VALUES(1,'2026级','2026级','ACTIVE',:now,:now),(2,'2025级','2025级','ACTIVE',:now,:now)"
            ),
            {"now": timestamp},
        )
        accounts = [
            ("admin", "系统管理员", "-", None, "UNSPECIFIED", "", "SUPER_ADMIN", "Admin123!"),
            ("2026001", "林夏", "2026级", 1, "FEMALE", "计算机科学", "USER", "Student123!"),
            ("2026002", "江晚", "2026级", 1, "FEMALE", "设计", "USER", "Student123!"),
            ("2026003", "苏晴", "2025级", 2, "FEMALE", "经济学", "USER", "Student123!"),
            ("2026004", "陈遇", "2026级", 1, "MALE", "计算机科学", "USER", "Student123!"),
            ("2026005", "周屿", "2026级", 1, "MALE", "数学", "USER", "Student123!"),
            ("2026006", "叶澜", "2026级", 1, "FEMALE", "中文", "USER", "Student123!"),
            ("2026007", "温然", "2026级", 1, "FEMALE", "法学", "USER", "Student123!"),
        ]
        for login, name, grade, grade_id, gender, major, account_type, password_text in accounts:
            password = hash_password(password_text)
            db.execute(
                text("""INSERT INTO users(login_identifier,password_hash,password_salt,role,account_type,
              authorization_version,must_change_password,name,grade,grade_id,gender,major,status,created_at,updated_at)
              VALUES(:login,:hash,:salt,:role,:type,1,0,:name,:grade,:grade_id,:gender,:major,'ACTIVE',:now,:now)"""),
                {
                    "login": login,
                    "hash": password.hash,
                    "salt": password.salt,
                    "role": "ADMIN" if account_type == "SUPER_ADMIN" else "STUDENT",
                    "type": account_type,
                    "name": name,
                    "grade": grade,
                    "grade_id": grade_id,
                    "gender": gender,
                    "major": major,
                    "now": timestamp,
                },
            )
        for user_id in range(2, 9):
            db.execute(
                text("""INSERT INTO roommate_cards(user_id,avatar_url,origin_province,origin_city,clothing_size,
              summer_temp_min,summer_temp_max,winter_temp_min,winter_temp_max,wake_up_time,sleep_time,nap_habit,
              personal_cleanliness,roommate_cleanliness,common_space_maintenance,unacceptable_hygiene,one_sentence_intro,
              personality_text,roommate_personality_text,interests_text,gaming_self,gaming_roommate,keyboard_noise_text,
              media_noise_text,self_acknowledged_shortcoming,additional_note,status,published_at,created_at,updated_at)
              VALUES(:user,'/assets/avatar-1.png','浙江','杭州','L',24,26,20,23,'7:00','23:30','午休','TIDY',
              'TIDY','NEGOTIABLE','吸烟','一句话介绍','开朗','坦诚','阅读和运动','偶尔游戏','戴耳机','可接受','不外放',
              '偶尔忘事','希望友好相处','PUBLISHED',:now,:now,:now)"""),
                {"user": user_id, "now": timestamp},
            )
        db.execute(
            text("""INSERT INTO dormitory_selection_rounds(id,code,name,description,status,created_by,opened_at,
          created_at,updated_at) VALUES(1,'ROUND_ONE','第一轮','测试轮次','OPEN',1,:now,:now,:now)"""),
            {"now": timestamp},
        )
        for user_id in range(2, 9):
            db.execute(
                text(
                    "INSERT INTO dormitory_round_participants(round_id,user_id,added_by,created_at) VALUES(1,:user,1,:now)"
                ),
                {"user": user_id, "now": timestamp},
            )
    yield
    _login_failures.clear()
    engine.dispose()


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def login(client: TestClient, identifier: str, password: str = "Student123!") -> dict:
    response = client.post("/api/auth/login", json={"loginIdentifier": identifier, "password": password})
    assert response.status_code == 200, response.text
    data = response.json()
    client.headers["x-csrf-token"] = data["csrfToken"]
    return data
