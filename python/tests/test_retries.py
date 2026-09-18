from __future__ import annotations

from pathlib import Path
import tempfile
import threading
import time
import unittest

from vera.workflow.api import current, step, workflow


ATTEMPTS: list[str] = []
WAITS: list[float] = []


@step(retries=2)
def flaky() -> str:
    ATTEMPTS.append("flaky")
    if len(ATTEMPTS) < 3:
        raise RuntimeError("not yet")
    return "third time"


@step(retries=1)
def always_fails() -> str:
    ATTEMPTS.append("always")
    raise RuntimeError("no")


@step(retries=5, timeout=0.05)
def hangs() -> str:
    ATTEMPTS.append("hangs")
    time.sleep(30)
    return "never"


@step(retries=2, backoff=0.02)
def waits() -> str:
    WAITS.append(time.monotonic())
    raise RuntimeError("again")


@step(retries=9, backoff=5.0)
def cancels_itself() -> str:
    ATTEMPTS.append("cancel")
    CANCEL.set()
    raise RuntimeError("first failure")


@step
def after() -> str:
    ATTEMPTS.append("after")
    return "after"


CANCEL = threading.Event()


@workflow
def eventually() -> str:
    return flaky()


@workflow
def never() -> str:
    return always_fails()


@workflow
def hanging() -> str:
    return hangs()


@workflow
def backing_off() -> str:
    return waits()


@workflow
def cancelled_mid_budget() -> str:
    return cancels_itself()


class RetryTests(unittest.TestCase):
    def setUp(self) -> None:
        ATTEMPTS.clear()
        WAITS.clear()
        CANCEL.clear()

    def journal(self) -> Path:
        return Path(tempfile.mkdtemp())

    def test_a_flaky_step_succeeds_within_its_budget(self) -> None:
        run = eventually.run(journal_dir=self.journal())

        self.assertEqual(run.status, "ok")
        self.assertEqual(run.result, "third time")
        self.assertEqual(len(ATTEMPTS), 3)

    def test_only_the_last_attempt_is_journaled(self) -> None:
        directory = self.journal()
        run = eventually.run(journal_dir=directory)

        lines = (directory / run.id / "journal.ndjson").read_text().splitlines()
        self.assertEqual(len(lines), 1)

    def test_an_exhausted_budget_fails_the_run_with_the_last_error(self) -> None:
        run = never.run(journal_dir=self.journal())

        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error.kind, "step")
        self.assertEqual(run.error.message, "no")
        self.assertEqual(len(ATTEMPTS), 2)

    def test_a_timeout_is_not_retried(self) -> None:
        run = hanging.run(journal_dir=self.journal())

        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error.kind, "timeout")
        self.assertEqual(len(ATTEMPTS), 1)

    def test_backoff_waits_longer_before_each_attempt(self) -> None:
        backing_off.run(journal_dir=self.journal())

        self.assertEqual(len(WAITS), 3)
        first = WAITS[1] - WAITS[0]
        second = WAITS[2] - WAITS[1]
        self.assertGreaterEqual(first, 0.02)
        self.assertGreater(second, first)

    def test_a_cancel_cuts_the_wait_short(self) -> None:
        started = time.monotonic()
        run = cancelled_mid_budget.run(journal_dir=self.journal(), cancel=CANCEL)

        self.assertEqual(run.status, "cancelled")
        self.assertEqual(len(ATTEMPTS), 1)
        self.assertLess(time.monotonic() - started, 5.0)

    def test_a_budget_is_validated_at_decoration(self) -> None:
        with self.assertRaises(ValueError):
            step(retries=-1)(after)
        with self.assertRaises(ValueError):
            step(retries=True)(after)
        with self.assertRaises(ValueError):
            step(backoff=-1.0)(after)

    def test_current_step_takes_a_budget_too(self) -> None:
        calls: list[str] = []

        def body() -> str:
            calls.append("body")
            if len(calls) < 2:
                raise RuntimeError("once")
            return "keyed"

        @workflow
        def keyed() -> str:
            return current.step("body", body, key="only", retries=1)

        run = keyed.run(journal_dir=self.journal())

        self.assertEqual(run.status, "ok")
        self.assertEqual(run.result, "keyed")
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
