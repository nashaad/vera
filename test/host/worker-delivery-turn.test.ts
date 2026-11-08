import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { DeliveryDiscardReason } from "../../src/engine/host-protocol.ts";
import type { InboundRouterHostHooks } from "../../src/engine/loop-services.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { forwardWorkerUpdate } from "../../src/host/agent-registry/subagent.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { ResidentAgent, type AgentAttachment } from "../../src/host/resident-agent.ts";
import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
import { WorkerSessionStore } from "../../src/host/worker/session.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
    ));
});

function workerRegistry(
    root: string,
    script: readonly AssistantMessage[],
    coordinator?: InboxDeliveryCoordinator,
    startupDelayMs?: number,
): AgentRegistry {
    return new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: () => ({
            module: join(import.meta.dir, "fixtures/worker-scripted-adapter.ts"),
            options: { script, ...(startupDelayMs === undefined ? {} : { startupDelayMs }) },
        }),
        model: "faux/test",
        approvalMode: "auto",
        ...(coordinator === undefined ? {} : { inboxDelivery: coordinator }),
    });
}

test("a delivery turn the worker drops frees the host to replace the conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-dropped-"));
    temporaryDirectories.push(root);
    const registry = workerRegistry(root, []);
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();

        // Nothing is waiting to be delivered, so the worker discards the turn it is asked for.
        deck.triggerDeliveryTurn();

        expect(await becomes(() => deck.idleForReplacement())).toBe(true);
        attachment.detach();
    } finally {
        await registry.close();
    }
}, 30_000);

test("a cut delivery does not make a later empty wake start a worker turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-cut-"));
    temporaryDirectories.push(root);
    const path = join(root, "deck.jsonl");
    const store = await SessionStore.create(path, { sessionId: "deck", cwd: root });
    await store.recordDelivery({ id: "child", sourceAgentId: "child", content: "Found the map" });
    await store.appendDeliveryMessage("child", {
        role: "user", internal: true, content: [{ type: "text", text: "Found the map" }],
    }, { turnStart: true });
    const registry = workerRegistry(root, [textResponse("Ready for the next request")]);
    try {
        const deck = await registry.resume({ sessionPath: path });
        const attachment = deck.attach();
        expect((await attachment.receive()).type).toBe("history");
        const reopened = await SessionStore.open(path);
        expect(reopened.hasUnansweredDeliveryTurn()).toBe(false);
        const seed = await readSessionSeed(path);
        const worker = WorkerSessionStore.seed(path, seed.header);
        seed.records.forEach((record, index) => worker.applyHostRecord(index + 2, record));
        expect(worker.projectedHarnessMessages()).toEqual(reopened.projectedHarnessMessages());
        deck.triggerDeliveryTurn();
        expect(await becomes(() => deck.idleForReplacement())).toBe(true);
        expect((await SessionStore.open(path)).messages().filter((message) => message.role === "assistant")).toHaveLength(0);
        attachment.send({ type: "prompt", content: "What next?" });
        await receiveType(attachment, "turn_finished");
        const completed = await SessionStore.open(path);
        expect(JSON.stringify(completed.messages())).toContain("Ready for the next request");
        attachment.detach();
    } finally {
        await registry.close();
    }
}, 30_000);

test("a worker starts a delivery turn for an admitted entry that was never recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-admitted-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: ["filesystem"],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const registry = workerRegistry(root, [textResponse("Gulls sighted.")], coordinator);
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();

        await coordinator.append({
            source: "watch/git",
            kind: "filesystem.changed",
            address: "deck",
            payload: JSON.stringify({}),
        });
        await receiveType(attachment, "turn_finished");
        expect(await becomes(() => deck.idleForReplacement())).toBe(true);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

test("a conversation in a worker is asked about an unadmitted source, and its turn starts on yes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-admission-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: [],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const registry = workerRegistry(root, [textResponse("Gulls sighted.")], coordinator);
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();

        await coordinator.append({
            source: "watch/git",
            kind: "filesystem.changed",
            address: "deck",
            payload: JSON.stringify({}),
        });
        const question = await receiveTypeWithin(attachment, "ui_request", 5_000);
        expect(question?.request).toMatchObject({ type: "user_question", outOfBand: true });

        attachment.send({
            type: "ui_response",
            requestId: question!.requestId,
            response: { type: "user_question", outcome: "selected", choiceId: "once" },
        });
        await receiveType(attachment, "turn_finished");
        const history = await receiveType(attachment, "history");
        expect(JSON.stringify(history.entries)).toContain("Gulls sighted.");
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

test("an entry waiting for a client to attach is asked about once the worker is up", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-admission-early-"));
    temporaryDirectories.push(root);
    const { inbox, coordinator } = unadmittingCoordinator(root);
    const registry = workerRegistry(root, [textResponse("Gulls sighted.")], coordinator, 300);
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        // Nobody is attached, so nothing is asked yet.
        await coordinator.append({
            source: "watch/git",
            kind: "filesystem.changed",
            address: "deck",
            payload: JSON.stringify({}),
        });
        const attachment = deck.attach();
        await attachment.receive();

        const question = await receiveTypeWithin(attachment, "ui_request", 8_000);
        expect(question?.request).toMatchObject({ type: "user_question", outOfBand: true });
        attachment.send({
            type: "ui_response",
            requestId: question!.requestId,
            response: { type: "user_question", outcome: "selected", choiceId: "once" },
        });
        await receiveType(attachment, "turn_finished");
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

test("an entry that arrives while the worker is still starting is asked about once, however many follow it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-admission-boot-"));
    temporaryDirectories.push(root);
    const { inbox, coordinator } = unadmittingCoordinator(root);
    const registry = workerRegistry(
        root,
        [textResponse("Gulls sighted."), textResponse("Gulls again."), textResponse("Gulls once more.")],
        coordinator,
        500,
    );
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();
        // The owner router exists, but the worker has not started listening for events.
        expect(await becomes(() => registry.agents.get("deck")?.workerOwnerRouter !== undefined)).toBe(true);

        for (let arrival = 0; arrival < 2; arrival += 1) {
            await coordinator.append({
                source: "watch/git",
                kind: "filesystem.changed",
                address: "deck",
                payload: JSON.stringify({ arrival }),
            });
        }
        const question = await receiveTypeWithin(attachment, "ui_request", 8_000);
        expect(question?.request).toMatchObject({ type: "user_question", outOfBand: true });
        // The second arrival joins the question already waiting; nothing else is shown.
        expect(await receiveTypeWithin(attachment, "ui_request", 500)).toBeUndefined();

        attachment.send({
            type: "ui_response",
            requestId: question!.requestId,
            response: { type: "user_question", outcome: "selected", choiceId: "session" },
        });
        await receiveType(attachment, "turn_finished");
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

test("the worker's transcript update that lands after the conversation closed is dropped", () => {
    const update: AgentUpdate = { type: "notice", key: "inbox", count: 1, seq: 1 };
    const closed = new ResidentAgent("closed", "/work/one");
    closed.close();
    expect(() => forwardWorkerUpdate(closed, update, undefined)).not.toThrow();

    const failed = new ResidentAgent("failed", "/work/one");
    failed.fail("failure-1", "worker lost");
    expect(() => forwardWorkerUpdate(failed, update, undefined)).not.toThrow();
});

test("a live conversation still receives the worker's updates, and a bad private update still throws", async () => {
    const agent = new ResidentAgent("live", "/work/one");
    const attachment = agent.attach();
    try {
        await attachment.receive();
        const update: AgentUpdate = { type: "notice", key: "inbox", count: 1, seq: 1 };
        forwardWorkerUpdate(agent, update, undefined);
        expect(await attachment.receive()).toEqual(update);
        expect(() => forwardWorkerUpdate(agent, update, "owner-1")).toThrow("unowned private update");
    } finally {
        attachment.detach();
        agent.close();
    }
});

test("closing the registry the moment a worker turn finishes raises nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-close-"));
    temporaryDirectories.push(root);
    const raised: unknown[] = [];
    const record = (error: unknown): void => {
        raised.push(error);
    };
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: ["filesystem"],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const registry = workerRegistry(root, [textResponse("Gulls sighted.")], coordinator);
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();
        await coordinator.append({
            source: "watch/git",
            kind: "filesystem.changed",
            address: "deck",
            payload: JSON.stringify({}),
        });
        await receiveType(attachment, "turn_finished");
        // The worker's history update for this turn is still in flight.
        await registry.close();
        await Bun.sleep(500);
        expect(raised).toEqual([]);
    } finally {
        process.off("uncaughtException", record);
        process.off("unhandledRejection", record);
        await registry.close();
        inbox.close();
    }
}, 30_000);

/** A worker boundary joined to a host boundary by in-memory pipes; the host may serve no requests. */
async function joinedRouter(
    root: string,
    hostRouter: {
        readonly hasPendingDeliveryTurn?: () => boolean | Promise<boolean>;
        readonly onDeliveryTurnDiscarded?: (reason: DeliveryDiscardReason) => void;
    } | undefined,
    prepare?: (store: SessionStore) => Promise<void>,
): Promise<InboundRouterHostHooks> {
    const host = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "delivery",
        cwd: root,
    });
    await prepare?.(host);
    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    const server = createWorkerBoundaryServer({
        pipe: createJsonPipe(
            { input: toHost, output: toWorker },
            hostRouter === undefined
                ? {}
                : {
                    onRequest: (body) => server.handleRequest(body),
                    onNotification: (body) => server.handleNotification(body),
                },
        ),
        store: host,
        services: hostRouter === undefined ? {} : { router: hostRouter },
    });
    const remote = createRemoteHostBoundary({
        pipe: createJsonPipe(
            { input: toWorker, output: toHost },
            { onNotification: (body) => remote.acceptNotification(body) },
        ),
        session: await readSessionSeed(host.path),
        offers: { approvalModeRead: false, modelSettings: false, selectedAgent: false },
        capabilities: {
            updateApprovalMode: false,
            reviewToolCall: false,
            applyHostToolEffect: false,
            requestMissingSubagentConfiguration: false,
            applyCommittedToolEffect: false,
            loadContextualContributions: false,
            checkSkillFile: false,
            hooks: false,
            reviewLog: false,
            hasPendingDeliveryTurn: true,
            selectAgent: false,
            listSkills: false,
            invokeSkill: false,
        },
        state: { policy: {} },
        onReplicaDiverged: () => undefined,
    });
    return remote.boundary.owned?.router ?? {};
}

test("the worker asks the host whether a delivery turn is pending and tells it when one is dropped", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-pipe-"));
    temporaryDirectories.push(root);
    let pending = true;
    const reasons: DeliveryDiscardReason[] = [];
    const router = await joinedRouter(root, {
        hasPendingDeliveryTurn: () => pending,
        onDeliveryTurnDiscarded: (reason) => {
            reasons.push(reason);
        },
    });

    expect(await router.hasPendingDeliveryTurn?.()).toBe(true);
    pending = false;
    expect(await router.hasPendingDeliveryTurn?.()).toBe(false);

    // Each reason reaches the host as the worker gave it.
    router.onDeliveryTurnDiscarded?.("folded");
    router.onDeliveryTurnDiscarded?.("aborted");
    router.onDeliveryTurnDiscarded?.("empty");
    expect(await becomes(() => reasons.length === 3)).toBe(true);
    expect(reasons).toEqual(["folded", "aborted", "empty"]);
});

test("the host includes its unanswered delivery in the pending reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-host-state-"));
    temporaryDirectories.push(root);
    const router = await joinedRouter(root, { hasPendingDeliveryTurn: () => false }, async (store) => {
        await store.recordDelivery({ id: "child", sourceAgentId: "child", content: "Found the map" });
        await store.appendDeliveryMessage("child", {
            role: "user", internal: true, content: [{ type: "text", text: "Found the map" }],
        });
    });
    expect(await router.hasPendingDeliveryTurn?.()).toBe(true);
});

test("a host that does not answer the pending question has the delivery turn dropped", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-old-host-"));
    temporaryDirectories.push(root);
    const router = await joinedRouter(root, undefined);

    expect(await router.hasPendingDeliveryTurn?.()).toBe(false);
});

test("a question raised after the worker speaks but before the owner router exists waits for the router", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-admission-late-router-"));
    temporaryDirectories.push(root);
    const { inbox, coordinator } = unadmittingCoordinator(root);
    const registry = workerRegistry(root, [textResponse("Gulls sighted.")], coordinator);
    // The start call returns late, so the worker's first update lands before the owner router is set.
    const exclusively = SessionStore.prototype.exclusively;
    SessionStore.prototype.exclusively = function <T>(this: SessionStore, task: () => Promise<T>): Promise<T> {
        const started = exclusively.call(this, task) as Promise<T>;
        return started.then(async (value) => {
            await Bun.sleep(2_000);
            return value;
        });
    };
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();
        await coordinator.append({
            source: "watch/git",
            kind: "filesystem.changed",
            address: "deck",
            payload: JSON.stringify({}),
        });

        // The worker has had time to speak; the question still waits for the router.
        expect(await receiveTypeWithin(attachment, "ui_request", 1_000)).toBeUndefined();
        expect(registry.agents.get("deck")?.workerOwnerRouter).toBeUndefined();

        const question = await receiveTypeWithin(attachment, "ui_request", 8_000);
        expect(question?.request).toMatchObject({ type: "user_question", outOfBand: true });
        attachment.send({
            type: "ui_response",
            requestId: question!.requestId,
            response: { type: "user_question", outcome: "selected", choiceId: "once" },
        });
        await receiveType(attachment, "turn_finished");
        attachment.detach();
    } finally {
        SessionStore.prototype.exclusively = exclusively;
        await registry.close();
        inbox.close();
    }
}, 30_000);

test("an entry woken while a worker's empty answer crosses the pipe is not woken again", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-empty-crossing-"));
    temporaryDirectories.push(root);
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: ["arc"],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    const registry = workerRegistry(
        root,
        [textResponse("Woke for the gull."), textResponse("Woke for the gull again.")],
        coordinator,
    );
    try {
        const deck = await registry.create({
            id: "deck",
            workspace: root,
            sessionPath: join(root, "deck.jsonl"),
        });
        const attachment = deck.attach();
        await attachment.receive();
        const session = registry.agents.get("deck")!.inbox!;
        const hasAdmittedPending = session.hasAdmittedPending.bind(session);
        let appended = false;
        session.hasAdmittedPending = () => {
            const answer = hasAdmittedPending();
            if (!answer && !appended) {
                appended = true;
                // Lands after the "nothing pending" reply leaves and before the worker's discard arrives.
                setImmediate(() => {
                    void coordinator.append({
                        source: "arc",
                        kind: "arc.post",
                        address: "deck",
                        payload: JSON.stringify({ gull: 1 }),
                    });
                });
            }
            return answer;
        };

        deck.triggerDeliveryTurn();
        expect(await receiveTypeWithin(attachment, "turn_finished", 8_000)).toBeDefined();
        await coordinator.append({
            source: "arc",
            kind: "arc.post",
            address: "someone-else",
            payload: JSON.stringify({}),
        });
        await coordinator.pumpAll();

        expect(appended).toBe(true);
        expect(await receiveTypeWithin(attachment, "turn_finished", 3_000)).toBeUndefined();
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

async function becomes(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await Bun.sleep(25);
    }
    return condition();
}

async function receiveTypeWithin<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
    ms: number,
): Promise<Extract<AgentUpdate, { readonly type: T }> | undefined> {
    try {
        return await receiveType(attachment, type, ms);
    } catch {
        return undefined;
    }
}

async function receiveType<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
    ms = 10_000,
): Promise<Extract<AgentUpdate, { readonly type: T }>> {
    const signal = AbortSignal.timeout(ms);
    while (true) {
        const update = await attachment.receive(signal);
        if (update.type === type) {
            return update as Extract<AgentUpdate, { readonly type: T }>;
        }
    }
}

/** A coordinator that has admitted no source, so every first entry from one raises a question. */
function unadmittingCoordinator(root: string): {
    readonly inbox: Inbox;
    readonly coordinator: InboxDeliveryCoordinator;
} {
    const inbox = Inbox.open(join(root, "inbox.db"));
    const coordinator = new InboxDeliveryCoordinator(
        new ConsumerRegistry(inbox, "node-a"),
        {
            admission: new InboxAdmissionPolicy({
                user: [],
                userConfigPath: join(root, "user-config.json"),
            }),
        },
    );
    return { inbox, coordinator };
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
