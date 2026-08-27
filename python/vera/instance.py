from __future__ import annotations

from pathlib import Path
import tempfile


class Vera:
    def __init__(
        self,
        *,
        workspace: Path,
        posture: str | None,
        temporary_directory: tempfile.TemporaryDirectory[str],
    ) -> None:
        self.workspace = workspace
        self.posture = posture
        self._temporary_directory = temporary_directory
        self._runtime_dir = Path(temporary_directory.name).resolve()

    @classmethod
    def create(cls, *, workspace: str, posture: str | None = None) -> Vera:
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
        )

    def close(self) -> None:
        self._temporary_directory.cleanup()
