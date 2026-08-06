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

test("subagent carries a model and effort override into the effect", async () => {
    const result = await subagentTool.execute(
        {
            description: "Trace the request path",
            model: "small-model",
            reasoning_effort: "low",
        },
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    );

    expect(result).toEqual({
        kind: "effect",
        effect: {
            type: "spawn_subagent",
            description: "Trace the request path",
            model: "small-model",
            reasoningEffort: "low",
        },
    });
});

test("subagent reads a blank override as no override", async () => {
    const result = await subagentTool.execute(
        { description: "Trace the request path", model: "  " },
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
});

test("subagent spawns with no effort, leaving the defaults to decide", async () => {
    const result = await subagentTool.execute(
        { description: "Trace the request path", model: "small-model" },
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    );

    expect(result).toEqual({
        kind: "effect",
        effect: {
            type: "spawn_subagent",
            description: "Trace the request path",
            model: "small-model",
        },
    });
});

test("subagent reads a null effort as no effort", async () => {
    const result = await subagentTool.execute(
        { description: "Trace the request path", reasoning_effort: null },
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
});

test("subagent requires a description", async () => {
    expect(subagentTool.execute(
        {},
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    )).rejects.toThrow("subagent tool requires a string description");
});

test("a spawn with no model named is not an error", async () => {
    const result = await subagentTool.execute(
        { description: "Trace the request path", model: "" },
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
    expect(subagentTool.definition.inputSchema.required).toEqual([
        "description",
    ]);
});
