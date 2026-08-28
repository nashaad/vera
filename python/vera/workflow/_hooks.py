from __future__ import annotations

from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from contextvars import copy_context
from dataclasses import dataclass
import json
import os
import select
import subprocess
import time
from typing import TypeAlias

from ._canonical import dumps
from ._errors import WorkflowError


PRE_STEP_HOOK_TIMEOUT_MS = 60_000

_DEFAULT_COMMAND_TIMEOUT_MS = 1_000
_MAX_COMMAND_TIMEOUT_MS = 30_000
_MAX_ARG_COUNT = 16
_MAX_ARG_BYTES = 8 * 1024
_MAX_INPUT_BYTES = 256 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024

PrepareStepHook: TypeAlias = Callable[[dict[str, object]], object]


@dataclass(frozen=True)
class PreStepChainResult:
    args: tuple[object, ...]
    kwargs: dict[str, object]
    mutated: bool
    replaced: bool
    replacement: object = None


def clone_json(value: object) -> object:
    return json.loads(dumps(value))


def normalize_prepare_step(
    prepare_step: PrepareStepHook | Sequence[PrepareStepHook] | None,
) -> list[PrepareStepHook]:
    if prepare_step is None:
        return []
    if callable(prepare_step):
        return [prepare_step]
    hooks = list(prepare_step)
    if any(not callable(hook) for hook in hooks):
        raise TypeError("prepare_step must be a callable or a sequence of callables")
    return hooks


class CommandHook:
    def __init__(
        self,
        argv: Sequence[str],
        *,
        timeout_ms: int = _DEFAULT_COMMAND_TIMEOUT_MS,
    ) -> None:
        argv_list = list(argv)
        _validate_command_hook(argv_list, timeout_ms)
        self.argv = tuple(argv_list)
        self.timeout_ms = timeout_ms

    def __call__(self, payload: dict[str, object]) -> object:
        encoded = dumps(payload).encode("utf-8")
        if len(encoded) > _MAX_INPUT_BYTES:
            raise _hook_error("Command hook input exceeded its byte bound")
        try:
            stdout, returncode = _run_command(self.argv, encoded, self.timeout_ms)
        except OSError as error:
            raise _hook_error(str(error) or type(error).__name__) from error
        if returncode != 0:
            raise _hook_error(f"Command hook exited with status {returncode}")
        try:
            text = stdout.decode("utf-8").strip()
        except UnicodeError as error:
            raise _hook_error("Command hook returned invalid JSON") from error
        if text == "":
            raise _hook_error("Command hook returned invalid JSON")
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise _hook_error("Command hook returned invalid JSON") from error


def run_pre_step_chain(
    hooks: Sequence[PrepareStepHook],
    payload: dict[str, object],
) -> PreStepChainResult:
    mutated = False
    deadline = time.monotonic() + PRE_STEP_HOOK_TIMEOUT_MS / 1000
    for hook in hooks:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _hook_error(
                f"pre_step hooks timed out after {PRE_STEP_HOOK_TIMEOUT_MS}ms"
            )
        clone = clone_json(payload)
        if type(clone) is not dict:
            raise _hook_error("pre_step payload must be a JSON object")
        raw = _call_hook(hook, clone, remaining)
        power, detail = _read_power(raw)
        if power == "observe":
            continue
        if power == "mutate":
            mutated = True
            _apply_mutate(payload, detail)
            continue
        if power == "block":
            raise _hook_error(detail)
        args, kwargs = _payload_call_args(payload)
        return PreStepChainResult(args, kwargs, mutated, True, detail)
    args, kwargs = _payload_call_args(payload)
    return PreStepChainResult(args, kwargs, mutated, False)


def _run_command(
    argv: tuple[str, ...],
    encoded: bytes,
    timeout_ms: int,
) -> tuple[bytes, int]:
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        shell=False,
    )
    stdin = process.stdin
    stdout = process.stdout
    if stdin is None or stdout is None:
        process.kill()
        process.wait()
        raise _hook_error("Command hook pipes were not created")
    deadline = time.monotonic() + timeout_ms / 1000
    chunks: list[bytes] = []
    total = 0
    stdin_offset = 0
    stdin_closed = False
    stdout_eof = False
    os.set_blocking(stdin.fileno(), False)
    os.set_blocking(stdout.fileno(), False)
    try:
        while not stdout_eof:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                process.wait()
                raise _hook_error(f"Command hook timed out after {timeout_ms}ms")
            wait_read = [stdout]
            wait_write = [] if stdin_closed else [stdin]
            readable, writable, _errored = select.select(
                wait_read,
                wait_write,
                [],
                remaining,
            )
            if stdin in writable and not stdin_closed:
                try:
                    written = os.write(stdin.fileno(), encoded[stdin_offset:])
                except BrokenPipeError:
                    stdin.close()
                    stdin_closed = True
                else:
                    stdin_offset += written
                    if stdin_offset >= len(encoded):
                        stdin.close()
                        stdin_closed = True
            if stdout in readable:
                try:
                    chunk = os.read(stdout.fileno(), 8192)
                except BlockingIOError:
                    continue
                if chunk == b"":
                    stdout_eof = True
                    continue
                total += len(chunk)
                # Kill here; communicate() would retain the rest of an unbounded stream.
                if total > _MAX_OUTPUT_BYTES:
                    process.kill()
                    process.wait()
                    raise _hook_error("Command hook output exceeded its byte bound")
                chunks.append(chunk)
            if not readable and not writable:
                process.kill()
                process.wait()
                raise _hook_error(f"Command hook timed out after {timeout_ms}ms")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            process.kill()
            process.wait()
            raise _hook_error(f"Command hook timed out after {timeout_ms}ms")
        returncode = process.wait(timeout=remaining)
        return b"".join(chunks), returncode
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise _hook_error(f"Command hook timed out after {timeout_ms}ms") from None
    finally:
        for stream in (process.stdin, process.stdout):
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except OSError:
                    pass
        if process.poll() is None:
            process.kill()
            process.wait()


def _call_hook(
    hook: PrepareStepHook,
    payload: dict[str, object],
    timeout_sec: float,
) -> object:
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        # Worker threads start empty; copy so in-process hooks still see `current`.
        context = copy_context()
        future = executor.submit(context.run, hook, payload)
        try:
            return future.result(timeout=timeout_sec)
        except FutureTimeout:
            raise _hook_error(
                f"pre_step hooks timed out after {PRE_STEP_HOOK_TIMEOUT_MS}ms"
            ) from None
    finally:
        # A timed-out callable may keep running; waiting here would block fail-closed.
        executor.shutdown(wait=False, cancel_futures=True)


def _read_power(value: object) -> tuple[str, object]:
    if type(value) is not dict:
        raise _hook_error("pre_step hook must return a JSON object")
    power = value.get("power")
    if power == "observe":
        return "observe", None
    if power == "mutate":
        return "mutate", value
    if power == "block":
        reason = value.get("reason")
        if type(reason) is not str or reason == "":
            raise _hook_error("pre_step block reason must be a non-empty string")
        return "block", reason
    if power == "replace":
        if "result" not in value:
            raise _hook_error("pre_step replace must include result")
        return "replace", value["result"]
    raise _hook_error(f"pre_step returned unsupported power: {power!r}")


def _apply_mutate(payload: dict[str, object], result: object) -> None:
    if type(result) is not dict:
        raise _hook_error("pre_step mutate must be a JSON object")
    if "args" in result:
        payload["args"] = _json_list(result["args"], "args")
    if "kwargs" in result:
        payload["kwargs"] = _json_object(result["kwargs"], "kwargs")


def _json_list(value: object, field: str) -> list[object]:
    if type(value) is not list:
        raise _hook_error(f"pre_step mutate {field} must be a JSON array")
    try:
        cloned = clone_json(value)
    except WorkflowError as error:
        raise _hook_error(f"pre_step mutate {field} is not JSON") from error
    if type(cloned) is not list:
        raise _hook_error(f"pre_step mutate {field} must be a JSON array")
    return cloned


def _json_object(value: object, field: str) -> dict[str, object]:
    if type(value) is not dict:
        raise _hook_error(f"pre_step mutate {field} must be a JSON object")
    try:
        cloned = clone_json(value)
    except WorkflowError as error:
        raise _hook_error(f"pre_step mutate {field} is not JSON") from error
    if type(cloned) is not dict:
        raise _hook_error(f"pre_step mutate {field} must be a JSON object")
    return cloned


def _payload_call_args(
    payload: dict[str, object],
) -> tuple[tuple[object, ...], dict[str, object]]:
    args = payload["args"]
    kwargs = payload["kwargs"]
    if type(args) is not list or type(kwargs) is not dict:
        raise _hook_error("pre_step args and kwargs must stay JSON")
    return tuple(args), dict(kwargs)


def _validate_command_hook(argv: list[str], timeout_ms: int) -> None:
    if (
        len(argv) == 0
        or len(argv) > _MAX_ARG_COUNT
        or any(type(argument) is not str or argument == "" for argument in argv)
        or len(json.dumps(argv, separators=(",", ":")).encode("utf-8")) > _MAX_ARG_BYTES
    ):
        raise ValueError("Command hook argv must be a bounded non-empty array")
    if (
        type(timeout_ms) is not int
        or timeout_ms <= 0
        or timeout_ms > _MAX_COMMAND_TIMEOUT_MS
    ):
        raise ValueError("Command hook timeout must be between 1 and 30000ms")


def _hook_error(message: str) -> WorkflowError:
    return WorkflowError("hook", message)
