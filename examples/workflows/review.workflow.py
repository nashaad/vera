"""One agent per file in a directory, merged into a report.

Run it:      python examples/workflows/review.workflow.py <directory>
Then:        python -m vera.workflow list
             python -m vera.workflow resume <run_id>

A resume replays the files already summarised out of the journal and only
calls an agent for the ones that are left.
"""

from __future__ import annotations

import atexit
from pathlib import Path
import sys

from vera import Agent, Vera, step, workflow


reviewer = Agent(
    name="file-summary",
    instructions=(
        "You summarise one file. Read the file you are given and answer with a "
        "single sentence saying what it is for."
    ),
    tools=["read"],
)

_instances: dict[Path, Vera] = {}


def instance(workspace: Path) -> Vera:
    """One agent process per workspace, reused by every step that needs it."""
    existing = _instances.get(workspace)
    if existing is not None:
        return existing
    created = Vera.create(workspace=str(workspace))
    _instances[workspace] = created
    return created


@atexit.register
def _close_instances() -> None:
    for created in _instances.values():
        created.close()
    _instances.clear()


@step
def files(directory: str) -> list[str]:
    return sorted(
        str(path) for path in Path(directory).iterdir()
        if path.is_file() and not path.name.startswith(".")
    )


@step
def summarize(path: str) -> str:
    file = Path(path)
    return instance(file.parent).run(reviewer, f"Read {file.name} and summarise it.")


@step
def report(paths: list[str], summaries: list[str]) -> str:
    lines = [f"# {Path(paths[0]).parent}", ""] if paths else ["# empty directory"]
    for path, summary in zip(paths, summaries):
        lines.append(f"- **{Path(path).name}**: {summary.strip()}")
    return "\n".join(lines)


@workflow
def review(directory: str) -> str:
    paths = files(directory)
    return report(paths, list(summarize.map(paths)))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} <directory>", file=sys.stderr)
        raise SystemExit(2)
    run = review.run(str(Path(sys.argv[1]).expanduser().resolve()))
    print(run.id, run.status)
    print(run.result)
