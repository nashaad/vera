from __future__ import annotations

from pathlib import Path
import importlib.util
import os
import sys

from ._errors import WorkflowError
from ._store import default_journal_dir, store_from_path
from .api import _Workflow


USAGE = (
    "usage: python -m vera.workflow list [--journal-dir DIR]\n"
    "       python -m vera.workflow show <run_id> [--journal-dir DIR]\n"
    "       python -m vera.workflow resume <run_id> [--journal-dir DIR]\n"
    "       python -m vera.workflow cancel <run_id> [--journal-dir DIR]"
)

CANCEL_REASON = "cancelled from the command line"


def _list(journal_dir: Path) -> None:
    summaries = store_from_path(journal_dir).runs()
    if not summaries:
        print(f"no workflow runs in {journal_dir}")
        return
    width = max(len(summary.workflow) for summary in summaries)
    for summary in summaries:
        print(
            f"{summary.run_id}  {summary.status:<9}  "
            f"{summary.workflow:<{width}}  {summary.started_at}"
        )


def _show(journal_dir: Path, run_id: str) -> None:
    store = store_from_path(journal_dir)
    journal = store.load(run_id, None)
    print(f"run    {journal.run_id}")
    print(f"name   {journal.header['workflow']}")
    print(f"status {journal.header['status']}")
    doc = journal.header["doc"]
    if doc:
        print(f"doc    {doc}")
    print("steps")
    for key in journal.records:
        print(f"  {key}")


def _cancel(journal_dir: Path, run_id: str) -> int:
    journal = store_from_path(journal_dir).load(run_id, None)
    status = journal.header["status"]
    if status == "running":
        journal.request_cancel(CANCEL_REASON)
        print(f"{run_id} cancel requested; it stops before its next step")
        return 0
    if status == "suspended":
        journal.mark_cancelled(CANCEL_REASON)
        print(f"{run_id} cancelled")
        return 0
    print(f"{run_id} is already {status}", file=sys.stderr)
    return 2


def _resume(journal_dir: Path, run_id: str) -> int:
    store = store_from_path(journal_dir)
    journal = store.load(run_id, None)
    entry = journal.header.get("entry")
    if type(entry) is not dict:
        raise WorkflowError(
            "journal",
            "workflow header has no entry; call .resume in the original process",
        )
    file = entry.get("file")
    workflow_name = entry.get("workflow")
    cwd = entry.get("cwd")
    if type(file) is not str or type(workflow_name) is not str or type(cwd) is not str:
        raise WorkflowError("journal", "workflow header entry is incomplete")
    source = Path(file)
    if not source.is_file():
        raise WorkflowError("journal", f"workflow entry file does not exist: {source}")
    module = _load_entry_module(source, run_id)
    found = None
    for value in vars(module).values():
        if isinstance(value, _Workflow) and value.name == workflow_name:
            found = value
            break
    if found is None:
        raise WorkflowError(
            "journal",
            f"workflow {workflow_name!r} not found in {source}",
        )
    previous = Path.cwd()
    try:
        os.chdir(cwd)
    except OSError as error:
        raise WorkflowError(
            "journal",
            f"workflow entry cwd does not exist: {cwd}",
        ) from error
    try:
        run = found.resume(run_id, journal=store)
    finally:
        os.chdir(previous)
    if run.status == "ok":
        print(run.id, run.status, run.result)
        return 0
    print(run.id, run.status, run.error, file=sys.stderr)
    return 1


def _load_entry_module(source: Path, run_id: str) -> object:
    package = _package_entry(source)
    if package is not None:
        root, dotted = package
        sys.path.insert(0, str(root))
        try:
            return importlib.import_module(dotted)
        except ImportError as error:
            raise WorkflowError(
                "journal",
                f"cannot import workflow entry module {dotted}: {error}",
            ) from error

    name = f"vera_workflow_entry_{run_id}"
    spec = importlib.util.spec_from_file_location(name, source)
    if spec is None or spec.loader is None:
        raise WorkflowError("journal", f"cannot load workflow entry file: {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _package_entry(source: Path) -> tuple[Path, str] | None:
    """Where an entry file sits in a package, and what to import it as.

    A module loaded from a path cannot run its own relative imports, so a
    workflow defined inside a package is imported by dotted name instead.
    """
    parts = [source.stem]
    directory = source.parent
    while (directory / "__init__.py").is_file():
        parts.append(directory.name)
        directory = directory.parent
    if len(parts) == 1:
        return None
    return directory, ".".join(reversed(parts))


def _parse(arguments: list[str]) -> tuple[str, str, Path] | None:
    if not arguments or arguments[0] not in {"list", "show", "resume", "cancel"}:
        return None
    command = arguments[0]
    rest = arguments[1:]
    directory: Path | None = None
    if len(rest) >= 2 and rest[-2] == "--journal-dir":
        directory = Path(rest[-1])
        rest = rest[:-2]
    wanted = 0 if command == "list" else 1
    if len(rest) != wanted:
        return None
    run_id = rest[0] if wanted else ""
    return command, run_id, directory if directory is not None else default_journal_dir()


def _main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    parsed = _parse(arguments)
    if parsed is None:
        print(USAGE, file=sys.stderr)
        return 2
    command, run_id, path = parsed
    try:
        if command == "list":
            _list(path)
            return 0
        if command == "show":
            _show(path, run_id)
            return 0
        if command == "cancel":
            return _cancel(path, run_id)
        return _resume(path, run_id)
    except WorkflowError as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(_main())
