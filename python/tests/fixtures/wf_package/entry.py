from __future__ import annotations

from vera.workflow.api import workflow

from .work import once


@workflow
def packaged(marker: str) -> str:
    return once(marker)
