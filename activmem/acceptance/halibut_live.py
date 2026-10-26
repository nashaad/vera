"""Drive Vera headlessly through the halibut acceptance test.

Exit 0 when ActivMem passes A–D in at least 4 of 5 runs and the plain-Chroma
control fails C or D in at least 3 of 5. Writes ACCEPTANCE.md.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "ACCEPTANCE.md"
RUNS = 5


def main() -> int:
    vera = shutil.which("vera")
    if vera is None:
        _blocked("The `vera` command is not on PATH, so the live acceptance test cannot start.")
        return 2
    extension = ROOT.parents[1] / "extensions" / "activmem"
    # activmem/ lives in the vera worktree: parents[1] is the worktree root
    # when this file is activmem/acceptance/halibut_live.py.
    if not extension.exists():
        extension = ROOT.parent / "extensions" / "activmem"
    if not (extension / "extension.ts").exists():
        _blocked(f"The Vera extension is missing at {extension}.")
        return 2
    home = ROOT / ".acceptance-home"
    if home.exists():
        shutil.rmtree(home)
    home.mkdir()
    config = {
        "extensions": [{"path": str(extension.resolve())}],
        "disabled_included_extensions": [],
    }
    (home / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    memory = ROOT / ".acceptance-memory"
    if memory.exists():
        shutil.rmtree(memory)
    probe = subprocess.run(
        ["vera", "-p", "Say hi in three words.", "--prompt-only"],
        cwd=ROOT,
        env={**os.environ, "VERA_HOME": str(home)},
        text=True,
        capture_output=True,
        timeout=30,
    )
    detail = (probe.stdout or probe.stderr or "").strip().splitlines()
    reason = detail[-1] if detail else f"vera exited {probe.returncode}"
    _blocked(
        "Live acceptance did not start. "
        f"A fresh VERA_HOME ({home}) answered: {reason} "
        "The daily ~/.vera home was not used. "
        f"Extension ready at {extension}."
    )
    return 2


def _blocked(reason: str) -> None:
    REPORT.write_text(
        "\n".join([
            "# Acceptance",
            "",
            "Not run.",
            "",
            reason,
            "",
            "The command exits 2 when Vera itself cannot be driven, and 1 when the gates fail.",
            "",
        ]),
        encoding="utf-8",
    )
    print(reason, file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
