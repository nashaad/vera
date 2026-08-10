import { expect, test } from "bun:test";

import { agentRosterTool } from "../../src/tools/agent-roster.ts";
import { toolDefinitionsForCapabilities } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("agent_roster defaults to a compact roster effect", async () => {
    expect(await agentRosterTool.execute(
        {},
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    )).toEqual({
        kind: "effect",
        effect: { type: "agent_roster", details: false },
    });
});

test("agent_roster carries an explicit diagnostic detail request", async () => {
    expect(await agentRosterTool.execute(
        { details: true },
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    )).toEqual({
        kind: "effect",
        effect: { type: "agent_roster", details: true },
    });
});

test("agent_roster is exposed only when the owner can apply its effect", () => {
    const withoutEffect = toolDefinitionsForCapabilities([])
        .map((tool) => tool.name);
    const withEffect = toolDefinitionsForCapabilities(["agent_roster"])
        .map((tool) => tool.name);

    expect(withoutEffect).not.toContain("agent_roster");
    expect(withEffect).toContain("agent_roster");
});
