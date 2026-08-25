import { expect, test } from "bun:test";

import { closeSubagentTool } from "../../src/tools/close-subagent.ts";
import { toolDefinitionsForCapabilities } from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("close_subagent returns a host-owned close effect", async () => {
    expect(await closeSubagentTool.execute(
        { subagent_id: "child-1" },
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    )).toEqual({
        kind: "effect",
        effect: {
            type: "close_subagent",
            subagentId: "child-1",
        },
    });
});

test("close_subagent is exposed only with its native effect", () => {
    const absent = toolDefinitionsForCapabilities([]).map((tool) => tool.name);
    const present = toolDefinitionsForCapabilities(["close_subagent"])
        .map((tool) => tool.name);
    const delegated = toolDefinitionsForCapabilities(
        ["close_subagent"],
        false,
        [],
        "subagent",
    ).map((tool) => tool.name);

    expect(absent).not.toContain("close_subagent");
    expect(present).toContain("close_subagent");
    expect(delegated).not.toContain("close_subagent");
});
