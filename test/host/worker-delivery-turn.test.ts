import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { InboundRouterHostHooks } from "../../src/engine/loop-services.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
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
): AgentRegistry {
    return new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: () => ({
            module: join(import.meta.dir, "fixtures/worker-scripted-adapter.ts"),
            options: { script },
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
        // The transcript update that follows the turn must land before the registry closes.
        await receiveType(attachment, "history");
        expect(await becomes(() => deck.idleForReplacement())).toBe(true);
        attachment.detach();
    } finally {
        await registry.close();
        inbox.close();
    }
}, 30_000);

/** A worker boundary joined to a host boundary by in-memory pipes; the host may serve no requests. */
async function joinedRouter(
    root: string,
    hostRouter: {
        readonly hasPendingDeliveryTurn?: () => boolean | Promise<boolean>;
        readonly onDeliveryTurnDiscarded?: () => void;
    } | undefined,
): Promise<InboundRouterHostHooks> {
    const host = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "delivery",
        cwd: root,
    });
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
    let discarded = 0;
    const router = await joinedRouter(root, {
        hasPendingDeliveryTurn: () => pending,
        onDeliveryTurnDiscarded: () => {
            discarded += 1;
        },
    });

    expect(await router.hasPendingDeliveryTurn?.()).toBe(true);
    pending = false;
    expect(await router.hasPendingDeliveryTurn?.()).toBe(false);

    router.onDeliveryTurnDiscarded?.();
    expect(await becomes(() => discarded === 1)).toBe(true);
});

test("a host that does not answer the pending question has the delivery turn dropped", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-delivery-old-host-"));
    temporaryDirectories.push(root);
    const router = await joinedRouter(root, undefined);

    expect(await router.hasPendingDeliveryTurn?.()).toBe(false);
});

async function becomes(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await Bun.sleep(25);
    }
    return condition();
}

async function receiveType<T extends AgentUpdate["type"]>(
    attachment: AgentAttachment,
    type: T,
): Promise<Extract<AgentUpdate, { readonly type: T }>> {
    const signal = AbortSignal.timeout(10_000);
    while (true) {
        const update = await attachment.receive(signal);
        if (update.type === type) {
            return update as Extract<AgentUpdate, { readonly type: T }>;
        }
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
