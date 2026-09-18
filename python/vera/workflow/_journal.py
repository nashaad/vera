from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import uuid

from ._canonical import dumps
from ._errors import WorkflowError


_RUN_ID = re.compile(r"wf_[0-9a-f]{16}\Z")
_BLOB_REF = re.compile(r"[0-9a-f]{64}\Z")
_STATUSES = {"ok", "failed", "suspended", "cancelled", "running"}
_INLINE_VALUE_MAX_BYTES = 8192


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _journal_error(message: str) -> WorkflowError:
    return WorkflowError("journal", message)


def _reject_constant(value: str) -> object:
    raise ValueError(f"invalid JSON constant {value}")


def _parse_json_text(text: str, source: str) -> object:
    if type(text) is not str:
        raise _journal_error(f"invalid JSON in {source}")
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as error:
        raise _journal_error(f"invalid JSON in {source}") from error


def _parse_json(text: str, source: Path) -> object:
    return _parse_json_text(text, str(source))


def _read_blob(path: Path, reference: str, byte_count: int) -> object:
    try:
        encoded = path.read_bytes()
    except OSError as error:
        raise _journal_error(f"cannot read {path}") from error
    if len(encoded) != byte_count:
        raise _journal_error(f"workflow blob byte count does not match: {reference}")
    if hashlib.sha256(encoded).hexdigest() != reference:
        raise _journal_error(f"workflow blob digest does not match: {reference}")
    try:
        text = encoded.decode("utf-8")
    except UnicodeError as error:
        raise _journal_error(f"workflow blob is not UTF-8: {reference}") from error
    value = _parse_json(text, path)
    try:
        canonical = dumps(value).encode("utf-8")
    except WorkflowError as error:
        raise _journal_error(f"workflow blob is not valid JSON: {reference}") from error
    if canonical != encoded:
        raise _journal_error(f"workflow blob is not canonical JSON: {reference}")
    return value


def _write_blob(run_dir: Path, encoded: bytes, reference: str) -> None:
    blob_dir = run_dir / "blobs"
    blob_path = blob_dir / reference
    temp_path = blob_dir / f".{reference}.tmp"
    try:
        blob_dir.mkdir(exist_ok=True)
        if blob_path.exists() and blob_path.read_bytes() == encoded:
            return
        with temp_path.open("wb") as blob_file:
            blob_file.write(encoded)
            blob_file.flush()
            os.fsync(blob_file.fileno())
        os.replace(temp_path, blob_path)
    except OSError as error:
        raise _journal_error(f"cannot write workflow blob {reference}") from error


def _validate_timestamp(value: object, field: str) -> None:
    if type(value) is not str:
        raise _journal_error(f"header field {field} must be a string")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise _journal_error(f"header field {field} is not ISO 8601") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _journal_error(f"header field {field} must include a timezone")


def validate_header(
    raw: object,
    run_id: str,
    workflow_name: str | None,
) -> dict[str, object]:
    if type(raw) is not dict:
        raise _journal_error("workflow header must be a JSON object")
    header: dict[str, object] = raw
    required = {"run_id", "workflow", "status", "started_at", "inbox", "doc"}
    missing = sorted(required.difference(header))
    if missing:
        raise _journal_error(f"workflow header is missing: {', '.join(missing)}")
    if header["run_id"] != run_id:
        raise _journal_error("workflow header run_id does not match its directory")
    stored_workflow = header["workflow"]
    if type(stored_workflow) is not str:
        raise _journal_error("header field workflow must be a string")
    if workflow_name is not None and stored_workflow != workflow_name:
        raise _journal_error(
            f"run belongs to workflow {stored_workflow!r}, not {workflow_name!r}"
        )
    status = header["status"]
    if type(status) is not str or status not in _STATUSES:
        raise _journal_error("workflow header has an invalid status")
    _validate_timestamp(header["started_at"], "started_at")
    if type(header["inbox"]) is not dict:
        raise _journal_error("header field inbox must be an object")
    if type(header["doc"]) is not str:
        raise _journal_error("header field doc must be a string")
    if status == "ok":
        _validate_timestamp(header.get("finished_at"), "finished_at")
    if status == "failed":
        error = header.get("error")
        if type(error) is not dict:
            raise _journal_error("failed workflow header must include error")
        if type(error.get("kind")) is not str or type(error.get("message")) is not str:
            raise _journal_error("workflow header error must include kind and message")
    if status in ("suspended", "cancelled") and type(header.get("reason")) is not str:
        raise _journal_error(f"{status} workflow header must include reason")
    args = header.get("args")
    kwargs = header.get("kwargs")
    if type(args) is not list or type(kwargs) is not dict:
        raise _journal_error("workflow header is missing resumable inputs")
    try:
        dumps({"args": args, "kwargs": kwargs})
    except WorkflowError as error:
        raise _journal_error("workflow header contains invalid inputs") from error
    _validate_entry(header.get("entry"))
    _validate_attempts(header.get("attempts"))
    return header


def _validate_entry(entry: object) -> None:
    if entry is None:
        return
    if type(entry) is not dict:
        raise _journal_error("header field entry must be an object")
    for field in ("file", "workflow", "cwd"):
        value = entry.get(field)
        if type(value) is not str or not value:
            raise _journal_error(
                f"header field entry.{field} must be a non-empty string"
            )
    extra = sorted(set(entry).difference({"file", "workflow", "cwd"}))
    if extra:
        raise _journal_error(
            f"header field entry has unknown keys: {', '.join(extra)}"
        )


def _validate_attempts(attempts: object) -> None:
    if attempts is None:
        return
    if type(attempts) is not list:
        raise _journal_error("header field attempts must be an array")
    for attempt in attempts:
        if type(attempt) is not dict:
            raise _journal_error("each workflow attempt must be an object")
        _validate_timestamp(attempt.get("started_at"), "attempts.started_at")
        if type(attempt.get("pid")) is not int:
            raise _journal_error("header field attempts.pid must be an integer")
        if type(attempt.get("host")) is not str:
            raise _journal_error("header field attempts.host must be a string")


def open_attempt(header: dict[str, object]) -> None:
    """Record the process about to run this workflow."""
    attempts = header.get("attempts")
    if type(attempts) is not list:
        attempts = []
        header["attempts"] = attempts
    attempts.append(
        {"started_at": _now(), "pid": os.getpid(), "host": socket.gethostname()}
    )


def close_attempt(header: dict[str, object], status: str) -> None:
    """Close the attempt this process opened.

    An attempt with no `finished_at` belongs to a process that never came back.
    """
    attempts = header.get("attempts")
    if type(attempts) is not list or not attempts:
        return
    attempt = attempts[-1]
    if type(attempt) is not dict or "finished_at" in attempt:
        return
    attempt["finished_at"] = _now()
    attempt["status"] = status
    error = header.get("error")
    if status == "failed" and type(error) is dict:
        attempt["error"] = dict(error)


class Journal:
    def __init__(
        self,
        journal_dir: Path,
        run_dir: Path,
        header: dict[str, object],
        records: dict[str, object],
        next_seq: int,
        timings: dict[str, dict[str, object]] | None = None,
    ) -> None:
        self.journal_dir = journal_dir
        self.run_dir = run_dir
        self.header = header
        self.records = records
        self.timings = timings if timings is not None else {}
        self._next_seq = next_seq

    @classmethod
    def create(
        cls,
        journal_dir: Path,
        workflow_name: str,
        doc: str,
        args: tuple[object, ...],
        kwargs: dict[str, object],
        entry: dict[str, str],
    ) -> Journal:
        cls._require_journal_dir(journal_dir)
        run_id = "wf_" + uuid.uuid4().hex[:16]
        run_dir = journal_dir / run_id
        header: dict[str, object] = {
            "run_id": run_id,
            "workflow": workflow_name,
            "status": "running",
            "started_at": _now(),
            "inbox": {},
            "doc": doc,
            "args": list(args),
            "kwargs": kwargs,
            "entry": dict(entry),
        }
        try:
            run_dir.mkdir()
            (run_dir / "journal.ndjson").touch(exist_ok=False)
        except OSError as error:
            raise _journal_error(
                f"cannot create workflow run in {journal_dir}"
            ) from error
        journal = cls(journal_dir, run_dir, header, {}, 1)
        journal.write_header()
        return journal

    @classmethod
    def load(
        cls,
        journal_dir: Path,
        run_id: str,
        workflow_name: str | None,
    ) -> Journal:
        cls._require_journal_dir(journal_dir)
        if _RUN_ID.fullmatch(run_id) is None:
            raise _journal_error(f"invalid workflow run id: {run_id}")
        run_dir = journal_dir / run_id
        if not run_dir.is_dir():
            raise _journal_error(f"workflow run does not exist: {run_id}")
        header_path = run_dir / "header.json"
        try:
            header_text = header_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise _journal_error(f"cannot read {header_path}") from error
        raw_header = _parse_json(header_text, header_path)
        header = validate_header(raw_header, run_id, workflow_name)
        records, timings, next_seq = cls._load_records(run_dir / "journal.ndjson")
        return cls(journal_dir, run_dir, header, records, next_seq, timings)

    @staticmethod
    def _require_journal_dir(journal_dir: Path) -> None:
        if not journal_dir.is_dir():
            raise _journal_error(f"journal directory does not exist: {journal_dir}")

    @staticmethod
    def _load_records(
        path: Path,
    ) -> tuple[dict[str, object], dict[str, dict[str, object]], int]:
        if not path.exists():
            return {}, {}, 1
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as error:
            raise _journal_error(f"cannot read {path}") from error
        records: dict[str, object] = {}
        timings: dict[str, dict[str, object]] = {}
        for expected_seq, line in enumerate(lines, start=1):
            if not line:
                raise _journal_error(f"blank line in {path}")
            raw = _parse_json(line, path)
            if type(raw) is not dict:
                raise _journal_error("workflow journal record must be an object")
            record: dict[str, object] = raw
            fields = set(record)
            inline_fields = {"seq", "key", "ok", "at", "ms", "value"}
            blob_fields = {"seq", "key", "ok", "at", "ms", "ref", "bytes"}
            if fields not in (inline_fields, blob_fields):
                raise _journal_error("workflow journal record has invalid fields")
            if type(record["seq"]) is not int or record["seq"] != expected_seq:
                raise _journal_error("workflow journal sequence is not contiguous")
            key = record["key"]
            if type(key) is not str or not key:
                raise _journal_error("workflow journal key must be a non-empty string")
            if record["ok"] is not True:
                raise _journal_error("workflow journal may contain successes only")
            if type(record["at"]) is not str or not record["at"]:
                raise _journal_error("workflow journal at must be a timestamp")
            if type(record["ms"]) is not int or record["ms"] < 0:
                raise _journal_error("workflow journal ms must be a whole number")
            if key in records:
                raise _journal_error(f"duplicate workflow journal key: {key}")
            if fields == inline_fields:
                value = record["value"]
                try:
                    dumps(value)
                except WorkflowError as error:
                    raise _journal_error(
                        "workflow journal contains an invalid value"
                    ) from error
            else:
                reference = record["ref"]
                byte_count = record["bytes"]
                if (
                    type(reference) is not str
                    or _BLOB_REF.fullmatch(reference) is None
                ):
                    raise _journal_error("workflow journal blob ref is invalid")
                if (
                    type(byte_count) is not int
                    or byte_count <= _INLINE_VALUE_MAX_BYTES
                ):
                    raise _journal_error("workflow journal blob byte count is invalid")
                value = _read_blob(
                    path.parent / "blobs" / reference,
                    reference,
                    byte_count,
                )
            records[key] = value
            timings[key] = {"at": record["at"], "ms": record["ms"]}
        return records, timings, len(lines) + 1

    @property
    def run_id(self) -> str:
        value = self.header["run_id"]
        if type(value) is not str:
            raise _journal_error("header field run_id must be a string")
        return value

    @property
    def inbox(self) -> dict[str, object]:
        value = self.header["inbox"]
        if type(value) is not dict:
            raise _journal_error("header field inbox must be an object")
        return value

    def inputs(self) -> tuple[tuple[object, ...], dict[str, object]]:
        args = self.header["args"]
        kwargs = self.header["kwargs"]
        if type(args) is not list or type(kwargs) is not dict:
            raise _journal_error("workflow header is missing resumable inputs")
        return tuple(args), kwargs

    def append(self, key: str, value: object, ms: int = 0) -> None:
        encoded_value = dumps(value).encode("utf-8")
        at = _now()
        record: dict[str, object] = {
            "seq": self._next_seq,
            "key": key,
            "ok": True,
            "at": at,
            "ms": ms,
        }
        if len(encoded_value) > _INLINE_VALUE_MAX_BYTES:
            reference = hashlib.sha256(encoded_value).hexdigest()
            _write_blob(self.run_dir, encoded_value, reference)
            record["ref"] = reference
            record["bytes"] = len(encoded_value)
        else:
            record["value"] = value
        try:
            line = json.dumps(
                record,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            )
            with (self.run_dir / "journal.ndjson").open(
                "a",
                encoding="utf-8",
                newline="\n",
            ) as journal_file:
                journal_file.write(line + "\n")
                journal_file.flush()
                os.fsync(journal_file.fileno())
        except (OSError, TypeError, ValueError) as error:
            raise _journal_error("cannot append workflow journal record") from error
        self.records[key] = value
        self.timings[key] = {"at": at, "ms": ms}
        self._next_seq += 1
        if self.header.pop("active", None) is not None:
            self._write_header_during_run()

    def start_attempt(self) -> None:
        open_attempt(self.header)
        self._write_header_during_run()

    def mark_step_started(self, key: str, step_name: str) -> None:
        """Name the step now in flight, so a crashed run says where it stopped."""
        self.header["active"] = {"key": key, "step": step_name, "at": _now()}
        self._write_header_during_run()

    def _write_header_during_run(self) -> None:
        """Rewrite the header without dropping a cancel another process asked for.

        The header file is the cancel channel, so a write from inside the run
        has to carry back whatever landed there since it was last read.
        """
        requested = self.cancel_requested()
        if requested is not None:
            self.header["cancel_requested"] = requested
        self.write_header()

    def mark_running(self) -> None:
        self.header["status"] = "running"
        self.header.pop("active", None)
        self.header.pop("cancel_requested", None)
        self.header.pop("finished_at", None)
        self.header.pop("error", None)
        self.header.pop("reason", None)
        self.write_header()

    def mark_ok(self) -> None:
        self.header["status"] = "ok"
        self.header.pop("active", None)
        self.header["finished_at"] = _now()
        self.header.pop("error", None)
        self.header.pop("reason", None)
        close_attempt(self.header, "ok")
        self.write_header()

    def mark_failed(self, kind: str, message: str) -> None:
        self.header["status"] = "failed"
        self.header.pop("active", None)
        self.header["error"] = {"kind": kind, "message": message}
        self.header.pop("finished_at", None)
        self.header.pop("reason", None)
        close_attempt(self.header, "failed")
        self.write_header()

    def mark_suspended(self, reason: str) -> None:
        self.header["status"] = "suspended"
        self.header.pop("active", None)
        self.header["reason"] = reason
        self.header.pop("finished_at", None)
        self.header.pop("error", None)
        close_attempt(self.header, "suspended")
        self.write_header()

    def mark_cancelled(self, reason: str) -> None:
        self.header["status"] = "cancelled"
        self.header.pop("active", None)
        self.header["reason"] = reason
        self.header.pop("finished_at", None)
        self.header.pop("error", None)
        close_attempt(self.header, "cancelled")
        self.write_header()

    def reload_inbox(self) -> None:
        stored = self._stored_header()
        if stored is None:
            return
        inbox = stored.get("inbox")
        if type(inbox) is dict:
            self.header["inbox"] = inbox

    def request_cancel(self, reason: str) -> None:
        self.header["cancel_requested"] = reason
        self.write_header()

    def cancel_requested(self) -> str | None:
        stored = self._stored_header()
        if stored is None:
            return None
        reason = stored.get("cancel_requested")
        return reason if type(reason) is str else None

    def _stored_header(self) -> dict[str, object] | None:
        header_path = self.run_dir / "header.json"
        try:
            raw = json.loads(header_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        return raw if type(raw) is dict else None

    def write_header(self) -> None:
        header_path = self.run_dir / "header.json"
        temp_path = self.run_dir / "header.json.tmp"
        try:
            encoded = dumps(self.header)
            with temp_path.open("w", encoding="utf-8", newline="\n") as header_file:
                header_file.write(encoded + "\n")
                header_file.flush()
                os.fsync(header_file.fileno())
            os.replace(temp_path, header_path)
        except (OSError, WorkflowError) as error:
            raise _journal_error(f"cannot write {header_path}") from error
