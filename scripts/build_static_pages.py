import argparse
import html
import json
import re
import shutil
import tomllib
from pathlib import Path, PurePosixPath
from string import Template
from urllib.parse import urlparse

import nh3
from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
RESERVED_ROUTES = {"/api", "/assets", "/login", "/roommates", "/static-pages", "/vendor"}
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
    "img",
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


def build(config_path: Path, template_path: Path, output_dir: Path, asset_output_dir: Path) -> None:
    content_root = config_path.resolve().parent
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    pages = config.get("pages")
    if not isinstance(pages, list) or not pages:
        raise ValueError("content/pages.toml must define at least one [[pages]] entry")

    routes: set[str] = set()
    slugs: set[str] = set()
    for page in pages:
        required = {"slug", "route", "title", "description", "source", "show_in_navigation", "order"}
        if not isinstance(page, dict) or set(page) != required:
            raise ValueError(f"page entries must contain exactly: {', '.join(sorted(required))}")
        slug = page["slug"]
        route = page["route"]
        if not isinstance(slug, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            raise ValueError(f"invalid page slug: {slug!r}")
        if not isinstance(route, str) or not re.fullmatch(r"/(?:[a-z0-9]+(?:-[a-z0-9]+)*/?)*", route):
            raise ValueError(f"invalid page route: {route!r}")
        route = route.rstrip("/") or "/"
        page["route"] = route
        if route != "/" and any(route == reserved or route.startswith(f"{reserved}/") for reserved in RESERVED_ROUTES):
            raise ValueError(f"reserved page route: {route}")
        if slug in slugs or route in routes:
            raise ValueError(f"duplicate page slug or route: {slug}, {route}")
        if not isinstance(page["title"], str) or not page["title"].strip():
            raise ValueError(f"page {slug} requires a title")
        if not isinstance(page["description"], str) or not page["description"].strip():
            raise ValueError(f"page {slug} requires a description")
        if not isinstance(page["show_in_navigation"], bool) or not isinstance(page["order"], int):
            raise ValueError(f"page {slug} has invalid navigation metadata")
        slugs.add(slug)
        routes.add(route)

    if "/" not in routes:
        raise ValueError("one page must use the root route /")

    shutil.rmtree(output_dir, ignore_errors=True)
    shutil.rmtree(asset_output_dir, ignore_errors=True)
    output_dir.mkdir(parents=True)
    asset_output_dir.mkdir(parents=True)
    template = Template(template_path.read_text(encoding="utf-8"))
    markdown = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False}).enable(
        ["table", "strikethrough"]
    )
    navigation_pages = sorted((page for page in pages if page["show_in_navigation"]), key=lambda page: page["order"])

    manifest = []
    for page in pages:
        source = (content_root / page["source"]).resolve()
        if not source.is_relative_to(content_root) or not source.is_file() or source.suffix.lower() != ".md":
            raise ValueError(f"invalid Markdown source for {page['slug']}: {page['source']}")
        source_text = source.read_text(encoding="utf-8")
        if len(source_text.encode("utf-8")) > 1_000_000:
            raise ValueError(f"Markdown source is too large: {page['source']}")
        tokens = markdown.parse(source_text)
        pending = list(tokens)
        while pending:
            token = pending.pop()
            pending.extend(token.children or [])
            if token.type != "image":
                continue
            image_source = token.attrGet("src") or ""
            parsed = urlparse(image_source)
            asset_path = PurePosixPath(parsed.path)
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or not asset_path.parts:
                raise ValueError(f"page images must be local files: {image_source}")
            if asset_path.parts[0] != "assets" or ".." in asset_path.parts:
                raise ValueError(f"page images must be inside the page assets directory: {image_source}")
            local_asset = (source.parent / Path(*asset_path.parts)).resolve()
            if not local_asset.is_relative_to(source.parent) or not local_asset.is_file():
                raise ValueError(f"missing page image: {image_source}")
            token.attrSet("src", f"/static-pages/{page['slug']}/{asset_path.as_posix()}")

        source_assets = source.parent / "assets"
        if source_assets.exists():
            if not source_assets.is_dir():
                raise ValueError(f"page assets path is not a directory: {source_assets}")
            shutil.copytree(source_assets, asset_output_dir / page["slug"] / "assets")

        rendered = nh3.clean(
            markdown.renderer.render(tokens, markdown.options, {}),
            tags=ALLOWED_TAGS,
            attributes={"a": {"href", "title"}, "img": {"src", "alt", "title"}},
            url_schemes={"http", "https", "mailto"},
            link_rel="noopener noreferrer",
        )
        navigation = "\n".join(
            f'          <a href="{html.escape(item["route"], quote=True)}"'
            f"{' class="active" aria-current="page"' if item['slug'] == page['slug'] else ''}>"
            f"{html.escape(item['title'])}</a>"
            for item in navigation_pages
        )
        document = template.substitute(
            description=html.escape(page["description"], quote=True),
            document_title=html.escape(f"{page['title']} · 合住"),
            navigation=navigation,
            content="\n".join(f"        {line}" for line in rendered.splitlines()),
        )
        route_parts = PurePosixPath(page["route"].lstrip("/")).parts
        page_output = output_dir.joinpath(*route_parts, "index.html") if route_parts else output_dir / "index.html"
        page_output.parent.mkdir(parents=True, exist_ok=True)
        page_output.write_text(document, encoding="utf-8", newline="\n")
        manifest.append(
            {key: page[key] for key in ("slug", "route", "title", "description", "show_in_navigation", "order")}
        )

    (output_dir / "pages.json").write_text(
        json.dumps({"pages": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build repository-backed public pages")
    parser.add_argument("--config", type=Path, default=ROOT / "content/pages.toml")
    parser.add_argument("--template", type=Path, default=ROOT / "templates/public-page.html")
    parser.add_argument("--output", type=Path, default=ROOT / "public/generated")
    parser.add_argument("--asset-output", type=Path, default=ROOT / "public/static-pages")
    arguments = parser.parse_args()
    build(arguments.config, arguments.template, arguments.output, arguments.asset_output)
