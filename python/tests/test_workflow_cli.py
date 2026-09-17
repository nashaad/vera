from __future__ import annotations

import contextlib
import io
from pathlib import Path
import os
import tempfile
import unittest

from vera.workflow.__main__ import _main
from vera.workflow._store import FileJournalStore, default_journal_dir
from vera.workflow.api import step, workflow


@step
def double(n: int) -> int:
    return n * 2


@workflow
def doubling(n: int) -> int:
    return double(n)


class TestWorkflowCli(unittest.TestCase):
    def setUp(self) -> None:
        self._home = tempfile.TemporaryDirectory()
        self.home = Path(self._home.name)
        self.addCleanup(self._home.cleanup)
        previous = os.environ.get("VERA_HOME")
        os.environ["VERA_HOME"] = str(self.home)
        self.addCleanup(self._restore_home, previous)

    def _restore_home(self, previous: str | None) -> None:
        if previous is None:
            os.environ.pop("VERA_HOME", None)
            return
        os.environ["VERA_HOME"] = previous

    def _run(self, *arguments: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = _main(list(arguments))
        return code, out.getvalue(), err.getvalue()

    def test_a_run_without_a_journal_dir_lands_in_the_vera_home(self) -> None:
        run = doubling.run(3)

        self.assertEqual(run.result, 6)
        self.assertEqual(default_journal_dir(), self.home / "workflows")
        self.assertTrue((self.home / "workflows" / run.id).is_dir())

    def test_list_shows_runs_newest_first_and_show_names_one(self) -> None:
        first = doubling.run(1)
        second = doubling.run(2)

        code, out, _ = self._run("list")
        self.assertEqual(code, 0)
        self.assertLess(out.index(second.id), out.index(first.id))
        self.assertIn("ok", out)

        code, out, _ = self._run("show", first.id)
        self.assertEqual(code, 0)
        self.assertIn("doubling", out)

    def test_list_reads_a_named_directory_and_says_when_it_is_empty(self) -> None:
        elsewhere = self.home / "elsewhere"
        elsewhere.mkdir()
        run = doubling.run(4, journal=FileJournalStore(elsewhere))

        code, out, _ = self._run("list", "--journal-dir", str(elsewhere))
        self.assertEqual(code, 0)
        self.assertIn(run.id, out)

        code, out, _ = self._run("list")
        self.assertEqual(code, 0)
        self.assertIn("no workflow runs", out)

    def test_a_bad_command_prints_usage(self) -> None:
        code, _, err = self._run("bogus")

        self.assertEqual(code, 2)
        self.assertIn("usage: python -m vera.workflow", err)

    def test_show_names_a_run_that_does_not_exist(self) -> None:
        code, _, err = self._run("show", "wf_00000000000000ff")

        self.assertEqual(code, 2)
        self.assertIn("wf_00000000000000ff", err)


if __name__ == "__main__":
    unittest.main()
