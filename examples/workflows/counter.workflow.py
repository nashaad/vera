"""An at-least-once counter; a crash before the journal append retries the whole step."""

from __future__ import annotations

from pathlib import Path
import sys

from vera.workflow.api import step, workflow


journal_dir: Path


@step
def bump() -> int:
    counter_path = journal_dir / "counter.txt"
    count = 1
    if counter_path.exists():
        count += len(counter_path.read_text(encoding="utf-8").splitlines())
    with counter_path.open("a", encoding="utf-8") as counter:
        counter.write(f"{count}\n")
    return count


@step
def double(n: int) -> int:
    return n * 2


@workflow
def main() -> int:
    return double(bump())


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} <journal_dir>", file=sys.stderr)
        raise SystemExit(2)
    journal_dir = Path(sys.argv[1])
    run = main.run(journal_dir=journal_dir)
    print(run.id, run.result)
