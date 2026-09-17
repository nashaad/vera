from __future__ import annotations

import os
from pathlib import Path
import tempfile
import json
import unittest
from unittest import mock

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
            first = Vera.create(workspace=str(first_workspace), _replay=True)
            second = Vera.create(workspace=str(second_workspace), _replay=True)
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
            vera = Vera.create(workspace=workspace, _replay=True)
            try:
                with self.assertRaisesRegex(
                    RuntimeError,
                    "No permission mode named missing-mode",
                ):
                    vera.run(invalid, "fail")

                self.assertEqual(vera.run(valid, "recovered"), "recovered")
            finally:
                vera.close()

    def test_live_run_reads_the_callers_vera_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            home = _home_with_config(root, provider="openrouter")
            agent = Agent(name="reader", instructions="Answer.", tools=[])
            with mock.patch.dict(
                os.environ,
                {"VERA_HOME": str(home), "OPENROUTER_API_KEY": ""},
            ):
                vera = Vera.create(workspace=str(root))
                try:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "No credentials for provider openrouter",
                    ):
                        vera.run(agent, "hello")
                finally:
                    vera.close()

    def test_agent_provider_overrides_the_home_route(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            home = _home_with_config(root, provider="openrouter")
            agent = Agent(
                name="reader",
                instructions="Answer.",
                tools=[],
                provider="deepseek",
                model="deepseek-chat",
            )
            with mock.patch.dict(
                os.environ,
                {"VERA_HOME": str(home), "DEEPSEEK_API_KEY": ""},
            ):
                vera = Vera.create(workspace=str(root))
                try:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "No credentials for provider deepseek",
                    ):
                        vera.run(agent, "hello")
                finally:
                    vera.close()

    def test_live_run_without_a_home_uses_the_agent_route(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            home = root / "missing"
            agent = Agent(
                name="reader",
                instructions="Answer.",
                tools=[],
                provider="openrouter",
                model="upstage/solar-pro4",
            )
            with mock.patch.dict(
                os.environ,
                {"VERA_HOME": str(home), "OPENROUTER_API_KEY": ""},
            ):
                vera = Vera.create(workspace=str(root))
                try:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "No credentials for provider openrouter",
                    ):
                        vera.run(agent, "hello")
                finally:
                    vera.close()
            self.assertFalse(home.exists())

    def test_live_run_without_a_home_needs_a_model(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            home = root / "missing"
            agent = Agent(name="reader", instructions="Answer.", tools=[])
            with mock.patch.dict(os.environ, {"VERA_HOME": str(home)}):
                vera = Vera.create(workspace=str(root))
                try:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "pass provider and model to the agent",
                    ):
                        vera.run(agent, "hello")
                finally:
                    vera.close()
            self.assertFalse(home.exists())


def _home_with_config(root: Path, *, provider: str) -> Path:
    home = root / "home"
    home.mkdir()
    (home / "config.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "provider": provider,
                "model": "upstage/solar-pro4",
                "approval_mode": "readonly",
            }
        )
    )
    return home


if __name__ == "__main__":
    unittest.main()
