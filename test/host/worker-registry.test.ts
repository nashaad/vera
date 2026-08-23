import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    AgentRegistry,
    defaultConcurrentWorkerCap,
} from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);

function toolCall(id: string, command: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "bash", input: { command } }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function text(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function receiveUntil(
    attachment: AgentAttachment,
    predicate: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    const deadline = Date.now() + 20_000;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for agent update");
        const update = await Promise.race([
            attachment.receive(),
            Bun.sleep(remaining).then(() => {
                throw new Error("Timed out waiting for agent update");
            }),
        ]);
        if (predicate(update)) return update;
    }
}

async function waitForFile(path: string): Promise<number> {
    const deadline = Date.now() + 20_000;
    while (Date.now() <= deadline) {
        try {
            return Number((await readFile(path, "utf8")).trim());
        } catch {
            await Bun.sleep(20);
        }
    }
    throw new Error(`Timed out waiting for ${path}`);
}

test("the registry contains a killed worker and keeps its sibling usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-registry-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const scripts = new Map<string, readonly AssistantMessage[]>([
        ["victim", [
            toolCall("hold", "sleep 60"),
            text("never reached"),
        ]],
        ["sibling", [text("sibling finished")]],
    ]);
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: scripts.get(sessionId) ?? [],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const victimPath = join(root, "victim.jsonl");
        const victim = await registry.create({
            id: "victim",
            workspace: root,
            sessionPath: victimPath,
        });
        const sibling = await registry.create({
            id: "sibling",
            workspace: root,
            sessionPath: join(root, "sibling.jsonl"),
        });
        const victimClient = victim.attach();
        expect((await victimClient.receive()).type).toBe("history");
        victimClient.send({ type: "prompt", content: "hold the tool open" });
        await receiveUntil(
            victimClient,
            (update) => update.type === "tool_started",
        );

        const workerPid = await waitForFile(join(root, "victim.pid"));
        expect(registry.list().find((entry) => entry.id === "victim"))
            .toMatchObject({
                worker_pid: workerPid,
                supervisor_pid: expect.any(Number),
            });
        process.kill(workerPid, "SIGKILL");
        const failure = await receiveUntil(
            victimClient,
            (update) => update.type === "agent_failed",
        );
        expect(failure).toMatchObject({
            type: "agent_failed",
            detail: expect.any(String),
        });
        if (failure.type === "agent_failed") {
            expect(failure.detail).not.toBe("");
        }
        expect(registry.list().find((entry) => entry.id === "victim")?.worker_pid)
            .toBeUndefined();

        const siblingClient = sibling.attach();
        expect((await siblingClient.receive()).type).toBe("history");
        siblingClient.send({ type: "prompt", content: "finish normally" });
        await receiveUntil(
            siblingClient,
            (update) => update.type === "turn_finished",
        );

        const stored = await SessionStore.open(victimPath);
        expect(stored.messages().map((message) => message.role))
            .toContain("user");
        const storedFailure = stored.agentFailure();
        expect(storedFailure).toBeDefined();
        expect(storedFailure?.detail).not.toBe("");

        const reopened = victim.attach();
        expect((await reopened.receive()).type).toBe("history");
        const replayedFailure = await receiveUntil(
            reopened,
            (update) => update.type === "agent_failed",
        );
        expect(replayedFailure).toMatchObject({
            type: "agent_failed",
            detail: storedFailure?.detail,
        });
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("a worker returns timeline replies only to their attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-timeline-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: () => ({
            module: ADAPTER,
            options: { script: [], pidPath: join(root, "worker.pid") },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });

    try {
        const agent = await registry.create({
            id: "timeline",
            workspace: root,
            sessionPath: join(root, "timeline.jsonl"),
        });
        const owner = agent.attach();
        const peer = agent.attach();
        expect((await owner.receive()).type).toBe("history");
        expect((await peer.receive()).type).toBe("history");

        owner.send({ type: "list_timeline", requestId: "timeline-1" });
        const reply = await receiveUntil(
            owner,
            (update) => update.type === "timeline",
        );
        expect(reply).toMatchObject({
            type: "timeline",
            requestId: "timeline-1",
        });
        const peerDeadline = Date.now() + 200;
        let peerSawReply = false;
        while (Date.now() < peerDeadline) {
            const update = await Promise.race([
                peer.receive(),
                Bun.sleep(peerDeadline - Date.now()).then(() => undefined),
            ]);
            if (update === undefined) break;
            if (
                update.type === "timeline"
                && update.requestId === "timeline-1"
            ) {
                peerSawReply = true;
                break;
            }
        }
        expect(peerSawReply).toBe(false);
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("the default worker cap scales with memory and stays inside its bounds", () => {
    const gb = 1024 * 1024 * 1024;
    expect(defaultConcurrentWorkerCap(1 * gb)).toBe(2);
    expect(defaultConcurrentWorkerCap(16 * gb)).toBe(12);
    expect(defaultConcurrentWorkerCap(1024 * gb)).toBe(16);
});

test("a session past the worker cap fails with the way to free a slot", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-cap-"));
    const previousWorkerMode = process.env.VERA_WORKER;
    process.env.VERA_WORKER = "1";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: ({ sessionId }) => ({
            module: ADAPTER,
            options: {
                script: [toolCall("hold", "sleep 60"), text("never reached")],
                pidPath: join(root, `${sessionId}.pid`),
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
        maxConcurrentWorkers: 1,
    });

    try {
        const first = await registry.create({
            id: "first",
            workspace: root,
            sessionPath: join(root, "first.jsonl"),
        });
        const firstClient = first.attach();
        expect((await firstClient.receive()).type).toBe("history");
        firstClient.send({ type: "prompt", content: "hold the slot" });
        await receiveUntil(
            firstClient,
            (update) => update.type === "tool_started",
        );
        await waitForFile(join(root, "first.pid"));

        const second = await registry.create({
            id: "second",
            workspace: root,
            sessionPath: join(root, "second.jsonl"),
        });
        const secondClient = second.attach();
        expect((await secondClient.receive()).type).toBe("history");
        secondClient.send({ type: "prompt", content: "should not start" });
        const failure = await receiveUntil(
            secondClient,
            (update) => update.type === "agent_failed",
        );

        expect(failure).toMatchObject({ type: "agent_failed" });
        if (failure.type === "agent_failed") {
            expect(failure.detail).toContain("1 isolated sessions");
            expect(failure.detail).toContain("vera close");
        }
        expect(
            registry.list().find((entry) => entry.id === "second")?.worker_pid,
        ).toBeUndefined();
    } finally {
        await registry.close();
        if (previousWorkerMode === undefined) {
            delete process.env.VERA_WORKER;
        } else {
            process.env.VERA_WORKER = previousWorkerMode;
        }
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
