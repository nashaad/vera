"""Durable at-least-once workflow API.

If the process dies after the side effect and before the journal line is on
disk, resume runs the step again. Users own idempotency, or they split work
into smaller steps.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from functools import update_wrapper
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Generic, ParamSpec, TypeVar, TypeVarTuple, Unpack, cast

from ._canonical import digest, dumps
from ._errors import Run, RunError, Suspend, WorkflowError
from ._hooks import (
    CommandHook,
    PrepareStepHook,
    clone_json,
    normalize_prepare_step,
    run_pre_step_chain,
)
from ._sql import SqliteJournalStore
from ._store import (
    FileJournalStore,
    JournalStore,
    RunJournal,
    capture_entry,
    resolve_store,
)
from ._ticket import Ticket


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
    "Ticket",
    "CommandHook",
    "FileJournalStore",
    "SqliteJournalStore",
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
    def __init__(
        self,
        journal: RunJournal,
        workflow_name: str,
        prepare_step: list[PrepareStepHook],
        inbox: dict[str, object],
    ) -> None:
        self.journal = journal
        self.workflow_name = workflow_name
        self._prepare_step = prepare_step
        self._inbox = inbox
        self.current_run = _CurrentRun(
            id=journal.run_id,
            journal_dir=journal.journal_dir,
            inbox=MappingProxyType(inbox),
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
        call_args: tuple[object, ...] = positional_args
        call_kwargs: dict[str, object] = keyword_args
        if self._prepare_step:
            payload = {
                "type": "pre_step",
                "run_id": self.current_run.id,
                "workflow": self.workflow_name,
                "step": step_name,
                "key": key,
                "args": clone_json(list(positional_args)),
                "kwargs": clone_json(keyword_args),
                "journal_dir": str(self.current_run.journal_dir),
                "inbox": clone_json(self._inbox),
            }
            if type(payload["args"]) is not list or type(payload["kwargs"]) is not dict:
                raise _RuntimeFault(
                    WorkflowError("hook", "pre_step args and kwargs must stay JSON")
                )
            try:
                chain = run_pre_step_chain(self._prepare_step, payload)
            except WorkflowError as error:
                raise _RuntimeFault(_hook_fault(error)) from error
            except Exception as error:
                raise _RuntimeFault(
                    WorkflowError("hook", _error_message(error))
                ) from error
            if chain.replaced:
                try:
                    dumps(chain.replacement)
                    self.journal.append(key, chain.replacement)
                except WorkflowError as error:
                    raise _RuntimeFault(error) from error
                return cast(R, chain.replacement)
            if chain.mutated:
                call_args = chain.args
                call_kwargs = chain.kwargs
        typed_args = cast("P.args", call_args)
        typed_kwargs = cast("P.kwargs", call_kwargs)
        value = _call_user_code(lambda: function(*typed_args, **typed_kwargs))
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

    def submit(self, *args: P.args, **kwargs: P.kwargs) -> Ticket[R]:
        return Ticket(self(*args, **kwargs))

    def map(self, items: Iterable[object]) -> tuple[R, ...]:
        one_argument_call = cast(Callable[[object], R], self)
        return tuple(one_argument_call(item) for item in items)


class _Workflow(Generic[Unpack[WorkflowArgs], R]):
    def __init__(self, function: Callable[[Unpack[WorkflowArgs]], R]) -> None:
        self._function = function
        self.name = function.__name__
        self._doc = " ".join((function.__doc__ or "").split())
        update_wrapper(self, function, updated=())

    def run(
        self,
        *args: Unpack[WorkflowArgs],
        journal_dir: Path | str | None = None,
        journal: JournalStore | None = None,
        prepare_step: PrepareStepHook | Sequence[PrepareStepHook] | None = None,
    ) -> Run:
        store = resolve_store(journal_dir=journal_dir, journal=journal)
        positional_args = tuple(args)
        dumps({"args": list(positional_args), "kwargs": {}})
        handle = store.create(
            self.name,
            self._doc,
            positional_args,
            {},
            capture_entry(self.name, self._function),
        )
        return self._execute(
            handle,
            positional_args,
            normalize_prepare_step(prepare_step),
            mark_running=False,
        )

    def resume(
        self,
        run_id: str,
        *,
        journal_dir: Path | str | None = None,
        journal: JournalStore | None = None,
        prepare_step: PrepareStepHook | Sequence[PrepareStepHook] | None = None,
    ) -> Run:
        store = resolve_store(journal_dir=journal_dir, journal=journal)
        handle = store.load(run_id, self.name)
        args, kwargs = handle.inputs()
        if kwargs:
            raise WorkflowError(
                "journal",
                "workflow run contains unsupported keyword inputs",
            )
        return self._execute(
            handle,
            args,
            normalize_prepare_step(prepare_step),
            mark_running=True,
        )

    def _execute(
        self,
        journal: RunJournal,
        args: tuple[object, ...],
        prepare_step: list[PrepareStepHook],
        *,
        mark_running: bool,
    ) -> Run:
        if mark_running:
            journal.mark_running()
        inbox = clone_json(journal.inbox)
        if type(inbox) is not dict:
            raise WorkflowError("journal", "header field inbox must be an object")
        runtime = _Runtime(journal, self.name, prepare_step, inbox)
        token = _runtime.set(runtime)
        typed_args = cast(tuple[Unpack[WorkflowArgs]], args)
        try:
            result = _call_user_code(lambda: self._function(*typed_args))
        except Suspend as suspended:
            journal.reload_inbox()
            journal.mark_suspended(suspended.reason)
            return Run(
                journal.run_id,
                "suspended",
                None,
                RunError("suspended", suspended.reason),
            )
        except _UserFailure as failure:
            message = _error_message(failure.error)
            journal.reload_inbox()
            journal.mark_failed("step", message)
            return Run(
                journal.run_id,
                "failed",
                None,
                RunError("step", message),
            )
        except _RuntimeFault as fault:
            error = fault.error
            if error.kind not in ("serialize", "hook"):
                raise error from fault
            message = _error_message(error)
            journal.reload_inbox()
            journal.mark_failed(error.kind, message)
            return Run(
                journal.run_id,
                "failed",
                None,
                RunError(error.kind, message),
            )
        finally:
            _runtime.reset(token)
        journal.reload_inbox()
        journal.mark_ok()
        return Run(journal.run_id, "ok", result, None)


def step(function: Callable[P, R]) -> _Step[P, R]:
    return _Step(function)


def workflow(
    function: Callable[[Unpack[WorkflowArgs]], R],
) -> _Workflow[Unpack[WorkflowArgs], R]:
    return _Workflow(function)


def _hook_fault(error: WorkflowError) -> WorkflowError:
    if error.kind in ("serialize", "hook"):
        return error
    return WorkflowError("hook", _error_message(error))
