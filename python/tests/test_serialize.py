from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from vera.workflow.api import RunError, step, workflow


class TestSerialize(unittest.TestCase):
    def test_set_argument_returns_failed_serialize_without_journal_line(
        self,
    ) -> None:
        step_entered = False

        @step
        def takes_set(xs: object) -> object:
            nonlocal step_entered
            step_entered = True
            return xs

        @workflow
        def invalid() -> object:
            return takes_set({1})

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = invalid.run(journal_dir=journal_dir)

            self.assertEqual(run.status, "failed")
            self.assertIsNone(run.result)
            error = run.error
            self.assertIsInstance(error, RunError)
            self.assertEqual(error.kind, "serialize")
            self.assertFalse(step_entered)

            run_dir = journal_dir / run.id
            header = json.loads(
                (run_dir / "header.json").read_text(encoding="utf-8")
            )
            self.assertEqual(header["status"], "failed")
            self.assertEqual(
                header["error"],
                {"kind": error.kind, "message": error.message},
            )
            self.assertEqual(
                (run_dir / "journal.ndjson").read_text(encoding="utf-8"),
                "",
            )

    def test_example_file_runs(self) -> None:
        worktree_root = Path(__file__).resolve().parents[2]
        python_pkg_root = worktree_root / "python"
        example_path = worktree_root / "examples" / "workflows" / "counter.workflow.py"
        env = os.environ | {"PYTHONPATH": str(python_pkg_root)}

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            completed = subprocess.run(
                [sys.executable, str(example_path), str(journal_dir)],
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            run_id, result = completed.stdout.split()
            self.assertTrue(run_id.startswith("wf_"))
            self.assertEqual(result, "2")
            self.assertEqual(
                (journal_dir / "counter.txt").read_text(encoding="utf-8"),
                "1\n",
            )
            run_dirs = [
                path
                for path in journal_dir.iterdir()
                if path.is_dir() and path.name.startswith("wf_")
            ]
            self.assertEqual(run_dirs, [journal_dir / run_id])
            header = json.loads(
                (run_dirs[0] / "header.json").read_text(encoding="utf-8")
            )
            self.assertEqual(header["status"], "ok")
            records = [
                json.loads(line)
                for line in (run_dirs[0] / "journal.ndjson")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(len(records), 2)
            self.assertIn("main/bump#0:", records[0]["key"])
            self.assertIn("main/double#0:", records[1]["key"])

        missing = subprocess.run(
            [sys.executable, str(example_path)],
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(missing.returncode, 2)
        self.assertEqual(missing.stdout, "")
        self.assertEqual(
            missing.stderr,
            "usage: counter.workflow.py <journal_dir>\n",
        )


if __name__ == "__main__":
    unittest.main()
