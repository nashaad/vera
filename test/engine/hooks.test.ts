import { expect, test } from "bun:test";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type {
    PostToolUseHookPayload,
    PreToolUseHookPayload,
} from "../../src/sdk/hooks.ts";

test("pre and post tool hooks receive serializable data in order", async () => {
    const hooks = new ToolHooks();
    const calls: string[] = [];
    const prePayload: PreToolUseHookPayload = {
        type: "pre_tool_use",
        toolCall: {
            id: "call-1",
            name: "bash",
            input: { command: "pwd" },
        },
        workspace: "/work/vera",
    };
    hooks.registerPreToolUse((payload) => {
        calls.push(`first:${payload.toolCall.name}`);
        (payload.toolCall.input as { command: string }).command = "mutated";
        return { behavior: "continue" };
    });
    hooks.registerPreToolUse((payload) => {
        calls.push(`second:${payload.toolCall.input.command}`);
        return { behavior: "deny", reason: "blocked by test" };
    });
    hooks.registerPreToolUse(() => {
        calls.push("unreachable");
        return { behavior: "continue" };
    });

    const decision = await hooks.runPreToolUse(
        prePayload,
        { timeoutMs: 100 },
    );
    expect(calls).toEqual(["first:bash", "second:pwd"]);
    expect(roundTrip(prePayload)).toEqual(prePayload);
    expect(roundTrip(decision)).toEqual(decision);

    const postPayload: PostToolUseHookPayload = {
        type: "post_tool_use",
        toolCall: prePayload.toolCall,
        result: {
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "/work/vera" }],
            isError: false,
        },
        workspace: "/work/vera",
        durationMs: 12,
    };
    let observed: PostToolUseHookPayload | undefined;
    hooks.registerPostToolUse((payload) => {
        const content = payload.result.content as Array<{
            type: "text";
            text: string;
        }>;
        content[0]!.text = "mutated";
    });
    hooks.registerPostToolUse((payload) => {
        observed = payload;
    });

    await hooks.runPostToolUse(postPayload, { timeoutMs: 100 });
    expect(observed).toEqual(postPayload);
    expect(roundTrip(postPayload)).toEqual(postPayload);
});

test("each hook call is bounded by its declared timeout", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => new Promise(() => {}));

    await expect(hooks.runPreToolUse({
        type: "pre_tool_use",
        toolCall: { id: "call-1", name: "bash", input: {} },
        workspace: "/work/vera",
    }, { timeoutMs: 5 })).rejects.toThrow(
        "pre_tool_use hooks timed out after 5ms",
    );

    const postHooks = new ToolHooks();
    postHooks.registerPostToolUse(() => new Promise(() => {}));
    await expect(postHooks.runPostToolUse({
        type: "post_tool_use",
        toolCall: { id: "call-1", name: "bash", input: {} },
        result: {
            toolCallId: "call-1",
            toolName: "bash",
            content: [],
            isError: false,
        },
        workspace: "/work/vera",
        durationMs: 1,
    }, { timeoutMs: 5 })).rejects.toThrow(
        "post_tool_use hooks timed out after 5ms",
    );

    const synchronous = new ToolHooks();
    synchronous.registerPreToolUse(() => {
        const finishAt = performance.now() + 10;
        while (performance.now() < finishAt) {
            // Deliberately occupy this in-process handler past its budget.
        }
        return { behavior: "deny", reason: "too late" };
    });
    await expect(synchronous.runPreToolUse({
        type: "pre_tool_use",
        toolCall: { id: "call-1", name: "bash", input: {} },
        workspace: "/work/vera",
    }, { timeoutMs: 5 })).rejects.toThrow(
        "pre_tool_use hooks timed out after 5ms",
    );
});

test("hook boundaries reject non-JSON data", async () => {
    const hooks = new ToolHooks();

    await expect(hooks.runPreToolUse({
        type: "pre_tool_use",
        toolCall: {
            id: "call-1",
            name: "bash",
            input: { value: 1n } as never,
        },
        workspace: "/work/vera",
    }, { timeoutMs: 100 })).rejects.toThrow(
        "Hook data at $.toolCall.input.value is not JSON-serializable",
    );

    await expect(hooks.runPostToolUse({
        type: "post_tool_use",
        toolCall: { id: "call-1", name: "bash", input: {} },
        result: {
            toolCallId: "call-1",
            toolName: "bash",
            content: [],
            isError: false,
        },
        workspace: "/work/vera",
        durationMs: Number.NaN,
    }, { timeoutMs: 100 })).rejects.toThrow(
        "Hook data at $.durationMs must contain a finite number",
    );

    const invalidResult = new ToolHooks();
    invalidResult.registerPreToolUse(() => ({
        behavior: "deny",
        reason: 1n,
    }) as never);
    await expect(invalidResult.runPreToolUse({
        type: "pre_tool_use",
        toolCall: { id: "call-1", name: "bash", input: {} },
        workspace: "/work/vera",
    }, { timeoutMs: 100 })).rejects.toThrow(
        "Hook data at $.reason is not JSON-serializable",
    );
});

function roundTrip<Value>(value: Value): Value {
    return JSON.parse(JSON.stringify(value)) as Value;
}
