from __future__ import annotations

import contextlib
import io
from pathlib import Path
import tempfile
import threading
import time
import unittest

from vera.workflow.__main__ import CANCEL_REASON, _main
from vera.workflow._sql import SqliteJournalStore
from vera.workflow._store import FileJournalStore
from vera.workflow.api import current, step, workflow


cancel = threading.Event()
seen: list[str] = []


@step
def first() -> int:
    seen.append("first")
    cancel.set()
    return 1


@step
def second(n: int) -> int:
    seen.append("second")
    return n + 1


@workflow
def two_steps() -> int:
    return second(first())


@step(timeout=0.05)
def long_step() -> int:
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if current.cancelled:
            seen.append("noticed")
            return 0
        time.sleep(0.01)
    seen.append("ran to the end")
    return 1


@workflow
def slow() -> int:
    return long_step()


journal_dir: Path


@step
def ask_to_stop() -> int:
    """Stands in for another process running the cancel command."""
    seen.append("ask")
    with contextlib.redirect_stdout(io.StringIO()):
        _main(["cancel", current.run.id, "--journal-dir", str(journal_dir)])
    return 1


@workflow
def asked() -> int:
    return second(ask_to_stop())


class TestCancel(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.store = FileJournalStore(Path(self._directory.name))
        self.addCleanup(self._directory.cleanup)
        cancel.clear()
        seen.clear()

    def test_a_cancelled_run_stops_before_the_next_step(self) -> None:
        run = two_steps.run(journal=self.store, cancel=cancel)

        self.assertEqual(run.status, "cancelled")
        self.assertEqual(seen, ["first"])
        assert run.error is not None
        self.assertEqual(run.error.kind, "cancelled")

    def test_a_cancelled_run_resumes_and_keeps_the_first_step(self) -> None:
        run = two_steps.run(journal=self.store, cancel=cancel)
        cancel.clear()
        seen.clear()

        resumed = two_steps.resume(run.id, journal=self.store, cancel=cancel)

        self.assertEqual(resumed.status, "ok")
        self.assertEqual(resumed.result, 2)
        self.assertEqual(seen, ["second"])

    def test_current_cancelled_is_false_without_a_token(self) -> None:
        recorded: list[bool] = []

        @step
        def look() -> int:
            recorded.append(current.cancelled)
            return 0

        @workflow
        def looking() -> int:
            return look()

        looking.run(journal=self.store)

        self.assertEqual(recorded, [False])

    def test_a_step_past_its_deadline_sees_the_cancellation(self) -> None:
        run = slow.run(journal=self.store)

        self.assertEqual(run.status, "failed")
        assert run.error is not None
        self.assertEqual(run.error.kind, "timeout")
        deadline = time.monotonic() + 1.0
        while "noticed" not in seen and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(seen, ["noticed"])


class TestCancelFromAnotherProcess(unittest.TestCase):
    def setUp(self) -> None:
        global journal_dir
        self._directory = tempfile.TemporaryDirectory()
        journal_dir = Path(self._directory.name)
        self.addCleanup(self._directory.cleanup)
        seen.clear()

    def test_the_cancel_command_stops_a_running_workflow(self) -> None:
        run = asked.run(journal_dir=journal_dir)

        self.assertEqual(run.status, "cancelled")
        self.assertEqual(seen, ["ask"])
        assert run.error is not None
        self.assertEqual(run.error.message, CANCEL_REASON)

    def test_a_resume_clears_the_request_and_finishes(self) -> None:
        run = asked.run(journal_dir=journal_dir)
        seen.clear()

        resumed = asked.resume(run.id, journal_dir=journal_dir)

        self.assertEqual(resumed.status, "ok")
        self.assertEqual(resumed.result, 2)
        self.assertEqual(seen, ["second"])

    def test_the_cancel_command_refuses_a_finished_run(self) -> None:
        run = two_steps.run(journal_dir=journal_dir)
        error = io.StringIO()

        with contextlib.redirect_stderr(error):
            code = _main(["cancel", run.id, "--journal-dir", str(journal_dir)])

        self.assertEqual(code, 2)
        self.assertIn("already ok", error.getvalue())

    def test_a_sqlite_journal_carries_the_request(self) -> None:
        global journal_dir
        journal_dir = Path(self._directory.name) / "runs.sqlite3"
        store = SqliteJournalStore(journal_dir)

        run = asked.run(journal=store)

        self.assertEqual(run.status, "cancelled")
        assert run.error is not None
        self.assertEqual(run.error.message, CANCEL_REASON)


if __name__ == "__main__":
    unittest.main()
