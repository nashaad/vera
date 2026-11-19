import { expect, test } from "bun:test";

import {
    executeToolHandler,
    toolDefinitionsForCapabilities,
} from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";

const scoped: RegisteredTool = {
    agents: ["help"],
    definition: {
        name: "scoped_tool",
        description: "Scoped",
        inputSchema: { type: "object", properties: {} },
    },
    async execute() {
        return { kind: "output", output: "ran", isError: false };
    },
};

const open: RegisteredTool = {
    definition: {
        name: "open_tool",
        description: "Open",
        inputSchema: { type: "object", properties: {} },
    },
    async execute() {
        return { kind: "output", output: "ran", isError: false };
    },
};

function offered(agentName: string | undefined): string[] {
    return toolDefinitionsForCapabilities(
        [],
        false,
        [scoped, open],
        "top_level",
        agentName,
    ).map((tool) => tool.name).filter((name) => name.endsWith("_tool"));
}

test("a tool that names agents is offered to those agents only", () => {
    expect(offered("help")).toEqual(["scoped_tool", "open_tool"]);
    expect(offered("chat")).toEqual(["open_tool"]);
});

test("a tool that names agents is offered to nobody while no agent is selected", () => {
    expect(offered(undefined)).toEqual(["open_tool"]);
});

test("a call to a tool the selected agent may not use is refused", async () => {
    const runtime = new ToolRuntime("/tmp");
    const call = { type: "tool_call" as const, id: "c1", name: "scoped_tool", input: {} };

    runtime.agentName = "chat";
    const refused = await executeToolHandler(call, runtime, new AbortController().signal, [scoped]);
    expect(refused).toMatchObject({
        isError: true,
        output: "The agent you are wearing does not offer the scoped_tool tool.",
    });

    runtime.agentName = undefined;
    expect(await executeToolHandler(call, runtime, new AbortController().signal, [scoped]))
        .toMatchObject({ isError: true });

    runtime.agentName = "help";
    expect(await executeToolHandler(call, runtime, new AbortController().signal, [scoped]))
        .toMatchObject({ isError: false, output: "ran" });
});
