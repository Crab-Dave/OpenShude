import json
import shutil
from pathlib import Path

import pytest

from scripts import build_static_pages


def static_page_repository(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(build_static_pages, "ROOT", tmp_path)
    content = tmp_path / "content"
    assets = content / "pages/home/assets"
    assets.mkdir(parents=True)
    (tmp_path / "public").mkdir()
    (tmp_path / "templates").mkdir()
    shutil.copyfile("templates/public-page.html", tmp_path / "templates/public-page.html")
    return content


def test_static_page_builder_renders_manifest_and_safe_local_image(tmp_path, monkeypatch):
    content = static_page_repository(tmp_path, monkeypatch)
    assets = content / "pages/home/assets"
    (assets / "example.png").write_bytes(b"example image")
    (content / "pages/home/content.md").write_text("# 占位首页\n\n![示例](assets/example.png)\n", encoding="utf-8")
    (content / "pages.toml").write_text(
        """[[pages]]
slug = "home"
route = "/"
title = "首页"
description = "合住校内室友双选系统"
source = "pages/home/content.md"
show_in_navigation = true
order = 10
""",
        encoding="utf-8",
    )
    build_static_pages.build()

    output = tmp_path / "public/generated"
    asset_output = tmp_path / "public/static-pages"
    document = (output / "index.html").read_text(encoding="utf-8")
    assert '<meta name="description" content="合住校内室友双选系统">' in document
    assert 'src="/static-pages/home/assets/example.png"' in document
    assert '<script src="/public-page.js"></script>' in document
    assert (asset_output / "home/assets/example.png").read_bytes() == b"example image"
    assert json.loads((output / "pages.json").read_text(encoding="utf-8"))["pages"][0]["route"] == "/"


def test_static_page_builder_rejects_remote_images(tmp_path, monkeypatch):
    content = static_page_repository(tmp_path, monkeypatch)
    (content / "page.md").write_text("![远程图片](https://example.com/image.png)", encoding="utf-8")
    (content / "pages.toml").write_text(
        """[[pages]]
slug = "home"
route = "/"
title = "首页"
description = "测试"
source = "page.md"
show_in_navigation = true
order = 10
""",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="page images must be local files"):
        build_static_pages.build()


def test_static_page_builder_rejects_source_outside_content(tmp_path, monkeypatch):
    content = static_page_repository(tmp_path, monkeypatch)
    (tmp_path / "outside.md").write_text("# 不应读取", encoding="utf-8")
    (content / "pages.toml").write_text(
        """[[pages]]
slug = "home"
route = "/"
title = "首页"
description = "测试"
source = "../outside.md"
show_in_navigation = true
order = 10
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="invalid Markdown source"):
        build_static_pages.build()
