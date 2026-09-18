from __future__ import annotations

from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples" / "workflows"


class TestExampleWorkflows(unittest.TestCase):
    def setUp(self) -> None:
        self._home = tempfile.TemporaryDirectory()
        self.home = Path(self._home.name)
        self.env = os.environ | {
            "PYTHONPATH": str(ROOT / "python"),
            "VERA_HOME": str(self.home),
        }
        self.env.pop("OPENROUTER_API_KEY", None)
        self.env.pop("STOP_AFTER", None)

    def tearDown(self) -> None:
        self._home.cleanup()

    def test_trip_stops_resumes_and_plans_the_pick(self) -> None:
        stopped = self._run(
            3, "trip.workflow.py", "--offline", "four days in May", stop_after=2
        )
        run_id = self._run_id(stopped.stderr)
        resumed = self._run(1, "-m", "vera.workflow", "resume", run_id, script=False)
        self.assertIn("Which one", resumed.stderr)
        answered = self._run(
            0, "-m", "vera.workflow", "answer", run_id, "Lisbon", script=False
        )
        self.assertIn(f"{run_id} ok", answered.stdout)
        self.assertIn("Lisbon", answered.stdout)
        self._assert_each_step_finished_once(run_id)

    def test_dinner_stops_resumes_and_writes_the_list(self) -> None:
        stopped = self._run(
            3,
            "dinner.workflow.py",
            "--offline",
            "Ana: peanuts; Ben: gluten; Chloe",
            stop_after=2,
        )
        run_id = self._run_id(stopped.stderr)
        resumed = self._run(1, "-m", "vera.workflow", "resume", run_id, script=False)
        self.assertIn("OK to shop", resumed.stderr)
        answered = self._run(0, "-m", "vera.workflow", "answer", run_id, "ok", script=False)
        self.assertIn(f"{run_id} ok", answered.stdout)
        self.assertIn("Produce:", answered.stdout)
        self._assert_each_step_finished_once(run_id)

    def test_survey_stops_while_tagging_and_resumes_the_rest(self) -> None:
        first = self._run(
            0, "survey.workflow.py", "--offline", str(EXAMPLES / "data" / "survey.txt")
        )
        self.assertIn("is waiting for you to check the themes", first.stdout)
        run_id = first.stdout.split()[0]
        self._run(
            3, "-m", "vera.workflow", "answer", run_id, "ok",
            script=False, stop_after=2,
        )
        resumed = self._run(0, "-m", "vera.workflow", "resume", run_id, script=False)
        self.assertIn("24 answers", resumed.stdout)
        counts = [int(count) for count in re.findall(r": (\d+)$", resumed.stdout, re.M)]
        self.assertEqual(sum(counts), 24)
        self._assert_each_step_finished_once(run_id)

    def test_live_runs_need_a_key(self) -> None:
        for name, argument in (
            ("trip.workflow.py", "a weekend"),
            ("dinner.workflow.py", "Ana"),
            ("survey.workflow.py", str(EXAMPLES / "data" / "survey.txt")),
        ):
            with self.subTest(name):
                completed = self._run(2, name, argument)
                self.assertIn("OPENROUTER_API_KEY", completed.stderr)

    def _assert_each_step_finished_once(self, run_id: str) -> None:
        # A step that finished before the stop must not run again after it.
        run_dir = self.home / "workflows" / run_id
        header = json.loads((run_dir / "header.json").read_text("utf-8"))
        self.assertEqual(header["status"], "ok")
        ended: dict[str, dict[str, object]] = {}
        started: dict[str, dict[str, object]] = {}
        for line in (run_dir / "spans.ndjson").read_text("utf-8").splitlines():
            span = json.loads(line)
            target = started if "start_time" in span else ended
            target[span["span_id"]] = span["attributes"]
        finished = Counter(
            attributes["halcyon.step.key"]
            for span_id, attributes in started.items()
            if attributes["openinference.span.kind"] == "CHAIN"
            and ended.get(span_id, {}).get("halcyon.outcome") == "ok"
        )
        self.assertTrue(finished)
        self.assertEqual(set(finished.values()), {1}, finished)

    def _run_id(self, text: str) -> str:
        found = re.search(r"wf_[0-9a-f]{16}", text)
        assert found is not None, text
        return found.group(0)

    def _run(
        self,
        code: int,
        *arguments: str,
        script: bool = True,
        stop_after: int | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = dict(self.env)
        if stop_after is not None:
            env["STOP_AFTER"] = str(stop_after)
        command = [str(EXAMPLES / arguments[0]), *arguments[1:]] if script else list(arguments)
        completed = subprocess.run(
            [sys.executable, *command],
            env=env, cwd=ROOT, check=False, capture_output=True, text=True,
        )
        self.assertEqual(completed.returncode, code, completed.stdout + completed.stderr)
        return completed


if __name__ == "__main__":
    unittest.main()
