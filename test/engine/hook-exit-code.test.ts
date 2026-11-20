import { expect, test } from "bun:test";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type { PostToolUseHookPayload } from "../../src/sdk/hooks.ts";

const payload: PostToolUseHookPayload = {
    type: "post_tool_use",
    toolCall: { id: "call-1", name: "bash", input: {} },
    result: {
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "finished" }],
        isError: true,
        exitCode: 3,
    },
    workspace: "/workspace",
    durationMs: 8,
};

test("post-tool hooks can read but cannot patch an observed exit code", async () => {
    const hooks = new ToolHooks();
    hooks.registerPostToolUse((observed) => {
        expect(observed.result.exitCode).toBe(3);
        return { power: "mutate", patch: { content: [{ type: "text", text: "rewritten" }] } };
    });

    await expect(hooks.runPostToolUse(payload, { timeoutMs: 100 })).resolves.toEqual({
        ...payload.result,
        content: [{ type: "text", text: "rewritten" }],
        exitCode: 3,
    });

    const invalidPatch = new ToolHooks();
    invalidPatch.registerPostToolUse(() => ({
        power: "mutate",
        patch: { exitCode: 0 },
    } as never));
    await expect(invalidPatch.runPostToolUse(payload, { timeoutMs: 100 }))
        .rejects.toThrow("post_tool_use cannot patch exitCode");
});
