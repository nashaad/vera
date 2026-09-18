from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import tempfile
import time
import unittest

from vera.workflow.__main__ import _main
from vera.workflow._store import FileJournalStore
from vera.workflow.api import step, workflow


SEEN: list[dict[str, object]] = []


@step
def quick(n: int) -> int:
    return n * 2


@step
def slow(n: int) -> int:
    time.sleep(0.05)
    return n


@step
def peek(journal_dir: str) -> str:
    """Read the header off disk mid-step, the way another process would."""
    run_dir = next(iter(sorted(Path(journal_dir).glob("wf_*"))))
    SEEN.append(json.loads((run_dir / "header.json").read_text(encoding="utf-8")))
    return "read"


@workflow
def timed(n: int) -> int:
    return quick(n) + slow(n)


@workflow
def watched(journal_dir: str) -> str:
    return peek(journal_dir)


class TestTiming(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.journal_dir = Path(self._dir.name)
        self.store = FileJournalStore(self.journal_dir)
        self.addCleanup(self._dir.cleanup)
        SEEN.clear()

    def _records(self, run_id: str) -> list[dict[str, object]]:
        path = self.journal_dir / run_id / "journal.ndjson"
        lines = path.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines]

    def _run_cli(self, *arguments: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = _main(list(arguments))
        return code, out.getvalue()

    def test_every_record_carries_a_timestamp_and_a_duration(self) -> None:
        run = timed.run(3, journal=self.store)

        records = self._records(run.id)
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertIsInstance(record["at"], str)
            self.assertIn("T", record["at"])
            self.assertIsInstance(record["ms"], int)
            self.assertGreaterEqual(record["ms"], 0)
        self.assertGreaterEqual(records[1]["ms"], 40)

    def test_a_replayed_step_is_timed_again_on_the_resumed_run(self) -> None:
        run = timed.run(3, journal=self.store)

        journal = self.store.load(run.id, None)
        self.assertEqual(set(journal.timings), set(journal.records))

    def test_the_header_names_the_step_in_flight(self) -> None:
        run = watched.run(str(self.journal_dir), journal=self.store)

        self.assertEqual(run.result, "read")
        self.assertEqual(len(SEEN), 1)
        self.assertEqual(SEEN[0]["active"]["step"], "peek")
        self.assertIn("peek", SEEN[0]["active"]["key"])
        finished = json.loads(
            (self.journal_dir / run.id / "header.json").read_text(encoding="utf-8")
        )
        self.assertNotIn("active", finished)

    def test_the_header_keeps_a_cancel_asked_for_while_a_step_runs(self) -> None:
        run = timed.run(3, journal=self.store)
        journal = self.store.load(run.id, None)

        other = self.store.load(run.id, None)
        other.request_cancel("from another process")
        journal.mark_step_started("timed/slow#0:abcd1234", "slow")

        stored = json.loads(
            (self.journal_dir / run.id / "header.json").read_text(encoding="utf-8")
        )
        self.assertEqual(stored["cancel_requested"], "from another process")
        self.assertEqual(stored["active"]["step"], "slow")

    def test_show_prints_step_durations_and_the_step_in_flight(self) -> None:
        run = timed.run(3, journal=self.store)
        journal = self.store.load(run.id, None)
        journal.mark_step_started("timed/slow#0:abcd1234", "slow")

        code, out = self._run_cli("show", run.id, "--journal-dir", str(self.journal_dir))

        self.assertEqual(code, 0)
        self.assertIn("ms", out)
        self.assertIn("active slow", out)


if __name__ == "__main__":
    unittest.main()
