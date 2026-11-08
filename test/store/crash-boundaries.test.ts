import { expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { restoreContextAfterCompaction, type RunTurnState } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage, type UserMessage } from "../../src/model/types.ts";
import { createSessionBranch } from "../../src/store/session-branch.ts";
import { CRASH_CUT_MESSAGE, openSessionForRecovery, readSessionIndexMetadata, readSessionSnapshot, readSessionTurnState, SessionStore } from "../../src/store/session-store.ts";
import { searchSessionFile } from "../../src/store/session-search.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }] });
const answer = (): AssistantMessage => ({
    role: "assistant", content: [{ type: "text", text: "The crow has the map." }],
    source: { provider: "faux", api: "scripted", model: "test" },
    usage: emptyUsage(), stopReason: "stop", turnTiming: { durationMs: 1, finishedAt: 1 },
});

async function expectNoCrash(path: string): Promise<void> {
    const before = await readFile(path, "utf8");
    expect((await readSessionTurnState(path)).turnOpen).toBe(false);
    await openSessionForRecovery(path);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readSessionSnapshot(path)).harnessMessages.some((entry) => entry.text === CRASH_CUT_MESSAGE)).toBe(false);
}

test("turn start and its first message are one durable record", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-turn-start-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        const first = await store.appendMessage(user("chart the cove"), { turnStart: true });
        const records = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
        expect(records).toHaveLength(2);
        expect(records[1]).toMatchObject({ type: "turn_start", id: first.id, message: user("chart the cove") });
        expect(await readSessionIndexMetadata(path)).toMatchObject({ title: "chart the cove", hasUserContent: true });
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);
        const search = await searchSessionFile(path, new Date().toISOString(), "chart", { query: "chart" }, 10);
        expect(search?.hits).toHaveLength(1);
        expect(await (await SessionStore.open(path)).repairCrashedTurn()).toBe(true);
        expect((await readSessionSnapshot(path)).harnessMessages.at(-1)?.text).toBe(CRASH_CUT_MESSAGE);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a legacy user-only file is left alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-legacy-tail-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage(user("chart the cove"));
        await expectNoCrash(path);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a torn turn-start record leaves neither a message nor start evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-torn-turn-start-"));
    const path = join(root, "session.jsonl");
    try {
        await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await appendFile(path, '{"type":"turn_start","id":"unfinished"');
        const reopened = await SessionStore.open(path);
        expect(reopened.messages()).toEqual([]);
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        expect(await reopened.repairCrashedTurn()).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("passive context inside a running turn does not hide a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-running-context-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage(user("chart the cove"), { turnStart: true });
        await store.appendMessage({ ...user("The map is ready."), internal: true, contextSource: "session_start" });
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);
        await openSessionForRecovery(path);
        expect((await readSessionSnapshot(path)).harnessMessages.at(-1)?.text).toBe(CRASH_CUT_MESSAGE);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a continued reply stays open until the final assistant outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-continued-turn-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage(user("chart the cove"), { turnStart: true });
        const { turnTiming: _turnTiming, ...continued } = answer();
        await store.appendMessage(continued);
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);
        await store.appendMessage({ ...user("Check the map."), internal: true, contextSource: "turn_ending" });
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);
        await openSessionForRecovery(path);
        expect((await readSessionSnapshot(path)).harnessMessages.at(-1)?.text).toBe(CRASH_CUT_MESSAGE);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const stopReason of ["stop", "length"] as const) {
    test(`a crash after an intermediate ${stopReason} reply leaves older calls alone`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-intermediate-reply-"));
        const path = join(root, "session.jsonl");
        try {
            const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
            await store.appendMessage({
                role: "assistant", content: [{ type: "tool_call", id: "old", name: "read", input: {} }],
                source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
            });
            await store.appendMessage(user("new prompt"), { turnStart: true });
            const { turnTiming: _turnTiming, ...continued } = answer();
            await store.appendMessage({ ...continued, stopReason });
            expect((await readSessionTurnState(path)).turnOpen).toBe(true);
            await openSessionForRecovery(path);
            const snapshot = await readSessionSnapshot(path);
            expect(snapshot.messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
            expect(snapshot.harnessMessages.at(-1)?.text).toBe(CRASH_CUT_MESSAGE);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("an interrupted close pairs calls and writes the existing abort outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-abort-tail-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage(user("chart the cove"), { turnStart: true });
        await store.appendMessage({
            role: "assistant", content: [{ type: "tool_call", id: "read-1", name: "read", input: {} }],
            source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
        });
        expect(await store.finishAbortedTurn()).toBe(true);
        expect(store.messages().slice(-2)).toEqual([
            { role: "tool_result", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Turn aborted" }], isError: true },
            { role: "assistant", content: [], source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "aborted", errorMessage: "Turn aborted" },
        ]);
        expect(await store.finishAbortedTurn()).toBe(false);
        await expectNoCrash(path);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a branch does not inherit a running turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-branch-tail-"));
    try {
        const source = await SessionStore.create(join(root, "source.jsonl"), { sessionId: "source", cwd: root });
        await source.appendMessage(user("chart the cove"), { turnStart: true });
        const path = join(root, "branch.jsonl");
        await createSessionBranch({ source, destinationPath: path, sessionId: "branch", position: "at" });
        expect(await readFile(path, "utf8")).not.toContain('"type":"turn_start"');
        await expectNoCrash(path);
        expect((await readSessionTurnState(source.path)).turnOpen).toBe(true);
        const branch = await SessionStore.open(path);
        await branch.appendMessage(user("new prompt"), { turnStart: true });
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);
        await openSessionForRecovery(path);
        expect((await readSessionSnapshot(path)).harnessMessages.at(-1)?.text).toBe(CRASH_CUT_MESSAGE);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a fork before a second prompt leaves the copied user tail alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-fork-tail-"));
    try {
        const source = await SessionStore.create(join(root, "source.jsonl"), { sessionId: "source", cwd: root });
        await source.appendMessage(user("first"), { turnStart: true });
        const second = await source.appendMessage(user("second"));
        await source.appendMessage(answer());
        const path = join(root, "fork.jsonl");
        await createSessionBranch({ source, destinationPath: path, sessionId: "fork", position: "before", entryId: second.id });
        await expectNoCrash(path);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const tail of ["user", "tool_result"] as const) {
    test(`rewind to a ${tail} tail does not reopen its old turn`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-rewind-tail-"));
        const path = join(root, "session.jsonl");
        try {
            const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
            await store.appendMessage(user("first"), { turnStart: true });
            if (tail === "tool_result") {
                await store.appendMessage({
                    role: "assistant", content: [{ type: "tool_call", id: "read-1", name: "read", input: {} }],
                    source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
                });
                await store.appendMessage({ role: "tool_result", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "map" }], isError: false });
            }
            const second = await store.appendMessage(user("second"));
            await store.appendMessage(answer());
            await store.rewindBefore(second.id);
            expect(store.messages().at(-1)?.role).toBe(tail);
            await expectNoCrash(path);
            await store.appendMessage(user("new prompt"), { turnStart: true });
            expect((await readSessionTurnState(path)).turnOpen).toBe(true);
            await openSessionForRecovery(path);
            expect((await readSessionSnapshot(path)).harnessMessages.at(-1)?.text).toBe(CRASH_CUT_MESSAGE);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("context restored after idle compaction does not start a turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-compact-tail-"));
    const path = join(root, "session.jsonl");
    const runtime = new ToolRuntime(root);
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage(user("first"), { turnStart: true });
        const firstAnswer = await store.appendMessage(answer());
        const retained = await store.appendMessage(user("second"), { turnStart: true });
        await store.appendMessage(answer());
        await store.appendCompaction({
            boundaryMessageId: firstAnswer.id, firstRetainedMessageId: retained.id,
            projection: [user("summary")], measured: { inputTokens: 1, estimated: true },
        });
        const hooks = new ToolHooks();
        hooks.registerSessionStart(() => ({ power: "mutate", context: "The map is ready." }));
        const events = new EngineEventBus();
        const channel = createInProcessChannel();
        const state: RunTurnState = {
            sessionId: "crow", messages: [...store.messages()], store, toolRuntime: runtime,
            inbound: new InboundCommandRouter(channel.engine, events), events, hooks,
            approvalMode: "auto", loadOptionalContext: false,
        };
        expect(await restoreContextAfterCompaction(state)).toBe(true);
        expect(store.messages().at(-1)).toMatchObject({ role: "user", contextSource: "session_start" });
        await expectNoCrash(path);
    } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
    }
});
