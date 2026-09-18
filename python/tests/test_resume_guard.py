from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

from vera.workflow.__main__ import _main


class TestResumeGuard(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.journal_dir = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    def _cli(self, *arguments: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = _main([*arguments, "--journal-dir", str(self.journal_dir)])
        return code, out.getvalue()

    def _write_run(self, run_id: str, attempt: dict[str, object]) -> None:
        run_dir = self.journal_dir / run_id
        run_dir.mkdir()
        (run_dir / "journal.ndjson").touch()
        (run_dir / "header.json").write_text(
            json.dumps(
                {
                    "run_id": run_id,
                    "workflow": "held",
                    "status": "running",
                    "started_at": "2026-09-17T12:00:00+00:00",
                    "inbox": {},
                    "doc": "",
                    "args": [],
                    "kwargs": {},
                    "attempts": [attempt],
                }
            ),
            encoding="utf-8",
        )

    def test_a_run_whose_process_is_alive_is_not_resumed(self) -> None:
        live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(live.wait)
        self.addCleanup(live.kill)
        self._write_run(
            "wf_00000000000000fa",
            {
                "started_at": "2026-09-17T12:00:00+00:00",
                "pid": live.pid,
                "host": socket.gethostname(),
            },
        )

        code, out = self._cli("resume", "wf_00000000000000fa")

        self.assertEqual(code, 2)
        self.assertIn(f"pid {live.pid}", out)

    def test_a_run_left_by_another_machine_is_not_resumed(self) -> None:
        self._write_run(
            "wf_00000000000000fb",
            {
                "started_at": "2026-09-17T12:00:00+00:00",
                "pid": 999999,
                "host": "some-other-box",
            },
        )

        code, out = self._cli("resume", "wf_00000000000000fb")

        self.assertEqual(code, 2)
        self.assertIn("sweep there", out)

    def test_a_run_whose_process_is_gone_from_here_still_resumes(self) -> None:
        entry = Path(__file__).resolve().parent / "fixtures" / "crash_entry.py"
        child = subprocess.run(
            [sys.executable, str(entry), str(self.journal_dir)],
            env=os.environ
            | {
                "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
                "VERA_WF_CRASH": "1",
            },
            check=False,
            capture_output=True,
        )
        self.assertNotEqual(child.returncode, 0)
        run_id = next(
            path.name
            for path in self.journal_dir.iterdir()
            if path.name.startswith("wf_")
        )

        code, out = self._cli("resume", run_id)

        self.assertEqual(code, 0)
        self.assertIn("ok", out)


if __name__ == "__main__":
    unittest.main()
