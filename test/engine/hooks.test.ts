import { expect, test } from "bun:test";

import { MAX_HOOK_CONTEXT_BYTES, ToolHooks } from "../../src/engine/hooks.ts";
import type {
    PostToolUseHookPayload,
    PreToolUseHookPayload,
    TurnEndingHookPayload,
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

const preTurnPayload = {
    type: "pre_turn" as const,
    workspace: "/work/vera",
    prompt: "review this patch",
    arrivedDuringTurn: false,
    model: "reviewer",
    tools: ["read", "write", "bash"],
    reasoningEffort: "high",
};

test("pre-turn mutations accumulate in order and cannot add tools", async () => {
    const hooks = new ToolHooks();
    const seen: string[][] = [];
    hooks.registerPreTurn((payload) => {
        seen.push([...payload.tools]);
        (payload as { model: string }).model = "hidden";
        return { power: "mutate", tools: ["read", "bash"], model: "cheap" };
    });
    hooks.registerPreTurn((payload) => {
        seen.push([...payload.tools]);
        return { power: "mutate", tools: ["bash", "write"] };
    });

    const outcome = await hooks.runPreTurn(preTurnPayload, { timeoutMs: 100 });

    expect(seen).toEqual([
        ["read", "write", "bash"],
        ["read", "bash"],
    ]);
    expect(outcome.payload).toEqual({
        type: "pre_turn",
        workspace: "/work/vera",
        prompt: "review this patch",
        arrivedDuringTurn: false,
        model: "cheap",
        tools: ["bash"],
        reasoningEffort: "high",
    });
    expect(outcome.result).toMatchObject({ power: "mutate", tools: ["bash", "write"] });
    expect(roundTrip(preTurnPayload)).toEqual(preTurnPayload);
});

test("pre-turn block stops later handlers", async () => {
    const hooks = new ToolHooks();
    let afterBlock = false;
    hooks.registerPreTurn(() => ({ power: "mutate", model: "cheap" }));
    hooks.registerPreTurn(() => ({ power: "block", reason: "not this turn" }));
    hooks.registerPreTurn(() => {
        afterBlock = true;
        return { power: "observe" };
    });
    expect(await hooks.runPreTurn(preTurnPayload, { timeoutMs: 100 })).toEqual({
        payload: {
            ...preTurnPayload,
            model: "cheap",
        },
        result: { power: "block", reason: "not this turn" },
        contexts: [],
    });
    expect(afterBlock).toBe(false);
});

test("an empty pre-turn tools list offers none, and unknown names are ignored", async () => {
    const empty = new ToolHooks();
    empty.registerPreTurn(() => ({ power: "mutate", tools: [] }));
    expect(
        (await empty.runPreTurn(preTurnPayload, { timeoutMs: 100 })).payload.tools,
    ).toEqual([]);

    const unknown = new ToolHooks();
    unknown.registerPreTurn(() => ({ power: "mutate", tools: ["not-a-tool"] }));
    expect(
        (await unknown.runPreTurn(preTurnPayload, { timeoutMs: 100 })).payload.tools,
    ).toEqual(preTurnPayload.tools);
});

test("pre-turn hooks share the declared timeout budget", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreTurn(() => new Promise(() => {}));
    await expect(hooks.runPreTurn(preTurnPayload, { timeoutMs: 5 })).rejects.toThrow(
        "pre_turn hooks timed out after 5ms",
    );
});

test("pre-turn context is collected in order with its source, and empty text adds nothing", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreTurn(() => ({ power: "mutate", context: "the crow buried it under the third palm" }), "lookout");
    hooks.registerPreTurn(() => ({ power: "mutate", context: "" }), "quiet");
    hooks.registerPreTurn(() => ({ power: "mutate", context: "mind the kraken" }));

    const outcome = await hooks.runPreTurn(preTurnPayload, { timeoutMs: 100 });

    expect(outcome.contexts).toEqual([
        { source: "lookout", context: "the crow buried it under the third palm" },
        { context: "mind the kraken" },
    ]);
});

test("a pre-turn block drops context gathered before it", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreTurn(() => ({ power: "mutate", context: "early note" }), "lookout");
    hooks.registerPreTurn(() => ({ power: "block", reason: "not this turn" }));

    expect((await hooks.runPreTurn(preTurnPayload, { timeoutMs: 100 })).contexts).toEqual([]);
});

test("pre-turn context that is not a string or is too large fails closed", async () => {
    const wrongType = new ToolHooks();
    wrongType.registerPreTurn(() => ({ power: "mutate", context: 7 }) as never);
    await expect(wrongType.runPreTurn(preTurnPayload, { timeoutMs: 100 })).rejects.toThrow("context");

    const tooLarge = new ToolHooks();
    tooLarge.registerPreTurn(() => ({ power: "mutate", context: "x".repeat(MAX_HOOK_CONTEXT_BYTES + 1) }));
    await expect(tooLarge.runPreTurn(preTurnPayload, { timeoutMs: 100 })).rejects.toThrow("context");
});

test("disposing a sourced pre-turn hook removes only that hook", async () => {
    const hooks = new ToolHooks();
    const dispose = hooks.registerPreTurn(() => ({ power: "mutate", context: "gone" }), "lookout");
    hooks.registerPreTurn(() => ({ power: "mutate", context: "kept" }), "lookout");
    dispose();

    expect((await hooks.runPreTurn(preTurnPayload, { timeoutMs: 100 })).contexts).toEqual([
        { source: "lookout", context: "kept" },
    ]);
});

const turnEndingPayload: TurnEndingHookPayload = {
    type: "turn_ending",
    workspace: "/work/vera",
    prompt: "find the treasure",
    reply: "done",
    spawned: false,
    continuations: 0,
};

test("the first turn_ending continue wins with its source and later hooks do not run", async () => {
    const hooks = new ToolHooks();
    const seen: string[] = [];
    hooks.registerTurnEnding(() => {
        seen.push("observer");
        return { power: "observe" };
    });
    hooks.registerTurnEnding(() => {
        seen.push("lookout");
        return { power: "continue", context: "no map, no treasure" };
    }, "lookout");
    hooks.registerTurnEnding(() => {
        seen.push("late");
        return { power: "continue", context: "unreached" };
    });

    const outcome = await hooks.runTurnEnding(turnEndingPayload, { timeoutMs: 100 });

    expect(outcome).toEqual({ continuation: { source: "lookout", context: "no map, no treasure" } });
    expect(seen).toEqual(["observer", "lookout"]);
});

test("turn_ending observers alone continue nothing", async () => {
    const hooks = new ToolHooks();
    hooks.registerTurnEnding(() => ({ power: "observe" }));
    expect(await hooks.runTurnEnding(turnEndingPayload, { timeoutMs: 100 })).toEqual({});
    expect(await new ToolHooks().runTurnEnding(turnEndingPayload, { timeoutMs: 100 })).toEqual({});
});

test("a turn_ending result with empty context or another power fails", async () => {
    const empty = new ToolHooks();
    empty.registerTurnEnding(() => ({ power: "continue", context: "" }));
    await expect(empty.runTurnEnding(turnEndingPayload, { timeoutMs: 100 })).rejects.toThrow("context");

    const wrongPower = new ToolHooks();
    wrongPower.registerTurnEnding(() => ({ power: "block", reason: "no" }) as never);
    await expect(wrongPower.runTurnEnding(turnEndingPayload, { timeoutMs: 100 })).rejects.toThrow();

    const slow = new ToolHooks();
    slow.registerTurnEnding(() => new Promise(() => {}));
    await expect(slow.runTurnEnding(turnEndingPayload, { timeoutMs: 5 })).rejects.toThrow("timed out");
});

function roundTrip<Value>(value: Value): Value {
    return JSON.parse(JSON.stringify(value)) as Value;
}
