from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile

from .agent import Agent


class Vera:
    def __init__(
        self,
        *,
        workspace: Path,
        posture: str | None,
        temporary_directory: tempfile.TemporaryDirectory[str],
        replay: bool,
    ) -> None:
        self.workspace = workspace
        self.posture = posture
        self._replay = replay
        self._temporary_directory = temporary_directory
        self._runtime_dir = Path(temporary_directory.name).resolve()

    @classmethod
    def create(
        cls,
        *,
        workspace: str,
        posture: str | None = None,
        _replay: bool = False,
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
        )

    def close(self) -> None:
        self._temporary_directory.cleanup()

    def run(self, agent: Agent, prompt: str) -> str:
        if not isinstance(agent, Agent):
            raise TypeError("Vera.run agent must be an Agent")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Vera.run prompt must be a non-empty string")
        if not self._runtime_dir.is_dir():
            raise RuntimeError("Vera instance is closed")

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
        payload: dict[str, object] = {
            "workspace": str(self.workspace),
            "agent": agent_payload,
            "prompt": prompt,
        }
        if self.posture is not None:
            payload["posture"] = self.posture
        if self._replay:
            payload["replay"] = True

        child_path = Path(__file__).with_name("_child.ts")
        # The child reads the caller's Vera home; scratch files go under TMPDIR.
        child_env = os.environ | {
            "TMPDIR": str(self._runtime_dir),
        }
        try:
            completed = subprocess.run(
                ["bun", str(child_path)],
                input=json.dumps(payload, separators=(",", ":")),
                capture_output=True,
                encoding="utf-8",
                env=child_env,
                check=False,
            )
        except OSError as error:
            raise RuntimeError("cannot start Vera bun child") from error
        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip()
            if not detail:
                detail = f"bun child exited with status {completed.returncode}"
            raise RuntimeError(f"Vera bun child failed: {detail}")
        return completed.stdout
