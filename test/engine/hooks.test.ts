import { expect, test } from "bun:test";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type {
    PostToolUseHookPayload,
    PreToolUseHookPayload,
} from "../../src/sdk/hooks.ts";

const prePayload: PreToolUseHookPayload = {
    type: "pre_tool_use",
    toolCall: {
        id: "call-1",
        name: "bash",
        input: { command: "pwd" },
    },
    workspace: "/work/vera",
};

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

test("pre-tool mutations are declarative and ordered", async () => {
    const hooks = new ToolHooks();
    const calls: string[] = [];
    hooks.registerPreToolUse((payload) => {
        calls.push(`first:${payload.toolCall.input.command}`);
        (payload.toolCall.input as { command: string }).command = "hidden";
        return { power: "mutate", input: { command: "printf changed" } };
    });
    hooks.registerPreToolUse((payload) => {
        calls.push(`second:${payload.toolCall.input.command}`);
        return { power: "observe" };
    });

    const outcome = await hooks.runPreToolUse(prePayload, { timeoutMs: 100 });

    expect(calls).toEqual(["first:pwd", "second:printf changed"]);
    expect(outcome).toEqual({
        toolCall: {
            id: "call-1",
            name: "bash",
            input: { command: "printf changed" },
        },
        result: { power: "mutate", input: { command: "printf changed" } },
    });
    expect(roundTrip(prePayload)).toEqual(prePayload);
});

test("pre-tool block and replace stop later handlers", async () => {
    const blocked = new ToolHooks();
    let afterBlock = false;
    blocked.registerPreToolUse(() => ({
        power: "mutate",
        input: { command: "printf changed before block" },
    }));
    blocked.registerPreToolUse(() => ({
        power: "block",
        reason: "blocked by test",
    }));
    blocked.registerPreToolUse(() => {
        afterBlock = true;
        return { power: "observe" };
    });
    expect(await blocked.runPreToolUse(prePayload, { timeoutMs: 100 })).toEqual({
        toolCall: {
            ...prePayload.toolCall,
            input: { command: "printf changed before block" },
        },
        result: { power: "block", reason: "blocked by test" },
    });
    expect(afterBlock).toBe(false);

    const replaced = new ToolHooks();
    replaced.registerPreToolUse(() => ({
        power: "replace",
        result: {
            content: [{ type: "text", text: "synthetic" }],
            isError: false,
        },
    }));
    expect(await replaced.runPreToolUse(prePayload, { timeoutMs: 100 })).toEqual({
        toolCall: prePayload.toolCall,
        result: {
            power: "replace",
            result: {
                content: [{ type: "text", text: "synthetic" }],
                isError: false,
            },
        },
    });
});

test("post-tool mutations patch cloned plain data in order", async () => {
    const hooks = new ToolHooks();
    let observed: PostToolUseHookPayload | undefined;
    hooks.registerPostToolUse((payload) => {
        const content = payload.result.content as Array<{
            type: "text";
            text: string;
        }>;
        content[0]!.text = "hidden";
        return {
            power: "mutate",
            patch: { content: [{ type: "text", text: "changed" }] },
        };
    });
    hooks.registerPostToolUse((payload) => {
        observed = payload;
        return { power: "mutate", patch: { isError: true } };
    });

    const result = await hooks.runPostToolUse(postPayload, { timeoutMs: 100 });

    expect(observed?.result.content[0]?.text).toBe("changed");
    expect(result).toEqual({
        ...postPayload.result,
        content: [{ type: "text", text: "changed" }],
        isError: true,
    });
    expect(roundTrip(postPayload)).toEqual(postPayload);
});

test("each hook chain is bounded by its declared timeout", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => new Promise(() => {}));
    await expect(hooks.runPreToolUse(prePayload, { timeoutMs: 5 })).rejects.toThrow(
        "pre_tool_use hooks timed out after 5ms",
    );

    const postHooks = new ToolHooks();
    postHooks.registerPostToolUse(() => new Promise(() => {}));
    await expect(
        postHooks.runPostToolUse(postPayload, { timeoutMs: 5 }),
    ).rejects.toThrow("post_tool_use hooks timed out after 5ms");

    const synchronous = new ToolHooks();
    synchronous.registerPreToolUse(() => {
        const finishAt = performance.now() + 10;
        while (performance.now() < finishAt) {
            // Deliberately occupy this in-process handler past its budget.
        }
        return { power: "block", reason: "too late" };
    });
    await expect(
        synchronous.runPreToolUse(prePayload, { timeoutMs: 5 }),
    ).rejects.toThrow("pre_tool_use hooks timed out after 5ms");
});

test("hook boundaries reject non-JSON and invalid result data", async () => {
    const hooks = new ToolHooks();
    await expect(hooks.runPreToolUse({
        ...prePayload,
        toolCall: {
            ...prePayload.toolCall,
            input: { value: 1n } as never,
        },
    }, { timeoutMs: 100 })).rejects.toThrow(
        "Hook data at $.toolCall.input.value is not JSON-serializable",
    );

    await expect(hooks.runPostToolUse({
        ...postPayload,
        durationMs: Number.NaN,
    }, { timeoutMs: 100 })).rejects.toThrow(
        "Hook data at $.durationMs must contain a finite number",
    );

    const executableReplacement = new ToolHooks();
    executableReplacement.registerPreToolUse(() => ({
        power: "replace",
        result: { run: () => "not data" },
    }) as never);
    await expect(
        executableReplacement.runPreToolUse(prePayload, { timeoutMs: 100 }),
    ).rejects.toThrow("Hook data at $.result.run is not JSON-serializable");

    const invalidPower = new ToolHooks();
    invalidPower.registerPostToolUse(() => ({ power: "replace" }) as never);
    await expect(
        invalidPower.runPostToolUse(postPayload, { timeoutMs: 100 }),
    ).rejects.toThrow("post_tool_use returned unsupported power: replace");
});

function roundTrip<Value>(value: Value): Value {
    return JSON.parse(JSON.stringify(value)) as Value;
}
