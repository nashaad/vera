from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
from typing import Any

from .agent import Agent


_SESSION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_ABORT_GRACE_SECONDS = 5.0
_CLOSE_GRACE_SECONDS = 5.0
_STDERR_LINES = 200


def child_script() -> Path:
    """The bun child: the bundle a wheel ships, else the source in a checkout."""
    here = Path(__file__).parent
    bundled = here / "_bun" / "src" / "child" / "child.js"
    if bundled.is_file():
        return bundled
    return here / "_child.ts"


class _ChildExited(Exception):
    pass


class _Child:
    """One bun process speaking JSON lines on stdin and stdout."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.stderr: deque[str] = deque(maxlen=_STDERR_LINES)
        self.readers = [
            threading.Thread(target=self._read_stdout, daemon=True),
            threading.Thread(target=self._read_stderr, daemon=True),
        ]
        for reader in self.readers:
            reader.start()

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr.append(line.rstrip("\n"))

    def send(self, message: dict[str, object]) -> None:
        assert self.process.stdin is not None
        try:
            self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise _ChildExited from error

    def receive(self, deadline: float | None) -> dict[str, Any]:
        """Next protocol line. Raises queue.Empty at the deadline."""
        remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
        line = self.lines.get(timeout=remaining)
        if line is None:
            self.lines.put(None)
            raise _ChildExited
        return json.loads(line)

    def detail(self) -> str:
        self.process.poll()
        text = "\n".join(self.stderr).strip()
        if text:
            return text
        return f"bun child exited with status {self.process.returncode}"

    def stop(self) -> None:
        try:
            assert self.process.stdin is not None
            self.process.stdin.close()
        except OSError:
            pass
        if self.process.poll() is None:
            try:
                self.process.wait(timeout=_CLOSE_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for reader in self.readers:
            reader.join(timeout=_CLOSE_GRACE_SECONDS)
        for stream in (self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


class Vera:
    def __init__(
        self,
        *,
        workspace: Path,
        posture: str | None,
        temporary_directory: tempfile.TemporaryDirectory[str],
        replay: bool,
        replay_delay: float = 0.0,
    ) -> None:
        self.workspace = workspace
        self.posture = posture
        self._replay = replay
        self._replay_delay = replay_delay
        self._temporary_directory = temporary_directory
        self._runtime_dir = Path(temporary_directory.name).resolve()
        self._child: _Child | None = None
        self._next_id = 0
        self._lock = threading.Lock()
        self._closed = False

    @classmethod
    def create(
        cls,
        *,
        workspace: str,
        posture: str | None = None,
        _replay: bool = False,
        _replay_delay: float = 0.0,
    ) -> Vera:
        if not isinstance(workspace, str) or not workspace.strip():
            raise ValueError("Vera workspace must be a non-empty path")
        if posture is not None:
            if not isinstance(posture, str) or not posture.strip():
                raise ValueError("Vera posture must be a non-empty name")
            posture = posture.strip()

        temporary_directory = tempfile.TemporaryDirectory(prefix="vera-sdk-")
        return cls(
            workspace=Path(workspace).expanduser().resolve(),
            posture=posture,
            temporary_directory=temporary_directory,
            replay=_replay,
            replay_delay=_replay_delay,
        )

    def __enter__(self) -> Vera:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            if self._child is not None:
                self._child.stop()
                self._child = None
            self._temporary_directory.cleanup()

    def run(
        self,
        agent: Agent,
        prompt: str,
        *,
        session: str | None = None,
        timeout: float | None = None,
    ) -> str:
        """One agent turn. A session name continues that conversation until close()."""
        if not isinstance(agent, Agent):
            raise TypeError("Vera.run agent must be an Agent")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Vera.run prompt must be a non-empty string")
        if session is not None and (
            not isinstance(session, str) or _SESSION_NAME.fullmatch(session) is None
        ):
            raise ValueError(
                "Vera.run session must be letters, digits, - or _, up to 64 characters"
            )
        if timeout is not None and (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or timeout <= 0
        ):
            raise ValueError("Vera.run timeout must be a positive number of seconds")

        agent_payload: dict[str, object] = {
            "name": agent.name,
            "instructions": agent.instructions,
        }
        if agent.tools is not None:
            agent_payload["tools"] = agent.tools
        if agent.posture is not None:
            agent_payload["posture"] = agent.posture
        if agent.provider is not None:
            agent_payload["provider"] = agent.provider
        if agent.model is not None:
            agent_payload["model"] = agent.model
        request: dict[str, object] = {
            "type": "run",
            "agent": agent_payload,
            "prompt": prompt,
        }
        if session is not None:
            request["session"] = session

        reply = self._request(request, timeout)
        if reply.get("type") != "result":
            raise RuntimeError(f"Vera bun child sent an unexpected reply: {reply}")
        return str(reply["text"])

    def tool(self, name: str, input: dict[str, object] | None = None) -> str:
        """Runs one tool under this instance's posture and returns its output.

        Raises PermissionError when the posture denies the call, including
        calls that would need an approval, and RuntimeError when the tool fails.
        """
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Vera.tool name must be a non-empty string")
        if input is None:
            input = {}
        if not isinstance(input, dict):
            raise TypeError("Vera.tool input must be a dict")

        reply = self._request({"type": "tool", "name": name, "input": input}, None)
        if reply.get("type") != "tool_result":
            raise RuntimeError(f"Vera bun child sent an unexpected reply: {reply}")
        output = str(reply["output"])
        if reply["outcome"] == "denied":
            raise PermissionError(output)
        if reply["outcome"] == "failed":
            raise RuntimeError(output)
        return output

    def _request(self, request: dict[str, object], timeout: float | None) -> dict[str, Any]:
        with self._lock:
            if self._closed or not self._runtime_dir.is_dir():
                raise RuntimeError("Vera instance is closed")
            child = self._ensure_child()
            self._next_id += 1
            request_id = self._next_id
            deadline = None if timeout is None else time.monotonic() + timeout
            try:
                child.send({"id": request_id, **request})
                reply = self._reply(child, request_id, deadline)
            except queue.Empty:
                reply = self._abort(child, request_id)
                if reply is None or reply.get("type") == "error":
                    raise TimeoutError(
                        f"Vera.run did not finish within {timeout} seconds"
                    ) from None
            except _ChildExited:
                self._child = None
                child.stop()
                raise RuntimeError(f"Vera bun child failed: {child.detail()}") from None
        if reply.get("type") == "error":
            raise RuntimeError(f"Vera bun child failed: {reply.get('message')}")
        return reply

    def _reply(self, child: _Child, request_id: int, deadline: float | None) -> dict[str, Any]:
        while True:
            reply = child.receive(deadline)
            if reply.get("id") == request_id:
                return reply
            if reply.get("type") == "error" and "id" not in reply:
                raise RuntimeError(f"Vera bun child failed: {reply.get('message')}")

    def _abort(self, child: _Child, request_id: int) -> dict[str, Any] | None:
        """Asks the child to stop the turn. A child that does not answer is replaced."""
        try:
            child.send({"type": "abort", "id": request_id})
            return self._reply(child, request_id, time.monotonic() + _ABORT_GRACE_SECONDS)
        except (queue.Empty, _ChildExited):
            self._child = None
            child.process.kill()
            child.stop()
            return None

    def _ensure_child(self) -> _Child:
        if self._child is not None:
            if self._child.process.poll() is None:
                return self._child
            self._child.stop()
            self._child = None
        child_path = child_script()
        # The child reads the caller's Vera home; scratch files go under TMPDIR.
        child_env = os.environ | {
            "TMPDIR": str(self._runtime_dir),
        }
        try:
            process = subprocess.Popen(
                ["bun", str(child_path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                encoding="utf-8",
                env=child_env,
            )
        except OSError as error:
            raise RuntimeError("cannot start Vera bun child") from error
        child = _Child(process)
        init: dict[str, object] = {
            "type": "init",
            "workspace": str(self.workspace),
        }
        if self.posture is not None:
            init["posture"] = self.posture
        if self._replay:
            init["replay"] = True
            init["replay_delay_ms"] = self._replay_delay * 1000
        try:
            child.send(init)
            ready = child.receive(None)
        except _ChildExited:
            child.stop()
            raise RuntimeError(f"Vera bun child failed: {child.detail()}") from None
        if ready.get("type") != "ready":
            child.stop()
            raise RuntimeError(f"Vera bun child failed: {ready.get('message')}")
        self._child = child
        return child
