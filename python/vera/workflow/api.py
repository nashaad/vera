"""Durable at-least-once workflow API.

If the process dies after the side effect and before the journal line is on
disk, resume runs the step again. Users own idempotency, or they split work
into smaller steps.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Generic, ParamSpec, TypeVar, cast

from ._canonical import digest, dumps
from ._errors import Run, Suspend, WorkflowError
from ._journal import Journal


P = ParamSpec("P")
R = TypeVar("R")

__all__ = ["workflow", "step", "Suspend", "WorkflowError", "Run", "current"]


@dataclass(frozen=True)
class _CurrentRun:
    id: str
    journal_dir: Path


class _Current:
    @property
    def run(self) -> _CurrentRun:
        runtime = _runtime.get()
        if runtime is None:
            raise RuntimeError("no workflow is running")
        return runtime.current_run

    @property
    def cancelled(self) -> bool:
        return False


class _StepFailure(Exception):
    def __init__(self, error: Exception) -> None:
        super().__init__(str(error))
        self.error = error


class _Runtime:
    def __init__(self, journal: Journal, workflow_name: str) -> None:
        self.journal = journal
        self.workflow_name = workflow_name
        self.current_run = _CurrentRun(
            id=journal.run_id,
            journal_dir=journal.journal_dir,
        )
        self._ordinals: dict[str, int] = {}

    def call_step(
        self,
        step_name: str,
        function: Callable[..., object],
        args: tuple[object, ...],
        kwargs: dict[str, object],
    ) -> object:
        ordinal = self._ordinals.get(step_name, 0)
        self._ordinals[step_name] = ordinal + 1
        key = (
            f"{self.workflow_name}/{step_name}#{ordinal}:"
            f"{digest(args, kwargs)}"
        )
        if key in self.journal.records:
            return self.journal.records[key]
        try:
            value = function(*args, **kwargs)
        except (WorkflowError, _StepFailure):
            raise
        except Exception as error:
            raise _StepFailure(error) from None
        dumps(value)
        self.journal.append(key, value)
        return value


_runtime: ContextVar[_Runtime | None] = ContextVar("vera_workflow_runtime", default=None)
current = _Current()


def _error_message(error: Exception) -> str:
    return str(error) or error.__class__.__name__


class _Step(Generic[P, R]):
    def __init__(self, function: Callable[P, R]) -> None:
        self._function = function
        self.name = function.__name__

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> R:
        runtime = _runtime.get()
        if runtime is None:
            return self._function(*args, **kwargs)
        value = runtime.call_step(
            self.name,
            self._function,
            tuple(args),
            dict(kwargs),
        )
        return cast(R, value)


class _Workflow:
    def __init__(self, function: Callable[..., object]) -> None:
        self._function = function
        self.name = function.__name__
        self._doc = " ".join((function.__doc__ or "").split())

    def run(
        self,
        *args: object,
        journal_dir: Path | str,
        **kwargs: object,
    ) -> Run:
        path = Path(journal_dir)
        dumps({"args": list(args), "kwargs": kwargs})
        journal = Journal.create(path, self.name, self._doc, args, kwargs)
        return self._execute(journal, args, kwargs, mark_running=False)

    def resume(self, run_id: str, *, journal_dir: Path | str) -> Run:
        journal = Journal.load(Path(journal_dir), run_id, self.name)
        args, kwargs = journal.inputs()
        return self._execute(journal, args, kwargs, mark_running=True)

    def _execute(
        self,
        journal: Journal,
        args: tuple[object, ...],
        kwargs: dict[str, object],
        *,
        mark_running: bool,
    ) -> Run:
        if mark_running:
            journal.mark_running()
        runtime = _Runtime(journal, self.name)
        token = _runtime.set(runtime)
        try:
            result = self._function(*args, **kwargs)
        except Suspend as suspended:
            journal.mark_suspended(suspended.reason)
            return Run(
                journal.run_id,
                "suspended",
                None,
                {"kind": "suspended", "message": suspended.reason},
            )
        except _StepFailure as failure:
            message = _error_message(failure.error)
            journal.mark_failed("step", message)
            return Run(
                journal.run_id,
                "failed",
                None,
                {"kind": "step", "message": message},
            )
        except WorkflowError as error:
            if error.kind != "serialize":
                raise
            message = _error_message(error)
            journal.mark_failed("serialize", message)
            return Run(
                journal.run_id,
                "failed",
                None,
                {"kind": "serialize", "message": message},
            )
        except Exception as error:
            message = _error_message(error)
            journal.mark_failed("step", message)
            return Run(
                journal.run_id,
                "failed",
                None,
                {"kind": "step", "message": message},
            )
        finally:
            _runtime.reset(token)
        journal.mark_ok()
        return Run(journal.run_id, "ok", result, None)


def step(function: Callable[P, R]) -> _Step[P, R]:
    return _Step(function)


def workflow(function: Callable[..., object]) -> _Workflow:
    return _Workflow(function)
