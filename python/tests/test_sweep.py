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


ENTRY = Path(__file__).resolve().parent / "fixtures" / "crash_entry.py"


class TestSweep(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.journal_dir = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    def _cli(self, *arguments: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = _main([*arguments, "--journal-dir", str(self.journal_dir)])
        return code, out.getvalue()

    def _crash_a_run(self) -> str:
        """Run the entry workflow in a child that kills itself mid-step."""
        environment = os.environ | {
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
            "VERA_WF_CRASH": "1",
        }
        child = subprocess.run(
            [sys.executable, str(ENTRY), str(self.journal_dir)],
            env=environment,
            check=False,
            capture_output=True,
        )
        self.assertNotEqual(child.returncode, 0)
        directories = [
            path for path in self.journal_dir.iterdir() if path.name.startswith("wf_")
        ]
        self.assertEqual(len(directories), 1)
        return directories[0].name

    def _header(self, run_id: str) -> dict[str, object]:
        path = self.journal_dir / run_id / "header.json"
        return json.loads(path.read_text(encoding="utf-8"))

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

    def test_a_dead_run_is_marked_crashed_and_not_resumed(self) -> None:
        run_id = self._crash_a_run()

        code, out = self._cli("sweep")

        self.assertEqual(code, 0)
        self.assertIn(run_id, out)
        self.assertIn("--resume", out)
        header = self._header(run_id)
        self.assertEqual(header["status"], "crashed")
        self.assertIn("did not come back", header["reason"])
        self.assertNotIn("finished_at", header["attempts"][0])
        self.assertEqual((self.journal_dir / "second.txt").exists(), False)

    def test_sweeping_twice_finds_nothing_the_second_time(self) -> None:
        self._crash_a_run()
        self._cli("sweep")

        code, out = self._cli("sweep")

        self.assertEqual(code, 0)
        self.assertIn("no crashed workflow runs", out)

    def test_resume_finishes_the_work_the_dead_process_left(self) -> None:
        run_id = self._crash_a_run()

        code, out = self._cli("sweep", "--resume")

        self.assertEqual(code, 0)
        self.assertIn("ok", out)
        self.assertEqual(self._header(run_id)["status"], "ok")
        self.assertEqual((self.journal_dir / "second.txt").read_text(), "second")

    def test_a_live_process_is_left_alone(self) -> None:
        live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(live.wait)
        self.addCleanup(live.kill)
        self._write_run(
            "wf_00000000000000fe",
            {
                "started_at": "2026-09-17T12:00:00+00:00",
                "pid": live.pid,
                "host": socket.gethostname(),
            },
        )

        code, out = self._cli("sweep")

        self.assertEqual(code, 0)
        self.assertIn("no crashed workflow runs", out)
        self.assertEqual(self._header("wf_00000000000000fe")["status"], "running")

    def test_a_run_from_another_machine_is_left_alone(self) -> None:
        self._write_run(
            "wf_00000000000000fd",
            {
                "started_at": "2026-09-17T12:00:00+00:00",
                "pid": 999999,
                "host": "some-other-box",
            },
        )

        code, out = self._cli("sweep")

        self.assertEqual(code, 0)
        self.assertIn("no crashed workflow runs", out)

    def test_a_cancelled_run_is_marked_but_never_resumed(self) -> None:
        run_id = self._crash_a_run()
        path = self.journal_dir / run_id / "header.json"
        header = json.loads(path.read_text(encoding="utf-8"))
        header["cancel_requested"] = "cancelled from the command line"
        path.write_text(json.dumps(header), encoding="utf-8")

        code, out = self._cli("sweep", "--resume")

        self.assertEqual(code, 0)
        self.assertIn("a cancel was asked for", out)
        self.assertEqual(self._header(run_id)["status"], "crashed")
        self.assertFalse((self.journal_dir / "second.txt").exists())


if __name__ == "__main__":
    unittest.main()
