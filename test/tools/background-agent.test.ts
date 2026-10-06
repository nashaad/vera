import { expect, test } from "bun:test";

import { asyncSubagentTool } from "../../src/tools/async-subagent.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("async_subagent returns a serializable spawn effect", async () => {
    const result = await asyncSubagentTool.execute(
        { description: "Run the integration tests" },
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    );

    expect(result).toEqual({
        kind: "effect",
        effect: {
            type: "spawn_async_subagent",
            description: "Run the integration tests",
        },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("async_subagent requires a description", async () => {
    expect(asyncSubagentTool.execute(
        {},
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    )).rejects.toThrow(
        "async_subagent tool requires a string description",
    );
});

test("async_subagent tells the parent the child cannot see this conversation", () => {
    expect(asyncSubagentTool.definition.description).toBe(
        "Launch a focused subagent concurrently and return its ID immediately. Its final summary arrives on a later turn. The child does not see this conversation. Put the goal, why it matters, what you already know, paths, and what to return in `description`.",
    );
    const properties = asyncSubagentTool.definition.inputSchema.properties as {
        readonly description: { readonly description?: string };
    };
    expect(properties.description.description).toBe(
        "The child's only view of the task. Include everything it needs; it cannot see this conversation.",
    );
});
