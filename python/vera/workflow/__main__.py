from __future__ import annotations

from pathlib import Path
import sys

from ._errors import WorkflowError
from ._journal import Journal


def _show(journal_dir: Path, run_id: str) -> None:
    journal = Journal.load(journal_dir, run_id, None)
    journal_path = journal.run_dir / "journal.ndjson"
    if not journal_path.is_file():
        raise WorkflowError(
            "journal",
            f"workflow journal does not exist: {journal_path}",
        )
    header = journal.header
    print(f"run    {header['run_id']}")
    print(f"name   {header['workflow']}")
    print(f"status {header['status']}")
    doc = header["doc"]
    if doc:
        print(f"doc    {doc}")
    print("steps")
    for key in journal.records:
        print(f"  {key}")


def _main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 3 or arguments[0] != "show":
        print(
            "usage: python -m vera.workflow show <journal_dir> <run_id>",
            file=sys.stderr,
        )
        return 2
    try:
        _show(Path(arguments[1]), arguments[2])
    except WorkflowError as error:
        print(error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
