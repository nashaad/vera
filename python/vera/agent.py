from __future__ import annotations

import re


_AGENT_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_MAX_AGENT_CHARACTERS = 256 * 1024


class Agent:
    def __init__(
        self,
        *,
        name: str,
        instructions: str,
        tools: list[str] | None = None,
        posture: str | None = None,
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

        normalized_tools: list[str] | None = None
        if tools is not None:
            if any(not isinstance(tool, str) or not tool.strip() for tool in tools):
                raise ValueError("Agent tools must be a list of non-empty names")
            normalized_tools = [tool.strip() for tool in tools]

        normalized_posture: str | None = None
        if posture is not None:
            if not isinstance(posture, str) or not posture.strip():
                raise ValueError("Agent posture must be a non-empty name")
            normalized_posture = posture.strip()

        self.name = name
        self.instructions = normalized_instructions
        self.tools = normalized_tools
        self.posture = normalized_posture
