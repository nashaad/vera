from __future__ import annotations

from pathlib import Path
import tempfile
import time
import unittest

from vera.workflow.api import StepTimeout, current, step, workflow


@step(timeout=0.05)
def hangs() -> str:
    time.sleep(30)
    return "never"


@step(timeout=10)
def reports_deadline() -> bool:
    return current.deadline is not None and current.deadline > time.monotonic()


@step
def untimed() -> bool:
    return current.deadline is None


@step(timeout=10)
def finishes(value: int) -> int:
    return value * 2


ATTEMPTS: list[str] = []


@step(timeout=0.05)
def hangs_once() -> str:
    ATTEMPTS.append("call")
    if len(ATTEMPTS) == 1:
        time.sleep(30)
    return "second attempt"


@workflow
def hanging() -> str:
    return hangs()


@workflow
def deadlines() -> dict[str, bool]:
    return {"timed": reports_deadline(), "untimed": untimed()}


@workflow
def doubling(value: int) -> int:
    return finishes(value)


@workflow
def retried() -> str:
    return hangs_once()


class TimeoutTests(unittest.TestCase):
    def journal(self) -> Path:
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: None)
        return directory

    def test_a_hung_step_fails_the_run_with_the_timeout_kind(self) -> None:
        run = hanging.run(journal_dir=self.journal())

        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error.kind, "timeout")
        self.assertIn("hangs exceeded 0.05s", run.error.message)

    def test_a_timed_step_that_finishes_behaves_like_any_other(self) -> None:
        run = doubling.run(4, journal_dir=self.journal())

        self.assertEqual(run.status, "ok")
        self.assertEqual(run.result, 8)

    def test_the_deadline_is_visible_only_inside_a_timed_step(self) -> None:
        run = deadlines.run(journal_dir=self.journal())

        self.assertEqual(run.status, "ok")
        self.assertEqual(run.result, {"timed": True, "untimed": True})

    def test_a_timed_out_step_is_not_journaled_so_resume_tries_again(self) -> None:
        directory = self.journal()
        ATTEMPTS.clear()

        first = retried.run(journal_dir=directory)
        self.assertEqual(first.status, "failed")
        self.assertEqual(first.error.kind, "timeout")

        second = retried.resume(first.id, journal_dir=directory)

        self.assertEqual(second.status, "ok")
        self.assertEqual(second.result, "second attempt")
        self.assertEqual(len(ATTEMPTS), 2)

    def test_the_bare_decorator_still_works(self) -> None:
        self.assertIsNone(untimed.timeout)
        self.assertEqual(finishes.timeout, 10)

    def test_a_non_positive_timeout_is_rejected(self) -> None:
        with self.assertRaises(ValueError):

            @step(timeout=0)
            def bad() -> None:
                return None

    def test_step_timeout_names_the_step_and_the_limit(self) -> None:
        error = StepTimeout("codex_exec", 600)

        self.assertEqual(error.step_name, "codex_exec")
        self.assertEqual(error.timeout, 600)
        self.assertEqual(str(error), "codex_exec exceeded 600s")


if __name__ == "__main__":
    unittest.main()
