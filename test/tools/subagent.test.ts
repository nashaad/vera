import { expect, test } from "bun:test";

import { ToolRuntime } from "../../src/tools/runtime.ts";
import { subagentTool } from "../../src/tools/subagent.ts";

test("subagent returns a serializable spawn effect", async () => {
    const result = await subagentTool.execute(
        { description: "Trace the request path" },
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    );

    expect(result).toEqual({
        kind: "effect",
        effect: {
            type: "spawn_subagent",
            description: "Trace the request path",
        },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("subagent requires a description", async () => {
    expect(subagentTool.execute(
        {},
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    )).rejects.toThrow("subagent tool requires a string description");
});
