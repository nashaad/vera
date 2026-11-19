import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchInstructionBudget } from "../../src/core-extensions/context/instruction-budget-notice.ts";
import {
    claimInstructionBudgetNotice,
    MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS,
} from "../../src/core-extensions/context/instruction-budget-store.ts";
import { extensionStorage } from "../../src/extensions/storage.ts";
import type { VeraClientContextSnapshot } from "../../src/sdk/context.ts";
import type { VeraClientAgentRef, VeraClientExtensionApi } from "../../src/sdk/extensions.ts";

const overBudget: VeraClientContextSnapshot = {
    availability: "available",
    model: { model: "test", capacity: 200_000 },
    headline: { tokens: 9_000, estimated: true },
    projection: {
        estimatedTokens: 9_000,
        components: [{
            kind: "prompt_contribution",
            id: "core.user-rules",
            owner: "core",
            source: "contextual",
            displayName: "User rules",
            count: 1,
            estimatedTokens: 9_000,
        }],
    },
};

const temporaryDirectories: string[] = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function testHome(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-instruction-notice-"));
    temporaryDirectories.push(directory);
    return directory;
}

function watcher(home: string, initialAgent = "conversation-1", budget = 8_000) {
    let agentId: string | undefined = initialAgent;
    let mainSnapshot: VeraClientContextSnapshot = overBudget;
    let focusedSnapshot: VeraClientContextSnapshot = { availability: "unavailable" };
    const targets: (VeraClientAgentRef | undefined)[] = [];
    const listeners = new Map<string, ((event?: unknown) => void)[]>();
    const notices: { text: string; tone?: string }[] = [];
    const vera = {
        storage: extensionStorage("vera.context", { profile: home, machine: home }),
        agents: {
            visible: () => [
                ...(agentId === undefined ? [] : [{ agentId, pane: "main" }]),
                { agentId: "sidebar", pane: "sidebar" },
            ],
        },
        context: {
            current: (target?: VeraClientAgentRef) => {
                targets.push(target);
                return target?.agentId === agentId ? mainSnapshot : focusedSnapshot;
            },
        },
        ui: {
            notice: (text: string, options?: { tone?: string }) => {
                notices.push({ text, tone: options?.tone });
            },
        },
        experimentalTui: {
            events: {
                on(event: string, listener: (event?: unknown) => void) {
                    const handlers = listeners.get(event) ?? [];
                    handlers.push(listener);
                    listeners.set(event, handlers);
                    return () => {};
                },
            },
        },
    } as unknown as VeraClientExtensionApi;
    const fire = (name: string, event?: unknown): void => {
        for (const listener of listeners.get(name) ?? []) listener(event);
    };
    watchInstructionBudget(vera, budget);
    return {
        fire,
        notices,
        targets,
        setAgent: (value: string | undefined) => { agentId = value; },
        setMainSnapshot: (value: VeraClientContextSnapshot) => { mainSnapshot = value; },
        setFocusedSnapshot: (value: VeraClientContextSnapshot) => { focusedSnapshot = value; },
    };
}

test("@core instruction budget warns once after reattaching to the same conversation", () => {
    const home = testHome();
    const first = watcher(home);
    first.fire("agent_event", { type: "user_prompt" });
    first.fire("transcript_changed");
    expect(first.notices).toHaveLength(0);
    first.fire("agent_event", { type: "turn_finished" });
    expect(first.notices).toEqual([{
        text: "Starting instructions are 9.0k tokens, over the 8.0k budget. See /context to trim.",
        tone: "soft",
    }]);
    expect(first.targets).toEqual([{ agentId: "conversation-1" }]);

    first.fire("agent_event", { type: "user_prompt" });
    first.fire("agent_event", { type: "turn_finished" });
    first.fire("conversation_changed");
    first.fire("transcript_changed");
    expect(first.notices).toHaveLength(1);

    const reattached = watcher(home);
    reattached.fire("transcript_changed");
    reattached.fire("agent_event", { type: "user_prompt" });
    reattached.fire("agent_event", { type: "turn_finished" });
    expect(reattached.notices).toEqual([]);

    reattached.setAgent("conversation-2");
    reattached.fire("conversation_changed");
    reattached.fire("agent_event", { type: "user_prompt" });
    reattached.fire("agent_event", { type: "turn_finished" });
    expect(reattached.notices).toHaveLength(1);
    reattached.setAgent("conversation-1");
    reattached.fire("conversation_changed");
    reattached.fire("transcript_changed");
    expect(reattached.notices).toHaveLength(1);

    const storage = extensionStorage("vera.context", { profile: home, machine: home });
    const names = readdirSync(join(storage.profile, "instruction-budget-notices"));
    expect(names.sort()).toEqual(["conversation-1", "conversation-2"].map((id) =>
        createHash("sha256").update(id).digest("hex")
    ).sort());
});

test("@core instruction budget retains the newest markers and can warn after pruning", () => {
    const home = testHome();
    const storage = extensionStorage("vera.context", { profile: home, machine: home });
    const directory = join(storage.profile, "instruction-budget-notices");
    mkdirSync(directory);
    const marker = (id: string): string => createHash("sha256").update(id).digest("hex");
    expect(MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS).toBe(500);
    for (let index = 0; index < MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS; index++) {
        const path = join(directory, marker(`conversation-${index}`));
        writeFileSync(path, "");
        utimesSync(path, 1_700_000_000 + index, 1_700_000_000 + index);
    }

    expect(claimInstructionBudgetNotice(storage.profile, "new-conversation")).toBe(true);
    const retained = new Set(readdirSync(directory));
    expect(retained.size).toBe(MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS);
    expect(retained.has(marker("conversation-0"))).toBe(false);
    expect(retained.has(marker("new-conversation"))).toBe(true);
    for (let index = 1; index < MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS; index++) {
        expect(retained.has(marker(`conversation-${index}`))).toBe(true);
    }

    const pruned = watcher(home, "conversation-0");
    pruned.fire("agent_event", { type: "turn_finished" });
    expect(pruned.notices).toHaveLength(1);
    const afterWarning = new Set(readdirSync(directory));
    expect(afterWarning.size).toBe(MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS);
    expect(afterWarning.has(marker("conversation-0"))).toBe(true);
    expect(afterWarning.has(marker("conversation-1"))).toBe(false);
});

test("instruction budget prunes an existing oversized store on a repeated claim", () => {
    const home = testHome();
    const storage = extensionStorage("vera.context", { profile: home, machine: home });
    const directory = join(storage.profile, "instruction-budget-notices");
    mkdirSync(directory);
    const total = MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS + 700;
    for (let index = 0; index < total; index++) {
        const name = createHash("sha256").update(`conversation-${index}`).digest("hex");
        const path = join(directory, name);
        writeFileSync(path, "");
        utimesSync(path, 1_700_000_000 + index, 1_700_000_000 + index);
    }
    writeFileSync(join(directory, "unrelated"), "keep");

    expect(claimInstructionBudgetNotice(storage.profile, `conversation-${total - 1}`)).toBe(false);
    const retained = new Set(readdirSync(directory));
    expect(retained.has("unrelated")).toBe(true);
    expect(retained.size).toBe(MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS + 1);
    for (let index = 0; index < total; index++) {
        const name = createHash("sha256").update(`conversation-${index}`).digest("hex");
        expect(retained.has(name)).toBe(index >= total - MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS);
    }
});

test("@core instruction budget bounds markers across concurrent client claims", async () => {
    const home = testHome();
    const storage = extensionStorage("vera.context", { profile: home, machine: home });
    const directory = join(storage.profile, "instruction-budget-notices");
    mkdirSync(directory);
    for (let index = 0; index < MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS - 5; index++) {
        const name = createHash("sha256").update(`old-${index}`).digest("hex");
        const path = join(directory, name);
        writeFileSync(path, "");
        utimesSync(path, 1_700_000_000 + index, 1_700_000_000 + index);
    }
    const program = `
        import { claimInstructionBudgetNotice } from ${JSON.stringify(new URL("../../src/core-extensions/context/instruction-budget-store.ts", import.meta.url).href)};
        console.log(claimInstructionBudgetNotice(process.argv[1], process.argv[2]));
    `;
    const children = Array.from({ length: 8 }, (_, index) => Bun.spawn([
        process.execPath, "-e", program, storage.profile, `new-${index}`,
    ], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (child) => ({
        code: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
    })));
    expect(results.map((result) => result.code)).toEqual(Array(8).fill(0));
    expect(results.map((result) => result.stdout)).toEqual(Array(8).fill("true"));
    expect(results.map((result) => result.stderr)).toEqual(Array(8).fill(""));
    expect(readdirSync(directory).length).toBe(MAX_INSTRUCTION_BUDGET_NOTICE_MARKERS);
    for (let index = 0; index < 8; index++) {
        expect(claimInstructionBudgetNotice(storage.profile, `new-${index}`)).toBe(false);
    }
});

test("instruction budget claims are shared by independent client instances", () => {
    const home = testHome();
    const first = watcher(home);
    const second = watcher(home);
    first.fire("agent_event", { type: "user_prompt" });
    second.fire("agent_event", { type: "user_prompt" });
    first.fire("agent_event", { type: "turn_finished" });
    second.fire("agent_event", { type: "turn_finished" });
    expect(first.notices.length + second.notices.length).toBe(1);
});

test("@core instruction budget markers survive process replacement and atomic claims", async () => {
    const home = testHome();
    const program = `
        import { extensionStorage } from ${JSON.stringify(new URL("../../src/extensions/storage.ts", import.meta.url).href)};
        import { claimInstructionBudgetNotice } from ${JSON.stringify(new URL("../../src/core-extensions/context/instruction-budget-store.ts", import.meta.url).href)};
        const home = process.argv[1];
        const storage = extensionStorage("vera.context", { profile: home, machine: home });
        console.log(claimInstructionBudgetNotice(storage.profile, "conversation-1"));
    `;
    const start = () => Bun.spawn([process.execPath, "-e", program, home], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const first = start();
    const second = start();
    const output = await Promise.all([first, second].map(async (child) => ({
        code: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
    })));
    expect(output.map((item) => item.code)).toEqual([0, 0]);
    expect(output.map((item) => item.stderr)).toEqual(["", ""]);
    expect(output.map((item) => item.stdout).sort()).toEqual(["false", "true"]);

    const resumed = watcher(home);
    resumed.fire("agent_event", { type: "turn_finished" });
    expect(resumed.notices).toEqual([]);
});

test("instruction budget does not claim a warning without the main agent or its projection", () => {
    const home = testHome();
    const client = watcher(home);
    client.setAgent(undefined);
    client.fire("transcript_changed");
    client.setAgent("conversation-1");
    client.setMainSnapshot({ availability: "unavailable" });
    client.setFocusedSnapshot(overBudget);
    client.fire("transcript_changed");
    expect(client.notices).toEqual([]);
    client.setMainSnapshot(overBudget);
    client.fire("agent_event", { type: "user_prompt" });
    client.fire("agent_event", { type: "turn_finished" });
    expect(client.notices).toHaveLength(1);
});

test("instruction budget records only a conversation that has exceeded the budget", () => {
    const home = testHome();
    const client = watcher(home);
    client.setMainSnapshot({
        ...overBudget,
        projection: {
            estimatedTokens: 7_000,
            components: [{
                kind: "prompt_contribution",
                id: "core.user-rules",
                owner: "core",
                source: "contextual",
                displayName: "User rules",
                count: 1,
                estimatedTokens: 7_000,
            }],
        },
    });
    client.fire("agent_event", { type: "turn_finished" });
    expect(client.notices).toEqual([]);
    client.setMainSnapshot(overBudget);
    client.fire("agent_event", { type: "turn_finished" });
    expect(client.notices).toHaveLength(1);
});

test("instruction budget retries when profile storage is temporarily unavailable", () => {
    const home = testHome();
    const storage = extensionStorage("vera.context", { profile: home, machine: home });
    const path = join(storage.profile, "instruction-budget-notices");
    writeFileSync(path, "not a directory");
    const client = watcher(home);
    client.fire("agent_event", { type: "user_prompt" });
    client.fire("agent_event", { type: "turn_finished" });
    expect(client.notices).toEqual([]);
    rmSync(path);
    mkdirSync(path);
    client.fire("transcript_changed");
    expect(client.notices).toHaveLength(1);
});

test("a disabled budget does not mark the conversation warned", () => {
    const home = testHome();
    const disabled = watcher(home, "conversation-1", 0);
    disabled.fire("agent_event", { type: "turn_finished" });
    expect(disabled.notices).toEqual([]);
    const enabled = watcher(home);
    enabled.fire("agent_event", { type: "turn_finished" });
    expect(enabled.notices).toHaveLength(1);
});
