from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from vera.workflow.api import Suspend, current, step, workflow


class TestSuspend(unittest.TestCase):
    def test_suspend_returns_suspended_run_without_journal_line(self) -> None:
        @step
        def approve() -> bool:
            raise Suspend("waiting on sign-off")

        @workflow
        def approval() -> bool:
            return approve()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = approval.run(journal_dir=journal_dir)

            self.assertEqual(run.status, "suspended")
            self.assertIsNone(run.result)
            self.assertIsNotNone(run.error)
            self.assertEqual(run.error.kind, "suspended")
            self.assertEqual(run.error.message, "waiting on sign-off")
            run_dir = journal_dir / run.id
            header = json.loads((run_dir / "header.json").read_text())
            self.assertEqual(header["status"], "suspended")
            self.assertEqual(header["reason"], "waiting on sign-off")
            self.assertEqual((run_dir / "journal.ndjson").read_text(), "")

    def test_resume_after_inbox_approved_completes_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            hits_path = journal_dir / "hits.txt"

            @step
            def approve() -> bool:
                self.assertFalse(hasattr(current.run.inbox, "__setitem__"))
                if not current.run.inbox.get("approved"):
                    raise Suspend("waiting on sign-off")
                with hits_path.open("a", encoding="utf-8") as hits:
                    hits.write("x")
                return True

            @workflow
            def approval() -> bool:
                return approve()

            first = approval.run(journal_dir=journal_dir)
            self.assertEqual(first.status, "suspended")
            self.assertFalse(hits_path.exists())

            run_dir = journal_dir / first.id
            header_path = run_dir / "header.json"
            header = json.loads(header_path.read_text(encoding="utf-8"))
            inbox = header["inbox"]
            self.assertIsInstance(inbox, dict)
            inbox["approved"] = True
            header_path.write_text(json.dumps(header), encoding="utf-8")

            resumed = approval.resume(first.id, journal_dir=journal_dir)

            self.assertEqual(resumed.status, "ok")
            self.assertIs(resumed.result, True)
            self.assertEqual(hits_path.read_text(encoding="utf-8"), "x")
            lines = (run_dir / "journal.ndjson").read_text().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertIn("approval/approve#0:", json.loads(lines[0])["key"])

    def test_show_cli_lists_keys(self) -> None:
        @step
        def add(n: int) -> int:
            return n + 1

        @workflow
        def total(n: int) -> int:
            """Adds n and one."""
            return add(n)

        python_pkg_root = str(Path(__file__).resolve().parents[1])
        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(3, journal_dir=journal_dir)

            shown = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "show",
                    run.id,
                    "--journal-dir",
                    str(journal_dir),
                ],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(shown.returncode, 0, shown.stderr)
            self.assertIn(run.id, shown.stdout)
            self.assertIn("total/add#0:", shown.stdout)
            self.assertIn("doc    Adds n and one.", shown.stdout)
            self.assertNotIn("\x1b", shown.stdout)

            missing = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "show",
                    "wf_0000000000000000",
                    "--journal-dir",
                    str(journal_dir),
                ],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(missing.returncode, 2)
            self.assertTrue(missing.stderr)
            self.assertNotIn("\x1b", missing.stderr)


if __name__ == "__main__":
    unittest.main()
