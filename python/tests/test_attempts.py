from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest

from vera.workflow.__main__ import _main
from vera.workflow._sql import SqliteJournalStore
from vera.workflow._store import FileJournalStore
from vera.workflow.api import Suspend, step, workflow


FAIL = {"on": True}


@step
def steady(n: int) -> int:
    return n * 2


@step
def shaky(n: int) -> int:
    if FAIL["on"]:
        raise RuntimeError("not this time")
    return n


@step
def waiting(n: int) -> int:
    raise Suspend("waiting on sign-off")


@workflow
def solid(n: int) -> int:
    return steady(n)


@workflow
def flaky(n: int) -> int:
    return shaky(n)


@workflow
def paused(n: int) -> int:
    return waiting(n)


class TestAttempts(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.journal_dir = Path(self._dir.name)
        self.store = FileJournalStore(self.journal_dir)
        self.addCleanup(self._dir.cleanup)
        FAIL["on"] = True

    def _header(self, run_id: str) -> dict[str, object]:
        path = self.journal_dir / run_id / "header.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_a_run_records_the_process_that_ran_it(self) -> None:
        run = solid.run(3, journal=self.store)

        attempts = self._header(run.id)["attempts"]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["pid"], os.getpid())
        self.assertEqual(attempts[0]["host"], socket.gethostname())
        self.assertEqual(attempts[0]["status"], "ok")
        self.assertIn("finished_at", attempts[0])

    def test_a_failed_attempt_keeps_its_own_error(self) -> None:
        run = flaky.run(3, journal=self.store)
        self.assertEqual(run.status, "failed")

        FAIL["on"] = False
        resumed = flaky.resume(run.id, journal=self.store)
        self.assertEqual(resumed.status, "ok")

        attempts = self._header(run.id)["attempts"]
        self.assertEqual([attempt["status"] for attempt in attempts], ["failed", "ok"])
        self.assertEqual(attempts[0]["error"]["kind"], "step")
        self.assertIn("not this time", attempts[0]["error"]["message"])
        self.assertNotIn("error", attempts[1])

    def test_a_suspended_attempt_closes_with_its_status(self) -> None:
        run = paused.run(3, journal=self.store)

        self.assertEqual(run.status, "suspended")
        attempts = self._header(run.id)["attempts"]
        self.assertEqual(attempts[0]["status"], "suspended")

    def test_the_sqlite_store_keeps_attempts(self) -> None:
        store = SqliteJournalStore(self.journal_dir / "runs.sqlite")
        run = flaky.run(3, journal=store)

        FAIL["on"] = False
        flaky.resume(run.id, journal=store)

        attempts = store.load(run.id, None).header["attempts"]
        self.assertEqual([attempt["status"] for attempt in attempts], ["failed", "ok"])
        self.assertEqual(attempts[1]["pid"], os.getpid())

    def test_show_lists_every_attempt(self) -> None:
        run = solid.run(3, journal=self.store)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = _main(["show", run.id, "--journal-dir", str(self.journal_dir)])

        self.assertEqual(code, 0)
        self.assertIn("attempts", out.getvalue())
        self.assertIn(f"pid {os.getpid()}", out.getvalue())


if __name__ == "__main__":
    unittest.main()
