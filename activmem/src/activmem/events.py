"""Append-only event log with a hash chain."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

HASH_LEN = 16
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ActivMemError(Exception):
    """Readable failure from the library or the CLI."""


class BrokenChainError(ActivMemError):
    def __init__(self, info: ChainBreak):
        self.info = info
        super().__init__(f"broken chain at line {info.line}: {info.message}")


class UnknownItemError(ActivMemError):
    def __init__(self, item_id: str):
        super().__init__(f"unknown item: {item_id}")


class BadLinkKindError(ActivMemError):
    def __init__(self, kind: str):
        super().__init__(f"bad link kind: {kind}")


class MissingActorError(ActivMemError):
    def __init__(self) -> None:
        super().__init__("actor is required")


class ForgottenError(ActivMemError):
    def __init__(self, text: str):
        super().__init__(f"forgotten and cannot be saved again: {text}")


@dataclass(frozen=True, slots=True)
class ChainBreak:
    line: int
    message: str


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_date(value: str, label: str) -> str:
    if not isinstance(value, str) or _DATE.match(value) is None:
        raise ActivMemError(f"bad {label}: {value!r}")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise ActivMemError(f"bad {label}: {value!r}") from exc
    return value


def check_as_of(value: str) -> str:
    if len(value) == 10:
        return check_date(value, "as_of")
    if len(value) >= 20 and value[10] == "T":
        check_date(value[:10], "as_of")
        return value
    raise ActivMemError(f"bad as_of: {value!r}")


def learned_ok(learned_at: str | None, as_of: str | None) -> bool:
    """True when an event is visible at as_of. A date compares by calendar day."""
    if as_of is None or not learned_at:
        return True
    if len(as_of) <= 10:
        return learned_at[:10] <= as_of[:10]
    return learned_at <= as_of


def normalize_true_at(value: object) -> dict[str, str | None] | None:
    """A bare date is that day only. A pair is an inclusive range; to may be None."""
    if value is None:
        return None
    if isinstance(value, str):
        day = check_date(value, "true_at")
        return {"from": day, "to": day}
    if isinstance(value, (list, tuple)) and len(value) == 2:
        start, end = value
        if start is not None:
            start = check_date(str(start), "true_at")
        if end is not None:
            end = check_date(str(end), "true_at")
        if start is None and end is None:
            raise ActivMemError(f"bad true_at: {value!r}")
        return {"from": start, "to": end}
    raise ActivMemError(f"bad true_at: {value!r}")


def covers(true_at: dict[str, str | None] | None, day: str | None) -> bool:
    if day is None or true_at is None:
        return True
    check_date(day, "true_on")
    start = true_at.get("from")
    end = true_at.get("to")
    if start and day < start:
        return False
    if end and day > end:
        return False
    return True


def require_actor(actor: object) -> str:
    if not isinstance(actor, str) or not actor.strip():
        raise MissingActorError()
    return actor.strip()


def compute_id(body: dict) -> str:
    raw = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:HASH_LEN]


def body_of(event: dict) -> dict:
    return {key: value for key, value in event.items() if key not in ("id", "prev_hash")}


def scan(path: Path) -> tuple[list[dict], ChainBreak | None]:
    if not path.exists():
        return [], None
    events: list[dict] = []
    previous = ""
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            raw = line.strip()
            if not raw:
                return events, ChainBreak(line_no, "empty line")
            try:
                record = json.loads(raw)
            except json.JSONDecodeError as exc:
                return events, ChainBreak(line_no, f"invalid json: {exc.msg}")
            if not isinstance(record, dict) or "id" not in record or "prev_hash" not in record:
                return events, ChainBreak(line_no, "event is missing id or prev_hash")
            if record["prev_hash"] != previous:
                return events, ChainBreak(line_no, "prev_hash does not match the previous event")
            body = {key: value for key, value in record.items() if key != "id"}
            expected = compute_id(body)
            if record["id"] != expected:
                return events, ChainBreak(
                    line_no,
                    f"hash mismatch (line has {record['id']}, chain computes {expected})",
                )
            events.append(record)
            previous = record["id"]
    return events, None


class EventLog:
    """Append-only JSONL. Each id is a short hash over the event and prev_hash."""

    def __init__(self, path: Path, *, force: bool = False):
        self.path = Path(path)
        self.force = force
        self._handle: object | None = None
        self.events, self.break_info = scan(self.path)
        self.tip = self.events[-1]["id"] if self.events else ""
        self.repaired_from: ChainBreak | None = None
        if self.break_info is not None:
            if not force:
                raise BrokenChainError(self.break_info)
            self.repaired_from = self.break_info
            self.replace_all([body_of(event) for event in self.events])
            self.break_info = None

    def close(self) -> None:
        handle = self._handle
        self._handle = None
        if handle is not None:
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _ensure(self):
        if self._handle is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._handle = open(self.path, "a", encoding="utf-8")
        return self._handle

    def append(self, body: dict) -> dict:
        if self.break_info is not None:
            raise BrokenChainError(self.break_info)
        payload = dict(body)
        payload.pop("id", None)
        payload["prev_hash"] = self.tip
        record = dict(payload)
        record["id"] = compute_id(payload)
        handle = self._ensure()
        handle.write(json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        self.events.append(record)
        self.tip = record["id"]
        return record

    def replace_all(self, bodies: list[dict]) -> list[dict]:
        """Rewrite the log, recomputing the hash chain. Used by forget and --force."""
        self.close()
        previous = ""
        records: list[dict] = []
        for body in bodies:
            payload = {key: value for key, value in body.items() if key not in ("id", "prev_hash")}
            payload["prev_hash"] = previous
            record = dict(payload)
            record["id"] = compute_id(payload)
            previous = record["id"]
            records.append(record)
        text = "".join(
            json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n"
            for record in records
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".jsonl.tmp")
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)
        self.events = records
        self.tip = previous
        self.break_info = None
        return records

    def reload(self) -> ChainBreak | None:
        self.close()
        self.events, self.break_info = scan(self.path)
        self.tip = self.events[-1]["id"] if self.events else ""
        if self.break_info is not None and not self.force:
            raise BrokenChainError(self.break_info)
        return self.break_info
