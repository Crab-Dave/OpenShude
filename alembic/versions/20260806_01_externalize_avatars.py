"""Move valid Base64 avatars out of SQLite rows."""

import base64
import hashlib
from pathlib import Path

from alembic import op
from app.config import get_settings

revision = "20260806_01"
down_revision = "20260805_01"
branch_labels = None
depends_on = None

SIGNATURES = {
    "data:image/png;base64": (b"\x89PNG\r\n\x1a\n", "png"),
    "data:image/jpeg;base64": (b"\xff\xd8\xff", "jpg"),
    "data:image/webp;base64": (b"RIFF", "webp"),
}


def upgrade() -> None:
    bind = op.get_bind()
    directory = Path(get_settings().avatar_dir)
    directory.mkdir(parents=True, exist_ok=True)
    rows = bind.exec_driver_sql("SELECT id,avatar_url FROM roommate_cards").mappings()
    for row in rows:
        value = row["avatar_url"] or ""
        header, separator, encoded = value.partition(",")
        signature = SIGNATURES.get(header.lower())
        if not separator or not signature:
            continue
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except ValueError:
            continue
        if len(decoded) > 2 * 1024 * 1024:
            continue
        prefix, extension = signature
        if not decoded.startswith(prefix) or (extension == "webp" and decoded[8:12] != b"WEBP"):
            continue
        digest = hashlib.sha256(decoded).hexdigest()
        target = directory / f"{digest}.{extension}"
        try:
            with target.open("xb") as output:
                output.write(decoded)
        except FileExistsError:
            pass
        bind.exec_driver_sql(
            "UPDATE roommate_cards SET avatar_url=? WHERE id=?",
            (f"/api/avatars/{digest}.{extension}", row["id"]),
        )


def downgrade() -> None:
    raise RuntimeError("Avatar externalization downgrade requires a verified backup")
