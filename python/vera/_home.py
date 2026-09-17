from __future__ import annotations

import os
from pathlib import Path


VERA_HOME_ENV = "VERA_HOME"


def vera_home() -> Path:
    """The one Vera home. VERA_HOME relocates the whole tree."""
    override = os.environ.get(VERA_HOME_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".vera"


def workflows_directory() -> Path:
    return vera_home() / "workflows"
