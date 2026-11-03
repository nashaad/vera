import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ToolHooks } from "../../src/engine/hooks.ts";
import type { SessionEndHookPayload } from "../../src/sdk/hooks.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { ClosedMember } from "../../src/host/agent-registry/support.ts";
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
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

interface TrashHarness {
    readonly root: string;
    readonly registry: AgentRegistry;
    readonly moved: SessionArtifacts[];
    readonly ended: SessionEndHookPayload[];
    readonly reported: ClosedMember[];
}

interface HarnessOptions {
    readonly moveToTrash?: (root: string) => Promise<void>;
    readonly onSessionEnd?: (payload: SessionEndHookPayload) => void;
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
    const reported: ClosedMember[] = [];
    let agentNumber = 0;
    const registry = new AgentRegistry({
        createAdapter: () => {
            agentNumber += 1;
            return createAdapter(agentNumber);
        },
        model: "faux/test",
        approvalMode: "full_access",
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        onSessionEnd: (payload) => {
            ended.push(payload);
            options.onSessionEnd?.(payload);
        },
        onSessionsClosed: async (members) => {
            reported.push(...members);
        },
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
        await run({ root, registry, moved, ended, reported });
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

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Deferred {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const TRASHING = "being moved to the trash";

// Every way a member could register again while its tree is in the trash.
function probeTrashingTree(
    harness: TrashHarness,
): Promise<PromiseSettledResult<unknown>[]> {
    const { registry, root } = harness;
    return Promise.allSettled([
        ...["parent", "middle", "leaf"].map((id) =>
            registry.resume({ sessionPath: join(root, `${id}.jsonl`) })
        ),
        registry.createWithKind(
            {
                id: "late",
                workspace: root,
                sessionPath: join(root, "late.jsonl"),
            },
            "background",
            { approvalMode: "auto", parentId: "middle" },
        ),
    ]);
}

async function expectAllRefused(
    probes: readonly Promise<PromiseSettledResult<unknown>[]>[],
): Promise<void> {
    expect(probes.length).toBeGreaterThan(0);
    for (const outcomes of await Promise.all(probes)) {
        expect(outcomes).toHaveLength(4);
        for (const outcome of outcomes) {
            expect(outcome.status).toBe("rejected");
            expect((outcome as PromiseRejectedResult).reason.message)
                .toContain(TRASHING);
        }
    }
}

async function openTreeOfThree(harness: TrashHarness): Promise<void> {
    await openParent(harness);
    await startChild(harness, "middle", "parent");
    await startChild(harness, "leaf", "middle");
    await untilSettled(harness.registry, ["middle", "leaf"]);
}

test("while a tree moves to the trash nothing from it can register and nothing is left after", async () => {
    const moving = deferred();
    const release = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);

            const trashing = harness.registry.trashSession("parent");
            await moving.promise;
            expect(harness.registry.list()).toEqual([]);

            await expectAllRefused([probeTrashingTree(harness)]);
            expect(await harness.registry.trashSession("parent")).toBe("busy");
            expect(await harness.registry.trashSession("middle")).toBe("busy");
            expect(await harness.registry.branch({
                sourceId: "parent",
                position: "at",
            })).toBeUndefined();
            expect(harness.registry.list()).toEqual([]);

            release.resolve();
            expect(await trashing).toBe("trashed");

            expect(harness.registry.list()).toEqual([]);
            expect(harness.registry.agents.size).toBe(0);
            expect(harness.registry.trashingIds.size).toBe(0);
            expect(existsSync(join(harness.root, "late.jsonl"))).toBe(false);
            expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(false);
            await harness.registry.resume({
                sessionPath: join(harness.root, "middle.jsonl"),
            });
            expect(harness.registry.find("middle")).toBeDefined();
        },
        {
            moveToTrash: async () => {
                moving.resolve();
                await release.promise;
            },
        },
    );
});

test("a failed trash restores the tree once and then accepts requests again", async () => {
    const moving = deferred();
    const release = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);

            const trashing = harness.registry.trashSession("parent");
            await moving.promise;
            await expectAllRefused([probeTrashingTree(harness)]);

            release.resolve();
            expect(await trashing).toBe("failed");

            expect(
                harness.registry.list()
                    .map((agent) => [agent.id, agent.parent_id ?? null])
                    .sort(),
            ).toEqual([
                ["leaf", "middle"],
                ["middle", "parent"],
                ["parent", null],
            ]);
            expect(harness.registry.trashingIds.size).toBe(0);
            expect(existsSync(join(harness.root, "late.jsonl"))).toBe(false);
            await expect(harness.registry.resume({
                sessionPath: join(harness.root, "parent.jsonl"),
            })).rejects.toThrow("already exists");
            expect(await harness.registry.trashSession("parent")).toBe("failed");
        },
        {
            moveToTrash: async () => {
                moving.resolve();
                await release.promise;
                throw new Error("trash unavailable");
            },
        },
    );
});

test("a resume or child created as the tree closes is refused", async () => {
    const probes: Promise<PromiseSettledResult<unknown>[]>[] = [];
    let harnessRef: TrashHarness | undefined;
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            harnessRef = harness;
            await openTreeOfThree(harness);

            expect(await harness.registry.trashSession("parent")).toBe("trashed");

            expect(probes).toHaveLength(2);
            await expectAllRefused(probes);
            expect(harness.registry.agents.size).toBe(0);
            expect(existsSync(join(harness.root, "late.jsonl"))).toBe(false);
        },
        {
            // Runs once per member, after its loop stops and before it is reaped.
            onSessionEnd: (payload) => {
                if (payload.sessionId === "leaf" || payload.sessionId === "middle") {
                    probes.push(probeTrashingTree(harnessRef!));
                }
            },
        },
    );
});

test("a child that began resuming before the trash is closed with it", async () => {
    const moving = deferred();
    const finishMove = deferred();
    const resumeStarted = deferred();
    const finishBind = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);
            await harness.registry.closeAgentTree("middle");
            const bind = harness.registry.bindSessionIdentity.bind(
                harness.registry,
            );
            harness.registry.bindSessionIdentity = async (store) => {
                resumeStarted.resolve();
                await finishBind.promise;
                return bind(store);
            };

            const late = harness.registry.resume({
                sessionPath: join(harness.root, "middle.jsonl"),
            });
            await resumeStarted.promise;
            const trashing = harness.registry.trashSession("parent");
            await moving.promise;
            finishBind.resolve();
            await late;
            expect(harness.registry.agents.has("middle")).toBe(true);

            finishMove.resolve();
            expect(await trashing).toBe("trashed");

            expect(harness.registry.agents.size).toBe(0);
            expect(existsSync(join(harness.root, "middle.jsonl"))).toBe(true);
        },
        {
            moveToTrash: async () => {
                moving.resolve();
                await finishMove.promise;
            },
        },
    );
});

test("a parent cannot be trashed while its child is still closing for the trash", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(4)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);

            const childTrash = harness.registry.trashSession("middle");
            expect(await harness.registry.trashSession("parent")).toBe("busy");
            expect(await childTrash).toBe("trashed");
            expect(await harness.registry.trashSession("parent")).toBe("trashed");
            expect(harness.registry.agents.size).toBe(0);
        },
    );
});

test("a child whose trash fails after its parent was trashed stays closed", async () => {
    const moving = deferred();
    const release = deferred();
    let moves = 0;
    await withRegistry(
        () => new FauxAdapter(replies(4)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);

            const childTrash = harness.registry.trashSession("middle");
            await moving.promise;
            expect(await harness.registry.trashSession("parent")).toBe("trashed");
            release.resolve();
            expect(await childTrash).toBe("failed");

            expect(harness.registry.agents.size).toBe(0);
            expect(harness.registry.trashingIds.size).toBe(0);
            expect(existsSync(join(harness.root, "middle.jsonl"))).toBe(true);
        },
        {
            moveToTrash: async () => {
                moves += 1;
                if (moves > 1) return;
                moving.resolve();
                await release.promise;
                throw new Error("trash unavailable");
            },
        },
    );
});

test("a failed trash restarts a child whose parent was closed on its own", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(4)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);
            await harness.registry.closeAgent("parent");
            expect(harness.registry.agents.get("middle")?.parentId)
                .toBe("parent");

            expect(await harness.registry.trashSession("middle")).toBe("failed");

            expect(
                harness.registry.list()
                    .map((agent) => [agent.id, agent.parent_id ?? null]),
            ).toEqual([["middle", "parent"]]);
            expect(harness.registry.find("middle")).toBeDefined();
        },
        { moveToTrash: failingMove },
    );
});

test("a session that is still starting cannot be trashed", async () => {
    const bindStarted = deferred();
    const finishBind = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(2)),
        async (harness) => {
            await openParent(harness);
            await harness.registry.closeAgent("parent");
            const bind = harness.registry.bindSessionIdentity.bind(
                harness.registry,
            );
            harness.registry.bindSessionIdentity = async (store) => {
                bindStarted.resolve();
                await finishBind.promise;
                return bind(store);
            };

            const resuming = harness.registry.resume({
                sessionPath: join(harness.root, "parent.jsonl"),
            });
            await bindStarted.promise;
            expect(await harness.registry.trashSession("parent")).toBe("busy");
            finishBind.resolve();
            await resuming;

            expect(harness.registry.find("parent")).toBeDefined();
            expect(harness.moved).toEqual([]);
            expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(true);
        },
    );
});

// Holds the identity binding of the named sessions, which start() awaits before it registers.
function holdIdentity(
    registry: AgentRegistry,
    ids: readonly string[],
): { readonly started: Deferred; readonly release: Deferred } {
    const started = deferred();
    const release = deferred();
    const bind = registry.bindSessionIdentity.bind(registry);
    registry.bindSessionIdentity = async (store) => {
        if (ids.includes(store.header.id)) {
            started.resolve();
            await release.promise;
        }
        return bind(store);
    };
    return { started, release };
}

test("a child restarted after its parent was trashed is closed again and keeps its file", async () => {
    const childMoving = deferred();
    const childRelease = deferred();
    let moves = 0;
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            const childTrash = harness.registry.trashSession("middle");
            await childMoving.promise;
            const held = holdIdentity(harness.registry, ["middle"]);
            childRelease.resolve();
            await held.started.promise;

            expect(await harness.registry.trashSession("parent")).toBe("trashed");
            held.release.resolve();
            expect(await childTrash).toBe("failed");

            expect(harness.registry.agents.size).toBe(0);
            expect(harness.registry.trashingIds.size).toBe(0);
            expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(false);
            expect(existsSync(join(harness.root, "middle.jsonl"))).toBe(true);
            expect(existsSync(join(harness.root, "leaf.jsonl"))).toBe(true);
        },
        {
            moveToTrash: async () => {
                moves += 1;
                if (moves > 1) return;
                childMoving.resolve();
                await childRelease.promise;
                throw new Error("trash unavailable");
            },
        },
    );
});

test("a grandchild is not restarted under a child the parent's trash closed", async () => {
    const childMoving = deferred();
    const childRelease = deferred();
    const parentMoving = deferred();
    const parentRelease = deferred();
    let moves = 0;
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            const childTrash = harness.registry.trashSession("middle");
            await childMoving.promise;
            const middle = holdIdentity(harness.registry, ["middle"]);
            childRelease.resolve();
            await middle.started.promise;
            const parentTrash = harness.registry.trashSession("parent");
            await parentMoving.promise;
            const leaf = holdIdentity(harness.registry, ["leaf"]);

            // Middle registers while its parent moves; the leaf would follow it.
            middle.release.resolve();
            await Promise.race([leaf.started.promise, childTrash]);
            parentRelease.resolve();
            expect(await parentTrash).toBe("trashed");
            leaf.release.resolve();
            expect(await childTrash).toBe("failed");

            expect(harness.registry.agents.size).toBe(0);
            expect(harness.registry.trashingIds.size).toBe(0);
            expect(existsSync(join(harness.root, "middle.jsonl"))).toBe(true);
            expect(existsSync(join(harness.root, "leaf.jsonl"))).toBe(true);
        },
        {
            moveToTrash: async () => {
                moves += 1;
                if (moves === 1) {
                    childMoving.resolve();
                    await childRelease.promise;
                    throw new Error("trash unavailable");
                }
                parentMoving.resolve();
                await parentRelease.promise;
            },
        },
    );
});

test("a host that closes while a trash moves is not idle and restarts nothing", async () => {
    const moving = deferred();
    const release = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(2)),
        async (harness) => {
            await openParent(harness);
            expect(harness.registry.idleForShutdown()).toBe(true);

            const trashing = harness.registry.trashSession("parent");
            await moving.promise;
            expect(harness.registry.idleForShutdown()).toBe(false);
            expect(harness.registry.idleForReplacement()).toBe(false);
            await harness.registry.close();
            release.resolve();
            expect(await trashing).toBe("failed");

            expect(harness.registry.agents.size).toBe(0);
            expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(true);
            expect(
                harness.ended.map((payload) =>
                    `${payload.sessionId}:${payload.reason}`
                ),
            ).toEqual(["parent:deleted"]);
        },
        {
            moveToTrash: async () => {
                moving.resolve();
                await release.promise;
                throw new Error("trash unavailable");
            },
        },
    );
});

test("a restart that registers after the host closed is closed again", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(2)),
        async (harness) => {
            await openParent(harness);
            const held = holdIdentity(harness.registry, ["parent"]);

            const trashing = harness.registry.trashSession("parent");
            await held.started.promise;
            await harness.registry.close();
            held.release.resolve();
            expect(await trashing).toBe("failed");

            expect(harness.registry.agents.size).toBe(0);
            expect(harness.registry.find("parent")).toBeUndefined();
            expect(existsSync(join(harness.root, "parent.jsonl"))).toBe(true);
        },
        { moveToTrash: failingMove },
    );
});

async function recordFailure(root: string, id: string): Promise<void> {
    const store = await SessionStore.open(join(root, `${id}.jsonl`));
    await store.appendAgentFailure(
        "failure-1",
        "Resident agent stopped unexpectedly",
    );
}

test("a child is not started again under a parent that came back failed", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);

            expect(await harness.registry.trashSession("parent"))
                .toBe("failed");

            expect(harness.registry.agents.get("middle")?.failure)
                .toBeDefined();
            expect(harness.registry.agents.has("leaf")).toBe(false);
            expect(harness.registry.list().map((agent) => agent.id).sort())
                .toEqual(["middle", "parent"]);
            expect(existsSync(join(harness.root, "leaf.jsonl"))).toBe(true);
            await harness.registry.resume({
                sessionPath: join(harness.root, "leaf.jsonl"),
            });
            expect(harness.registry.find("leaf")).toBeDefined();
        },
        {
            // The middle session reads as failed when it starts again.
            moveToTrash: async (root) => {
                await recordFailure(root, "middle");
                throw new Error("trash unavailable");
            },
        },
    );
});

test("a child under a parent that was already failed stays closed after a failed trash", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            harness.registry.agents.get("middle")!.agent.fail(
                "failure-1",
                "Resident agent stopped unexpectedly",
            );

            expect(await harness.registry.trashSession("parent"))
                .toBe("failed");

            expect(harness.registry.list().map((agent) => agent.id))
                .toEqual(["parent"]);
            expect(harness.registry.agents.has("middle")).toBe(false);
            expect(harness.registry.agents.has("leaf")).toBe(false);
            expect(existsSync(join(harness.root, "middle.jsonl"))).toBe(true);
            expect(existsSync(join(harness.root, "leaf.jsonl"))).toBe(true);
            await harness.registry.resume({
                sessionPath: join(harness.root, "leaf.jsonl"),
            });
            expect(harness.registry.find("leaf")).toBeDefined();
        },
        { moveToTrash: failingMove },
    );
});

test("a child that registers after its parent failed is closed again", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            const held = holdIdentity(harness.registry, ["leaf"]);

            const trashing = harness.registry.trashSession("parent");
            await held.started.promise;
            harness.registry.agents.get("middle")!.agent.fail(
                "failure-1",
                "Resident agent stopped unexpectedly",
            );
            held.release.resolve();
            expect(await trashing).toBe("failed");

            expect(harness.registry.agents.has("leaf")).toBe(false);
            expect(harness.registry.agents.has("middle")).toBe(true);
            expect(existsSync(join(harness.root, "leaf.jsonl"))).toBe(true);
            await harness.registry.resume({
                sessionPath: join(harness.root, "leaf.jsonl"),
            });
            expect(harness.registry.find("leaf")).toBeDefined();
        },
        { moveToTrash: failingMove },
    );
});

test("closing a tree and parking an idle tree return the sessions they closed", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            const sorted = (members: readonly { id: string }[]) =>
                members.map((member) => member.id).sort();

            const parked = await harness.registry.parkExpiredIdle(
                Date.now() + 11 * 60 * 1_000,
            );
            expect(sorted(parked)).toEqual(["leaf", "middle", "parent"]);
            expect(parked.find((member) => member.id === "leaf")?.sessionPath)
                .toBe(join(harness.root, "leaf.jsonl"));
            expect(harness.registry.list()).toEqual([]);

            await harness.registry.resume({
                sessionPath: join(harness.root, "parent.jsonl"),
            });
            const outcome = await harness.registry.closeAgentTree("parent");
            expect(outcome.status).toBe("closed");
            expect(sorted(outcome.closed)).toEqual(["parent"]);
            expect(basename(outcome.closed[0]?.sessionPath ?? ""))
                .toBe("parent.jsonl");
        },
    );
});

test("a close that lands during a trash is refused, and a failed trash leaves the tree running", async () => {
    const moving = deferred();
    const release = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);

            const trashing = harness.registry.trashSession("parent");
            await moving.promise;
            expect(harness.registry.agents.size).toBe(0);
            for (const id of ["parent", "middle", "leaf"]) {
                expect(await harness.registry.closeAgentTree(id)).toEqual({
                    status: "busy",
                    sessionRetained: true,
                    closed: [],
                });
            }
            expect(harness.reported).toEqual([]);

            release.resolve();
            expect(await trashing).toBe("failed");

            expect(harness.registry.list().map((agent) => agent.id).sort())
                .toEqual(["leaf", "middle", "parent"]);
            expect((await harness.registry.closeAgentTree("parent")).status)
                .toBe("closed");
        },
        {
            moveToTrash: async () => {
                moving.resolve();
                await release.promise;
                throw new Error("trash unavailable");
            },
        },
    );
});

test("a close of a member the trash is still closing is refused", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            const leaf = harness.registry.agents.get("leaf")!;
            const leafRun = leaf.run;
            const gate = deferred();
            leaf.run = gate.promise.then(() => leafRun);

            const trashing = harness.registry.trashSession("parent");
            expect(leaf.agent.closed).toBe(true);
            expect(harness.registry.agents.has("leaf")).toBe(true);
            expect((await harness.registry.closeAgentTree("leaf")).status)
                .toBe("busy");
            expect(harness.registry.agents.has("leaf")).toBe(true);

            gate.resolve();
            expect(await trashing).toBe("failed");
            expect(harness.registry.find("leaf")).toBeDefined();
        },
        { moveToTrash: failingMove },
    );
});

test("a trash reports the members that registered while it closed or moved", async () => {
    const moving = deferred();
    const finishMove = deferred();
    const resumeStarted = deferred();
    const finishBind = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);
            await harness.registry.closeAgentTree("middle");
            const bind = harness.registry.bindSessionIdentity.bind(
                harness.registry,
            );
            harness.registry.bindSessionIdentity = async (store) => {
                resumeStarted.resolve();
                await finishBind.promise;
                return bind(store);
            };

            const late = harness.registry.resume({
                sessionPath: join(harness.root, "middle.jsonl"),
            });
            await resumeStarted.promise;
            const trashing = harness.registry.trashSession("parent");
            await moving.promise;
            finishBind.resolve();
            await late;

            finishMove.resolve();
            expect(await trashing).toBe("trashed");

            // The target's file is gone, so only its child is reported.
            expect(harness.reported.map((member) => member.id))
                .toEqual(["middle"]);
            expect(basename(harness.reported[0]!.sessionPath))
                .toBe("middle.jsonl");
        },
        {
            moveToTrash: async () => {
                moving.resolve();
                await finishMove.promise;
            },
        },
    );
});

test("a failed trash reports every member it closed, including one that registered while it closed", async () => {
    const resumeStarted = deferred();
    const finishBind = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);
            await harness.registry.closeAgentTree("middle");
            const bind = harness.registry.bindSessionIdentity.bind(
                harness.registry,
            );
            harness.registry.bindSessionIdentity = async (store) => {
                resumeStarted.resolve();
                await finishBind.promise;
                return bind(store);
            };
            const late = harness.registry.resume({
                sessionPath: join(harness.root, "middle.jsonl"),
            });
            await resumeStarted.promise;
            // The parent's close waits on this, so the late child registers inside it.
            const parent = harness.registry.agents.get("parent")!;
            const parentRun = parent.run;
            const gate = deferred();
            parent.run = gate.promise.then(() => parentRun);

            const trashing = harness.registry.trashSession("parent");
            expect(parent.agent.closed).toBe(true);
            finishBind.resolve();
            await late;
            gate.resolve();
            expect(await trashing).toBe("failed");

            // The parent restarted from its plan; the late child was not planned and stays closed.
            expect(harness.registry.list().map((agent) => agent.id))
                .toEqual(["parent"]);
            expect(harness.reported.map((member) => member.id).sort())
                .toEqual(["middle", "parent"]);
        },
        { moveToTrash: failingMove },
    );
});

test("closing a descendant reports the sessions it closed", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);

            const result = await harness.registry.closeDescendantTree(
                "parent",
                "middle",
            );

            expect(result.status).toBe("closed");
            expect(harness.reported.map((member) => member.id).sort())
                .toEqual(["leaf", "middle"]);
            expect(basename(
                harness.reported.find((member) => member.id === "leaf")
                    ?.sessionPath ?? "",
            )).toBe("leaf.jsonl");
            expect(harness.registry.find("parent")).toBeDefined();
        },
    );
});

test("a failing report does not undo a close", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            const registry = harness.registry;
            const options = registry.options as {
                onSessionsClosed?: () => Promise<void>;
            };
            options.onSessionsClosed = async () => {
                throw new Error("listing unavailable");
            };

            const result = await registry.closeDescendantTree("parent", "middle");

            expect(result.status).toBe("closed");
            expect(registry.find("middle")).toBeUndefined();
            expect(registry.find("parent")).toBeDefined();
        },
    );
});

test("a descendant close refused for a trash does not keep suppressing the child's completion", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openTreeOfThree(harness);
            const middle = harness.registry.agents.get("middle")!;
            middle.pendingAsyncTurns = 1;
            harness.registry.trashingIds.add("middle");

            const result = await harness.registry.closeDescendantTree(
                "parent",
                "middle",
            );

            expect(result.status).toBe("busy");
            expect(harness.registry.suppressedCompletionDeliveries.has(middle))
                .toBe(false);
            expect(harness.registry.find("middle")).toBeDefined();
            harness.registry.trashingIds.delete("middle");
            middle.pendingAsyncTurns = 0;
        },
    );
});

// Fails the test instead of hanging it when a close never finishes.
async function finishesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("did not finish")), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

test("closing an ancestor while a child's failed trash restarts the child finishes and leaves nothing behind", async () => {
    const parentRun = deferred();
    await withRegistry(
        () => new FauxAdapter(replies(6)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);
            const parent = harness.registry.agents.get("parent")!;
            const run = parent.run;
            parent.run = run.then(() => parentRun.promise);

            const trashing = harness.registry.trashSession("middle");
            const closing = harness.registry.closeAgentTree("parent");
            expect(await finishesWithin(trashing, 2_000)).toBe("failed");
            parentRun.resolve();
            expect((await finishesWithin(closing, 2_000)).status).toBe("closed");

            expect([...harness.registry.agents.keys()]).toEqual([]);
            expect(harness.registry.trashingIds.size).toBe(0);
            expect(existsSync(join(harness.root, "middle.jsonl"))).toBe(true);
        },
        { moveToTrash: failingMove },
    );
});

test("reaping an entry that is no longer the registered one leaves the registered one alone", async () => {
    await withRegistry(
        () => new FauxAdapter(replies(4)),
        async (harness) => {
            await openParent(harness);
            await startChild(harness, "middle", "parent");
            await untilSettled(harness.registry, ["middle"]);
            const stale = harness.registry.agents.get("parent")!;

            await harness.registry.reapClosedAgent("middle", stale);

            expect(harness.registry.find("middle")).toBeDefined();
            expect(harness.registry.find("parent")).toBeDefined();
        },
    );
});
