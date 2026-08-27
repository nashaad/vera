"""Public workflow result and error types."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Run:
    id: str
    status: str
    result: object | None
    error: dict[str, str] | None


class WorkflowError(Exception):
    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


class Suspend(BaseException):
    reason: str

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason
