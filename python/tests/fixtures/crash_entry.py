from __future__ import annotations

import os
from pathlib import Path
import sys

from vera.workflow.api import current, step, workflow


@step
def first() -> int:
    return 1


@step
def second() -> int:
    if os.environ.get("VERA_WF_CRASH") == "1":
        os._exit(9)
    Path(current.run.journal_dir, "second.txt").write_text("second")
    return 2


@workflow
def crashy() -> int:
    return first() + second()


if __name__ == "__main__":
    crashy.run(journal_dir=Path(sys.argv[1]))
