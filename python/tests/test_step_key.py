from __future__ import annotations

import json
from pathlib import Path
import tempfile
import time
import unittest

from vera.workflow.api import Suspend, current, step, workflow


EXECUTED: list[str] = []
INSERT_EXTRA = False
SUSPEND = True


def develop(task: str) -> dict[str, str]:
    EXECUTED.append(f"develop:{task}")
    return {"worktree": f"/tmp/{task}"}


def extra() -> str:
    EXECUTED.append("extra")
    return "extra"


@step
def ordinal_develop(task: str) -> dict[str, str]:
    EXECUTED.append(f"ordinal:{task}")
    return {"worktree": f"/tmp/{task}"}


@workflow
def keyed_job(task: str) -> dict[str, str]:
    if INSERT_EXTRA:
        current.step("extra", extra, key="extra#1")
    result = current.step("develop", develop, task, key="develop#1")
    if SUSPEND:
        raise Suspend("stopping after develop")
    return result


@workflow
def ordinal_job(task: str) -> dict[str, str]:
    if INSERT_EXTRA:
        ordinal_develop("extra")
    result = ordinal_develop(task)
    if SUSPEND:
        raise Suspend("stopping after develop")
    return result


def journal_keys(directory: Path, run_id: str) -> list[str]:
    path = next(Path(directory).rglob("journal.ndjson"))
    lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return [line["key"] for line in lines if "key" in line]


class ExplicitKeyTests(unittest.TestCase):
    def setUp(self) -> None:
        global INSERT_EXTRA, SUSPEND
        EXECUTED.clear()
        INSERT_EXTRA = False
        SUSPEND = True
        self.directory = Path(tempfile.mkdtemp())

    def test_the_key_carries_no_ordinal(self) -> None:
        global SUSPEND
        SUSPEND = False

        run = keyed_job.run("hello", journal_dir=self.directory)

        self.assertEqual(run.status, "ok")
        key = journal_keys(self.directory, run.id)[0]
        self.assertTrue(key.startswith("keyed_job/develop#1:"), key)
        self.assertNotIn("#0:", key)

    def test_inserting_a_call_does_not_invalidate_a_keyed_record(self) -> None:
        global INSERT_EXTRA, SUSPEND

        first = keyed_job.run("hello", journal_dir=self.directory)
        self.assertEqual(first.status, "suspended")
        self.assertEqual(EXECUTED, ["develop:hello"])

        INSERT_EXTRA = True
        SUSPEND = False
        second = keyed_job.resume(first.id, journal_dir=self.directory)

        self.assertEqual(second.status, "ok")
        self.assertEqual(second.result, {"worktree": "/tmp/hello"})
        self.assertEqual(EXECUTED, ["develop:hello", "extra"])

    def test_the_positional_ordinal_invalidates_a_sibling_of_the_same_step(self) -> None:
        global INSERT_EXTRA, SUSPEND

        first = ordinal_job.run("hello", journal_dir=self.directory)
        self.assertEqual(first.status, "suspended")
        self.assertEqual(EXECUTED, ["ordinal:hello"])

        INSERT_EXTRA = True
        SUSPEND = False
        second = ordinal_job.resume(first.id, journal_dir=self.directory)

        self.assertEqual(second.status, "ok")
        self.assertEqual(EXECUTED, ["ordinal:hello", "ordinal:extra", "ordinal:hello"])

    def test_the_same_key_and_arguments_replay_within_one_run(self) -> None:
        global SUSPEND
        SUSPEND = False

        @workflow
        def twice(task: str) -> list[dict[str, str]]:
            return [
                current.step("develop", develop, task, key="develop#1"),
                current.step("develop", develop, task, key="develop#1"),
            ]

        run = twice.run("hello", journal_dir=self.directory)

        self.assertEqual(run.status, "ok")
        self.assertEqual(EXECUTED, ["develop:hello"])

    def test_changed_arguments_under_one_key_still_run(self) -> None:
        @workflow
        def changed() -> list[dict[str, str]]:
            return [
                current.step("develop", develop, "one", key="develop#1"),
                current.step("develop", develop, "two", key="develop#1"),
            ]

        run = changed.run(journal_dir=self.directory)

        self.assertEqual(run.status, "ok")
        self.assertEqual(EXECUTED, ["develop:one", "develop:two"])

    def test_a_keyed_step_accepts_a_timeout(self) -> None:
        def hangs() -> None:
            time.sleep(30)

        @workflow
        def hanging() -> None:
            current.step("hangs", hangs, key="hangs#1", timeout=0.05)

        run = hanging.run(journal_dir=self.directory)

        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error.kind, "timeout")

    def test_a_decorated_step_is_rejected(self) -> None:
        @workflow
        def wrong() -> None:
            current.step("ordinal_develop", ordinal_develop, "x", key="x#1")

        run = wrong.run(journal_dir=self.directory)

        self.assertEqual(run.status, "failed")
        self.assertIn("already has a key", run.error.message)

    def test_an_empty_key_is_rejected(self) -> None:
        @workflow
        def wrong() -> None:
            current.step("extra", extra, key="")

        run = wrong.run(journal_dir=self.directory)

        self.assertEqual(run.status, "failed")
        self.assertIn("non-empty key", run.error.message)

    def test_outside_a_workflow_it_is_a_plain_call(self) -> None:
        self.assertEqual(current.step("extra", extra, key="extra#1"), "extra")
        self.assertEqual(EXECUTED, ["extra"])


if __name__ == "__main__":
    unittest.main()
