from __future__ import annotations

import tempfile
from typing import Any
import unittest

from vera.agent import Agent
from vera.instance import Vera


# The replay child answers with the latest user message, so a stored context
# becomes the reply. That is how these tests see what reached the model.
crow = Agent(name="crow", instructions="Echo the latest message.", tools=[])


class TestTurnHooks(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.vera = Vera.create(workspace=self.workspace.name, _replay=True)

    def tearDown(self) -> None:
        self.vera.close()
        self.workspace.cleanup()

    def test_prepare_turn_sees_snake_case_and_adds_context(self) -> None:
        seen: list[dict[str, Any]] = []

        def spot(turn: dict[str, Any]) -> dict[str, object]:
            seen.append(turn)
            return {"power": "mutate", "context": "under the third palm"}

        answer = self.vera.run(crow, "find the treasure", prepare_turn=spot)

        self.assertEqual(answer, "under the third palm")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["type"], "pre_turn")
        self.assertEqual(seen[0]["prompt"], "find the treasure")
        self.assertEqual(seen[0]["tools"], [])
        self.assertIs(seen[0]["arrived_during_turn"], False)
        self.assertEqual(seen[0]["reasoning_effort"], "high")
        self.assertNotIn("arrivedDuringTurn", seen[0])

    def test_before_turn_ends_continues_once(self) -> None:
        seen: list[dict[str, Any]] = []

        def lookout(turn: dict[str, Any]) -> dict[str, object]:
            seen.append(turn)
            return {"power": "continue", "context": "draw the map", "display": "No map yet"}

        answer = self.vera.run(crow, "find the treasure", before_turn_ends=lookout)

        self.assertEqual(answer, "draw the map")
        self.assertEqual([turn["continuations"] for turn in seen], [0, 1])
        self.assertEqual([turn["reply"] for turn in seen], ["find the treasure", "draw the map"])
        self.assertIs(seen[0]["spawned"], False)

    def test_none_observes(self) -> None:
        calls: list[str] = []

        def watch(turn: dict[str, Any]) -> None:
            calls.append(str(turn["type"]))
            return None

        answer = self.vera.run(
            crow, "find the treasure", prepare_turn=watch, before_turn_ends=watch
        )

        self.assertEqual(answer, "find the treasure")
        self.assertEqual(calls, ["pre_turn", "turn_ending"])

    def test_block_fails_the_run_with_the_reason(self) -> None:
        def stop(turn: dict[str, Any]) -> dict[str, object]:
            return {"power": "block", "reason": "the parrot is asleep"}

        with self.assertRaisesRegex(RuntimeError, "the parrot is asleep"):
            self.vera.run(crow, "find the treasure", prepare_turn=stop)

    def test_prepare_turn_that_raises_fails_closed(self) -> None:
        def broken(turn: dict[str, Any]) -> dict[str, object]:
            raise ValueError("compass spun")

        with self.assertRaisesRegex(RuntimeError, "ValueError: compass spun"):
            self.vera.run(crow, "find the treasure", prepare_turn=broken)

    def test_before_turn_ends_that_raises_keeps_the_reply(self) -> None:
        def broken(turn: dict[str, Any]) -> dict[str, object]:
            raise ValueError("compass spun")

        answer = self.vera.run(crow, "find the treasure", before_turn_ends=broken)

        self.assertEqual(answer, "find the treasure")

    def test_a_bad_result_fails_closed(self) -> None:
        cases: list[object] = [
            {"power": "mutate", "contxt": "typo"},
            "continue",
            {"power": "mutate", "context": {1, 2}},
        ]
        for result in cases:
            with self.subTest(result=result):
                with self.assertRaises(RuntimeError):
                    self.vera.run(crow, "find the treasure", prepare_turn=lambda _: result)  # type: ignore[arg-type,return-value]  # wrong on purpose

    def test_the_child_survives_a_failed_hook(self) -> None:
        def broken(turn: dict[str, Any]) -> dict[str, object]:
            raise ValueError("compass spun")

        with self.assertRaises(RuntimeError):
            self.vera.run(crow, "find the treasure", prepare_turn=broken)
        self.assertEqual(self.vera.run(crow, "try again"), "try again")

    def test_hooks_must_be_callable(self) -> None:
        with self.assertRaises(TypeError):
            self.vera.run(crow, "find the treasure", prepare_turn="spot")  # type: ignore[arg-type]  # wrong on purpose
        with self.assertRaises(TypeError):
            self.vera.run(crow, "find the treasure", before_turn_ends=3)  # type: ignore[arg-type]  # wrong on purpose


if __name__ == "__main__":
    unittest.main()
