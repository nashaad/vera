import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationCosts } from "../../extensions/budget/conversation-cost.ts";
import { conversationCost } from "../../extensions/budget/budget.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { budgetAsk, budgetReply, writeBudgetTranscript } from "../support/budget-transcript.ts";

function fixture(run: (path: string, costs: ConversationCosts) => void): void {
    const directory = fs.mkdtempSync(join(tmpdir(), "budget-totals-"));
    try {
        run(join(directory, "voyage.jsonl"), new ConversationCosts());
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test("incremental totals match the full scan on an 80 MiB transcript and repeated appends", () => {
    fixture((path, costs) => {
        writeBudgetTranscript(path, 80 * 1024 * 1024);
        expect(costs.read(path)).toEqual(conversationCost(path));
        for (let index = 0; index < 5; index++) {
            fs.appendFileSync(path, budgetReply(index * 0.0000000004) + budgetReply());
            expect(costs.read(path)).toEqual(conversationCost(path));
        }
    });
});

test("replacement, shrink, same-size rewrite, growing rewrite and deletion rebuild totals", () => {
    fixture((path, costs) => {
        for (const source of [budgetReply(1), budgetReply(2), budgetReply(3) + budgetReply(4), budgetReply(5)]) {
            fs.writeFileSync(path, source);
            expect(costs.read(path)).toEqual(conversationCost(path));
        }
        fs.writeFileSync(`${path}.new`, budgetReply(8));
        fs.renameSync(`${path}.new`, path);
        expect(costs.read(path)).toEqual(conversationCost(path));
        fs.rmSync(path);
        expect(costs.read(path)).toEqual(conversationCost(path));
        fs.writeFileSync(path, budgetReply(9));
        expect(costs.read(path)).toEqual(conversationCost(path));
    });
});

test("unknown prices, skipped records, nonterminated lines and UTF-8 chunk boundaries preserve the full scan", () => {
    fixture((path, costs) => {
        const entries = [
            budgetReply(0), budgetReply(-1), budgetReply(),
            budgetReply(1).replace('"cost":1', '"cost":1e999'),
            budgetReply(1).replace('"cost":1', '"cost":"1"'),
            budgetReply(2).replace('"api":"fixture"', '"api":"none"'),
            '{"type":"message","message":{"role":"user"}}\n',
            '{"type":"compaction"}\n', '{"type":"compaction","billed":null}\n',
            '{"type":"compaction","billed":{"usage":{"cost":0.5}}}\n',
            budgetAsk(12), budgetAsk(),
            budgetReply(0.25, "🏴‍☠️".repeat(20000)), "  \r\n",
            budgetReply(0.75).trimEnd(),
        ];
        fs.writeFileSync(path, entries.join(""));
        expect(costs.read(path)).toEqual(conversationCost(path));
        expect(costs.read(path)).toEqual(conversationCost(path));
        fs.appendFileSync(path, "\n" + budgetReply(1));
        expect(costs.read(path)).toEqual(conversationCost(path));
        fs.appendFileSync(path, '  {"type":"compaction","billed":');
        expect(() => costs.read(path)).toThrow();
        expect(() => conversationCost(path)).toThrow();
        fs.appendFileSync(path, '{"usage":{"cost":1}}}\n');
        expect(costs.read(path)).toEqual(conversationCost(path));
    });
});

test("rewind keeps recorded spending and a branch has its own totals", async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "budget-branches-"));
    const costs = new ConversationCosts();
    const path = join(directory, "voyage.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "voyage", cwd: directory });
        const user = await store.appendMessage({ role: "user", content: [{ type: "text", text: "Find the treasure." }] });
        const reply = JSON.parse(budgetReply(0.3)).message;
        await store.appendMessage(reply);
        expect(costs.read(path).dollars).toBe(0.3);
        await store.rewindBefore(user.id);
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Chart the islands." }] });
        await store.appendMessage(reply);
        expect(costs.read(path)).toEqual(conversationCost(path));
        expect(costs.read(path).dollars).toBe(0.6);
        const branchPath = join(directory, "branch.jsonl");
        const branch = await SessionStore.create(branchPath, { sessionId: "branch", cwd: directory,
            origin: { sessionId: "voyage", entryId: user.id, position: "before" } });
        await branch.appendMessage(reply);
        expect(costs.read(branchPath)).toEqual(conversationCost(branchPath));
        expect(costs.read(branchPath).dollars).toBe(0.3);
        expect(costs.read(path).dollars).toBe(0.6);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("both readers total what session usage counts, including side questions", async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "budget-usage-"));
    const path = join(directory, "voyage.jsonl");
    const costs = new ConversationCosts();
    try {
        const store = await SessionStore.create(path, { sessionId: "voyage", cwd: directory });
        const first = await store.appendMessage({ role: "user", content: [{ type: "text", text: "Find the treasure." }] });
        await store.appendMessage({ role: "assistant", content: [{ type: "text", text: "Charting." }],
            source: { provider: "fixture", api: "fixture", model: "fixture" },
            usage: { ...emptyUsage(), cost: 0.25 }, stopReason: "stop" });
        await store.rewindBefore(first.id);
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Try again." }] });
        const second = await store.appendMessage({ role: "assistant", content: [{ type: "text", text: "A new course." }],
            source: { provider: "fixture", api: "fixture", model: "fixture" },
            usage: { ...emptyUsage(), cost: 0.125 }, stopReason: "stop" });
        await store.appendCompaction({
            boundaryMessageId: second.id,
            firstRetainedMessageId: null,
            projection: [{ role: "user", content: [{ type: "text", text: "A map of the islands." }] }],
            measured: { inputTokens: 12, estimated: true },
            billed: { provider: "fixture", model: "fixture", usage: { ...emptyUsage(), cost: 0.5 } },
        });
        await store.appendMessage({ role: "assistant", content: [{ type: "text", text: "No price." }],
            source: { provider: "fixture", api: "fixture", model: "fixture" },
            usage: emptyUsage(), stopReason: "stop" });
        await store.appendMessage({ role: "assistant", content: [{ type: "text", text: "Imported." }],
            source: { provider: "claude-code", api: "none", model: "claude-code" },
            usage: { ...emptyUsage(), cost: 10 }, stopReason: "stop" });
        await store.appendAskBilling({ provider: "fixture", model: "fixture",
            usage: { ...emptyUsage(), cost: 0.75 } });
        await store.appendAskBilling({ provider: "fixture", model: "fixture", usage: emptyUsage() });

        const usage = store.usageMessages();
        const reported = usage.reduce((sum, message) => sum + (message.usage.cost ?? 0), 0);
        expect(reported).toBe(1.625);
        expect(usage.filter((message) => message.usage.cost === undefined)).toHaveLength(2);
        for (const reader of [conversationCost(path), costs.read(path)]) {
            expect(reader.dollars).toBe(reported);
            expect(reader.priced).toBe(4);
            expect(reader.unpriced).toBe(2);
        }
        expect(conversationCost(path)).toEqual(costs.read(path));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("model requests read only appends after the command builds totals and skip disabled budgets", async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "budget-request-"));
    const sessionPath = join(directory, "voyage.jsonl");
    const sessionId = crypto.randomUUID();
    writeBudgetTranscript(sessionPath, 8 * 1024 * 1024);
    const registry = await startExtensionRegistry({ extensions: [{
        path: new URL("../../extensions/budget", import.meta.url).pathname, enabled: true, config: {},
    }] });
    const spy = spyOn(fs, "readSync");
    try {
        await registry.invokeCommand("budget", "100", directory, undefined, sessionId, sessionPath);
        expect(spy.mock.calls.length).toBeGreaterThan(100);
        const wrapped = registry.modelMiddleware()[0]!({ stream: (request) => new FauxAdapter([{ role: "assistant", content: [],
            source: { provider: "fixture", api: "fixture", model: "fixture" }, usage: emptyUsage(), stopReason: "stop" }]).stream(request) },
        { sessionId, sessionPath, workspace: directory, provider: "fixture", purpose: "turn",
            ask: async () => ({ outcome: "selected", choice: { id: "ignore", label: "Ignore budget and continue" } }) });
        spy.mockClear();
        expect((await wrapped.stream({ model: "fixture", messages: [] }).result()).stopReason).toBe("stop");
        expect(spy).not.toHaveBeenCalled();
        const before = fs.statSync(sessionPath).size;
        const appended = budgetReply(0.25);
        fs.appendFileSync(sessionPath, appended);
        expect((await wrapped.stream({ model: "fixture", messages: [] }).result()).stopReason).toBe("stop");
        const reads = spy.mock.calls as unknown as [number, Buffer, number, number, number][];
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.reduce((sum, call) => sum + call[3], 0)).toBeLessThanOrEqual(8192 + Buffer.byteLength(appended));
        expect(reads.every((call) => call[4] >= before - 4096)).toBe(true);
        await registry.invokeCommand("budget", "", directory, undefined, sessionId, sessionPath);
        spy.mockClear();
        fs.appendFileSync(sessionPath, budgetReply(0.5));
        expect((await wrapped.stream({ model: "fixture", messages: [] }).result()).stopReason).toBe("stop");
        expect(spy).not.toHaveBeenCalled();
        const enabled = await registry.invokeCommand("budget", "100", directory, undefined, sessionId, sessionPath);
        expect(enabled.body).toMatchObject({ text: expect.stringContaining(`Known spend: $${conversationCost(sessionPath).dollars.toFixed(2)}`) });
        await registry.invokeCommand("budget", "0", directory, undefined, sessionId, sessionPath);
        expect((await wrapped.stream({ model: "fixture", messages: [] }).result()).stopReason).toBe("stop");
        spy.mockClear();
        fs.appendFileSync(sessionPath, budgetReply(0.5));
        expect((await wrapped.stream({ model: "fixture", messages: [] }).result()).stopReason).toBe("stop");
        expect(spy).not.toHaveBeenCalled();
    } finally {
        spy.mockRestore();
        await registry.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
