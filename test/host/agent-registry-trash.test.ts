import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type { SessionEndHookPayload } from "../../src/sdk/hooks.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../src/model/types.ts";
import {
    trashSessionArtifacts,
    type SessionArtifacts,
} from "../../src/host/session-trash.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

interface TrashHarness {
    readonly root: string;
    readonly registry: AgentRegistry;
    readonly moved: SessionArtifacts[];
    readonly ended: SessionEndHookPayload[];
}

interface HarnessOptions {
    readonly moveToTrash?: (root: string) => Promise<void>;
    readonly createToolHooks?: () => ToolHooks;
}

const failingMove = async (): Promise<void> => {
    throw new Error("trash unavailable");
};

async function removeThenFail(root: string, name: string): Promise<void> {
    await rm(join(root, name));
    throw new Error("trash unavailable");
}

// The real mover runs, so a trashed session file is gone and a failed move restores it.
async function withRegistry(
    createAdapter: (agentNumber: number) => ModelAdapter,
    run: (harness: TrashHarness) => Promise<void>,
    options: HarnessOptions = {},
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-trash-tree-"));
    const moved: SessionArtifacts[] = [];
    const ended: SessionEndHookPayload[] = [];
    let agentNumber = 0;
    const registry = new AgentRegistry({
        createAdapter: () => {
            agentNumber += 1;
            return createAdapter(agentNumber);
        },
        model: "faux/test",
        approvalMode: "full_access",
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        onSessionEnd: (payload) => ended.push(payload),
        ...(options.createToolHooks === undefined
            ? {}
            : { createToolHooks: options.createToolHooks }),
        trashSessionArtifacts: async (artifacts) => {
            await trashSessionArtifacts(artifacts, {
                moveToTrash: async () => {
                    await options.moveToTrash?.(root);
                },
            });
            moved.push(artifacts);
        },
    });
    try {
        await run({ root, registry, moved, ended });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function replies(count: number): AssistantMessage[] {
    return Array.from({ length: count }, () => textResponse("The crow is done."));
}

async function openParent(harness: TrashHarness): Promise<void> {
    await harness.registry.create({
        id: "parent",
        workspace: harness.root,
        sessionPath: join(harness.root, "parent.jsonl"),
    });
}

async function startChild(
    harness: TrashHarness,
    id: string,
    parentId: string,
): Promise<void> {
    await harness.registry.createWithKind(
        {
            id,
            workspace: harness.root,
            sessionPath: join(harness.root, `${id}.jsonl`),
        },
        "background",
        { approvalMode: "auto", parentId },
    );
    harness.registry.find(id)!.sendPrompt(`work for ${id}`);
    harness.registry.trackAsyncSubagentTurn(id);
}

async function untilSettled(
    registry: AgentRegistry,
    finishedIds: readonly string[],
): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (true) {
        const statuses = new Map(
            registry.list().map((agent) => [agent.id, agent.status]),
        );
        const quiet = registry.list().every((agent) =>
            registry.find(agent.id)?.idleForShutdown() === true
        );
        if (
            quiet
            && finishedIds.every((id) => statuses.get(id) === "completed")
        ) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(
                `agents did not settle: ${JSON.stringify([...statuses])}`,
            );
        }
        await Bun.sleep(10);
    }
}

async function untilWorking(
    registry: AgentRegistry,
    id: string,
): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (
        registry.list().find((agent) => agent.id === id)?.status !== "working"
    ) {
        if (Date.now() > deadline) {
            throw new Error(`${id} never started working`);
        }
        await Bun.sleep(5);
    }
}

async function untilDeliveryPending(
    registry: AgentRegistry,
    id: string,
): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (
        registry.agents.get(id)?.pendingCompletionDeliveries !== 1
        || registry.find(id)?.idleForShutdown() !== true
    ) {
        if (Date.now() > deadline) {
            throw new Error(`${id} never held a pending delivery`);
        }
        await Bun.sleep(5);
    }
}

// Holds every delivery recorded for the parent until the returned function runs.
function holdDeliveries(registry: AgentRegistry, parentId: string): () => void {
    const store = registry.agents.get(parentId)!.store;
    const record = store.recordDelivery.bind(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    store.recordDelivery = async (delivery) => {
        await gate;
        return record(delivery);
    };
    return release;
}

function movedPaths(moved: readonly SessionArtifacts[]): string[] {
    return moved.map((artifacts) => artifacts.sessionPath);
}

async function drainTurn(attachment: AgentAttachment): Promise<void> {
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
}

function asyncSubagentScript(): AssistantMessage[] {
    return [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "start-background",
                name: "async_subagent",
                input: { description: "Run the integration tests" },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        textResponse("I started the background work."),
        textResponse("I incorporated the background result."),
    ];
}

async function startParentWithAsyncChild(
    harness: TrashHarness,
): Promise<string> {
    const parent = await harness.registry.create({
        id: "parent",
        workspace: harness.root,
        sessionPath: join(harness.root, "parent.jsonl"),
        startupProfile: "bare",
    });
    const attachment = parent.attach();
    expect((await attachment.receive()).type).toBe("history");
    attachment.send({ type: "prompt", content: "Run tests in the background" });
    await drainTurn(attachment);
    attachment.detach();
    const child = harness.registry.list().find(
        (agent) => agent.parent_id === "parent",
    );
    expect(child).toMatchObject({ kind: "background" });
    return child!.id;
}

function asyncChildAdapters(childDelayMs: number) {
    return (agentNumber: number): ModelAdapter =>
        agentNumber === 1
            ? new FauxAdapter(asyncSubagentScript())
            : new FauxAdapter(
                [textResponse("All integration tests pass.")],
                { delayMs: childDelayMs },
            );
}

test("trashing a parent closes its finished child and keeps the child's file", async () => {
    await withRegistry(asyncChildAdapters(0), async (harness) => {
        const childId = await startParentWithAsyncChild(harness);
        await untilSettled(harness.registry, [childId]);
        const childPath = join(harness.root, `${childId}.jsonl`);

        expect(await harness.registry.trashSession("parent")).toBe("trashed");

        expect(movedPaths(harness.moved))
            .toEqual([join(harness.root, "parent.jsonl")]);
        expect(harness.registry.list()).toEqual([]);
        expect(harness.registry.find(childId)).toBeUndefined();
        expect(existsSync(childPath)).toBe(true);
        expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(false);
        await expect(harness.registry.resume({
            sessionPath: join(harness.root, "parent.jsonl"),
        })).rejects.toThrow();
        expect(harness.ended.map((payload) => payload.sessionId).sort())
            .toEqual(["parent", childId].sort());
        expect(harness.ended.every((payload) => payload.reason === "deleted"))
            .toBe(true);
    });
});

test("trash refuses while a child is still working and moves nothing", async () => {
    await withRegistry(asyncChildAdapters(300), async (harness) => {
        const childId = await startParentWithAsyncChild(harness);
        expect(harness.registry.list().find((agent) => agent.id === childId))
            .toMatchObject({ status: "working" });

        expect(await harness.registry.trashSession("parent")).toBe("busy");

        expect(harness.moved).toEqual([]);
        expect(harness.registry.list().map((agent) => agent.id).sort())
            .toEqual(["parent", childId].sort());
    });
});

test("trash refuses while a grandchild is working under a finished child", async () => {
    await withRegistry(
        (agentNumber) => agentNumber === 3
            ? new FauxAdapter(replies(3), { delayMs: 300 })
            : new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);
            await startChild(harness, "leaf", "middle");
            await untilWorking(harness.registry, "leaf");

            expect(await harness.registry.trashSession("parent")).toBe("busy");

            expect(harness.moved).toEqual([]);
            expect(harness.registry.list().map((agent) => agent.id).sort())
                .toEqual(["leaf", "middle", "parent"]);
        },
    );
});

test("trashing a parent closes finished children at every depth", async () => {
    await withRegistry(() => new FauxAdapter(replies(6)), async (harness) => {
        await openParent(harness);
        await startChild(harness, "middle", "parent");
        await startChild(harness, "leaf", "middle");
        await untilSettled(harness.registry, ["middle", "leaf"]);

        expect(await harness.registry.trashSession("parent")).toBe("trashed");

        expect(movedPaths(harness.moved))
            .toEqual([join(harness.root, "parent.jsonl")]);
        expect(harness.registry.list()).toEqual([]);
        expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(false);
        expect(existsSync(join(harness.root, "middle.jsonl"))).toBe(true);
        expect(existsSync(join(harness.root, "leaf.jsonl"))).toBe(true);
    });
});

test("an idle resident background session with no children trashes", async () => {
    await withRegistry(() => new FauxAdapter(replies(6)), async (harness) => {
        await openParent(harness);
        await startChild(harness, "middle", "parent");
        await untilSettled(harness.registry, ["middle"]);

        expect(await harness.registry.trashSession("middle")).toBe("trashed");

        expect(movedPaths(harness.moved))
            .toEqual([join(harness.root, "middle.jsonl")]);
        expect(harness.registry.list().map((agent) => agent.id))
            .toEqual(["parent"]);
        expect(harness.registry.find("parent")).toBeDefined();
    });
});

test("a failed trash starts the parent and its finished children again", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await startChild(harness, "leaf", "middle");
            await untilSettled(harness.registry, ["middle", "leaf"]);

            expect(await harness.registry.trashSession("parent"))
                .toBe("failed");

            expect(harness.moved).toEqual([]);
            expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(true);
            expect(
                harness.registry.list()
                    .map((agent) => [agent.id, agent.parent_id ?? null])
                    .sort(),
            ).toEqual([
                ["leaf", "middle"],
                ["middle", "parent"],
                ["parent", null],
            ]);
            await untilSettled(harness.registry, ["middle", "leaf"]);
            expect(await harness.registry.trashSession("middle"))
                .toBe("failed");
        },
        { moveToTrash: failingMove },
    );
});

test("trash refuses while the session's own completion is still being delivered", async () => {
    await withRegistry(() => new FauxAdapter(replies(6)), async (harness) => {
        await openParent(harness);
        const release = holdDeliveries(harness.registry, "parent");
        try {
            await startChild(harness, "middle", "parent");
            await untilDeliveryPending(harness.registry, "middle");

            expect(await harness.registry.trashSession("middle"))
                .toBe("busy");

            expect(harness.moved).toEqual([]);
            expect(harness.registry.find("middle")).toBeDefined();
            expect(harness.ended).toEqual([]);
        } finally {
            release();
        }
        await untilSettled(harness.registry, ["middle"]);
        expect(await harness.registry.trashSession("middle")).toBe("trashed");
    });
});

test("a child whose parent did not start again stays closed after a failed trash", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await startChild(harness, "leaf", "middle");
            await startChild(harness, "sibling", "parent");
            await untilSettled(harness.registry, ["middle", "leaf", "sibling"]);

            expect(await harness.registry.trashSession("parent"))
                .toBe("failed");

            expect(harness.registry.list().map((agent) => agent.id).sort())
                .toEqual(["parent", "sibling"]);
            expect(existsSync(join(harness.root, "leaf.jsonl"))).toBe(true);
        },
        { moveToTrash: (root) => removeThenFail(root, "middle.jsonl") },
    );
});

test("a child that fails while starting again leaves no entry behind", async () => {
    let hookCalls = 0;
    let failOnCall = 0;
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await startChild(harness, "leaf", "middle");
            await untilSettled(harness.registry, ["middle", "leaf"]);
            // The restart order is parent, middle, leaf.
            failOnCall = hookCalls + 2;

            expect(await harness.registry.trashSession("parent"))
                .toBe("failed");

            expect(harness.registry.list().map((agent) => agent.id))
                .toEqual(["parent"]);
            expect(harness.registry.agents.has("middle")).toBe(false);
            expect(harness.registry.agents.has("leaf")).toBe(false);
            await harness.registry.resume({
                sessionPath: join(harness.root, "middle.jsonl"),
            });
            expect(harness.registry.find("middle")).toBeDefined();
        },
        {
            moveToTrash: failingMove,
            createToolHooks: () => {
                hookCalls += 1;
                if (hookCalls === failOnCall) {
                    throw new Error("tool hooks unavailable");
                }
                return new ToolHooks();
            },
        },
    );
});
