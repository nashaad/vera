from __future__ import annotations

import re
from typing import Callable

from .tools import Function, tool


_AGENT_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_MAX_AGENT_CHARACTERS = 256 * 1024


class Agent:
    def __init__(
        self,
        *,
        name: str,
        instructions: str,
        tools: list[str | Function | Callable[..., object]] | None = None,
        posture: str | None = None,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        if _AGENT_NAME.fullmatch(name) is None:
            raise ValueError(
                "Agent name must use lowercase letters, numbers, and single hyphens"
            )

        normalized_instructions = instructions.strip()
        if not normalized_instructions:
            raise ValueError("Agent instructions must not be empty")
        if len(normalized_instructions) > _MAX_AGENT_CHARACTERS:
            raise ValueError(
                f"Agent {name} exceeds the {_MAX_AGENT_CHARACTERS}-character limit"
            )

        # Strings name Vera's built-in tools; callables are this process's functions.
        normalized_tools: list[str] | None = None
        functions: list[Function] = []
        if tools is not None:
            normalized_tools = []
            for entry in tools:
                if isinstance(entry, str):
                    if not entry.strip():
                        raise ValueError("Agent tool names must not be empty")
                    normalized_tools.append(entry.strip())
                elif callable(entry):
                    functions.append(tool(entry))
                else:
                    raise TypeError(
                        "Agent tools must be built-in tool names or functions, "
                        f"not {type(entry).__name__}"
                    )
            function_names = [function.name for function in functions]
            for function_name in function_names:
                if function_names.count(function_name) > 1:
                    raise ValueError(f"Agent {name} has two functions named {function_name}")

        normalized_posture: str | None = None
        if posture is not None:
            if not isinstance(posture, str) or not posture.strip():
                raise ValueError("Agent posture must be a non-empty name")
            normalized_posture = posture.strip()

        self.provider = _optional_name(provider, "provider")
        self.model = _optional_name(model, "model")
        self.name = name
        self.instructions = normalized_instructions
        self.tools = normalized_tools
        self.functions = tuple(functions)
        self.posture = normalized_posture


def _optional_name(value: str | None, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Agent {field} must be a non-empty string")
    return value.strip()
