"""Import chat JSONL and plain text. Re-ingesting a file does not duplicate."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from activmem.events import ActivMemError
from activmem.text import content_hash

_BLANK = re.compile(r"\n\s*\n")


@dataclass(slots=True)
class IngestReport:
    added: int
    skipped: int
    path: str

    def to_dict(self) -> dict:
        return asdict(self)


def ingest_chat(mem, path: str | Path) -> IngestReport:
    file = Path(path)
    if not file.is_file():
        raise ActivMemError(f"no such file: {file}")
    default_session = file.stem
    added = 0
    skipped = 0
    for lineno, line in enumerate(file.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ActivMemError(f"{file}:{lineno}: invalid json: {exc.msg}") from exc
        if not isinstance(record, dict) or "role" not in record or "text" not in record:
            raise ActivMemError(f"{file}:{lineno}: each line needs role and text")
        text = record["text"]
        if not isinstance(text, str):
            raise ActivMemError(f"{file}:{lineno}: text must be a string")
        role = str(record["role"])
        if role == "user":
            actor = "nash"
        elif role == "assistant":
            actor = "assistant"
        else:
            actor = role
        session = record.get("session") or default_session
        learned = record.get("ts") if isinstance(record.get("ts"), str) else None
        if _skip_or_save(mem, text, actor, session, learned):
            skipped += 1
        else:
            added += 1
    return IngestReport(added=added, skipped=skipped, path=str(file))


def ingest_text(mem, path: str | Path, *, actor: str = "nash") -> IngestReport:
    file = Path(path)
    if not file.is_file():
        raise ActivMemError(f"no such file: {file}")
    raw = file.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = [part.strip() for part in _BLANK.split(raw) if part.strip()]
    added = 0
    skipped = 0
    for paragraph in paragraphs:
        if _skip_or_save(mem, paragraph, actor, file.stem, None):
            skipped += 1
        else:
            added += 1
    return IngestReport(added=added, skipped=skipped, path=str(file))


def _skip_or_save(mem, text: str, actor: str, session: str | None, learned_at: str | None) -> bool:
    """Return True when the save was skipped as a duplicate or a forgotten text."""
    cleaned = text.strip()
    if not cleaned:
        return True
    content = content_hash(actor, cleaned)
    if content in mem.index.forgotten_hashes or content in mem.index.by_hash:
        return True
    mem.save(cleaned, actor=actor, session=session, learned_at=learned_at)
    return False
