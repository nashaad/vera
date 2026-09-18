from __future__ import annotations

import contextlib
import io
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

from vera.workflow.__main__ import _main, _serve_answer
from vera.workflow._errors import WorkflowError
from vera.workflow._sql import SqliteJournalStore
from vera.workflow._store import FileJournalStore
from vera.workflow.api import ask, step, workflow


DRAFTS: list[str] = []


@step
def draft(topic: str) -> str:
    DRAFTS.append(topic)
    return f"a draft about {topic}"


@workflow
def publish(topic: str) -> str:
    text = draft(topic)
    verdict = ask(f"Ship this?\n\n{text}")
    return f"{verdict}: {text}"


@workflow
def interview() -> str:
    name = ask("Name?")
    colour = ask("Colour?")
    return f"{name} likes {colour}"


@step
def sign_off(topic: str) -> str:
    return ask(f"Sign off on {topic}?")


@workflow
def gated(topic: str) -> str:
    return sign_off(topic)


@step(timeout=5)
def timed_sign_off(topic: str) -> str:
    return ask(f"Sign off on {topic}?")


@workflow
def timed_gate(topic: str) -> str:
    return timed_sign_off(topic)


class TestAsk(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.journal_dir = Path(self._dir.name)
        self.store = FileJournalStore(self.journal_dir)
        self.addCleanup(self._dir.cleanup)
        DRAFTS.clear()

    def test_ask_suspends_the_run_with_the_question(self) -> None:
        run = publish.run("otters", journal=self.store)

        self.assertEqual(run.status, "suspended")
        header = self.store.load(run.id, None).header
        asking = header["asking"]
        assert type(asking) is dict
        self.assertEqual(asking["key"], "ask#0")
        self.assertEqual(asking["question"], "Ship this?\n\na draft about otters")
        self.assertEqual(header["reason"], asking["question"])

    def test_an_answer_resumes_without_rerunning_earlier_steps(self) -> None:
        run = publish.run("otters", journal=self.store)
        self.store.load(run.id, None).put_inbox("ask#0", "yes")

        resumed = publish.resume(run.id, journal=self.store)

        self.assertEqual(resumed.status, "ok")
        self.assertEqual(resumed.result, "yes: a draft about otters")
        self.assertEqual(DRAFTS, ["otters"])
        self.assertNotIn("asking", self.store.load(run.id, None).header)

    def test_each_question_waits_for_its_own_answer(self) -> None:
        run = interview.run(journal=self.store)
        self.store.load(run.id, None).put_inbox("ask#0", "Ada")

        second = interview.resume(run.id, journal=self.store)

        self.assertEqual(second.status, "suspended")
        asking = self.store.load(run.id, None).header["asking"]
        assert type(asking) is dict
        self.assertEqual(asking["key"], "ask#1")
        self.store.load(run.id, None).put_inbox("ask#1", "green")
        done = interview.resume(run.id, journal=self.store)
        self.assertEqual(done.result, "Ada likes green")

    def test_a_question_inside_a_step_is_keyed_under_that_step(self) -> None:
        run = gated.run("otters", journal=self.store)

        asking = self.store.load(run.id, None).header["asking"]
        assert type(asking) is dict
        key = asking["key"]
        assert type(key) is str
        self.assertTrue(key.startswith("gated/sign_off#0:"))
        self.assertTrue(key.endswith("/ask#0"))
        self.store.load(run.id, None).put_inbox(key, "approved")
        done = gated.resume(run.id, journal=self.store)
        self.assertEqual(done.result, "approved")

    def test_a_step_with_a_timeout_can_ask(self) -> None:
        run = timed_gate.run("otters", journal=self.store)

        self.assertEqual(run.status, "suspended")
        asking = self.store.load(run.id, None).header["asking"]
        assert type(asking) is dict
        key = asking["key"]
        assert type(key) is str
        self.store.load(run.id, None).put_inbox(key, "fine")
        done = timed_gate.resume(run.id, journal=self.store)
        self.assertEqual(done.result, "fine")

    def test_ask_outside_a_workflow_is_refused(self) -> None:
        with self.assertRaises(WorkflowError):
            ask("anyone there?")

    def test_the_sqlite_store_keeps_the_question_and_answer(self) -> None:
        store = SqliteJournalStore(self.journal_dir / "runs.sqlite")
        run = publish.run("otters", journal=store)

        asking = store.load(run.id, None).header["asking"]
        assert type(asking) is dict
        self.assertEqual(asking["key"], "ask#0")
        store.load(run.id, None).put_inbox("ask#0", "yes")
        done = publish.resume(run.id, journal=store)
        self.assertEqual(done.result, "yes: a draft about otters")
        self.assertNotIn("asking", store.load(run.id, None).header)

    def test_cancelling_a_waiting_run_drops_the_question(self) -> None:
        run = publish.run("otters", journal=self.store)

        with contextlib.redirect_stdout(io.StringIO()):
            code = self._cli("cancel", run.id)

        self.assertEqual(code, 0)
        self.assertNotIn("asking", self.store.load(run.id, None).header)

    def test_answer_on_the_command_line_resumes_the_run(self) -> None:
        run = publish.run("otters", journal=self.store)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self._cli("answer", run.id, "ship it")

        self.assertEqual(code, 0)
        self.assertIn("answered", out.getvalue())
        self.assertEqual(self.store.load(run.id, None).header["status"], "ok")

    def test_show_prints_the_pending_question(self) -> None:
        run = publish.run("otters", journal=self.store)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self._cli("show", run.id)

        self.assertIn("asking Ship this?", out.getvalue())

    def test_answer_refuses_a_run_that_is_not_asking(self) -> None:
        run = interview.run(journal=self.store)
        self.store.load(run.id, None).put_inbox("ask#0", "Ada")
        self.store.load(run.id, None).put_inbox("ask#1", "green")
        interview.resume(run.id, journal=self.store)

        with contextlib.redirect_stderr(io.StringIO()):
            code = self._cli("answer", run.id, "again")

        self.assertEqual(code, 2)

    def _cli(self, *arguments: str) -> int:
        return _main([*arguments, "--journal-dir", str(self.journal_dir)])


class TestAnswerPage(unittest.TestCase):
    def test_the_page_takes_one_answer_and_stops(self) -> None:
        urls: list[str] = []
        answers: list[str] = []
        server = Thread(
            target=lambda: answers.append(
                _serve_answer("wf_0000000000000001", "Ship <this>?", urls.append)
            )
        )
        server.start()
        while not urls:
            server.join(0.01)
        url = urls[0]

        page = urlopen(url).read().decode("utf-8")
        self.assertIn("Ship &lt;this&gt;?", page)
        with self.assertRaises(HTTPError) as missing:
            urlopen(url.rsplit("/", 1)[0] + "/elsewhere")
        self.assertEqual(missing.exception.code, 404)

        body = urlencode({"answer": "  yes  "}).encode("utf-8")
        done = urlopen(url, data=body).read().decode("utf-8")
        server.join(5)

        self.assertIn("Answered", done)
        self.assertFalse(server.is_alive())
        self.assertEqual(answers, ["yes"])


if __name__ == "__main__":
    unittest.main()
