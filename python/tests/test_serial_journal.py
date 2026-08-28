from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from vera.workflow.api import WorkflowError, current, step, workflow


CHILD = r"""
import os
import sys
from pathlib import Path
from vera.workflow.api import step, workflow

journal_dir = Path(sys.argv[1])
mode = sys.argv[2]
a_path = journal_dir / "a.txt"
b_path = journal_dir / "b.txt"

@step
def a() -> int:
    a_path.write_text("a")
    return 1

@step
def b() -> int:
    if os.environ.get("VERA_WF_CRASH") == "1":
        os._exit(1)
    b_path.write_text("b")
    return 2

@workflow
def pair() -> int:
    return a() + b()

if mode == "run":
    pair.run(journal_dir=journal_dir)
elif mode == "resume":
    run_id = sys.argv[3]
    out = Path(sys.argv[4])
    run = pair.resume(run_id, journal_dir=journal_dir)
    out.write_text(str(run.result))
else:
    raise SystemExit("bad mode")
"""


class TestSerialJournal(unittest.TestCase):
    def test_run_returns_value_and_writes_header_and_journal(self) -> None:
        @step
        def add(x: int, y: int) -> int:
            self.assertFalse(current.cancelled)
            self.assertIsInstance(current.run.journal_dir, Path)
            return x + y

        @workflow
        def total() -> int:
            return add(2, 3)

        self.assertEqual(add.__name__, "add")
        self.assertEqual(add.__wrapped__.__name__, add.__name__)
        self.assertEqual(total.__name__, "total")

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(journal_dir=journal_dir)

            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, 5)
            run_dir = journal_dir / run.id
            header = json.loads((run_dir / "header.json").read_text())
            self.assertEqual(header["status"], "ok")
            self.assertEqual(header["workflow"], "total")
            lines = (run_dir / "journal.ndjson").read_text().splitlines()
            self.assertEqual(len(lines), 1)
            record = json.loads(lines[0])
            self.assertEqual(record["value"], 5)
            self.assertTrue(record["key"].startswith("total/add#0:"))

    def test_resume_skips_completed_step_side_effect(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            hits_path = journal_dir / "hits.txt"

            @step
            def hit(value: int) -> int:
                with hits_path.open("a") as hits:
                    hits.write("x")
                return value + 1

            @workflow
            def total(value: int) -> int:
                return hit(value)

            first = total.run(3, journal_dir=journal_dir)
            self.assertEqual(hits_path.read_text(), "x")

            resumed = total.resume(first.id, journal_dir=journal_dir)

            self.assertEqual(resumed.status, "ok")
            self.assertEqual(resumed.result, 4)
            self.assertEqual(hits_path.read_text(), "x")

    def test_failed_step_returns_failed_run_and_omits_journal_line(self) -> None:
        @step
        def fail() -> None:
            raise RuntimeError("boom")

        @workflow
        def broken() -> None:
            try:
                fail()
            except Exception:
                self.fail("workflow glue swallowed a failed step")

        @step
        def fail_with_workflow_error() -> None:
            raise WorkflowError("journal", "raised by user code")

        @workflow
        def also_broken() -> None:
            fail_with_workflow_error()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = broken.run(journal_dir=journal_dir)

            self.assertEqual(run.status, "failed")
            self.assertIsNotNone(run.error)
            self.assertEqual(run.error.kind, "step")
            run_dir = journal_dir / run.id
            journal_path = run_dir / "journal.ndjson"
            self.assertFalse(journal_path.exists() and journal_path.read_text())
            header = json.loads((run_dir / "header.json").read_text())
            self.assertEqual(header["status"], "failed")

            user_error_run = also_broken.run(journal_dir=journal_dir)
            self.assertEqual(user_error_run.status, "failed")
            self.assertIsNotNone(user_error_run.error)
            self.assertEqual(user_error_run.error.kind, "step")

    def test_resume_retries_failed_step(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            gate_path = journal_dir / "gate.txt"

            @step
            def gated() -> str:
                if not gate_path.exists():
                    gate_path.write_text("no")
                    raise RuntimeError("not yet")
                return "ok"

            @workflow
            def wait_for_gate() -> str:
                return gated()

            first = wait_for_gate.run(journal_dir=journal_dir)
            self.assertEqual(first.status, "failed")

            resumed = wait_for_gate.resume(first.id, journal_dir=journal_dir)

            self.assertEqual(resumed.status, "ok")
            self.assertEqual(resumed.result, "ok")
            run_dir = journal_dir / first.id
            journal_path = run_dir / "journal.ndjson"
            header_path = run_dir / "header.json"
            lines = journal_path.read_text().splitlines()
            self.assertEqual(len(lines), 1)

            journal_bytes = journal_path.read_bytes()
            journal_path.write_bytes(b"\xff")
            with self.assertRaises(WorkflowError) as journal_error:
                wait_for_gate.resume(first.id, journal_dir=journal_dir)
            self.assertEqual(journal_error.exception.kind, "journal")

            journal_path.write_bytes(journal_bytes)
            header_path.write_bytes(b"\xff")
            with self.assertRaises(WorkflowError) as header_error:
                wait_for_gate.resume(first.id, journal_dir=journal_dir)
            self.assertEqual(header_error.exception.kind, "journal")

    def test_crash_mid_run_then_resume_in_a_child_process(self) -> None:
        python_pkg_root = str(Path(__file__).resolve().parents[1])
        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            env = os.environ | {
                "PYTHONPATH": python_pkg_root,
                "VERA_WF_CRASH": "1",
            }
            crashed = subprocess.run(
                [sys.executable, "-c", CHILD, str(journal_dir), "run"],
                env=env,
                check=False,
            )

            self.assertNotEqual(crashed.returncode, 0)
            self.assertEqual((journal_dir / "a.txt").read_text(), "a")
            self.assertFalse((journal_dir / "b.txt").exists())
            run_dirs = [
                path
                for path in journal_dir.iterdir()
                if path.is_dir() and path.name.startswith("wf_")
            ]
            self.assertEqual(len(run_dirs), 1)
            run_dir = run_dirs[0]
            header = json.loads((run_dir / "header.json").read_text())
            self.assertEqual(header["status"], "running")
            lines = (run_dir / "journal.ndjson").read_text().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertIn("/a#", json.loads(lines[0])["key"])

            resume_env = env.copy()
            resume_env.pop("VERA_WF_CRASH")
            resumed = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    CHILD,
                    str(journal_dir),
                    "resume",
                    run_dir.name,
                    str(journal_dir / "result.txt"),
                ],
                env=resume_env,
                check=False,
            )

            self.assertEqual(resumed.returncode, 0)
            self.assertEqual((journal_dir / "result.txt").read_text(), "3")
            self.assertEqual((journal_dir / "a.txt").read_text(), "a")
            self.assertEqual((journal_dir / "b.txt").read_text(), "b")


if __name__ == "__main__":
    unittest.main()
