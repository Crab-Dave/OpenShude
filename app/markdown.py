import html

import nh3
from markdown_it import MarkdownIt

MARKDOWN_TAGS = {
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
    "s",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
}
MARKDOWN = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False, "breaks": True}).enable(
    ["table", "strikethrough"]
)


def render_markdown(content: str) -> str:
    return nh3.clean(
        MARKDOWN.render(content),
        tags=MARKDOWN_TAGS,
        attributes={"a": {"href", "title"}},
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer nofollow",
    )


def markdown_summary(content: str, limit: int) -> tuple[str, bool]:
    rendered = render_markdown(content)
    plain = html.unescape(nh3.clean(rendered, tags=set(), attributes={}, url_schemes=set()))
    normalized = " ".join(plain.split())
    return normalized[:limit], len(normalized) > limit
