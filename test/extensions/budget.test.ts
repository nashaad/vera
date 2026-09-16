import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConversationBudget, conversationCost } from "../../extensions/budget/budget.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { startClientExtensionRegistry } from "../../src/extensions/client-registry.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import type { UserQuestionResult } from "../../src/engine/inbound-command-router.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function assistantText(text: string): AssistantMessage {
    return { role: "assistant", content: [{ type: "text", text }],
        source: { provider: "faux", api: "fixture", model: "fixture" }, usage: emptyUsage(), stopReason: "stop" };
}

const path = new URL("../../extensions/budget", import.meta.url).pathname;

test("reminders fire once below the limit and approval repeats at the limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "budget-reminders-"));
    try {
        const budget = new ConversationBudget(directory);
        budget.set("s", 1);
        const cost = (dollars: number) => ({ dollars, priced: 1, unpriced: 0 });
        expect(budget.reminder("s", cost(0.49), true)).toBeUndefined();
        expect(budget.reminder("s", cost(0.5), true)).toContain("Halfway through budget");
        expect(new ConversationBudget(directory).reminder("s", cost(0.75), true)).toBeUndefined();
        expect(budget.reminder("s", cost(0.8), true)).toContain("80%");
        expect(budget.reminder("s", cost(1), true)).toBeUndefined();
        expect(budget.approval("s", cost(1))).toBe("Budget reached: $1.00 / $1.00.");
        expect(budget.approval("s", cost(1))).toBe("Budget reached: $1.00 / $1.00.");
        budget.set("s", 3);
        expect(budget.reminder("s", cost(1.5), true)).toBe("Halfway through budget: $1.50 spent of $3.00. $1.50 remaining.");
        expect(budget.approval("s", cost(3.25))).toBe("Budget exceeded: $3.25 / $3.00.");
        budget.ignore("s");
        expect(new ConversationBudget(directory).approval("s", cost(4))).toBeUndefined();
        expect(new ConversationBudget(directory).reminder("s", cost(4), true)).toBeUndefined();
        expect(budget.approval("another-session", cost(4))).toBeUndefined();
        budget.set("s", 3);
        expect(budget.approval("s", cost(4))).toContain("Budget exceeded");
        budget.set("s", -1);
        expect(new ConversationBudget(directory).reminder("s", cost(10), true)).toBeUndefined();
        expect(() => budget.set("s", -2)).toThrow();
        expect(() => budget.set("s", NaN)).toThrow();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("commands and reminders use recorded cost and missing confirmation stops spending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "budget-command-"));
    const id = randomUUID();
    const sessionPath = join(directory, `${id}.jsonl`);
    const store = await SessionStore.create(sessionPath, { sessionId: id, cwd: directory });
    const priced = { ...assistantText("first"), usage: { ...emptyUsage(), cost: 0.5 } };
    await store.appendMessage(priced);
    let registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: {} }] });
    const received: ModelRequest[] = [];
    try {
        const command = (args: string) => registry.invokeCommand("budget", args, directory, undefined, id, sessionPath);
        expect((await command("1")).body).toMatchObject({ text: expect.stringContaining("Budget changed to $1.00. Spent: $0.50. Remaining: $0.50.") });
        expect(registry.sessionState(id)).toEqual({ "vera.budget": { dollars: 1 } });
        const wrapped = registry.modelMiddleware()[0]!({ stream(request) {
            received.push(request);
            return new FauxAdapter([assistantText("done")]).stream(request);
        } }, { sessionId: id, sessionPath, workspace: directory, provider: "faux" });
        await wrapped.stream({ model: "fixture", messages: [] }).result();
        expect(JSON.stringify(received[0]!.messages)).toContain("Halfway through budget");
        await registry.close();
        registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: {} }] });
        expect(registry.sessionState(id)).toEqual({ "vera.budget": { dollars: 1 } });
        expect((await command(".5")).body).toMatchObject({ text: expect.stringContaining("Budget changed to $0.50") });
        expect((await command("0.5")).body).toMatchObject({ text: expect.stringContaining("Budget changed to $0.50") });
        await expect(command("dollars")).rejects.toThrow("Use /budget 0.50");
        expect((await command("  ")).body).toMatchObject({ text: expect.stringContaining("Budget reminders off") });
        expect(registry.sessionState(id)).toEqual({ "vera.budget": { dollars: -1 } });
        await registry.close();
        registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: {} }] });
        expect(registry.sessionState(id)).toEqual({ "vera.budget": { dollars: -1 } });
        expect((await command("-1")).body).toMatchObject({ text: expect.stringContaining("Budget reminders off") });
        await wrapped.stream({ model: "fixture", messages: [] }).result();
        expect(received[1]!.messages).toHaveLength(0);
        expect(conversationCost(sessionPath).dollars).toBe(0.5);
        expect((await command("0")).body).toMatchObject({ text: expect.stringContaining("Budget changed to $0.00") });
        expect((await wrapped.stream({ model: "fixture", messages: [] }).result()).stopReason).toBe("aborted");
        expect(received).toHaveLength(2);
    } finally {
        await registry.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("sidebar distinguishes reported, partial, zero, and unavailable cost", async () => {
    const registry = await startClientExtensionRegistry({
        extensions: [{ path, enabled: true, config: {} }],
        preferences: { get: async () => undefined, set: async () => {}, delete: async () => {} },
        modelSettings: { current: () => undefined, update: async () => ({ status: "rejected", reason: "unavailable" }), subscribe: () => () => {} },
        picker: { request: async () => ({ outcome: "cancelled" }) },
        notice: { post: () => {} },
    });
    try {
        const render = (cost: number | undefined, unpriced: number, calls = 2, budget = -1) => registry.renderSidebarSummary({ extensionState: { "vera.budget": { dollars: budget } }, usage: { rows: [{
            ...emptyUsage(), provider: "faux", model: "fixture", durationMs: 0,
            ...(cost === undefined ? {} : { cost }), calls, callsWithoutCost: unpriced,
        }] } });
        expect(render(0.5, 0)).toEqual([{ label: "Cost", value: "$0.50" }]);
        expect(render(0.5, 1)).toEqual([{ label: "Known cost", value: "$0.50" }]);
        expect(render(undefined, 2)).toEqual([{ label: "Cost", value: "unavailable" }]);
        expect(render(0, 0)).toEqual([{ label: "Cost", value: "$0.00" }]);
        expect(render(1.75, 0, 7, 3)).toEqual([{ label: "Cost", value: "$1.75 / $3.00 · 58%" }]);
        expect(render(3.25, 0, 13, 3)).toEqual([{ label: "Cost", value: "$3.25 / $3.00 · 108%" }]);
        expect(render(1.75, 1, 8, 3)).toEqual([{ label: "Known cost", value: "$1.75 / $3.00 · 58%" }]);
        expect(render(undefined, 2, 2, 3)).toEqual([{ label: "Cost", value: "unavailable / $3.00" }]);
        expect(render(0, 0, 1, 0)).toEqual([{ label: "Cost", value: "$0.00 / $0.00 · 100%" }]);
        expect(render(0.25, 0, 1, 0)).toEqual([{ label: "Cost", value: "$0.25 / $0.00 · over" }]);
    } finally {
        await registry.close();
    }
});

test("approval supports increasing, persistent ignore, reset, and cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "budget-approval-"));
    const id = randomUUID();
    const sessionPath = join(directory, `${id}.jsonl`);
    const store = await SessionStore.create(sessionPath, { sessionId: id, cwd: directory });
    await store.appendMessage({ ...assistantText("prior"), usage: { ...emptyUsage(), cost: 1 } });
    const registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: {} }] });
    let resolve!: (answer: UserQuestionResult) => void;
    let questions = 0;
    const received: ModelRequest[] = [];
    try {
        await registry.invokeCommand("budget", "1", directory, undefined, id, sessionPath);
        const wrapped = registry.modelMiddleware()[0]!({ stream(request) {
            received.push(request);
            return new FauxAdapter([assistantText("next")]).stream(request);
        } }, { sessionId: id, sessionPath, workspace: directory, provider: "faux",
            ask: async (_request, signal) => {
                questions++;
                return new Promise<UserQuestionResult>((accept) => {
                    resolve = accept;
                    signal?.addEventListener("abort", () => accept({ outcome: "cancelled" }), { once: true });
                });
            } });
        const first = wrapped.stream({ model: "fixture", systemPrompt: "unchanged", messages: [] }).result();
        expect(questions).toBe(1);
        expect(received).toHaveLength(0);
        resolve({ outcome: "custom", text: ".5" });
        await Bun.sleep(0);
        expect(questions).toBe(2);
        expect(received).toHaveLength(0);
        resolve({ outcome: "custom", text: "2.5" });
        expect((await first).stopReason).toBe("stop");
        expect(received[0]!.systemPrompt).toBe("unchanged");
        expect(JSON.stringify(received[0]!.messages)).toContain("Budget increased to $2.50");
        expect(registry.sessionState(id)).toEqual({ "vera.budget": { dollars: 2.5 } });
        await wrapped.stream({ model: "fixture", messages: [] }).result();
        expect(questions).toBe(2);
        await registry.invokeCommand("budget", "1", directory, undefined, id, sessionPath);
        const ignoring = wrapped.stream({ model: "fixture", messages: [] }).result();
        resolve({ outcome: "selected", choice: { id: "ignore", label: "Ignore budget and continue" } });
        await ignoring;
        await wrapped.stream({ model: "fixture", messages: [] }).result();
        expect(questions).toBe(3);
        expect(received).toHaveLength(4);
        expect(JSON.stringify(received[2]!.messages)).toContain("The user chose to ignore this budget and continue.");
        expect(received[3]!.messages).toHaveLength(0);
        await registry.invokeCommand("budget", "1", directory, undefined, id, sessionPath);
        const stopped = wrapped.stream({ model: "fixture", messages: [] }).result();
        resolve({ outcome: "selected", choice: { id: "stop", label: "Stop" } });
        expect((await stopped).stopReason).toBe("aborted");
        expect(received).toHaveLength(4);
        const controller = new AbortController();
        const cancelled = wrapped.stream({ model: "fixture", messages: [], signal: controller.signal }).result();
        controller.abort();
        expect((await cancelled).stopReason).toBe("aborted");
        expect(received).toHaveLength(4);
    } finally {
        await registry.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
