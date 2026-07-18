import { expect, test } from "bun:test";

import { backgroundAgentTool } from "../../src/tools/background-agent.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("background_agent returns a serializable spawn effect", async () => {
    const result = await backgroundAgentTool.execute(
        { description: "Run the integration tests" },
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    );

    expect(result).toEqual({
        kind: "effect",
        effect: {
            type: "spawn_background_agent",
            description: "Run the integration tests",
        },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("background_agent requires a description", async () => {
    expect(backgroundAgentTool.execute(
        {},
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    )).rejects.toThrow(
        "background_agent tool requires a string description",
    );
});
