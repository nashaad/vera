from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from vera.workflow.__main__ import _main
from vera.workflow._sql import SqliteJournalStore
from vera.workflow._store import FileJournalStore
from vera.workflow.api import Suspend, step, workflow


FAIL = {"left": 0}


@step
def steady(n: int) -> int:
    return n * 2


@step
def shaky(n: int) -> int:
    if FAIL["left"] > 0:
        FAIL["left"] -= 1
        raise RuntimeError("not this time")
    return n


@step
def waiting(n: int) -> int:
    raise Suspend("waiting on sign-off")


@workflow
def solid(n: int) -> int:
    return steady(n) + steady(n + 1)


@workflow
def flaky(n: int) -> int:
    return shaky(n)


@workflow
def retried(n: int) -> int:
    return current_retry(n)


@step(retries=2)
def current_retry(n: int) -> int:
    if FAIL["left"] > 0:
        FAIL["left"] -= 1
        raise RuntimeError("not this time")
    return n


@workflow
def paused(n: int) -> int:
    return waiting(n)


class TestSpans(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.journal_dir = Path(self._dir.name)
        self.store = FileJournalStore(self.journal_dir)
        self.addCleanup(self._dir.cleanup)
        FAIL["left"] = 0

    def _spans(self, run_id: str) -> list[dict[str, object]]:
        return self.store.load(run_id, None).spans()

    def test_every_step_opens_and_closes_a_span(self) -> None:
        run = solid.run(3, journal=self.store)

        spans = self._spans(run.id)
        self.assertEqual([span["step"] for span in spans], ["steady", "steady"])
        for span in spans:
            self.assertEqual(span["status"], "ok")
            self.assertEqual(span["attempt"], 1)
            self.assertIn("start", span)
            self.assertIn("end", span)
            self.assertGreaterEqual(span["ms"], 0)

    def test_a_span_carries_the_journal_key_of_its_step(self) -> None:
        run = solid.run(3, journal=self.store)

        keys = [span["key"] for span in self._spans(run.id)]
        self.assertEqual(sorted(keys), sorted(self.store.load(run.id, None).records))

    def test_a_failed_try_is_a_span_the_journal_never_sees(self) -> None:
        FAIL["left"] = 2
        run = retried.run(3, journal=self.store)

        self.assertEqual(run.status, "ok")
        spans = self._spans(run.id)
        self.assertEqual(
            [span["status"] for span in spans], ["failed", "failed", "ok"]
        )
        self.assertIn("not this time", spans[0]["message"])
        self.assertEqual(len(self.store.load(run.id, None).records), 1)

    def test_a_suspended_step_closes_its_span_as_suspended(self) -> None:
        run = paused.run(3, journal=self.store)

        spans = self._spans(run.id)
        self.assertEqual([span["status"] for span in spans], ["suspended"])

    def test_a_resume_opens_spans_under_the_second_attempt(self) -> None:
        FAIL["left"] = 1
        run = flaky.run(3, journal=self.store)
        self.assertEqual(run.status, "failed")

        flaky.resume(run.id, journal=self.store)

        spans = self._spans(run.id)
        self.assertEqual([span["attempt"] for span in spans], [1, 2])
        self.assertEqual([span["status"] for span in spans], ["failed", "ok"])

    def test_a_crash_leaves_the_span_it_died_in_open(self) -> None:
        entry = Path(__file__).resolve().parent / "fixtures" / "crash_entry.py"
        subprocess.run(
            [sys.executable, str(entry), str(self.journal_dir)],
            env=os.environ
            | {
                "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
                "VERA_WF_CRASH": "1",
            },
            check=False,
            capture_output=True,
        )
        run_id = next(
            path.name
            for path in self.journal_dir.iterdir()
            if path.name.startswith("wf_")
        )

        spans = self._spans(run_id)

        self.assertEqual([span["step"] for span in spans], ["first", "second"])
        self.assertEqual(spans[0]["status"], "ok")
        self.assertNotIn("status", spans[1])
        self.assertNotIn("end", spans[1])

    def test_the_sqlite_store_keeps_spans(self) -> None:
        store = SqliteJournalStore(self.journal_dir / "runs.sqlite")
        FAIL["left"] = 1
        run = flaky.run(3, journal=store)
        flaky.resume(run.id, journal=store)

        spans = store.load(run.id, None).spans()

        self.assertEqual([span["attempt"] for span in spans], [1, 2])
        self.assertEqual([span["status"] for span in spans], ["failed", "ok"])
        self.assertIn("not this time", spans[0]["message"])

    def test_show_prints_spans_under_their_attempt(self) -> None:
        run = solid.run(3, journal=self.store)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = _main(["show", run.id, "--journal-dir", str(self.journal_dir)])

        self.assertEqual(code, 0)
        self.assertIn("steady", out.getvalue())
        self.assertIn("ok", out.getvalue())

    def test_a_span_line_is_json_per_line(self) -> None:
        run = solid.run(3, journal=self.store)

        path = self.journal_dir / run.id / "spans.ndjson"
        lines = [json.loads(line) for line in path.read_text().splitlines()]

        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[0]["span"], lines[1]["span"])
        self.assertIn("start", lines[0])
        self.assertIn("end", lines[1])


if __name__ == "__main__":
    unittest.main()
