from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from vera.workflow.api import WorkflowError, step, workflow


class TestBlobs(unittest.TestCase):
    def test_blob_spill_writes_ref_not_value(self) -> None:
        value = "x" * 9000

        @step
        def large_value() -> str:
            return value

        @workflow
        def produce() -> str:
            return large_value()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            first = produce.run(journal_dir=journal_dir)
            run_dir = journal_dir / first.id
            record = json.loads((run_dir / "journal.ndjson").read_text())

            self.assertEqual(first.result, value)
            self.assertNotIn("value", record)
            self.assertEqual(record["bytes"], 9002)
            reference = record["ref"]
            self.assertRegex(reference, r"\A[0-9a-f]{64}\Z")
            blob_path = run_dir / "blobs" / reference
            self.assertEqual(blob_path.read_text(), json.dumps(value))

            resumed = produce.resume(first.id, journal_dir=journal_dir)

            self.assertEqual(resumed.result, value)
            self.assertEqual(
                (run_dir / "journal.ndjson").read_text().splitlines(),
                [json.dumps(record, separators=(",", ":"))],
            )
            self.assertEqual(
                [path.name for path in (run_dir / "blobs").iterdir()],
                [reference],
            )

    def test_small_value_stays_inline(self) -> None:
        @step
        def small_value() -> str:
            return "ok"

        @workflow
        def produce() -> str:
            return small_value()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = produce.run(journal_dir=journal_dir)
            run_dir = journal_dir / run.id
            record = json.loads((run_dir / "journal.ndjson").read_text())

            self.assertEqual(record["value"], "ok")
            self.assertNotIn("ref", record)
            self.assertFalse((run_dir / "blobs").exists())

    def test_resume_rejects_blob_that_does_not_match_its_ref(self) -> None:
        @step
        def large_value() -> str:
            return "x" * 9000

        @workflow
        def produce() -> str:
            return large_value()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = produce.run(journal_dir=journal_dir)
            run_dir = journal_dir / run.id
            record = json.loads((run_dir / "journal.ndjson").read_text())
            blob_path = run_dir / "blobs" / record["ref"]
            blob_path.write_text(json.dumps("y" * 9000))

            with self.assertRaises(WorkflowError) as raised:
                produce.resume(run.id, journal_dir=journal_dir)

            self.assertEqual(raised.exception.kind, "journal")


if __name__ == "__main__":
    unittest.main()
