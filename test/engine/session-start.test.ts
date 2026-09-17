import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolHooks, MAX_SESSION_START_CONTEXT_BYTES } from "../../src/engine/hooks.ts";
import { measureMessages } from "../../src/engine/context-measurement.ts";
import { fullSummaryStrategy } from "../../src/engine/compaction-full-summary.ts";
import { projectTranscript, type AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { startWorker } from "../../src/host/worker/handle.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import type { SessionStartHook, SessionStartHookPayload } from "../../src/sdk/hooks.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const roots: string[] = [];
const payload: SessionStartHookPayload = {
    type: "session_start", sessionId: "session", workspace: "/work", reason: "start",
};
const adapterModule = new URL("../host/fixtures/worker-session-start-adapter.ts", import.meta.url).pathname;

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vera-session-start-")));
    roots.push(root);
    return root;
}

function reply(): AssistantMessage {
    return {
        role: "assistant", content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(), stopReason: "stop",
    };
}

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Session-start test timed out");
        await Bun.sleep(10);
    }
}

async function finishTurn(client: AgentAttachment): Promise<void> {
    while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
}

test("session-start hooks preserve registration order, isolate payloads, and unregister", async () => {
    const hooks = new ToolHooks();
    hooks.registerSessionStart((input) => {
        (input as { workspace: string }).workspace = "/changed";
        return { power: "mutate", context: "first" };
    });
    hooks.registerSessionStart((input) => {
        expect(input.workspace).toBe("/work");
        return { power: "observe" };
    });
    const remove = hooks.registerSessionStart(() => ({ power: "mutate", context: "removed" }));
    remove();
    hooks.registerSessionStart(() => ({ power: "mutate", context: "last" }));
    expect(await hooks.runSessionStart(payload, { timeoutMs: 100 })).toEqual([
        { index: 1, context: "first" }, { index: 3, context: "last" },
    ]);
    expect(payload.workspace).toBe("/work");
});

test("invalid, oversized, throwing, and timed-out hooks log and allow later hooks", async () => {
    const hooks = new ToolHooks();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
        const invalid: unknown[] = [null, { power: "block", reason: "no" }, { power: "mutate", context: 3 },
            { power: "mutate", context: "é".repeat(MAX_SESSION_START_CONTEXT_BYTES / 2 + 1) }];
        for (const result of invalid) hooks.registerSessionStart((() => result) as SessionStartHook);
        hooks.registerSessionStart(() => { throw new Error("broken"); });
        hooks.registerSessionStart(() => new Promise(() => {}));
        hooks.registerSessionStart(() => ({ power: "mutate", context: "survived" }));
        expect(await hooks.runSessionStart(payload, { timeoutMs: 10 })).toEqual([
            { index: 7, context: "survived" },
        ]);
        expect(warning).toHaveBeenCalledTimes(6);
    } finally {
        warning.mockRestore();
    }
});

test("the context cap counts UTF-8 bytes and accepts the exact boundary", async () => {
    const hooks = new ToolHooks();
    const context = "é".repeat(MAX_SESSION_START_CONTEXT_BYTES / 2);
    hooks.registerSessionStart(() => ({ power: "mutate", context }));
    expect(await hooks.runSessionStart(payload, { timeoutMs: 100 })).toEqual([{ index: 1, context }]);
});

for (const worker of [false, true]) {
    test(`start and resume run once, persist context, and project a notice (worker=${worker})`, async () => {
        const root = workspace();
        const path = join(root, "session.jsonl");
        const requestPath = join(root, "requests.jsonl");
        const seen: SessionStartHookPayload[] = [];
        const requests: ModelRequest[] = [];
        const registry = new AgentRegistry({
            createAdapter: () => {
                const faux = new FauxAdapter([reply(), reply(), reply()]);
                return { stream(request) { requests.push(request); return faux.stream(request); } };
            },
            ...(worker ? { workerAdapterSpec: () => ({
                module: adapterModule, options: { requestPath },
            }) } : {}),
            model: "test", approvalMode: "ask",
            createToolHooks: () => {
                const hooks = new ToolHooks();
                hooks.registerSessionStart((input) => {
                    seen.push(input);
                    return { power: "mutate", context: `context for ${input.reason}` };
                });
                hooks.registerSessionStart(() => ({ power: "mutate", context: "second contribution" }));
                return hooks;
            },
        });
        try {
            const agent = await registry.create({ id: "start-test", workspace: root, sessionPath: path });
            const client = agent.attach();
            await waitFor(() => seen.length === 1);
            let initial: AgentUpdate;
            do {
                initial = await client.receive(AbortSignal.timeout(10_000));
            } while (initial.type !== "history" || !JSON.stringify(initial).includes("context for start"));
            client.send({ type: "prompt", content: "first" });
            await finishTurn(client);
            client.send({ type: "prompt", content: "second" });
            await finishTurn(client);
            expect(seen).toEqual([{ ...payload, sessionId: "start-test", workspace: root }]);
            const captured = worker
                ? readFileSync(requestPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
                : requests;
            expect(captured[0].messages[0]).toMatchObject({
                role: "user", internal: true, contextSource: "session_start",
                content: [{ type: "text", text: "## Session start hook 1\n\ncontext for start\n\n## Session start hook 2\n\nsecond contribution" }],
            });
            const reopened = await SessionStore.open(path);
            expect(reopened.messages().filter((message) => message.internal)).toHaveLength(1);
            expect(projectTranscript(reopened.messages())[0]).toMatchObject({
                kind: "harness", tone: "soft", text: expect.stringContaining("context for start"),
            });
            await registry.closeAgent(agent.id);
            const resumed = await registry.resume({ sessionPath: path });
            const resumedClient = resumed.attach();
            resumedClient.send({ type: "prompt", content: "third" });
            await finishTurn(resumedClient);
            expect(seen.map((item) => item.reason)).toEqual(["start", "resume"]);
            expect((await SessionStore.open(path)).messages().filter((message) => message.internal)).toHaveLength(2);
        } finally {
            await registry.close();
        }
    }, 30_000);
}

test("successful compaction reruns hooks before continuing and failed compaction does not", async () => {
    const root = workspace();
    const path = join(root, "session.jsonl");
    let push: ((line: number, record: Record<string, unknown>) => void) | undefined;
    const store = await SessionStore.create(path, {
        sessionId: "compact-start", cwd: root,
        onRecordAppended: (line, record) => push?.(line, record),
    });
    const seen: string[] = [];
    const hooks = new ToolHooks();
    hooks.registerSessionStart((input) => {
        seen.push(input.reason);
        return {
            power: "mutate",
            context: `context ${seen.length}: ${input.reason}`
                + (input.reason === "compacted" ? " restored context".repeat(2000) : ""),
        };
    });
    const updates: AgentUpdate[] = [];
    let failSummary = false;
    const handle = await startWorker({
        store,
        session: { path, header: JSON.parse(readFileSync(path, "utf8").split("\n")[0]!), records: [] },
        model: "test", adapter: { module: adapterModule, options: { requestPath: join(root, "requests.jsonl") } },
        data: { approvalMode: "ask" },
        services: {
            hooks,
            compaction: {
                strategy: fullSummaryStrategy,
                models: { summarizer: async () => {
                    if (failSummary) throw new Error("summary unavailable");
                    return { text: "# Task\nFinish the work.\n\n# State\nTwo turns finished.\n\n# Decisions\nNone.\n\n# Constraints\nNone.\n\n# Open\nContinue.", model: "summary", provider: "faux" };
                } },
            },
        },
        onUpdate: (update) => { updates.push(update); },
    });
    push = handle.server.pushRecord;
    try {
        for (let round = 0; round < 2; round++) {
            handle.send({ type: "prompt", content: `job ${round}: ` + "context ".repeat(800) });
            await waitFor(() => updates.filter((update) => update.type === "turn_finished").length === round + 1);
        }
        for (let compact = 0; compact < 2; compact++) {
            const updateCount = updates.length;
            handle.send({ type: "compact", requestId: `compact-${compact}` });
            await waitFor(() => updates.slice(updateCount).some((update) => update.type === "context"));
            expect(seen.filter((reason) => reason === "compacted")).toHaveLength(compact + 1);
            const current = updates.slice(updateCount).find((update) => update.type === "context");
            const finished = updates.slice(updateCount).find((update) => update.type === "compaction" && update.phase === "finished");
            if (current?.type !== "context" || finished?.type !== "compaction") {
                throw new Error("Compaction measurement missing");
            }
            const reopened = await SessionStore.open(path);
            expect(current.measurement.tokens).toBeGreaterThan(finished.after!);
            expect(current.measurement.tokens).toBeGreaterThanOrEqual(measureMessages(reopened.modelContext()));
            handle.send({ type: "prompt", content: "continue: " + "more context ".repeat(800) });
            await waitFor(() => updates.filter((update) => update.type === "turn_finished").length === compact + 3);
        }
        expect(seen).toEqual(["start", "compacted", "compacted"]);
        const requests = readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(JSON.stringify(requests.at(-1).messages)).toContain("context 3: compacted");
        failSummary = true;
        const finishedBefore = updates.filter((update) => update.type === "compaction" && update.phase === "finished").length;
        handle.send({ type: "compact", requestId: "failed" });
        await waitFor(() => updates.filter((update) => update.type === "compaction" && update.phase === "finished").length > finishedBefore);
        expect(seen).toEqual(["start", "compacted", "compacted"]);
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);

test("reopening an empty saved session is resume, and attaching does not rerun hooks", async () => {
    const root = workspace();
    const path = join(root, "empty.jsonl");
    const seen: string[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]), model: "test", approvalMode: "ask",
        createToolHooks: () => {
            const hooks = new ToolHooks();
            hooks.registerSessionStart((input) => {
                seen.push(input.reason);
                return { power: "observe" };
            });
            return hooks;
        },
    });
    try {
        const agent = await registry.create({ workspace: root, sessionPath: path });
        const first = agent.attach();
        await first.receive(AbortSignal.timeout(1000));
        await waitFor(() => seen.length === 1);
        const second = agent.attach();
        await second.receive(AbortSignal.timeout(1000));
        expect(seen).toEqual(["start"]);
        await registry.closeAgent(agent.id);
        expect((await SessionStore.open(path)).messages()).toEqual([]);
        await registry.resume({ sessionPath: path });
        await waitFor(() => seen.length === 2);
        expect(seen).toEqual(["start", "resume"]);
    } finally {
        await registry.close();
    }
});
