from __future__ import annotations

import contextlib
import hashlib
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest

from vera.workflow.__main__ import _main
from vera.workflow._errors import WorkflowError
from vera.workflow._sql import SqliteJournalStore
from vera.workflow._store import FileJournalStore
from vera.workflow.api import ModelCall, model_call, step, workflow


BREAK = {"now": False}


@step
def ask(prompt: str) -> str:
    with model_call("claude-opus-5", provider="anthropic") as call:
        call.usage(
            input_tokens=1200,
            output_tokens=310,
            cached_input_tokens=800,
            cost=0.0123,
        )
    with model_call("claude-haiku-4-5") as call:
        call.usage(input_tokens=400, output_tokens=90, cost=0.0004)
    return prompt.upper()


@step
def refused(prompt: str) -> str:
    with model_call("claude-opus-5") as call:
        call.usage(input_tokens=90)
        raise RuntimeError("provider said no")


@step
def converse(prompt: str) -> str:
    with model_call("claude-opus-5") as call:
        call.input([{"role": "user", "content": prompt}])
        call.output("hi back")
    return "hi back"


@workflow
def talk(prompt: str) -> str:
    return converse(prompt)


@workflow
def chat(prompt: str) -> str:
    return ask(prompt)


@workflow
def doomed(prompt: str) -> str:
    return refused(prompt)


def _attributes(span: dict[str, object]) -> dict[str, object]:
    attributes = span["attributes"]
    assert type(attributes) is dict
    return attributes


class TestModelCalls(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.journal_dir = Path(self._dir.name)
        self.store = FileJournalStore(self.journal_dir)
        self.addCleanup(self._dir.cleanup)

    def _spans(self, run_id: str) -> list[dict[str, object]]:
        return self.store.load(run_id, None).spans()

    def test_a_model_call_is_a_span_under_its_step(self) -> None:
        run = chat.run("hello", journal=self.store)

        spans = self._spans(run.id)
        self.assertEqual(
            [span["name"] for span in spans],
            ["ask", "claude-opus-5", "claude-haiku-4-5"],
        )
        self.assertEqual(spans[1]["parent_id"], spans[0]["span_id"])
        self.assertEqual(spans[2]["parent_id"], spans[0]["span_id"])
        self.assertEqual(_attributes(spans[0])["openinference.span.kind"], "CHAIN")
        self.assertEqual(_attributes(spans[1])["openinference.span.kind"], "LLM")

    def test_a_model_call_records_what_it_used(self) -> None:
        run = chat.run("hello", journal=self.store)

        opus = _attributes(self._spans(run.id)[1])
        self.assertEqual(opus["llm.model_name"], "claude-opus-5")
        self.assertEqual(opus["llm.provider"], "anthropic")
        self.assertEqual(opus["llm.token_count.prompt"], 1200)
        self.assertEqual(opus["llm.token_count.completion"], 310)
        self.assertEqual(opus["llm.token_count.total"], 1510)
        self.assertEqual(opus["llm.token_count.prompt_details.cache_read"], 800)
        self.assertEqual(opus["llm.cost.total"], 0.0123)

    def test_a_call_with_no_provider_leaves_the_field_out(self) -> None:
        run = chat.run("hello", journal=self.store)

        self.assertNotIn("llm.provider", _attributes(self._spans(run.id)[2]))

    def test_a_model_call_carries_the_step_key_of_its_parent(self) -> None:
        run = chat.run("hello", journal=self.store)

        spans = self._spans(run.id)
        keys = {_attributes(span)["halcyon.step.key"] for span in spans}
        self.assertEqual(len(keys), 1)

    def test_a_failure_inside_the_call_still_settles_its_span(self) -> None:
        run = doomed.run("hello", journal=self.store)

        self.assertEqual(run.status, "failed")
        spans = self._spans(run.id)
        call = _attributes(spans[1])
        self.assertEqual(call["halcyon.outcome"], "failed")
        self.assertEqual(spans[1]["status_message"], "provider said no")
        self.assertEqual(call["llm.token_count.prompt"], 90)

    def test_a_retried_step_records_each_try_of_the_call(self) -> None:
        run = chat.run("hello", journal=self.store)
        chat.resume(run.id, journal=self.store)

        # The resume replays the recorded step, so it opens no further calls.
        spans = self._spans(run.id)
        self.assertEqual(len(spans), 3)

    def test_a_model_call_outside_a_step_records_nothing(self) -> None:
        with model_call("claude-opus-5") as call:
            call.usage(input_tokens=10, output_tokens=2)

        self.assertEqual(call.attributes["llm.token_count.total"], 12)

    def test_negative_counts_are_refused(self) -> None:
        with model_call("claude-opus-5") as call:
            with self.assertRaises(WorkflowError):
                call.usage(input_tokens=-1)
            with self.assertRaises(WorkflowError):
                call.usage(cost=-0.5)

    def test_the_sqlite_store_keeps_model_call_spans(self) -> None:
        store = SqliteJournalStore(self.journal_dir / "runs.sqlite")
        run = chat.run("hello", journal=store)

        spans = store.load(run.id, None).spans()

        self.assertEqual(spans[1]["parent_id"], spans[0]["span_id"])
        self.assertEqual(_attributes(spans[1])["llm.cost.total"], 0.0123)

    def test_show_prints_the_run_cost_and_its_calls(self) -> None:
        run = chat.run("hello", journal=self.store)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = _main(["show", run.id, "--journal-dir", str(self.journal_dir)])

        self.assertEqual(code, 0)
        self.assertIn("cost   $0.0127", out.getvalue())
        self.assertIn("claude-opus-5", out.getvalue())
        self.assertIn("1510 tokens", out.getvalue())

    def test_a_call_records_what_it_sent_and_got_back(self) -> None:
        run = talk.run("hello", journal=self.store)

        call = _attributes(self._spans(run.id)[1])
        self.assertEqual(
            call["input.value"], '[{"content":"hello","role":"user"}]'
        )
        self.assertEqual(call["input.mime_type"], "application/json")
        self.assertEqual(call["output.value"], "hi back")
        self.assertEqual(call["output.mime_type"], "text/plain")

    def test_a_large_prompt_goes_to_a_blob(self) -> None:
        prompt = "x" * 9000
        run = talk.run(prompt, journal=self.store)

        call = _attributes(self._spans(run.id)[1])
        self.assertNotIn("input.value", call)
        reference = call["halcyon.input.ref"]
        assert type(reference) is str
        blob = (self.journal_dir / run.id / "blobs" / reference).read_bytes()
        self.assertEqual(hashlib.sha256(blob).hexdigest(), reference)
        self.assertEqual(call["halcyon.input.bytes"], len(blob))
        self.assertIn(prompt, blob.decode("utf-8"))
        self.assertEqual(call["output.value"], "hi back")

    def test_the_sqlite_store_keeps_a_large_prompt_as_a_blob(self) -> None:
        path = self.journal_dir / "runs.sqlite"
        store = SqliteJournalStore(path)
        run = talk.run("y" * 9000, journal=store)

        call = _attributes(store.load(run.id, None).spans()[1])
        reference = call["halcyon.input.ref"]
        with contextlib.closing(sqlite3.connect(path)) as db:
            row = db.execute(
                "SELECT body FROM blobs WHERE digest = ?", (reference,)
            ).fetchone()
        self.assertEqual(hashlib.sha256(row[0]).hexdigest(), reference)

    def test_a_value_that_is_not_json_is_refused(self) -> None:
        call = ModelCall("claude-opus-5")
        with self.assertRaises(WorkflowError):
            call.input(object())


if __name__ == "__main__":
    unittest.main()
