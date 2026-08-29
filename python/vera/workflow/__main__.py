from __future__ import annotations

from pathlib import Path
import importlib.util
import os
import sys

from ._errors import WorkflowError
from ._store import store_from_path
from .api import _Workflow


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
    name = f"vera_workflow_entry_{run_id}"
    spec = importlib.util.spec_from_file_location(name, source)
    if spec is None or spec.loader is None:
        raise WorkflowError("journal", f"cannot load workflow entry file: {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 3 or arguments[0] not in {"show", "resume"}:
        print(
            "usage: python -m vera.workflow show|resume <journal_dir> <run_id>",
            file=sys.stderr,
        )
        return 2
    command, raw_dir, run_id = arguments
    path = Path(raw_dir)
    try:
        if command == "show":
            _show(path, run_id)
            return 0
        return _resume(path, run_id)
    except WorkflowError as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(_main())
