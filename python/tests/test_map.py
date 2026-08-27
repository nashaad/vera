from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from vera.workflow.api import Ticket, step, workflow


CHILD = r"""
import os
import sys
from pathlib import Path
from vera.workflow.api import step, workflow

journal_dir = Path(sys.argv[1])
mode = sys.argv[2]
hits_path = journal_dir / "hits.txt"

@step
def hit(value: int) -> int:
    if value == 3 and os.environ.get("VERA_WF_CRASH") == "1":
        os._exit(1)
    with hits_path.open("a", encoding="utf-8") as hits:
        hits.write(f"{value}\n")
    return value * 2

@workflow
def mapped() -> tuple[object, ...]:
    return hit.map([1, 2, 3])

if mode == "run":
    mapped.run(journal_dir=journal_dir)
elif mode == "resume":
    run_id = sys.argv[3]
    run = mapped.resume(run_id, journal_dir=journal_dir)
    if run.status != "ok":
        raise SystemExit(run.status)
else:
    raise SystemExit("bad mode")
"""


class TestMap(unittest.TestCase):
    def test_submit_returns_ticket_and_journals_once(self) -> None:
        @step
        def add(x: int, y: int) -> int:
            return x + y

        @workflow
        def total() -> int:
            ticket = add.submit(2, 3)
            self.assertIsInstance(ticket, Ticket)
            first = ticket.result()
            second = ticket.result()
            self.assertEqual(second, first)
            return first

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(journal_dir=journal_dir)

            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, 5)
            lines = (journal_dir / run.id / "journal.ndjson").read_text(
                encoding="utf-8"
            ).splitlines()
            self.assertEqual(len(lines), 1)

    def test_map_journals_each_item(self) -> None:
        @step
        def double(value: int) -> int:
            return value * 2

        @workflow
        def mapped() -> tuple[object, ...]:
            return double.map([1, 2, 3])

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = mapped.run(journal_dir=journal_dir)

            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, (2, 4, 6))
            records = [
                json.loads(line)
                for line in (journal_dir / run.id / "journal.ndjson")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(len(records), 3)
            for ordinal, record in enumerate(records):
                self.assertIn(f"#{ordinal}:", record["key"])

    def test_map_resume_skips_completed_items(self) -> None:
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
            self.assertEqual(
                (journal_dir / "hits.txt").read_text(encoding="utf-8"),
                "1\n2\n",
            )
            run_dirs = [
                path
                for path in journal_dir.iterdir()
                if path.is_dir() and path.name.startswith("wf_")
            ]
            self.assertEqual(len(run_dirs), 1)
            journal_path = run_dirs[0] / "journal.ndjson"
            self.assertEqual(len(journal_path.read_text().splitlines()), 2)

            resume_env = env.copy()
            resume_env.pop("VERA_WF_CRASH")
            resumed = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    CHILD,
                    str(journal_dir),
                    "resume",
                    run_dirs[0].name,
                ],
                env=resume_env,
                check=False,
            )

            self.assertEqual(resumed.returncode, 0)
            self.assertEqual(
                (journal_dir / "hits.txt").read_text(encoding="utf-8"),
                "1\n2\n3\n",
            )
            self.assertEqual(len(journal_path.read_text().splitlines()), 3)

    def test_ticket_has_only_result(self) -> None:
        @step
        def identity(value: int) -> int:
            return value

        ticket = identity.submit(3)

        self.assertTrue(hasattr(ticket, "result"))
        self.assertFalse(hasattr(ticket, "add_done_callback"))
        self.assertFalse(hasattr(ticket, "done"))
        self.assertFalse(hasattr(ticket, "cancel"))


if __name__ == "__main__":
    unittest.main()
