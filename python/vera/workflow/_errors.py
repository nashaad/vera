from dataclasses import dataclass


@dataclass(frozen=True)
class RunError:
    kind: str
    message: str


@dataclass(frozen=True)
class Run:
    id: str
    status: str
    result: object | None
    error: RunError | None


class WorkflowError(Exception):
    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


class StepTimeout(Exception):
    """Raised in the workflow when a step exceeds its deadline."""

    def __init__(self, step_name: str, timeout: float) -> None:
        super().__init__(f"{step_name} exceeded {timeout}s")
        self.step_name = step_name
        self.timeout = timeout


class Cancelled(BaseException):
    """Ends a run between steps once its cancel token is set."""

    reason: str

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Suspend(BaseException):
    reason: str

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason
