import { expect, test } from "bun:test";

import {
    assembleContextualSystemPrompt,
    assembleStableSystemPrompt,
    assembleSystemPrompt,
} from "../../src/engine/assemble.ts";
import type { ModelTool } from "../../src/model/types.ts";

test("system prompt sections are assembled from current inputs", () => {
    const tools: readonly ModelTool[] = [
        {
            name: "inspect",
            description: "Inspect the current state.",
            inputSchema: { type: "object" },
        },
        {
            name: "change",
            description: "Change the current state.",
            inputSchema: { type: "object" },
        },
    ];

    expect(assembleSystemPrompt({
        tools,
        workspace: "/work/vera",
        date: new Date(2026, 6, 17),
    })).toBe([
        "## Identity",
        "You are Vera, a coding agent. Follow the user's instructions and use the available tools when they help.",
        "",
        "## Narration",
        "Say what you are doing as you go. Before your first tool call, state in one sentence what you are about to do. While working, post a short update when you find something, change direction, or hit a blocker. Write these as ordinary response text. Reasoning may be hidden from the user, so it is not a substitute for telling them what is happening.",
        "",
        "## Tools",
        "Available tools:",
        "- inspect: Inspect the current state.",
        "- change: Change the current state.",
        "",
        "## Workspace",
        "Working directory: /work/vera",
        "",
        "## Date",
        "Current date: 2026-07-17",
    ].join("\n"));
});

test("stable and contextual prompt parts combine without changing output", () => {
    const tools: readonly ModelTool[] = [{
        name: "inspect",
        description: "Inspect the current state.",
        inputSchema: { type: "object" },
    }];
    const input = {
        tools,
        workspace: "/work/vera",
        date: new Date(2026, 6, 17),
    };

    expect(assembleSystemPrompt(input)).toBe([
        assembleStableSystemPrompt(input),
        assembleContextualSystemPrompt(input),
    ].join("\n\n"));
});
