"""Durable at-least-once workflow API.

If the process dies after the side effect and before the journal line is on
disk, resume runs the step again. Users own idempotency, or they split work
into smaller steps.
"""

from __future__ import annotations

from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from functools import update_wrapper
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Generic, ParamSpec, TypeVar, TypeVarTuple, Unpack, cast

from ._canonical import digest, dumps
from ._errors import Run, RunError, Suspend, WorkflowError
from ._journal import Journal


P = ParamSpec("P")
R = TypeVar("R")
WorkflowArgs = TypeVarTuple("WorkflowArgs")

__all__ = [
    "workflow",
    "step",
    "Suspend",
    "WorkflowError",
    "Run",
    "RunError",
    "current",
]


@dataclass(frozen=True)
class _CurrentRun:
    id: str
    journal_dir: Path
    inbox: Mapping[str, object]


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


class _UserFailure(BaseException):
    def __init__(self, error: Exception) -> None:
        super().__init__(str(error))
        self.error = error


class _RuntimeFault(BaseException):
    def __init__(self, error: WorkflowError) -> None:
        super().__init__(str(error))
        self.error = error


def _call_user_code(function: Callable[[], R]) -> R:
    try:
        return function()
    except Exception as error:
        raise _UserFailure(error) from None


class _Runtime:
    def __init__(self, journal: Journal, workflow_name: str) -> None:
        self.journal = journal
        self.workflow_name = workflow_name
        self.current_run = _CurrentRun(
            id=journal.run_id,
            journal_dir=journal.journal_dir,
            inbox=MappingProxyType(journal.inbox),
        )
        self._ordinals: dict[str, int] = {}

    def call_step(
        self,
        step_name: str,
        function: Callable[P, R],
        args: P.args,
        kwargs: P.kwargs,
    ) -> R:
        ordinal = self._ordinals.get(step_name, 0)
        self._ordinals[step_name] = ordinal + 1
        positional_args = tuple(args)
        keyword_args = dict(kwargs)
        try:
            key = (
                f"{self.workflow_name}/{step_name}#{ordinal}:"
                f"{digest(positional_args, keyword_args)}"
            )
        except WorkflowError as error:
            raise _RuntimeFault(error) from error
        if key in self.journal.records:
            return cast(R, self.journal.records[key])
        value = _call_user_code(lambda: function(*args, **kwargs))
        try:
            dumps(value)
            self.journal.append(key, value)
        except WorkflowError as error:
            raise _RuntimeFault(error) from error
        return value


_runtime: ContextVar[_Runtime | None] = ContextVar("vera_workflow_runtime", default=None)
current = _Current()


def _error_message(error: Exception) -> str:
    return str(error) or error.__class__.__name__


class _Step(Generic[P, R]):
    def __init__(self, function: Callable[P, R]) -> None:
        self._function = function
        self.name = function.__name__
        update_wrapper(self, function, updated=())

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> R:
        runtime = _runtime.get()
        if runtime is None:
            return self._function(*args, **kwargs)
        value = runtime.call_step(
            self.name,
            self._function,
            args,
            kwargs,
        )
        return value


class _Workflow(Generic[Unpack[WorkflowArgs], R]):
    def __init__(self, function: Callable[[Unpack[WorkflowArgs]], R]) -> None:
        self._function = function
        self.name = function.__name__
        self._doc = " ".join((function.__doc__ or "").split())
        update_wrapper(self, function, updated=())

    def run(
        self,
        *args: Unpack[WorkflowArgs],
        journal_dir: Path | str,
    ) -> Run:
        path = Path(journal_dir)
        positional_args = tuple(args)
        dumps({"args": list(positional_args), "kwargs": {}})
        journal = Journal.create(path, self.name, self._doc, positional_args, {})
        return self._execute(journal, positional_args, mark_running=False)

    def resume(self, run_id: str, *, journal_dir: Path | str) -> Run:
        journal = Journal.load(Path(journal_dir), run_id, self.name)
        args, kwargs = journal.inputs()
        if kwargs:
            raise WorkflowError(
                "journal",
                "workflow run contains unsupported keyword inputs",
            )
        return self._execute(journal, args, mark_running=True)

    def _execute(
        self,
        journal: Journal,
        args: tuple[object, ...],
        *,
        mark_running: bool,
    ) -> Run:
        if mark_running:
            journal.mark_running()
        runtime = _Runtime(journal, self.name)
        token = _runtime.set(runtime)
        typed_args = cast(tuple[Unpack[WorkflowArgs]], args)
        try:
            result = _call_user_code(lambda: self._function(*typed_args))
        except Suspend as suspended:
            journal.mark_suspended(suspended.reason)
            return Run(
                journal.run_id,
                "suspended",
                None,
                RunError("suspended", suspended.reason),
            )
        except _UserFailure as failure:
            message = _error_message(failure.error)
            journal.mark_failed("step", message)
            return Run(
                journal.run_id,
                "failed",
                None,
                RunError("step", message),
            )
        except _RuntimeFault as fault:
            error = fault.error
            if error.kind != "serialize":
                raise error from fault
            message = _error_message(error)
            journal.mark_failed("serialize", message)
            return Run(
                journal.run_id,
                "failed",
                None,
                RunError("serialize", message),
            )
        finally:
            _runtime.reset(token)
        journal.mark_ok()
        return Run(journal.run_id, "ok", result, None)


def step(function: Callable[P, R]) -> _Step[P, R]:
    return _Step(function)


def workflow(
    function: Callable[[Unpack[WorkflowArgs]], R],
) -> _Workflow[Unpack[WorkflowArgs], R]:
    return _Workflow(function)
