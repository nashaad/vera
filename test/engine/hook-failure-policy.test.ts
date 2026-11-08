import { expect, test } from "bun:test";

import { setHookDeadlinePolicy } from "../../src/engine/hook-deadline.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";

type Phase = "pre_tool_use" | "pre_turn";
type Policy = "allow" | "deny" | undefined;
type TestHook = () => { readonly power: "observe" } | Promise<never>;

function harness(phase: Phase) {
    const hooks = new ToolHooks();
    const reports: string[] = [];
    return {
        register(hook: TestHook, policy: Policy, name: string): void {
            if (policy !== undefined) {
                setHookDeadlinePolicy(hook, {
                    onFailure: policy,
                    blockReason: (failure) => `${name}: ${failure}`,
                });
            }
            if (phase === "pre_tool_use") hooks.registerPreToolUse(hook);
            else hooks.registerPreTurn(hook, name);
        },
        async run() {
            const options = { timeoutMs: 20, onFailure: (error: string) => reports.push(error) };
            const outcome = phase === "pre_tool_use"
                ? await hooks.runPreToolUse({
                    type: "pre_tool_use",
                    workspace: "/work",
                    toolCall: { id: "call", name: "read", input: {} },
                }, options)
                : await hooks.runPreTurn({
                    type: "pre_turn",
                    workspace: "/work",
                    prompt: "find the treasure",
                    model: "test",
                    tools: [],
                    arrivedDuringTurn: false,
                    spawned: false,
                }, options);
            return outcome.result;
        },
        reports,
    };
}

for (const phase of ["pre_tool_use", "pre_turn"] as const) {
    test(`${phase} denies when the running deny hook reaches the deadline`, async () => {
        const chain = harness(phase);
        let laterRan = false;
        chain.register(() => new Promise(() => {}), "deny", "first");
        chain.register(() => { laterRan = true; return { power: "observe" }; }, "deny", "later");
        expect(await chain.run()).toEqual({ power: "block", reason: "first: timed out after 20ms" });
        expect(laterRan).toBe(false);
        expect(chain.reports).toEqual([`${phase} hooks timed out after 20ms`]);
    });

    test(`${phase} gives the first unrun deny hook priority over an undeclared hook`, async () => {
        const chain = harness(phase);
        let laterRan = false;
        chain.register(() => new Promise(() => {}), undefined, "running");
        chain.register(() => { laterRan = true; return { power: "observe" }; }, undefined, "unconfigured");
        chain.register(() => { laterRan = true; return { power: "observe" }; }, "deny", "guard");
        chain.register(() => { laterRan = true; return { power: "observe" }; }, "deny", "second guard");
        expect(await chain.run()).toEqual({ power: "block", reason: "guard: did not run before the hook deadline" });
        expect(laterRan).toBe(false);
        expect(chain.reports).toEqual([`${phase} hooks timed out after 20ms`]);
    });

    test(`${phase} retains the generic failure when an unrun hook is undeclared`, async () => {
        const chain = harness(phase);
        chain.register(() => new Promise(() => {}), "allow", "running");
        chain.register(() => ({ power: "observe" }), undefined, "unconfigured");
        await expect(chain.run()).rejects.toThrow(`${phase} hooks timed out after 20ms`);
        expect(chain.reports).toEqual([]);
    });

    test(`${phase} proceeds and reports the deadline when every remaining hook allows`, async () => {
        const chain = harness(phase);
        let laterRan = false;
        chain.register(() => new Promise(() => {}), "allow", "running");
        chain.register(() => { laterRan = true; return { power: "observe" }; }, "allow", "later");
        expect(await chain.run()).toEqual({ power: "observe" });
        expect(laterRan).toBe(false);
        expect(chain.reports).toEqual([`${phase} hooks timed out after 20ms`]);
    });

    test(`${phase} notices the deadline when a synchronous hook throws late`, async () => {
        const chain = harness(phase);
        chain.register(() => {
            const end = performance.now() + 30;
            while (performance.now() < end) {}
            throw new Error("late");
        }, undefined, "running");
        chain.register(() => ({ power: "observe" }), "deny", "guard");
        expect(await chain.run()).toEqual({ power: "block", reason: "guard: did not run before the hook deadline" });
        expect(chain.reports).toEqual([`${phase} hooks timed out after 20ms`]);
    });
}

test("an allowed deadline retains earlier pre-tool mutations", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => ({ power: "mutate", input: { path: "treasure" } }));
    const slow = () => new Promise<never>(() => {});
    setHookDeadlinePolicy(slow, { onFailure: "allow", blockReason: (failure) => failure });
    hooks.registerPreToolUse(slow);
    const outcome = await hooks.runPreToolUse({
        type: "pre_tool_use", workspace: "/work", toolCall: { id: "call", name: "read", input: { path: "map" } },
    }, { timeoutMs: 20 });
    expect(outcome.toolCall.input).toEqual({ path: "treasure" });
    expect(outcome.result).toEqual({ power: "mutate", input: { path: "treasure" } });
});

test("an allowed deadline retains earlier pre-turn mutations and context", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreTurn(() => ({ power: "mutate", model: "crow", context: "treasure is buried" }), "lookout");
    const slow = () => new Promise<never>(() => {});
    setHookDeadlinePolicy(slow, { onFailure: "allow", blockReason: (failure) => failure });
    hooks.registerPreTurn(slow);
    const outcome = await hooks.runPreTurn({
        type: "pre_turn", workspace: "/work", prompt: "treasure", model: "test", tools: [],
        arrivedDuringTurn: false, spawned: false,
    }, { timeoutMs: 20 });
    expect(outcome.payload.model).toBe("crow");
    expect(outcome.result).toEqual({ power: "mutate", model: "crow" });
    expect(outcome.contexts).toEqual([{ source: "lookout", context: "treasure is buried" }]);
});
