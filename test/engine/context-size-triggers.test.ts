import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createContextSizeTriggerSet,
    type ContextSizeAction,
    type ContextSizeTriggerSet,
} from "../../src/engine/context-size-triggers.ts";
import {
    defaultContextSizePolicies,
} from "../../src/engine/context-size-trigger-defaults.ts";
import {
    assembleAgedToolResults,
    toolResultAgingGateFraction,
} from "../../src/engine/tool-result-history.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

test("a ladder fires at or above its highest reached level and stays armed", () => {
    const triggers = createContextSizeTriggerSet([{
        kind: "ladder",
        id: "compact",
        levels: [400, 800],
        actions: ["compact"],
    }]);
    expect(triggers.fire("compact", { tokens: 399 })).toBeUndefined();
    expect(triggers.fire("compact", { tokens: 400 })?.policy?.id).toBe("compact");
    expect(triggers.fire("compact", { tokens: 900 })).toBeDefined();
    // Stateless: the compaction latch, not the ladder, decides about retries.
    expect(triggers.fire("compact", { tokens: 900 })).toBeDefined();
    expect(triggers.fire("trim", { tokens: 900 })).toBeUndefined();
});

test("high_low fires once, re-arms below low, and stays armed when nothing changed", () => {
    const triggers = createContextSizeTriggerSet([{
        kind: "high_low",
        id: "active_turn",
        high: 800,
        low: 300,
        actions: ["stub_active_turn"],
    }]);
    expect(triggers.fire("stub_active_turn", { tokens: 799 })).toBeUndefined();
    expect(triggers.fire("stub_active_turn", { tokens: 800 })).toBeDefined();
    // A fire alone does not disarm; the action reports whether it changed content.
    expect(triggers.fire("stub_active_turn", { tokens: 900 })).toBeDefined();
    triggers.observe("stub_active_turn", { tokens: 900 }, false);
    expect(triggers.fire("stub_active_turn", { tokens: 900 })).toBeDefined();
    triggers.observe("stub_active_turn", { tokens: 900 }, true);
    expect(triggers.fire("stub_active_turn", { tokens: 900 })).toBeUndefined();
    // The re-arm happens on a later fire call once the context is at or below low.
    expect(triggers.fire("stub_active_turn", { tokens: 300 })).toBeUndefined();
    expect(triggers.fire("stub_active_turn", { tokens: 800 })).toBeDefined();
});

test("high_low can be re-armed by an action that shrinks below low", () => {
    const triggers = createContextSizeTriggerSet([{
        kind: "high_low",
        id: "active_turn",
        high: 800,
        low: 300,
        actions: ["stub_active_turn"],
    }]);
    triggers.fire("stub_active_turn", { tokens: 900 });
    triggers.observe("stub_active_turn", { tokens: 200 }, true);
    expect(triggers.fire("stub_active_turn", { tokens: 800 })).toBeDefined();
});

test("every_n fires at from, then only after another whole step", () => {
    const triggers = createContextSizeTriggerSet([{
        kind: "every_n",
        id: "trim",
        from: 1_000,
        step: 100,
        actions: ["trim"],
    }]);
    expect(triggers.fire("trim", { tokens: 999 })).toBeUndefined();
    expect(triggers.fire("trim", { tokens: 1_000 })).toBeDefined();
    expect(triggers.fire("trim", { tokens: 1_099 })).toBeUndefined();
    expect(triggers.fire("trim", { tokens: 1_100 })).toBeDefined();
    // A jump of several steps counts once and rebases on the crossed step.
    expect(triggers.fire("trim", { tokens: 1_300 })).toBeDefined();
    expect(triggers.fire("trim", { tokens: 1_399 })).toBeUndefined();
    expect(triggers.fire("trim", { tokens: 1_400 })).toBeDefined();
});

test("a fresh every_n set fires at from again", () => {
    const policies = [{
        kind: "every_n" as const,
        id: "trim",
        from: 1_000,
        step: 100,
        actions: ["trim" as const],
    }];
    expect(createContextSizeTriggerSet(policies).fire("trim", { tokens: 1_500 }))
        .toBeDefined();
    expect(createContextSizeTriggerSet(policies).fire("trim", { tokens: 1_500 }))
        .toBeDefined();
});

test("stacked policies fire independently and in declaration order", () => {
    const triggers = createContextSizeTriggerSet([
        {
            kind: "ladder",
            id: "late",
            levels: [200],
            actions: ["compact"],
        },
        {
            kind: "ladder",
            id: "early",
            levels: [100],
            actions: ["compact"],
        },
        {
            kind: "every_n",
            id: "trim",
            from: 100,
            step: 10,
            actions: ["trim"],
        },
    ]);
    expect(triggers.fire("compact", { tokens: 100 })?.policy?.id).toBe("early");
    expect(triggers.fire("compact", { tokens: 200 })?.policy?.id).toBe("late");
    expect(triggers.fire("trim", { tokens: 100 })?.policy?.id).toBe("trim");
    expect(triggers.fire("stub_active_turn", { tokens: 200 })).toBeUndefined();
});

test("the default list reproduces each window's gate, active-turn pair, and compaction level", () => {
    const cases = [
        {
            capacity: 400_000,
            gateFraction: 0.8,
            from: 320_000,
            step: 40_000,
            high: 300_000,
            low: 140_000,
            compact: 328_000,
        },
        {
            capacity: 128_000,
            gateFraction: 0.6,
            from: 76_800,
            step: 12_800,
            high: 96_000,
            low: 44_800,
            compact: 104_960,
        },
        {
            capacity: 100_000,
            gateFraction: 0.4,
            from: 40_000,
            step: 10_000,
            high: 75_000,
            low: 35_000,
            compact: 82_000,
        },
        {
            capacity: undefined,
            gateFraction: 0.6,
            from: 60_000,
            step: 10_000,
            high: 75_000,
            low: 35_000,
            compact: 100_000,
        },
    ];
    for (const expected of cases) {
        expect(toolResultAgingGateFraction(expected.capacity))
            .toBe(expected.gateFraction);
        const [trim, active, compact] = defaultContextSizePolicies({
            capacity: expected.capacity,
            trimGateFraction: expected.gateFraction,
        });
        expect(trim).toMatchObject({
            kind: "every_n",
            from: expected.from,
            step: expected.step,
            actions: ["trim"],
        });
        expect(active).toMatchObject({
            kind: "high_low",
            high: expected.high,
            low: expected.low,
            actions: ["stub_active_turn"],
        });
        expect(compact).toMatchObject({
            kind: "ladder",
            levels: [expected.compact],
            actions: ["compact"],
        });
    }
});

test("a configured compaction trigger keeps its tokens, fraction, and cap", () => {
    const level = (
        capacity: number | undefined,
        trigger?: { readonly fraction?: number; readonly tokens?: number },
    ): number | undefined => {
        const policy = defaultContextSizePolicies({
            capacity,
            trimGateFraction: 0.6,
            ...(trigger === undefined ? {} : { compactionTrigger: trigger }),
        })[2];
        return policy?.kind === "ladder" ? policy.levels[0] : undefined;
    };
    expect(level(128_000, { tokens: 30_000 })).toBe(30_000);
    expect(level(128_000, { fraction: 0.2 })).toBe(25_600);
    expect(level(128_000, { tokens: 500_000 })).toBe(104_960);
    expect(level(128_000, { tokens: 500_000, fraction: 0.2 })).toBe(25_600);
    expect(level(undefined, { tokens: 30_000 })).toBe(30_000);
    expect(level(undefined, { fraction: 0.2 })).toBe(100_000);
});

test("no action changes earlier content unless a trigger fires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-size-trigger-"));
    try {
        const capacity = 10_000;
        const output = "src/map.ts:12:buried chest\n".repeat(400);
        const entries: { readonly message: ModelMessage }[] = [user("first")];
        for (let index = 0; index < 2; index += 1) {
            const id = `old-${index}`;
            const path = join(directory, `${id}.txt`);
            await writeFile(path, output);
            entries.push(call(id), spilled(id, "grep", output, path));
        }
        entries.push(assistant("done"), user("second"));
        const lengths: number[] = [];
        for (let index = 0; index < 4; index += 1) {
            const id = `new-${index}`;
            const path = join(directory, `${id}.txt`);
            await writeFile(path, output);
            entries.push(call(id), spilled(id, "grep", output, path));
            lengths.push(entries.length);
        }

        const quiet = assembleAgedToolResults(entries, {
            capacity: 1_000_000,
            ageAfterTurns: 1,
            budgetBytes: 10_000_000,
        }, null);
        expect(quiet).toEqual(entries.map((entry) => entry.message));

        const fired: ContextSizeAction[] = [];
        let previous: readonly ModelMessage[] | undefined;
        let sawChange = false;
        let sawFire = false;
        for (const length of lengths) {
            fired.length = 0;
            const triggers = recordingTriggers(capacity, fired);
            const messages = assembleAgedToolResults(entries.slice(0, length), {
                capacity,
                level: "tight",
                ageAfterTurns: 1,
                budgetBytes: 10_000_000,
                triggers,
            }, null);
            if (previous !== undefined) {
                const shared = Math.min(previous.length, messages.length);
                let changed = false;
                for (let index = 0; index < shared; index += 1) {
                    if (JSON.stringify(previous[index])
                        !== JSON.stringify(messages[index])) {
                        changed = true;
                        break;
                    }
                }
                if (changed) {
                    sawChange = true;
                    expect(fired.length).toBeGreaterThan(0);
                }
                if (fired.length === 0) {
                    expect(changed).toBe(false);
                }
            }
            if (fired.length > 0) sawFire = true;
            previous = messages;
        }
        expect(sawFire).toBe(true);
        expect(sawChange).toBe(true);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

function recordingTriggers(
    capacity: number,
    fired: ContextSizeAction[],
): ContextSizeTriggerSet {
    const inner = createContextSizeTriggerSet(
        defaultContextSizePolicies({
            capacity,
            trimGateFraction: toolResultAgingGateFraction(capacity),
        }),
    );
    return {
        fire(action, measurement) {
            const trigger = inner.fire(action, measurement);
            if (trigger !== undefined) fired.push(action);
            return trigger;
        },
        observe(action, measurement, changed) {
            inner.observe(action, measurement, changed);
        },
        reset(action) {
            inner.reset(action);
        },
    };
}

function spilled(
    id: string,
    tool: string,
    output: string,
    spillPath: string,
): { readonly message: ModelMessage } {
    return {
        message: {
            role: "tool_result",
            toolCallId: id,
            toolName: tool,
            content: [{ type: "text", text: output }],
            isError: false,
            toolResultSource: {
                originalBytes: Math.max(3_000, Buffer.byteLength(output, "utf8")),
                spillPath,
            },
        },
    };
}

function user(text: string): { readonly message: ModelMessage } {
    return { message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(text: string): { readonly message: ModelMessage } {
    return {
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    };
}

function call(id: string): { readonly message: ModelMessage } {
    return {
        message: {
            role: "assistant",
            content: [{
                type: "tool_call",
                id,
                name: "grep",
                input: { path: "note.md", command: "echo hi" },
            }],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
    };
}
