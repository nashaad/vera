"""Halcyon, Vera's durable at-least-once workflow framework.

If the process dies after the side effect and before the journal line is on
disk, resume runs the step again. Users own idempotency, or they split work
into smaller steps.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from contextvars import ContextVar, copy_context
from dataclasses import dataclass
from functools import update_wrapper
from pathlib import Path
from threading import Thread
import time
from types import MappingProxyType
from typing import Callable, Generic, ParamSpec, TypeVar, TypeVarTuple, Unpack, cast

from ._canonical import digest, dumps
from ._errors import Run, RunError, StepTimeout, Suspend, WorkflowError
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
    "StepTimeout",
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

    @property
    def deadline(self) -> float | None:
        """Absolute `time.monotonic()` the running step must finish by.

        `None` when the step declared no timeout. A step that can outlast its
        deadline is responsible for its own interruption, because the runtime
        stops waiting but cannot stop the work.
        """
        return _deadline.get()

    def step(
        self,
        name: str,
        function: Callable[..., R],
        *args: object,
        key: str,
        timeout: float | None = None,
        **kwargs: object,
    ) -> R:
        """Call `function` as a step journaled under an explicit key.

        The escape hatch for callers whose steps are chosen at runtime rather
        than written out. The key replaces the positional ordinal, so inserting
        or removing calls elsewhere in the run does not invalidate this one.
        The caller owns key uniqueness: two calls sharing a key and arguments
        return the first recorded value and the second body never runs.
        """
        if isinstance(function, _Step):
            raise WorkflowError(
                "step",
                "current.step takes a plain function; a @step already has a key",
            )
        if not key:
            raise WorkflowError("step", "current.step requires a non-empty key")
        runtime = _runtime.get()
        if runtime is None:
            return function(*args, **kwargs)
        return runtime.call_step(name, function, args, kwargs, key=key, timeout=timeout)


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
        *,
        key: str | None = None,
        timeout: float | None = None,
    ) -> R:
        positional_args = tuple(args)
        keyword_args = dict(kwargs)
        if key is None:
            ordinal = self._ordinals.get(step_name, 0)
            self._ordinals[step_name] = ordinal + 1
            name = f"{step_name}#{ordinal}"
        else:
            name = key
        try:
            key = f"{self.workflow_name}/{name}:{digest(positional_args, keyword_args)}"
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
        value = _invoke(step_name, function, typed_args, typed_kwargs, timeout)
        try:
            dumps(value)
            self.journal.append(key, value)
        except WorkflowError as error:
            raise _RuntimeFault(error) from error
        return value


_runtime: ContextVar[_Runtime | None] = ContextVar("vera_workflow_runtime", default=None)
_deadline: ContextVar[float | None] = ContextVar("vera_step_deadline", default=None)
current = _Current()


def _error_message(error: Exception) -> str:
    return str(error) or error.__class__.__name__


def _invoke(
    step_name: str,
    function: Callable[..., R],
    args: tuple[object, ...],
    kwargs: dict[str, object],
    timeout: float | None,
) -> R:
    """Run a step body, under a deadline when it declared one.

    A Python thread cannot be killed. When the deadline passes the runtime
    stops waiting and raises, but the body keeps running until it returns. A
    body that can outlast its deadline reads `current.deadline` and interrupts
    itself, for instance by passing the remaining time to a subprocess.
    """
    if timeout is None:
        return _call_user_code(lambda: function(*args, **kwargs))
    token = _deadline.set(time.monotonic() + timeout)
    try:
        context = copy_context()
    finally:
        _deadline.reset(token)
    outcome: list[tuple[bool, object]] = []

    def body() -> None:
        try:
            outcome.append((True, function(*args, **kwargs)))
        except Exception as error:  # noqa: BLE001 - reported through _UserFailure
            outcome.append((False, error))

    worker = Thread(
        target=lambda: context.run(body),
        name=f"vera-step-{step_name}",
        daemon=True,
    )
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise _UserFailure(StepTimeout(step_name, timeout))
    succeeded, value = outcome[0]
    if succeeded:
        return cast(R, value)
    raise _UserFailure(cast(Exception, value))


class _Step(Generic[P, R]):
    def __init__(self, function: Callable[P, R], timeout: float | None = None) -> None:
        if timeout is not None and timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self._function = function
        self.name = function.__name__
        self.timeout = timeout
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
            timeout=self.timeout,
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
            kind = "timeout" if isinstance(failure.error, StepTimeout) else "step"
            message = _error_message(failure.error)
            journal.reload_inbox()
            journal.mark_failed(kind, message)
            return Run(
                journal.run_id,
                "failed",
                None,
                RunError(kind, message),
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


def step(
    function: Callable[P, R] | None = None,
    *,
    timeout: float | None = None,
) -> _Step[P, R] | Callable[[Callable[P, R]], _Step[P, R]]:
    """Mark a function as a journaled step, bare or with arguments.

    `@step` and `@step(timeout=30)` are both accepted. A timeout is a deadline
    on one call, not a retry budget: the runtime stops waiting and raises
    `StepTimeout`, which fails the run with kind `timeout` unless the caller
    handles it. Nothing is journaled, so a resumed run tries the step again.
    """
    if function is not None:
        return _Step(function, timeout)

    def decorate(inner: Callable[P, R]) -> _Step[P, R]:
        return _Step(inner, timeout)

    return decorate


def workflow(
    function: Callable[[Unpack[WorkflowArgs]], R],
) -> _Workflow[Unpack[WorkflowArgs], R]:
    return _Workflow(function)


def _hook_fault(error: WorkflowError) -> WorkflowError:
    if error.kind in ("serialize", "hook"):
        return error
    return WorkflowError("hook", _error_message(error))
