from __future__ import annotations

from collections.abc import Sequence
import hashlib
from pathlib import Path
import sqlite3
from typing import Protocol
import uuid

from ._canonical import dumps
from ._errors import WorkflowError
from ._journal import (
    _BLOB_REF,
    _INLINE_VALUE_MAX_BYTES,
    _RUN_ID,
    _journal_error,
    _now,
    _parse_json_text,
    close_attempt,
    open_attempt,
    validate_header,
)
from ._store import RunSummary


class SqlDialect:
    placeholder: str = "?"
    blob_type: str = "BLOB"
    blob_insert: str = (
        "INSERT OR IGNORE INTO blobs (digest, body) VALUES (?, ?)"
    )

    def values(self, count: int) -> str:
        return ",".join(self.placeholder for _ in range(count))

    def schema(self) -> tuple[str, ...]:
        return (
            """
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                workflow TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                inbox TEXT NOT NULL,
                doc TEXT NOT NULL,
                args TEXT NOT NULL,
                kwargs TEXT NOT NULL,
                error TEXT,
                reason TEXT,
                active TEXT,
                attempts TEXT,
                entry_file TEXT,
                entry_workflow TEXT,
                entry_cwd TEXT,
                cancel_requested TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS records (
                run_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                key TEXT NOT NULL,
                at TEXT NOT NULL,
                ms INTEGER NOT NULL,
                value TEXT,
                blob_ref TEXT,
                blob_bytes INTEGER,
                PRIMARY KEY (run_id, seq),
                UNIQUE (run_id, key),
                FOREIGN KEY (run_id) REFERENCES runs(run_id)
            )
            """,
            f"""
            CREATE TABLE IF NOT EXISTS blobs (
                digest TEXT PRIMARY KEY,
                body {self.blob_type} NOT NULL
            )
            """,
        )

    def insert_run(self) -> str:
        return (
            "INSERT INTO runs ("
            "run_id, workflow, status, started_at, finished_at, inbox, doc, "
            "args, kwargs, error, reason, active, attempts, entry_file, "
            "entry_workflow, entry_cwd"
            f") VALUES ({self.values(16)})"
        )

    def select_run(self) -> str:
        return (
            "SELECT run_id, workflow, status, started_at, finished_at, inbox, "
            "doc, args, kwargs, error, reason, active, attempts, entry_file, "
            f"entry_workflow, entry_cwd FROM runs WHERE run_id = {self.placeholder}"
        )

    def update_run(self) -> str:
        return (
            "UPDATE runs SET workflow = {p}, status = {p}, started_at = {p}, "
            "finished_at = {p}, inbox = {p}, doc = {p}, args = {p}, "
            "kwargs = {p}, error = {p}, reason = {p}, active = {p}, "
            "attempts = {p}, entry_file = {p}, entry_workflow = {p}, "
            "entry_cwd = {p} "
            "WHERE run_id = {p}"
        ).format(p=self.placeholder)

    def select_records(self) -> str:
        return (
            "SELECT seq, key, at, ms, value, blob_ref, blob_bytes FROM records "
            f"WHERE run_id = {self.placeholder} ORDER BY seq"
        )

    def insert_record(self) -> str:
        return (
            "INSERT INTO records ("
            "run_id, seq, key, at, ms, value, blob_ref, blob_bytes"
            f") VALUES ({self.values(8)})"
        )

    def select_blob(self) -> str:
        return f"SELECT body FROM blobs WHERE digest = {self.placeholder}"

    def select_runs(self) -> str:
        return (
            "SELECT run_id, workflow, status, started_at, finished_at FROM runs "
            "ORDER BY started_at DESC"
        )

    def select_inbox(self) -> str:
        return f"SELECT inbox FROM runs WHERE run_id = {self.placeholder}"

    def select_cancel_requested(self) -> str:
        return (
            "SELECT cancel_requested FROM runs "
            f"WHERE run_id = {self.placeholder}"
        )

    def update_cancel_requested(self) -> str:
        return (
            "UPDATE runs SET cancel_requested = {p} WHERE run_id = {p}"
        ).format(p=self.placeholder)


class SqliteDialect(SqlDialect):
    pass


class PostgresDialect(SqlDialect):
    placeholder = "%s"
    blob_type = "BYTEA"
    blob_insert = (
        "INSERT INTO blobs (digest, body) VALUES (%s, %s) "
        "ON CONFLICT (digest) DO NOTHING"
    )


class SqlCursor(Protocol):
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class SqlConnection(Protocol):
    def execute(self, sql: str, parameters: Sequence[object] = ()) -> SqlCursor: ...

    def commit(self) -> None: ...


class SqlRunJournal:
    def __init__(
        self,
        store: SqlJournalStore,
        header: dict[str, object],
        records: dict[str, object],
        next_seq: int,
        timings: dict[str, dict[str, object]] | None = None,
    ) -> None:
        self.journal_dir = store.journal_dir
        self.header = header
        self.records = records
        self.timings = timings if timings is not None else {}
        self._store = store
        self._next_seq = next_seq

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
        blob_ref: str | None = None
        blob_bytes: int | None = None
        inline: str | None = None
        if len(encoded_value) > _INLINE_VALUE_MAX_BYTES:
            blob_ref = hashlib.sha256(encoded_value).hexdigest()
            blob_bytes = len(encoded_value)
            self._store._execute(
                self._store.dialect.blob_insert,
                (blob_ref, encoded_value),
            )
        else:
            inline = dumps(value)
        self._store._execute(
            self._store.dialect.insert_record(),
            (
                self.run_id,
                self._next_seq,
                key,
                at,
                ms,
                inline,
                blob_ref,
                blob_bytes,
            ),
        )
        self._store._commit()
        self.records[key] = value
        self.timings[key] = {"at": at, "ms": ms}
        self._next_seq += 1
        if self.header.pop("active", None) is not None:
            self.write_header()

    def start_attempt(self) -> None:
        open_attempt(self.header)
        self.write_header()

    def mark_step_started(self, key: str, step_name: str) -> None:
        """Name the step now in flight, so a crashed run says where it stopped."""
        self.header["active"] = {"key": key, "step": step_name, "at": _now()}
        self.write_header()

    def mark_running(self) -> None:
        self._set_cancel_requested(None)
        self.header.pop("active", None)
        self.header["status"] = "running"
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

    def write_header(self) -> None:
        entry = self.header.get("entry")
        entry_file = entry_workflow = entry_cwd = None
        if type(entry) is dict:
            file = entry.get("file")
            workflow = entry.get("workflow")
            cwd = entry.get("cwd")
            if type(file) is str:
                entry_file = file
            if type(workflow) is str:
                entry_workflow = workflow
            if type(cwd) is str:
                entry_cwd = cwd
        error = self.header.get("error")
        error_text = dumps(error) if type(error) is dict else None
        inbox = self.header["inbox"]
        args = self.header["args"]
        kwargs = self.header["kwargs"]
        if type(inbox) is not dict or type(args) is not list or type(kwargs) is not dict:
            raise _journal_error("workflow header is missing resumable inputs")
        self._store._execute(
            self._store.dialect.update_run(),
            (
                self.header["workflow"],
                self.header["status"],
                self.header["started_at"],
                self.header.get("finished_at"),
                dumps(inbox),
                self.header["doc"],
                dumps(args),
                dumps(kwargs),
                error_text,
                self.header.get("reason"),
                _active_text(self.header.get("active")),
                _attempts_text(self.header.get("attempts")),
                entry_file,
                entry_workflow,
                entry_cwd,
                self.run_id,
            ),
        )
        self._store._commit()

    def request_cancel(self, reason: str) -> None:
        self._set_cancel_requested(reason)

    def cancel_requested(self) -> str | None:
        rows = self._store._query(
            self._store.dialect.select_cancel_requested(),
            (self.run_id,),
        )
        if not rows:
            return None
        reason = rows[0][0]
        return reason if type(reason) is str else None

    def _set_cancel_requested(self, reason: str | None) -> None:
        self._store._execute(
            self._store.dialect.update_cancel_requested(),
            (reason, self.run_id),
        )
        self._store._commit()

    def reload_inbox(self) -> None:
        rows = self._store._query(
            self._store.dialect.select_inbox(),
            (self.run_id,),
        )
        if not rows:
            return
        raw = rows[0][0]
        if type(raw) is not str:
            return
        try:
            inbox = _parse_json_text(raw, "inbox")
        except WorkflowError:
            return
        if type(inbox) is dict:
            self.header["inbox"] = inbox


class SqlJournalStore:
    def __init__(
        self,
        locator: Path,
        dialect: SqlDialect,
        connection: SqlConnection,
    ) -> None:
        self.journal_dir = locator
        self.dialect = dialect
        self._connection = connection
        for statement in dialect.schema():
            connection.execute(statement)
        connection.commit()

    def _execute(self, sql: str, parameters: Sequence[object] = ()) -> None:
        try:
            self._connection.execute(sql, tuple(parameters))
        except sqlite3.Error as error:
            raise _journal_error("cannot write workflow journal") from error

    def _query(
        self,
        sql: str,
        parameters: Sequence[object] = (),
    ) -> list[tuple[object, ...]]:
        try:
            cursor = self._connection.execute(sql, tuple(parameters))
            return list(cursor.fetchall())
        except sqlite3.Error as error:
            raise _journal_error("cannot read workflow journal") from error

    def _commit(self) -> None:
        try:
            self._connection.commit()
        except sqlite3.Error as error:
            raise _journal_error("cannot write workflow journal") from error

    def create(
        self,
        workflow_name: str,
        doc: str,
        args: tuple[object, ...],
        kwargs: dict[str, object],
        entry: dict[str, str],
    ) -> SqlRunJournal:
        run_id = "wf_" + uuid.uuid4().hex[:16]
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
        self._execute(
            self.dialect.insert_run(),
            (
                run_id,
                workflow_name,
                "running",
                header["started_at"],
                None,
                dumps({}),
                doc,
                dumps(list(args)),
                dumps(kwargs),
                None,
                None,
                None,
                None,
                entry["file"],
                entry["workflow"],
                entry["cwd"],
            ),
        )
        self._commit()
        return SqlRunJournal(self, header, {}, 1)

    def load(self, run_id: str, workflow_name: str | None) -> SqlRunJournal:
        if _RUN_ID.fullmatch(run_id) is None:
            raise _journal_error(f"invalid workflow run id: {run_id}")
        rows = self._query(self.dialect.select_run(), (run_id,))
        if not rows:
            raise _journal_error(f"workflow run does not exist: {run_id}")
        header = _header_from_row(rows[0])
        header = validate_header(header, run_id, workflow_name)
        records, timings, next_seq = self._load_records(run_id)
        return SqlRunJournal(self, header, records, next_seq, timings)

    def runs(self) -> list[RunSummary]:
        summaries: list[RunSummary] = []
        for row in self._query(self.dialect.select_runs()):
            run_id, workflow_name, status, started_at, finished_at = row
            summaries.append(RunSummary(
                run_id=str(run_id),
                workflow=str(workflow_name),
                status=str(status),
                started_at=str(started_at),
                finished_at=None if finished_at is None else str(finished_at),
            ))
        return summaries

    def _load_records(
        self, run_id: str
    ) -> tuple[dict[str, object], dict[str, dict[str, object]], int]:
        rows = self._query(self.dialect.select_records(), (run_id,))
        records: dict[str, object] = {}
        timings: dict[str, dict[str, object]] = {}
        for expected_seq, row in enumerate(rows, start=1):
            seq, key, at, ms, inline, blob_ref, blob_bytes = row
            if type(seq) is not int or seq != expected_seq:
                raise _journal_error("workflow journal sequence is not contiguous")
            if type(key) is not str or not key:
                raise _journal_error("workflow journal key must be a non-empty string")
            if key in records:
                raise _journal_error(f"duplicate workflow journal key: {key}")
            if type(at) is not str or not at:
                raise _journal_error("workflow journal at must be a timestamp")
            if type(ms) is not int or ms < 0:
                raise _journal_error("workflow journal ms must be a whole number")
            timings[key] = {"at": at, "ms": ms}
            if inline is not None:
                value = _parse_json_text(inline, key)
                try:
                    dumps(value)
                except WorkflowError as error:
                    raise _journal_error(
                        "workflow journal contains an invalid value"
                    ) from error
                records[key] = value
                continue
            if type(blob_ref) is not str or _BLOB_REF.fullmatch(blob_ref) is None:
                raise _journal_error("workflow journal blob ref is invalid")
            if type(blob_bytes) is not int or blob_bytes <= _INLINE_VALUE_MAX_BYTES:
                raise _journal_error("workflow journal blob byte count is invalid")
            blob_rows = self._query(self.dialect.select_blob(), (blob_ref,))
            if not blob_rows:
                raise _journal_error(f"cannot read workflow blob {blob_ref}")
            encoded = blob_rows[0][0]
            if type(encoded) is not bytes or len(encoded) != blob_bytes:
                raise _journal_error(
                    f"workflow blob byte count does not match: {blob_ref}"
                )
            if hashlib.sha256(encoded).hexdigest() != blob_ref:
                raise _journal_error(f"workflow blob digest does not match: {blob_ref}")
            try:
                text = encoded.decode("utf-8")
            except UnicodeError as error:
                raise _journal_error(
                    f"workflow blob is not UTF-8: {blob_ref}"
                ) from error
            value = _parse_json_text(text, blob_ref)
            if dumps(value).encode("utf-8") != encoded:
                raise _journal_error(
                    f"workflow blob is not canonical JSON: {blob_ref}"
                )
            records[key] = value
        return records, timings, len(rows) + 1


class SqliteJournalStore(SqlJournalStore):
    def __init__(self, path: Path | str) -> None:
        locator = Path(path).expanduser()
        if not locator.parent.is_dir():
            raise _journal_error(
                f"journal directory does not exist: {locator.parent}"
            )
        locator = locator.resolve()
        connection = sqlite3.connect(str(locator))
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA busy_timeout = 5000")
        super().__init__(locator, SqliteDialect(), connection)


def _active_text(active: object) -> str | None:
    return dumps(active) if type(active) is dict else None


def _attempts_text(attempts: object) -> str | None:
    return dumps(attempts) if type(attempts) is list else None


def _header_from_row(row: tuple[object, ...]) -> dict[str, object]:
    (
        run_id,
        workflow,
        status,
        started_at,
        finished_at,
        inbox,
        doc,
        args,
        kwargs,
        error,
        reason,
        active,
        attempts,
        entry_file,
        entry_workflow,
        entry_cwd,
    ) = row
    header: dict[str, object] = {
        "run_id": run_id,
        "workflow": workflow,
        "status": status,
        "started_at": started_at,
        "inbox": _parse_json_text(inbox, "inbox") if type(inbox) is str else {},
        "doc": doc,
        "args": _parse_json_text(args, "args") if type(args) is str else [],
        "kwargs": _parse_json_text(kwargs, "kwargs") if type(kwargs) is str else {},
    }
    if type(finished_at) is str:
        header["finished_at"] = finished_at
    if type(error) is str:
        header["error"] = _parse_json_text(error, "error")
    if type(reason) is str:
        header["reason"] = reason
    if type(active) is str:
        header["active"] = _parse_json_text(active, "active")
    if type(attempts) is str:
        header["attempts"] = _parse_json_text(attempts, "attempts")
    if (
        type(entry_file) is str
        and type(entry_workflow) is str
        and type(entry_cwd) is str
    ):
        header["entry"] = {
            "file": entry_file,
            "workflow": entry_workflow,
            "cwd": entry_cwd,
        }
    return header
