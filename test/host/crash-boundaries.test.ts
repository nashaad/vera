import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { importSessionFile } from "../../src/host/session-import-service.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { CRASH_CUT_MESSAGE, readSessionSnapshot, readSessionTurnState } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const adapterModule = fileURLToPath(new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url));

function answer(): AssistantMessage {
    return {
        role: "assistant", content: [{ type: "text", text: "The map is ready." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(), stopReason: "stop",
    };
}

async function receiveUntil(client: AgentAttachment, predicate: (update: AgentUpdate) => boolean): Promise<AgentUpdate> {
    for (;;) {
        const update = await client.receive(AbortSignal.timeout(10_000));
        if (predicate(update)) return update;
    }
}

async function expectNoCrash(path: string): Promise<void> {
    expect((await readSessionSnapshot(path)).harnessMessages.some((entry) => entry.text === CRASH_CUT_MESSAGE)).toBe(false);
    expect((await readSessionTurnState(path)).turnOpen).toBe(false);
}

test("an imported user tail resumes without a crash line", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-import-resume-"));
    const source = join(root, "source.jsonl");
    const registry = new AgentRegistry({ createAdapter: () => new FauxAdapter([]), model: "faux/test", approvalMode: "auto" });
    try {
        await writeFile(source, `${JSON.stringify({
            type: "user", sessionId: "source", cwd: root, uuid: "user-1", parentUuid: null,
            timestamp: new Date().toISOString(), message: { role: "user", content: "chart the cove" },
        })}\n`);
        const imported = await importSessionFile(source, { sessionDirectory: root, indexed: [] });
        if (imported.status !== "imported") throw new Error(imported.reason);
        const agent = await registry.resume({ sessionPath: imported.sessionPath });
        const client = agent.attach();
        await receiveUntil(client, (update) => update.type === "history");
        await expectNoCrash(imported.sessionPath);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an imported unanswered tool call resumes as text without a crash line", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-import-tool-resume-"));
    const source = join(root, "source.jsonl");
    const registry = new AgentRegistry({ createAdapter: () => new FauxAdapter([]), model: "faux/test", approvalMode: "auto" });
    const timestamp = new Date().toISOString();
    try {
        const common = { sessionId: "source", cwd: root, timestamp };
        await writeFile(source, [
            { ...common, type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "chart the cove" } },
            { ...common, type: "assistant", uuid: "assistant-1", parentUuid: "user-1", message: {
                role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read", input: { path: "map" } }],
            } },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n");
        const imported = await importSessionFile(source, { sessionDirectory: root, indexed: [] });
        if (imported.status !== "imported") throw new Error(imported.reason);
        const agent = await registry.resume({ sessionPath: imported.sessionPath });
        await receiveUntil(agent.attach(), (update) => update.type === "history");
        expect((await readSessionSnapshot(imported.sessionPath)).messages.at(-1)).toMatchObject({
            role: "assistant", stopReason: "stop", content: [{ type: "text", text: expect.stringContaining("[tool] read") }],
        });
        await expectNoCrash(imported.sessionPath);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a branch with initial messages resumes without a crash line", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-seeded-resume-"));
    const path = join(root, "branch.jsonl");
    const registry = new AgentRegistry({ createAdapter: () => new FauxAdapter([]), model: "faux/test", approvalMode: "auto" });
    try {
        await registry.create({ id: "source", workspace: root, sessionPath: join(root, "source.jsonl") });
        const branch = await registry.branch({
            sourceId: "source", id: "branch", sessionPath: path, position: "at",
            initialMessages: [{ role: "user", content: [{ type: "text", text: "Reference map" }] }],
        });
        expect(branch?.agent.id).toBe("branch");
        await registry.closeAgent("branch");
        const resumed = await registry.resume({ sessionPath: path });
        await receiveUntil(resumed.attach(), (update) => update.type === "history");
        await expectNoCrash(path);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an idle session-start hook resumes without a crash line", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-hook-resume-"));
    const path = join(root, "session.jsonl");
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]), model: "faux/test", approvalMode: "auto",
        createToolHooks: () => {
            const hooks = new ToolHooks();
            hooks.registerSessionStart(() => ({ power: "mutate", context: "The map is ready." }));
            return hooks;
        },
    });
    try {
        const agent = await registry.create({ id: "crow", workspace: root, sessionPath: path });
        await receiveUntil(agent.attach(), (update) => update.type === "history" && JSON.stringify(update).includes("The map is ready."));
        await registry.closeAgent("crow");
        const resumed = await registry.resume({ sessionPath: path });
        await receiveUntil(resumed.attach(), (update) => update.type === "history" && JSON.stringify(update).includes("The map is ready."));
        await expectNoCrash(path);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a provider failure stays terminal on resume and the next turn works", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-failure-resume-"));
    const path = join(root, "session.jsonl");
    let available = false;
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter(available ? [answer()] : []),
        model: "faux/test", approvalMode: "auto",
    });
    try {
        const agent = await registry.create({ id: "crow", workspace: root, sessionPath: path });
        const client = agent.attach();
        await receiveUntil(client, (update) => update.type === "history");
        client.send({ type: "prompt", content: "Chart the cove" });
        expect(await receiveUntil(client, (update) => update.type === "turn_finished")).toMatchObject({ outcome: "error" });
        await registry.closeAgent("crow");
        available = true;
        const resumed = await registry.resume({ sessionPath: path });
        const next = resumed.attach();
        await receiveUntil(next, (update) => update.type === "history");
        await expectNoCrash(path);
        next.send({ type: "prompt", content: "Try the map again" });
        await receiveUntil(next, (update) => update.type === "turn_finished");
        expect((await readSessionSnapshot(path)).messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("closing a worker at an approval persists an abort and allows a later turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-close-worker-tail-"));
    const path = join(root, "session.jsonl");
    const pidPath = join(root, "worker.pid");
    const tool: AssistantMessage = {
        role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "bash", input: { command: "env CLOSE=waiting" } }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
    };
    let starts = 0;
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: () => ({ module: adapterModule, options: { script: starts++ === 0 ? [tool] : [answer()], pidPath } }),
        model: "faux/test", approvalMode: "ask",
    });
    try {
        const agent = await registry.create({ id: "crow", workspace: root, sessionPath: path });
        const client = agent.attach();
        await receiveUntil(client, (update) => update.type === "history");
        client.send({ type: "prompt", content: "Check the cove" });
        await receiveUntil(client, (update) => update.type === "ui_request");
        const pid = Number((await readFile(pidPath, "utf8")).trim());
        await registry.closeAgent("crow");
        expect(() => process.kill(pid, 0)).toThrow();
        const snapshot = await readSessionSnapshot(path);
        expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
        expect(snapshot.messages.filter((message) => message.role === "tool_result" && message.toolCallId === "call-1")).toHaveLength(1);
        await expectNoCrash(path);
        const resumed = await registry.resume({ sessionPath: path });
        const next = resumed.attach();
        await receiveUntil(next, (update) => update.type === "history");
        next.send({ type: "prompt", content: "What next?" });
        await receiveUntil(next, (update) => update.type === "turn_finished");
        expect((await readSessionSnapshot(path)).messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
        await expectNoCrash(path);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}, 15_000);

for (const writeFailure of [false, true]) {
    test(`a stalled worker close ${writeFailure ? "reports an abort write failure" : "persists an abort after the worker exits"}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-write-failure-"));
        const path = join(root, "session.jsonl");
        const tool: AssistantMessage = {
            role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "bash", input: { command: "env CLOSE=waiting" } }],
            source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
        };
        const registry = new AgentRegistry({
            createAdapter: () => new FauxAdapter([]),
            workerAdapterSpec: () => ({ module: adapterModule, options: { script: [tool] } }),
            model: "faux/test", approvalMode: "ask",
        });
        try {
            const agent = await registry.create({ id: "crow", workspace: root, sessionPath: path });
            const client = agent.attach();
            await receiveUntil(client, (update) => update.type === "history");
            client.send({ type: "prompt", content: "Check the cove" });
            await receiveUntil(client, (update) => update.type === "ui_request");
            const entry = registry.agents.get("crow");
            if (entry?.worker === undefined) throw new Error("Expected a running worker");
            const send = entry.worker.send.bind(entry.worker);
            spyOn(entry.worker, "send").mockImplementation((command) => {
                if (command.type !== "abort") send(command);
            });
            if (writeFailure) {
                spyOn(entry.store, "finishAbortedTurn").mockRejectedValueOnce(new Error("disk unavailable"));
            }
            const pid = entry.worker.pid;
            if (writeFailure) {
                await expect(registry.closeAgent("crow")).rejects.toThrow("disk unavailable");
            } else {
                expect(await registry.closeAgent("crow")).toBe("closed");
                const snapshot = await readSessionSnapshot(path);
                expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted", errorMessage: "Turn aborted" });
                expect(snapshot.messages.filter((message) => message.role === "tool_result" && message.toolCallId === "call-1")).toHaveLength(1);
                await expectNoCrash(path);
            }
            expect(() => process.kill(pid, 0)).toThrow();
            expect(registry.find("crow")).toBeUndefined();
        } finally {
            await registry.close();
            await rm(root, { recursive: true, force: true });
        }
    }, 15_000);
}
