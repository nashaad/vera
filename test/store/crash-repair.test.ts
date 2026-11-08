import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage } from "../../src/model/types.ts";
import {
    CRASHED_TOOL_RESULT,
    CRASH_CUT_MESSAGE,
    SessionStore,
    readSessionSnapshot,
    readSessionTurnState,
} from "../../src/store/session-store.ts";

test("crash repair pairs unanswered calls and writes one cut marker", async () => {
    expect(CRASHED_TOOL_RESULT).toBe("The host stopped before this tool call finished, so its result was not recorded and its effect is unknown. Check the workspace before relying on it or running it again.");
    expect(CRASH_CUT_MESSAGE).toBe("Vera crashed before this turn finished.");
    const root = await mkdtemp(join(tmpdir(), "vera-crash-store-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the deck" }] }, { turnStart: true });
        await store.appendMessage({
            role: "assistant",
            content: [
                { type: "tool_call", id: "read-1", name: "read", input: { path: "deck" } },
                { type: "tool_call", id: "write-1", name: "write", input: { path: "log", content: "ahoy" } },
                { type: "tool_call", id: "read-2", name: "read", input: { path: "map" } },
            ],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendMessage({
            role: "tool_result", toolCallId: "read-2", toolName: "read",
            content: [{ type: "text", text: "map" }], isError: false,
        });
        await store.appendHarnessMessage("Stopped: Vera is stopping", "error");
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);

        const reopened = await SessionStore.open(path);
        expect(await reopened.repairCrashedTurn()).toBe(true);
        expect(reopened.messages().slice(-2)).toEqual([
            { role: "tool_result", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: CRASHED_TOOL_RESULT }], isError: true },
            { role: "tool_result", toolCallId: "write-1", toolName: "write", content: [{ type: "text", text: CRASHED_TOOL_RESULT }], isError: true },
        ]);
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        const snapshot = await readSessionSnapshot(path);
        expect(snapshot.harnessMessages.at(-1)).toEqual({ afterMessage: 5, text: CRASH_CUT_MESSAGE, tone: "soft" });
        expect(JSON.stringify(snapshot.messages)).not.toContain(CRASH_CUT_MESSAGE);
        const repaired = await readFile(path, "utf8");
        expect(JSON.parse(repaired.trimEnd().split("\n").at(-1)!)).toMatchObject({
            type: "harness_message", text: CRASH_CUT_MESSAGE, tone: "soft", crashCut: true,
        });
        expect(JSON.stringify(snapshot)).not.toContain("crashCut");

        const again = await SessionStore.open(path);
        expect(await again.repairCrashedTurn()).toBe(false);
        expect(await readFile(path, "utf8")).toBe(repaired);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a cut prompt gets only a marker, and a completed session is untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-crash-store-"));
    try {
        const path = join(root, "crow.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Ahoy" }] }, { turnStart: true });
        expect(await store.repairCrashedTurn()).toBe(true);
        expect(store.messages()).toHaveLength(1);
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        const repaired = await readFile(path, "utf8");
        expect(await (await SessionStore.open(path)).repairCrashedTurn()).toBe(false);
        expect(await readFile(path, "utf8")).toBe(repaired);

        const donePath = join(root, "done.jsonl");
        const done = await SessionStore.create(donePath, { sessionId: "done", cwd: root });
        await done.appendMessage({ role: "user", content: [{ type: "text", text: "Ahoy" }] });
        await done.appendMessage({
            role: "assistant", content: [{ type: "text", text: "Ahoy" }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(), stopReason: "stop",
        });
        const original = await readFile(donePath, "utf8");
        expect(await (await SessionStore.open(donePath)).repairCrashedTurn()).toBe(false);
        expect(await readFile(donePath, "utf8")).toBe(original);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a cut delivery is visible and is not an unanswered delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-crash-delivery-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.recordDelivery({ id: "child-1", sourceAgentId: "child", content: "Found the map" });
        await store.appendDeliveryMessage("child-1", {
            role: "user", internal: true, content: [{ type: "text", text: "Found the map" }],
        }, { turnStart: true });
        expect(store.hasUnansweredDeliveryTurn()).toBe(true);
        expect(await store.repairCrashedTurn()).toBe(true);
        expect(store.hasUnansweredDeliveryTurn()).toBe(false);
        expect(store.projectedHarnessMessages()).toEqual([
            { afterMessage: 1, text: CRASH_CUT_MESSAGE, tone: "soft" },
        ]);
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "What next?" }] }, { turnStart: true });
        expect(store.hasUnansweredDeliveryTurn()).toBe(false);
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a cut prompt does not add results for calls in an earlier turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-crash-prompt-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({
            role: "assistant", content: [{ type: "tool_call", id: "old", name: "read", input: {} }],
            source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
        });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Try again" }] }, { turnStart: true });
        expect(await store.repairCrashedTurn()).toBe(true);
        expect(store.messages().map((message) => message.role)).toEqual(["assistant", "user"]);
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a terminal failure is not repaired after its last user message", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-crash-failure-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "Ahoy" }] }, { turnStart: true });
        await store.appendAgentFailure("failure-1", "Stopped unexpectedly");
        const before = await readFile(path, "utf8");
        expect(await (await SessionStore.open(path)).repairCrashedTurn()).toBe(false);
        expect(await readFile(path, "utf8")).toBe(before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
