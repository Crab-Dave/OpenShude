import html
import json
import shutil
import tomllib
from pathlib import Path, PurePosixPath
from string import Template
from urllib.parse import urlparse

import nh3
from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
RESERVED_ROUTES = {"/api", "/assets", "/login", "/roommates", "/static-pages", "/vendor"}
REQUIRED_PAGE_FIELDS = {"slug", "route", "title", "description", "source", "show_in_navigation", "order"}
MANIFEST_FIELDS = ("slug", "route", "title", "description", "show_in_navigation", "order")
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


def valid_slug(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    return all(
        part and all(character.isascii() and (character.islower() or character.isdigit()) for character in part)
        for part in value.split("-")
    )


def normalize_route(value: object) -> str | None:
    if not isinstance(value, str) or not value.startswith("/"):
        return None
    route = value[:-1] if value != "/" and value.endswith("/") else value
    if route == "/":
        return route
    return route if all(valid_slug(segment) for segment in route[1:].split("/")) else None


def validate_page_identity(page: dict, slugs: set[str], routes: set[str]) -> tuple[str, str]:
    slug = page["slug"]
    route = normalize_route(page["route"])
    if not valid_slug(slug):
        raise ValueError(f"invalid page slug: {slug!r}")
    if route is None:
        raise ValueError(f"invalid page route: {page['route']!r}")
    if route != "/" and any(route == reserved or route.startswith(f"{reserved}/") for reserved in RESERVED_ROUTES):
        raise ValueError(f"reserved page route: {route}")
    if slug in slugs or route in routes:
        raise ValueError(f"duplicate page slug or route: {slug}, {route}")
    return slug, route


def validate_page_metadata(page: dict, slug: str) -> None:
    if not isinstance(page["title"], str) or not page["title"].strip():
        raise ValueError(f"page {slug} requires a title")
    if not isinstance(page["description"], str) or not page["description"].strip():
        raise ValueError(f"page {slug} requires a description")
    if not isinstance(page["source"], str) or not page["source"]:
        raise ValueError(f"page {slug} requires a Markdown source")
    if not isinstance(page["show_in_navigation"], bool):
        raise ValueError(f"page {slug} has invalid navigation visibility")
    if not isinstance(page["order"], int) or isinstance(page["order"], bool):
        raise ValueError(f"page {slug} has invalid navigation order")


def validate_page(raw_page: object, slugs: set[str], routes: set[str]) -> dict:
    if not isinstance(raw_page, dict) or set(raw_page) != REQUIRED_PAGE_FIELDS:
        raise ValueError(f"page entries must contain exactly: {', '.join(sorted(REQUIRED_PAGE_FIELDS))}")
    page = dict(raw_page)
    slug, route = validate_page_identity(page, slugs, routes)
    validate_page_metadata(page, slug)
    page["route"] = route
    slugs.add(slug)
    routes.add(route)
    return page


def repository_paths() -> tuple[Path, Path, Path, Path]:
    repository_root = ROOT.resolve()
    content_root = (repository_root / "content").resolve()
    template_path = (repository_root / "templates/public-page.html").resolve()
    public_root = (repository_root / "public").resolve()
    output_dir = (public_root / "generated").resolve()
    asset_output_dir = (public_root / "static-pages").resolve()
    if not content_root.is_relative_to(repository_root) or not content_root.is_dir():
        raise ValueError("content directory must be inside the repository")
    if not template_path.is_relative_to(repository_root / "templates") or not template_path.is_file():
        raise ValueError("public page template must be inside the repository templates directory")
    if not public_root.is_relative_to(repository_root) or not public_root.is_dir():
        raise ValueError("public directory must be inside the repository")
    if not output_dir.is_relative_to(public_root) or not asset_output_dir.is_relative_to(public_root):
        raise ValueError("generated pages must stay inside the public directory")
    return content_root, template_path, output_dir, asset_output_dir


def load_pages(content_root: Path) -> list[dict]:
    config_path = (content_root / "pages.toml").resolve()
    if not config_path.is_relative_to(content_root) or not config_path.is_file():
        raise ValueError("content/pages.toml must be inside the content directory")
    raw_pages = tomllib.loads(config_path.read_text(encoding="utf-8")).get("pages")
    if not isinstance(raw_pages, list) or not raw_pages:
        raise ValueError("content/pages.toml must define at least one [[pages]] entry")
    slugs: set[str] = set()
    routes: set[str] = set()
    pages = [validate_page(raw_page, slugs, routes) for raw_page in raw_pages]
    if "/" not in routes:
        raise ValueError("one page must use the root route /")
    return pages


def rewrite_page_images(tokens: list, source: Path, slug: str) -> None:
    source_directory = source.parent.resolve()
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
        local_asset = (source_directory / Path(*asset_path.parts)).resolve()
        if not local_asset.is_relative_to(source_directory) or not local_asset.is_file():
            raise ValueError(f"missing page image: {image_source}")
        token.attrSet("src", f"/static-pages/{slug}/{asset_path.as_posix()}")


def copy_page_assets(source: Path, destination: Path) -> None:
    source_assets = source.parent / "assets"
    if not source_assets.exists():
        return
    if not source_assets.is_dir() or any(item.is_symlink() for item in source_assets.rglob("*")):
        raise ValueError(f"page assets must be a directory without symbolic links: {source_assets}")
    shutil.copytree(source_assets, destination)


def render_page(
    page: dict, content_root: Path, template: Template, markdown: MarkdownIt, navigation: str
) -> tuple[str, Path]:
    source = (content_root / page["source"]).resolve()
    if not source.is_relative_to(content_root) or not source.is_file() or source.suffix.lower() != ".md":
        raise ValueError(f"invalid Markdown source for {page['slug']}: {page['source']}")
    source_text = source.read_text(encoding="utf-8")
    if len(source_text.encode("utf-8")) > 1_000_000:
        raise ValueError(f"Markdown source is too large: {page['source']}")
    tokens = markdown.parse(source_text)
    rewrite_page_images(tokens, source, page["slug"])
    rendered = nh3.clean(
        markdown.renderer.render(tokens, markdown.options, {}),
        tags=ALLOWED_TAGS,
        attributes={"a": {"href", "title"}, "img": {"src", "alt", "title"}},
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer",
    )
    document = template.substitute(
        description=html.escape(page["description"], quote=True),
        document_title=html.escape(f"{page['title']} · 合住"),
        navigation=navigation,
        content="\n".join(f"        {line}" for line in rendered.splitlines()),
    )
    return document, source


def page_navigation(page: dict, navigation_pages: list[dict]) -> str:
    return "\n".join(
        f'          <a href="{html.escape(item["route"], quote=True)}"'
        f"{' class="active" aria-current="page"' if item['slug'] == page['slug'] else ''}>"
        f"{html.escape(item['title'])}</a>"
        for item in navigation_pages
    )


def build() -> None:
    content_root, template_path, output_dir, asset_output_dir = repository_paths()
    pages = load_pages(content_root)
    shutil.rmtree(output_dir, ignore_errors=True)
    shutil.rmtree(asset_output_dir, ignore_errors=True)
    output_dir.mkdir()
    asset_output_dir.mkdir()
    template = Template(template_path.read_text(encoding="utf-8"))
    markdown = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False}).enable(
        ["table", "strikethrough"]
    )
    navigation_pages = sorted((page for page in pages if page["show_in_navigation"]), key=lambda page: page["order"])
    manifest = []
    for page in pages:
        navigation = page_navigation(page, navigation_pages)
        document, source = render_page(page, content_root, template, markdown, navigation)
        route_parts = PurePosixPath(page["route"].lstrip("/")).parts
        page_output = output_dir.joinpath(*route_parts, "index.html") if route_parts else output_dir / "index.html"
        page_output = page_output.resolve()
        if not page_output.is_relative_to(output_dir):
            raise ValueError(f"generated page path escapes the output directory: {page['route']}")
        page_output.parent.mkdir(parents=True, exist_ok=True)
        page_output.write_text(document, encoding="utf-8", newline="\n")
        asset_destination = (asset_output_dir / page["slug"] / "assets").resolve()
        if not asset_destination.is_relative_to(asset_output_dir):
            raise ValueError(f"generated asset path escapes the output directory: {page['slug']}")
        copy_page_assets(source, asset_destination)
        manifest.append({key: page[key] for key in MANIFEST_FIELDS})
    (output_dir / "pages.json").write_text(
        json.dumps({"pages": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    build()
