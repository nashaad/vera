from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from vera.agent import Agent
from vera.instance import Vera


class TestVeraRun(unittest.TestCase):
    def test_two_instances_run_in_two_bun_children(self) -> None:
        before = {
            name: os.environ.get(name)
            for name in ("VERA_RUNTIME_DIR", "VERA_HOME")
        }
        agent = Agent(
            name="reviewer",
            instructions="Return the recorded reply.",
            tools=[],
            posture="readonly",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            first_workspace = root / "first"
            second_workspace = root / "second"
            first_workspace.mkdir()
            second_workspace.mkdir()
            first = Vera.create(workspace=str(first_workspace))
            second = Vera.create(workspace=str(second_workspace))
            first_runtime = first._runtime_dir
            second_runtime = second._runtime_dir
            try:
                self.assertEqual(first.run(agent, "first child"), "first child")
                self.assertEqual(second.run(agent, "second child"), "second child")
                self.assertNotEqual(first_runtime, second_runtime)
                self.assertTrue(first_runtime.is_dir())
                self.assertTrue(second_runtime.is_dir())
                live_home = Path.home() / ".vera"
                self.assertNotIn(live_home, first_runtime.parents)
                self.assertNotIn(live_home, second_runtime.parents)
                self.assertEqual(
                    {
                        name: os.environ.get(name)
                        for name in ("VERA_RUNTIME_DIR", "VERA_HOME")
                    },
                    before,
                )
            finally:
                first.close()
                second.close()

    def test_child_failure_is_non_empty_and_instance_can_run_again(self) -> None:
        invalid = Agent(
            name="invalid-posture",
            instructions="Fail before the recorded model runs.",
            posture="missing-mode",
        )
        valid = Agent(
            name="valid-posture",
            instructions="Return the recorded reply.",
            posture="readonly",
        )
        with tempfile.TemporaryDirectory() as workspace:
            vera = Vera.create(workspace=workspace)
            try:
                with self.assertRaisesRegex(
                    RuntimeError,
                    "No permission mode named missing-mode",
                ):
                    vera.run(invalid, "fail")

                self.assertEqual(vera.run(valid, "recovered"), "recovered")
            finally:
                vera.close()


if __name__ == "__main__":
    unittest.main()
