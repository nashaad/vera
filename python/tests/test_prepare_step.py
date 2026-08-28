from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

from vera.workflow._canonical import digest
from vera.workflow.api import CommandHook, Suspend, current, step, workflow


def _header(run_dir: Path) -> dict[str, object]:
    return json.loads((run_dir / "header.json").read_text(encoding="utf-8"))


def _journal_lines(run_dir: Path) -> list[str]:
    text = (run_dir / "journal.ndjson").read_text(encoding="utf-8")
    if text == "":
        return []
    return text.splitlines()


def _write_script(directory: Path, body: str) -> Path:
    path = directory / "hook.py"
    path.write_text(body, encoding="utf-8")
    return path


class TestPrepareStep(unittest.TestCase):
    def test_omitted_prepare_step_journals_once(self) -> None:
        hits = 0

        @step
        def bump() -> int:
            nonlocal hits
            hits += 1
            return hits

        @workflow
        def counter() -> int:
            return bump()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            first = counter.run(journal_dir=journal_dir)
            self.assertEqual(first.status, "ok")
            self.assertEqual(first.result, 1)
            run_dir = journal_dir / first.id
            self.assertEqual(len(_journal_lines(run_dir)), 1)
            self.assertEqual(_header(run_dir)["status"], "ok")

            resumed = counter.resume(first.id, journal_dir=journal_dir)
            self.assertEqual(resumed.status, "ok")
            self.assertEqual(resumed.result, 1)
            self.assertEqual(hits, 1)
            self.assertEqual(len(_journal_lines(run_dir)), 1)

    def test_journal_hit_skips_hook_on_resume(self) -> None:
        hook_hits = 0
        body_hits = 0

        def notify(payload: dict[str, object]) -> dict[str, object]:
            nonlocal hook_hits
            hook_hits += 1
            return {"power": "observe"}

        @step
        def bump() -> int:
            nonlocal body_hits
            body_hits += 1
            return 1

        @workflow
        def counter() -> int:
            return bump()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            first = counter.run(journal_dir=journal_dir, prepare_step=notify)
            self.assertEqual(first.status, "ok")
            self.assertEqual(hook_hits, 1)
            self.assertEqual(body_hits, 1)
            run_dir = journal_dir / first.id
            self.assertEqual(len(_journal_lines(run_dir)), 1)

            resumed = counter.resume(
                first.id,
                journal_dir=journal_dir,
                prepare_step=notify,
            )
            self.assertEqual(resumed.status, "ok")
            self.assertEqual(hook_hits, 1)
            self.assertEqual(body_hits, 1)
            self.assertEqual(len(_journal_lines(run_dir)), 1)

    def test_observe_runs_body_and_journals_one_line(self) -> None:
        seen: list[object] = []

        def notify(payload: dict[str, object]) -> dict[str, object]:
            seen.append(payload["type"])
            return {"power": "observe"}

        @step
        def add(n: int) -> int:
            return n + 1

        @workflow
        def total(n: int) -> int:
            return add(n)

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(3, journal_dir=journal_dir, prepare_step=notify)
            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, 4)
            self.assertEqual(seen, ["pre_step"])
            run_dir = journal_dir / run.id
            self.assertEqual(_header(run_dir)["status"], "ok")
            lines = _journal_lines(run_dir)
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["value"], 4)

    def test_mutate_changes_body_args_not_journal_key(self) -> None:
        seen: list[tuple[int, int]] = []

        def mutator(payload: dict[str, object]) -> dict[str, object]:
            return {"power": "mutate", "args": [10, 20]}

        @step
        def add(x: int, y: int) -> int:
            seen.append((x, y))
            return x + y

        @workflow
        def total() -> int:
            return add(2, 3)

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(journal_dir=journal_dir, prepare_step=mutator)
            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, 30)
            self.assertEqual(seen, [(10, 20)])
            run_dir = journal_dir / run.id
            lines = _journal_lines(run_dir)
            self.assertEqual(len(lines), 1)
            record = json.loads(lines[0])
            self.assertEqual(record["value"], 30)
            expected_key = f"total/add#0:{digest((2, 3), {})}"
            self.assertEqual(record["key"], expected_key)

    def test_in_place_payload_mutation_without_mutate_keeps_glue_args(self) -> None:
        seen: list[int] = []

        def messy(payload: dict[str, object]) -> dict[str, object]:
            args = payload["args"]
            if type(args) is list:
                args[0] = 99
            return {"power": "observe"}

        @step
        def echo(n: int) -> int:
            seen.append(n)
            return n

        @workflow
        def total() -> int:
            return echo(2)

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(journal_dir=journal_dir, prepare_step=messy)
            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, 2)
            self.assertEqual(seen, [2])
            run_dir = journal_dir / run.id
            lines = _journal_lines(run_dir)
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["value"], 2)

    def test_replace_skips_body_and_journals_hook_result(self) -> None:
        def replacer(payload: dict[str, object]) -> dict[str, object]:
            return {"power": "replace", "result": {"approved": True}}

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            side = journal_dir / "side.txt"

            @step
            def work() -> int:
                side.write_text("ran", encoding="utf-8")
                return 1

            @workflow
            def job() -> int:
                return work()

            run = job.run(journal_dir=journal_dir, prepare_step=replacer)
            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, {"approved": True})
            self.assertFalse(side.exists())
            run_dir = journal_dir / run.id
            self.assertEqual(_header(run_dir)["status"], "ok")
            lines = _journal_lines(run_dir)
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["value"], {"approved": True})

    def test_replace_null_skips_body_and_journals_null(self) -> None:
        def replacer(payload: dict[str, object]) -> dict[str, object]:
            return {"power": "replace", "result": None}

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            side = journal_dir / "side.txt"

            @step
            def work() -> int:
                side.write_text("ran", encoding="utf-8")
                return 1

            @workflow
            def job() -> int:
                return work()

            run = job.run(journal_dir=journal_dir, prepare_step=replacer)
            self.assertEqual(run.status, "ok")
            self.assertIsNone(run.result)
            self.assertFalse(side.exists())
            run_dir = journal_dir / run.id
            self.assertEqual(_header(run_dir)["status"], "ok")
            lines = _journal_lines(run_dir)
            self.assertEqual(len(lines), 1)
            self.assertIsNone(json.loads(lines[0])["value"])

    def test_block_fails_closed_and_resume_retries_hook(self) -> None:
        hook_hits = 0

        def blocker(payload: dict[str, object]) -> dict[str, object]:
            nonlocal hook_hits
            hook_hits += 1
            return {"power": "block", "reason": "not tonight"}

        @step
        def work() -> int:
            return 1

        @workflow
        def job() -> int:
            return work()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            first = job.run(journal_dir=journal_dir, prepare_step=blocker)
            self.assertEqual(first.status, "failed")
            self.assertIsNone(first.result)
            self.assertIsNotNone(first.error)
            self.assertEqual(first.error.kind, "hook")
            self.assertEqual(first.error.message, "not tonight")
            run_dir = journal_dir / first.id
            self.assertEqual(_header(run_dir)["status"], "failed")
            self.assertEqual(_header(run_dir)["error"], {
                "kind": "hook",
                "message": "not tonight",
            })
            self.assertEqual(_journal_lines(run_dir), [])
            self.assertEqual(hook_hits, 1)

            resumed = job.resume(
                first.id,
                journal_dir=journal_dir,
                prepare_step=blocker,
            )
            self.assertEqual(resumed.status, "failed")
            self.assertEqual(resumed.error.kind, "hook")
            self.assertEqual(hook_hits, 2)
            self.assertEqual(_journal_lines(run_dir), [])

    def test_hook_raise_is_kind_hook_and_skips_body(self) -> None:
        body_hits = 0

        def boom(payload: dict[str, object]) -> dict[str, object]:
            raise RuntimeError("nope")

        @step
        def work() -> int:
            nonlocal body_hits
            body_hits += 1
            return 1

        @workflow
        def job() -> int:
            return work()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = job.run(journal_dir=journal_dir, prepare_step=boom)
            self.assertEqual(run.status, "failed")
            self.assertIsNotNone(run.error)
            self.assertEqual(run.error.kind, "hook")
            self.assertEqual(body_hits, 0)
            run_dir = journal_dir / run.id
            self.assertEqual(_header(run_dir)["error"]["kind"], "hook")
            self.assertEqual(_journal_lines(run_dir), [])

    def test_unknown_power_is_kind_hook_and_skips_body(self) -> None:
        body_hits = 0

        def weird(payload: dict[str, object]) -> dict[str, object]:
            return {"power": "park"}

        @step
        def work() -> int:
            nonlocal body_hits
            body_hits += 1
            return 1

        @workflow
        def job() -> int:
            return work()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = job.run(journal_dir=journal_dir, prepare_step=weird)
            self.assertEqual(run.status, "failed")
            self.assertIsNotNone(run.error)
            self.assertEqual(run.error.kind, "hook")
            self.assertEqual(body_hits, 0)
            self.assertEqual(_journal_lines(journal_dir / run.id), [])

    def test_replace_non_json_result_is_kind_serialize(self) -> None:
        body_hits = 0

        def bad(payload: dict[str, object]) -> dict[str, object]:
            return {"power": "replace", "result": {1, 2}}

        @step
        def work() -> int:
            nonlocal body_hits
            body_hits += 1
            return 1

        @workflow
        def job() -> int:
            return work()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = job.run(journal_dir=journal_dir, prepare_step=bad)
            self.assertEqual(run.status, "failed")
            self.assertIsNotNone(run.error)
            self.assertEqual(run.error.kind, "serialize")
            self.assertEqual(body_hits, 0)
            run_dir = journal_dir / run.id
            self.assertEqual(_header(run_dir)["error"]["kind"], "serialize")
            self.assertEqual(_journal_lines(run_dir), [])

    def test_observe_then_suspend_resume_with_inbox_write(self) -> None:
        def notify(payload: dict[str, object]) -> dict[str, object]:
            return {"power": "observe"}

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            hits_path = journal_dir / "hits.txt"

            @step
            def approve() -> bool:
                if not current.run.inbox.get("approved"):
                    raise Suspend("waiting on sign-off")
                hits_path.write_text("x", encoding="utf-8")
                return True

            @workflow
            def approval() -> bool:
                return approve()

            first = approval.run(journal_dir=journal_dir, prepare_step=notify)
            self.assertEqual(first.status, "suspended")
            self.assertFalse(hits_path.exists())
            run_dir = journal_dir / first.id
            self.assertEqual(_header(run_dir)["status"], "suspended")
            self.assertEqual(_journal_lines(run_dir), [])

            header_path = run_dir / "header.json"
            header = json.loads(header_path.read_text(encoding="utf-8"))
            inbox = header["inbox"]
            self.assertIsInstance(inbox, dict)
            inbox["approved"] = True
            header_path.write_text(json.dumps(header), encoding="utf-8")

            resumed = approval.resume(
                first.id,
                journal_dir=journal_dir,
                prepare_step=notify,
            )
            self.assertEqual(resumed.status, "ok")
            self.assertIs(resumed.result, True)
            self.assertEqual(hits_path.read_text(encoding="utf-8"), "x")
            self.assertEqual(len(_journal_lines(run_dir)), 1)

    def test_hook_header_write_is_invisible_until_resume(self) -> None:
        payloads: list[object] = []

        def writer(payload: dict[str, object]) -> dict[str, object]:
            payloads.append(payload["inbox"])
            run_dir = Path(str(payload["journal_dir"])) / str(payload["run_id"])
            header_path = run_dir / "header.json"
            header = json.loads(header_path.read_text(encoding="utf-8"))
            inbox = header["inbox"]
            self.assertIsInstance(inbox, dict)
            inbox["approved"] = True
            header_path.write_text(json.dumps(header), encoding="utf-8")
            return {"power": "observe"}

        @step
        def approve() -> bool:
            if not current.run.inbox.get("approved"):
                raise Suspend("waiting on sign-off")
            return True

        @workflow
        def approval() -> bool:
            return approve()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            first = approval.run(journal_dir=journal_dir, prepare_step=writer)
            self.assertEqual(first.status, "suspended")
            self.assertEqual(payloads, [{}])
            run_dir = journal_dir / first.id
            self.assertEqual(_header(run_dir)["inbox"], {"approved": True})
            self.assertEqual(_journal_lines(run_dir), [])

            resumed = approval.resume(
                first.id,
                journal_dir=journal_dir,
                prepare_step=writer,
            )
            self.assertEqual(resumed.status, "ok")
            self.assertEqual(payloads, [{}, {"approved": True}])
            self.assertEqual(len(_journal_lines(run_dir)), 1)

    def test_nested_run_does_not_inherit_outer_prepare_step(self) -> None:
        seen: list[str] = []

        def notify(payload: dict[str, object]) -> dict[str, object]:
            seen.append(str(payload["step"]))
            return {"power": "observe"}

        @step
        def inner_step() -> int:
            return 1

        @workflow
        def inner() -> int:
            return inner_step()

        @step
        def outer_step() -> int:
            return 2

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            inner_dir = journal_dir / "inner"
            inner_dir.mkdir()

            @workflow
            def outer() -> int:
                outer_step()
                return inner.run(journal_dir=inner_dir).result or 0

            run = outer.run(journal_dir=journal_dir, prepare_step=notify)
            self.assertEqual(run.status, "ok")
            self.assertEqual(seen, ["outer_step"])
            self.assertEqual(len(_journal_lines(journal_dir / run.id)), 1)

    def test_chain_order_mutate_then_replace_skips_later_hook(self) -> None:
        log: list[object] = []
        body_hits = 0

        def first(payload: dict[str, object]) -> dict[str, object]:
            log.append("first")
            return {"power": "mutate", "args": [7]}

        def second(payload: dict[str, object]) -> dict[str, object]:
            log.append(("second", list(payload["args"])))
            return {"power": "replace", "result": 8}

        def third(payload: dict[str, object]) -> dict[str, object]:
            log.append("third")
            return {"power": "observe"}

        @step
        def echo(n: int) -> int:
            nonlocal body_hits
            body_hits += 1
            return n

        @workflow
        def total() -> int:
            return echo(1)

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(
                journal_dir=journal_dir,
                prepare_step=[first, second, third],
            )
            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, 8)
            self.assertEqual(body_hits, 0)
            self.assertEqual(log, ["first", ("second", [7])])
            run_dir = journal_dir / run.id
            lines = _journal_lines(run_dir)
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["value"], 8)

    def test_resume_refires_hook_on_miss(self) -> None:
        hook_hits = 0

        def notify(payload: dict[str, object]) -> dict[str, object]:
            nonlocal hook_hits
            hook_hits += 1
            return {"power": "observe"}

        @step
        def approve() -> bool:
            if not current.run.inbox.get("approved"):
                raise Suspend("waiting on sign-off")
            return True

        @workflow
        def approval() -> bool:
            return approve()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            first = approval.run(journal_dir=journal_dir, prepare_step=notify)
            self.assertEqual(first.status, "suspended")
            self.assertEqual(hook_hits, 1)
            self.assertEqual(_journal_lines(journal_dir / first.id), [])

            resumed = approval.resume(
                first.id,
                journal_dir=journal_dir,
                prepare_step=notify,
            )
            self.assertEqual(resumed.status, "suspended")
            self.assertEqual(hook_hits, 2)

    def test_command_hook_replace_via_subprocess(self) -> None:
        body_hits = 0

        @step
        def work() -> int:
            nonlocal body_hits
            body_hits += 1
            return 1

        @workflow
        def job() -> int:
            return work()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            script = _write_script(
                journal_dir,
                "import json, sys\n"
                "json.dump("
                '{"power": "replace", "result": 41}, '
                "sys.stdout)\n",
            )
            run = job.run(
                journal_dir=journal_dir,
                prepare_step=CommandHook([sys.executable, str(script)]),
            )
            self.assertEqual(run.status, "ok")
            self.assertEqual(run.result, 41)
            self.assertEqual(body_hits, 0)
            run_dir = journal_dir / run.id
            lines = _journal_lines(run_dir)
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["value"], 41)

    def test_command_hook_timeout_nonzero_empty_stdout_fail_closed(self) -> None:
        body_hits = 0

        @step
        def work() -> int:
            nonlocal body_hits
            body_hits += 1
            return 1

        @workflow
        def job() -> int:
            return work()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)

            timeout_script = _write_script(
                journal_dir,
                "import time\ntime.sleep(2)\nprint('{\"power\": \"observe\"}')\n",
            )
            timed_out = job.run(
                journal_dir=journal_dir,
                prepare_step=CommandHook(
                    [sys.executable, str(timeout_script)],
                    timeout_ms=100,
                ),
            )
            self.assertEqual(timed_out.status, "failed")
            self.assertIsNotNone(timed_out.error)
            self.assertEqual(timed_out.error.kind, "hook")
            self.assertEqual(body_hits, 0)
            self.assertEqual(_journal_lines(journal_dir / timed_out.id), [])

            exit_script = _write_script(
                journal_dir,
                "import sys\nsys.exit(3)\n",
            )
            exited = job.run(
                journal_dir=journal_dir,
                prepare_step=CommandHook([sys.executable, str(exit_script)]),
            )
            self.assertEqual(exited.status, "failed")
            self.assertEqual(exited.error.kind, "hook")
            self.assertEqual(body_hits, 0)
            self.assertEqual(_journal_lines(journal_dir / exited.id), [])

            empty_script = _write_script(journal_dir, "pass\n")
            empty = job.run(
                journal_dir=journal_dir,
                prepare_step=CommandHook([sys.executable, str(empty_script)]),
            )
            self.assertEqual(empty.status, "failed")
            self.assertEqual(empty.error.kind, "hook")
            self.assertEqual(body_hits, 0)
            self.assertEqual(_journal_lines(journal_dir / empty.id), [])

            invalid_script = _write_script(journal_dir, "print('not-json')\n")
            invalid = job.run(
                journal_dir=journal_dir,
                prepare_step=CommandHook([sys.executable, str(invalid_script)]),
            )
            self.assertEqual(invalid.status, "failed")
            self.assertEqual(invalid.error.kind, "hook")
            self.assertEqual(body_hits, 0)
            self.assertEqual(_journal_lines(journal_dir / invalid.id), [])

    def test_command_hook_empty_argv_refused_at_construct(self) -> None:
        with self.assertRaises(ValueError):
            CommandHook([])

    def test_command_hook_oversized_stdout_fails_closed(self) -> None:
        body_hits = 0

        @step
        def work() -> int:
            nonlocal body_hits
            body_hits += 1
            return 1

        @workflow
        def job() -> int:
            return work()

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            script = _write_script(
                journal_dir,
                "import sys\n"
                "while True:\n"
                "    sys.stdout.write('x' * 8192)\n"
                "    sys.stdout.flush()\n",
            )
            started = time.monotonic()
            run = job.run(
                journal_dir=journal_dir,
                prepare_step=CommandHook(
                    [sys.executable, str(script)],
                    timeout_ms=2000,
                ),
            )
            elapsed = time.monotonic() - started
            self.assertEqual(run.status, "failed")
            self.assertIsNotNone(run.error)
            self.assertEqual(run.error.kind, "hook")
            self.assertIn("byte bound", run.error.message)
            self.assertLess(elapsed, 1.5)
            self.assertEqual(body_hits, 0)
            self.assertEqual(_journal_lines(journal_dir / run.id), [])


if __name__ == "__main__":
    unittest.main()
