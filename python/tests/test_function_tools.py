from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import tempfile
from typing import Literal, Optional
import unittest

from vera.agent import Agent
from vera.instance import Vera
from vera.tools import Function, tool


class Deck(Enum):
    POOP = "poop"
    GUN = "gun"


def count_parrots(deck: str, include_chicks: bool = False) -> str:
    """Count the parrots on one deck.

    Chicks hide in the rigging.

    Args:
        deck (str): Which deck to search.
        include_chicks: Whether chicks count,
            even the loud ones.

    Returns:
        How many parrots were found.
    """
    return f"{deck}: {5 if include_chicks else 3} parrots"


def parrot_count_tool() -> Function:
    return tool(count_parrots)


class TestSchema(unittest.TestCase):
    def test_docstring_gives_description_and_argument_text(self) -> None:
        counted = tool(count_parrots)

        self.assertEqual(counted.name, "count_parrots")
        self.assertEqual(
            counted.description,
            "Count the parrots on one deck.\n\nChicks hide in the rigging.",
        )
        self.assertEqual(
            counted.parameters,
            {
                "type": "object",
                "properties": {
                    "deck": {"type": "string", "description": "(str) Which deck to search."},
                    "include_chicks": {
                        "type": "boolean",
                        "description": "Whether chicks count, even the loud ones.",
                    },
                },
                "required": ["deck"],
            },
        )

    def test_type_hints_map_to_json_schema(self) -> None:
        def stow(
            crates: int,
            weight: float,
            labels: list[str],
            manifest: dict[str, int],
            hold: Literal["fore", "aft"],
            deck: Deck,
            note: Optional[str] = None,
            anything=None,
            *extra: object,
            **more: object,
        ) -> None:
            return None

        properties = tool(stow).parameters["properties"]

        self.assertEqual(
            properties,
            {
                "crates": {"type": "integer"},
                "weight": {"type": "number"},
                "labels": {"type": "array", "items": {"type": "string"}},
                "manifest": {"type": "object", "additionalProperties": {"type": "integer"}},
                "hold": {"type": "string", "enum": ["fore", "aft"]},
                "deck": {"type": "string", "enum": ["poop", "gun"]},
                "note": {"type": "string"},
                "anything": {},
            },
        )
        self.assertEqual(
            tool(stow).parameters["required"],
            ["crates", "weight", "labels", "manifest", "hold", "deck"],
        )

    def test_overrides_and_the_function_stays_callable(self) -> None:
        counted = tool(count_parrots, name="parrots", description="Count parrots.")

        self.assertEqual(counted.name, "parrots")
        self.assertEqual(counted.description, "Count parrots.")
        self.assertEqual(counted("gun"), "gun: 3 parrots")
        self.assertIs(tool(counted), counted)

    def test_a_function_without_a_docstring_has_an_empty_description(self) -> None:
        def hoist(sail: str) -> str:
            return sail

        self.assertEqual(tool(hoist).description, "")

    def test_bad_functions_are_refused(self) -> None:
        async def sail() -> str:
            return "away"

        def CaptainLog() -> str:
            return ""

        def plank(victim: str, /) -> str:
            return victim

        with self.assertRaisesRegex(TypeError, "must not be async"):
            tool(sail)
        with self.assertRaisesRegex(ValueError, "lowercase snake_case"):
            tool(CaptainLog)
        with self.assertRaisesRegex(ValueError, "positional-only"):
            tool(plank)
        with self.assertRaisesRegex(ValueError, 'type "object"'):
            Function(name="plank", description="", parameters={}, entrypoint=plank)


class TestAgentTools(unittest.TestCase):
    def test_names_and_functions_mix(self) -> None:
        lookout = Agent(
            name="lookout",
            instructions="Count parrots.",
            tools=["read", count_parrots],
        )

        self.assertEqual(lookout.tools, ["read"])
        self.assertEqual([function.name for function in lookout.functions], ["count_parrots"])

    def test_duplicates_and_non_tools_are_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "two functions named count_parrots"):
            Agent(name="lookout", instructions="x", tools=[count_parrots, count_parrots])
        with self.assertRaisesRegex(TypeError, "not int"):
            Agent(name="lookout", instructions="x", tools=[3])  # type: ignore[list-item]


class TestFunctionCalls(unittest.TestCase):
    """The replay model turns "call <name> <json>" into one tool call, then echoes the result."""

    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.vera = Vera.create(workspace=self.workspace.name, _replay=True)

    def tearDown(self) -> None:
        self.vera.close()
        self.workspace.cleanup()

    def test_the_model_calls_a_python_function(self) -> None:
        seen: list[tuple[str, bool]] = []

        def count(deck: str, include_chicks: bool = False) -> str:
            seen.append((deck, include_chicks))
            return count_parrots(deck, include_chicks)

        lookout = Agent(name="lookout", instructions="Count parrots.", tools=[count])
        answer = self.vera.run(
            lookout, 'call count {"deck": "poop", "include_chicks": true}'
        )

        self.assertEqual(seen, [("poop", True)])
        self.assertEqual(answer, "poop: 5 parrots")

    def test_a_function_runs_under_ask(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            with Vera.create(workspace=workspace, posture="ask", _replay=True) as vera:
                lookout = Agent(name="lookout", instructions="x", tools=[count_parrots])
                answer = vera.run(lookout, 'call count_parrots {"deck": "gun"}')

        self.assertEqual(answer, "gun: 3 parrots")

    def test_a_non_string_result_becomes_json(self) -> None:
        @dataclass
        class Tally:
            deck: str
            parrots: int

        def tally(deck: str) -> Tally:
            return Tally(deck=deck, parrots=3)

        lookout = Agent(name="lookout", instructions="x", tools=[tally])
        answer = self.vera.run(lookout, 'call tally {"deck": "poop"}')

        self.assertEqual(answer, '{"deck": "poop", "parrots": 3}')

    def test_a_raising_function_gives_the_model_its_error(self) -> None:
        def sink(deck: str) -> str:
            raise ValueError(f"the {deck} deck is flooded")

        lookout = Agent(name="lookout", instructions="x", tools=[sink])
        answer = self.vera.run(lookout, 'call sink {"deck": "bilge"}')

        self.assertEqual(answer, "error: ValueError: the bilge deck is flooded")
        self.assertEqual(self.vera.run(lookout, "still afloat"), "still afloat")

    def test_a_function_calling_its_own_instance_is_refused(self) -> None:
        def ask_again(deck: str) -> str:
            return self.vera.run(Agent(name="crow", instructions="x", tools=[]), deck)

        lookout = Agent(name="lookout", instructions="x", tools=[ask_again])
        with self.assertRaisesRegex(RuntimeError, "create another Vera instance"):
            self.vera.run(lookout, 'call ask_again {"deck": "poop"}', timeout=10)
        self.assertEqual(self.vera.run(lookout, "try again"), "try again")

    def test_a_function_named_after_a_built_in_tool_fails_the_run(self) -> None:
        def read(path: str) -> str:
            return path

        lookout = Agent(name="lookout", instructions="x", tools=[read])
        with self.assertRaisesRegex(RuntimeError, "collides with a built-in tool"):
            self.vera.run(lookout, 'call read {"path": "map.txt"}')


if __name__ == "__main__":
    unittest.main()
