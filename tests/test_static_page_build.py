import json
import subprocess
import sys


def run_builder(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "scripts/build_static_pages.py", *arguments],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def test_static_page_builder_renders_manifest_and_safe_local_image(tmp_path):
    content = tmp_path / "content"
    assets = content / "pages/home/assets"
    assets.mkdir(parents=True)
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
    output = tmp_path / "generated"
    asset_output = tmp_path / "static-pages"
    result = run_builder(
        "--config",
        str(content / "pages.toml"),
        "--output",
        str(output),
        "--asset-output",
        str(asset_output),
    )

    assert result.returncode == 0, result.stderr
    document = (output / "index.html").read_text(encoding="utf-8")
    assert '<meta name="description" content="合住校内室友双选系统">' in document
    assert 'src="/static-pages/home/assets/example.png"' in document
    assert "<script" not in document
    assert (asset_output / "home/assets/example.png").read_bytes() == b"example image"
    assert json.loads((output / "pages.json").read_text(encoding="utf-8"))["pages"][0]["route"] == "/"


def test_static_page_builder_rejects_remote_images(tmp_path):
    content = tmp_path / "content"
    content.mkdir()
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
    result = run_builder(
        "--config",
        str(content / "pages.toml"),
        "--output",
        str(tmp_path / "generated"),
        "--asset-output",
        str(tmp_path / "assets"),
    )

    assert result.returncode != 0
    assert "page images must be local files" in result.stderr
