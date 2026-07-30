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
