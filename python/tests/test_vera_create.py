from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

import vera
from vera.agent import Agent
from vera.instance import Vera


class TestVeraCreate(unittest.TestCase):
    def test_two_creates_get_two_runtime_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            first = Vera.create(workspace=workspace)
            second = Vera.create(workspace=workspace)
            first_runtime = first._runtime_dir
            second_runtime = second._runtime_dir

            try:
                self.assertNotEqual(first_runtime, second_runtime)
                self.assertTrue(first_runtime.is_dir())
                self.assertTrue(second_runtime.is_dir())

                first.close()
                self.assertFalse(first_runtime.exists())
                self.assertTrue(second_runtime.is_dir())
            finally:
                first.close()
                second.close()

            self.assertFalse(second_runtime.exists())

    def test_create_does_not_set_process_env(self) -> None:
        before = {
            name: os.environ.get(name)
            for name in ("VERA_RUNTIME_DIR", "VERA_HOME")
        }
        with tempfile.TemporaryDirectory() as workspace:
            vera = Vera.create(workspace=workspace)
            runtime_dir = vera._runtime_dir
            try:
                self.assertEqual(
                    {
                        name: os.environ.get(name)
                        for name in ("VERA_RUNTIME_DIR", "VERA_HOME")
                    },
                    before,
                )
                self.assertNotEqual(runtime_dir, Path.home() / ".vera")
            finally:
                vera.close()

    def test_agent_rejects_defineagent_name(self) -> None:
        agent = Agent(
            name="reviewer",
            instructions="Review the change.",
            tools=["read", "grep"],
            posture="readonly",
        )

        self.assertEqual(agent.name, "reviewer")
        self.assertEqual(agent.tools, ["read", "grep"])
        self.assertFalse(hasattr(vera, "Agent"))
        self.assertFalse(hasattr(vera, "Vera"))
        with self.assertRaises(ImportError):
            exec("from vera.agent import defineAgent", {})

    def test_agent_validates_at_construction(self) -> None:
        with self.assertRaises(ValueError):
            Agent(name="Review Agent", instructions="Review the change.")
        with self.assertRaises(ValueError):
            Agent(name="reviewer", instructions="  ")
        with self.assertRaises(ValueError):
            Agent(name="reviewer", instructions="Review.", tools=[""])

    def test_workflow_still_imports(self) -> None:
        from vera.workflow.api import step, workflow

        self.assertTrue(callable(step))
        self.assertTrue(callable(workflow))


if __name__ == "__main__":
    unittest.main()
