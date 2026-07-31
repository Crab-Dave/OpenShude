import hashlib
from typing import Annotated

import nh3
from fastapi import APIRouter, Depends, Request
from markdown_it import MarkdownIt
from sqlalchemy import text
from sqlalchemy.orm import Session

from .common import audit, authorize_global, clean_text, current_user, now, one, require_management
from .database import get_db
from .dormitories import begin_immediate
from .errors import ApiError

router = APIRouter(prefix="/api")
DB = Annotated[Session, Depends(get_db)]
HOMEPAGE_KEY = "homepage_markdown"
MAX_MARKDOWN_LENGTH = 100_000
DEFAULT_MARKDOWN = """# 欢迎来到合住

这里是校内室友双选系统。你可以阅读首页通知，登录后完善室友卡片、联系同学并参与当前选宿舍轮次。

## 使用提示

- 请如实填写个人信息，尊重他人的生活习惯和沟通边界。
- 私信与组队信息仅供本系统内部使用。
- 如遇账号或内容问题，请联系系统管理员。
"""
_markdown = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False}).enable(
    ["table", "strikethrough"]
)
ALLOWED_TAGS = {
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
}


def render_markdown(markdown: str) -> str:
    return nh3.clean(
        _markdown.render(markdown),
        tags=ALLOWED_TAGS,
        attributes={"a": {"href", "title"}},
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer",
    )


def homepage_row(db: Session) -> dict:
    row = one(db, "SELECT value,updated_at,revision FROM system_settings WHERE key=:key", {"key": HOMEPAGE_KEY})
    return row or {"value": DEFAULT_MARKDOWN, "updated_at": None, "revision": 0}


def content_payload(row: dict, include_markdown: bool = False) -> dict:
    payload = {
        "html": render_markdown(row["value"]),
        "updatedAt": row["updated_at"],
        "revision": row["revision"],
    }
    if include_markdown:
        payload["markdown"] = row["value"]
    return payload


def homepage_admin(request: Request, db: Session) -> tuple[dict, dict]:
    user = current_user(request, db)
    require_management(db, user)
    return user, authorize_global(db, user, "HOMEPAGE_UPDATE", "HOMEPAGE")


@router.get("/public/homepage")
def public_homepage(db: DB) -> dict:
    return content_payload(homepage_row(db))


@router.get("/admin/homepage")
def admin_homepage(request: Request, db: DB) -> dict:
    homepage_admin(request, db)
    return content_payload(homepage_row(db), True)


@router.post("/admin/homepage/preview")
def preview_homepage(request: Request, body: dict, db: DB) -> dict:
    homepage_admin(request, db)
    markdown = clean_text(body.get("markdown"), MAX_MARKDOWN_LENGTH)
    return {"html": render_markdown(markdown)}


@router.put("/admin/homepage")
def update_homepage(request: Request, body: dict, db: DB) -> dict:
    admin, grant = homepage_admin(request, db)
    markdown = clean_text(body.get("markdown"), MAX_MARKDOWN_LENGTH, True)
    reason = clean_text(body.get("reason"), 200, True)
    expected_revision = body.get("expectedRevision")
    if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 0:
        raise ApiError(400, "INVALID_CONTENT_REVISION", "内容修订号无效")

    begin_immediate(db)
    previous = homepage_row(db)
    if previous["revision"] != expected_revision:
        raise ApiError(409, "CONTENT_VERSION_CONFLICT", "首页内容已被其他管理员更新，请重新加载")
    timestamp = now()
    revision = expected_revision + 1
    db.execute(
        text("""INSERT INTO system_settings(key,value,updated_by,updated_at,revision)
        VALUES(:key,:value,:admin,:updated,:revision)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,
          updated_at=excluded.updated_at,revision=excluded.revision"""),
        {"key": HOMEPAGE_KEY, "value": markdown, "admin": admin["id"], "updated": timestamp, "revision": revision},
    )
    audit(
        db,
        admin,
        request,
        "UPDATE_HOMEPAGE",
        "SYSTEM_CONTENT",
        "homepage",
        reason,
        grant=grant,
        before={
            "revision": previous["revision"],
            "length": len(previous["value"]),
            "sha256": hashlib.sha256(previous["value"].encode()).hexdigest(),
        },
        after={"revision": revision, "length": len(markdown), "sha256": hashlib.sha256(markdown.encode()).hexdigest()},
    )
    db.commit()
    return content_payload({"value": markdown, "updated_at": timestamp, "revision": revision}, True)
