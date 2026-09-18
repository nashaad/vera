from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import inspect
import json
from pathlib import Path
from typing import Protocol, runtime_checkable

from .._home import workflows_directory
from ._errors import WorkflowError
from ._journal import Journal, _journal_error


@runtime_checkable
class RunJournal(Protocol):
    header: dict[str, object]
    records: dict[str, object]
    timings: dict[str, dict[str, object]]
    journal_dir: Path

    @property
    def run_id(self) -> str: ...

    @property
    def inbox(self) -> dict[str, object]: ...

    def inputs(self) -> tuple[tuple[object, ...], dict[str, object]]: ...

    def append(self, key: str, value: object, ms: int = 0) -> None: ...

    def mark_step_started(self, key: str, step_name: str) -> None: ...

    def start_attempt(self) -> None: ...

    def mark_running(self) -> None: ...

    def mark_ok(self) -> None: ...

    def mark_failed(self, kind: str, message: str) -> None: ...

    def mark_suspended(self, reason: str) -> None: ...

    def mark_crashed(self, reason: str) -> None: ...

    def mark_cancelled(self, reason: str) -> None: ...

    def write_header(self) -> None: ...

    def reload_inbox(self) -> None: ...

    def request_cancel(self, reason: str) -> None: ...

    def cancel_requested(self) -> str | None: ...


@dataclass(frozen=True)
class RunSummary:
    run_id: str
    workflow: str
    status: str
    started_at: str
    finished_at: str | None


@runtime_checkable
class JournalStore(Protocol):
    def create(
        self,
        workflow_name: str,
        doc: str,
        args: tuple[object, ...],
        kwargs: dict[str, object],
        entry: dict[str, str],
    ) -> RunJournal: ...

    def load(self, run_id: str, workflow_name: str | None) -> RunJournal: ...

    def runs(self) -> list[RunSummary]: ...


class FileJournalStore:
    def __init__(self, journal_dir: Path | str) -> None:
        self.journal_dir = Path(journal_dir).expanduser().resolve()

    def create(
        self,
        workflow_name: str,
        doc: str,
        args: tuple[object, ...],
        kwargs: dict[str, object],
        entry: dict[str, str],
    ) -> Journal:
        return Journal.create(
            self.journal_dir,
            workflow_name,
            doc,
            args,
            kwargs,
            entry,
        )

    def load(self, run_id: str, workflow_name: str | None) -> Journal:
        return Journal.load(self.journal_dir, run_id, workflow_name)

    def runs(self) -> list[RunSummary]:
        """Newest first. A run whose header cannot be read is left out."""
        summaries: list[RunSummary] = []
        try:
            entries = sorted(self.journal_dir.iterdir())
        except OSError:
            return summaries
        for entry in entries:
            header = _read_header(entry / "header.json")
            if header is not None:
                summaries.append(header)
        summaries.sort(key=lambda summary: summary.started_at, reverse=True)
        return summaries


def _read_header(path: Path) -> RunSummary | None:
    try:
        header = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    if type(header) is not dict:
        return None
    fields = [header.get(name) for name in ("run_id", "workflow", "status", "started_at")]
    if any(type(field) is not str for field in fields):
        return None
    finished = header.get("finished_at")
    return RunSummary(
        run_id=str(fields[0]),
        workflow=str(fields[1]),
        status=str(fields[2]),
        started_at=str(fields[3]),
        finished_at=finished if type(finished) is str else None,
    )


def capture_entry(
    workflow_name: str,
    function: Callable[..., object],
) -> dict[str, str]:
    try:
        located = inspect.getfile(function)
    except TypeError as error:
        raise _journal_error("cannot locate workflow entry file") from error
    source = Path(located)
    return {
        "file": str(source.resolve()) if source.is_file() else located,
        "workflow": workflow_name,
        "cwd": str(Path.cwd()),
    }


def resolve_store(
    *,
    journal_dir: Path | str | None,
    journal: JournalStore | None,
) -> JournalStore:
    if journal is not None and journal_dir is not None:
        raise WorkflowError("journal", "pass journal_dir or journal, not both")
    if journal is not None:
        return journal
    if journal_dir is None:
        return FileJournalStore(default_journal_dir())
    return FileJournalStore(journal_dir)


def default_journal_dir() -> Path:
    """Journals land in the Vera home unless a run names its own directory."""
    directory = workflows_directory()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    return directory


def store_from_path(path: Path) -> JournalStore:
    from ._sql import SqliteJournalStore

    locator = Path(path).expanduser()
    if locator.is_file() or locator.suffix in {".sqlite", ".db", ".sqlite3"}:
        return SqliteJournalStore(locator)
    if not locator.is_dir():
        raise _journal_error(f"journal directory does not exist: {locator}")
    return FileJournalStore(locator)
