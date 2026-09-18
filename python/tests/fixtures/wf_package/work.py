from __future__ import annotations

from pathlib import Path

from vera.workflow.api import step


@step
def once(marker: str) -> str:
    path = Path(marker)
    if not path.exists():
        path.write_text("tried")
        raise RuntimeError("first attempt")
    return "second attempt"
