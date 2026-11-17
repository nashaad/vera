import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel, type MessageChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import type { EngineCommand } from "../../src/engine/timeline-control.ts";
import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { recordDeliveryAndNotify } from "../../src/host/delivery-notifier.ts";
import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelInputMessage } from "../../src/model/types.ts";
import { sessionRecordForWire } from "../../src/store/session-record-projection.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
        await Bun.sleep(5);
    }
}

function answer(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

test("@core the host replicates an active completion to the worker and settles its stale wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-active-delivery-"));
    const path = join(root, "session.jsonl");
    const host = await SessionStore.create(path, { sessionId: "parent", cwd: root });
    const hostEvents = new EngineEventBus();
    const hostNotifications: EngineEvent[] = [];
    hostEvents.subscribe((event) => hostNotifications.push(event));
    const discarded: string[] = [];
    const diverged: Error[] = [];
    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    const hostPipe = createJsonPipe({ input: toHost, output: toWorker }, {
        onRequest: (body) => server.handleRequest(body),
        onNotification: (body) => server.handleNotification(body),
    });
    const server = createWorkerBoundaryServer({
        pipe: hostPipe,
        store: host,
        services: {
            eventBus: hostEvents,
            router: {
                hasPendingDeliveryTurn: () => false,
                onDeliveryTurnDiscarded: (reason) => discarded.push(reason),
            },
        },
    });
    host.watchRecords((line, record) => server.pushRecord(line, sessionRecordForWire(record)));
    const workerPipe = createJsonPipe({ input: toWorker, output: toHost }, {
        onNotification: (body) => remote.acceptNotification(body),
    });
    const remote = createRemoteHostBoundary({
        pipe: workerPipe,
        session: await readSessionSeed(path),
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
        onReplicaDiverged: (error) => diverged.push(error),
    });
    const owned = remote.boundary.owned!;
    const worker = owned.sessionStore!;
    const transport = createInProcessChannel();
    const client = transport.client as MessageChannel<EngineCommand, AgentUpdate>;
    const inbound = new InboundCommandRouter(
        transport.engine as MessageChannel<AgentUpdate, EngineCommand>,
        owned.eventBus!,
        owned.router,
    );
    const workerEvents: EngineEvent[] = [];
    owned.eventBus!.subscribe((event) => workerEvents.push(event));
    let startTool!: (signal: AbortSignal) => void;
    const toolStarted = new Promise<AbortSignal>((resolve) => { startTool = resolve; });
    let releaseTool!: () => void;
    const gate = new Promise<void>((resolve) => { releaseTool = resolve; });
    const tool: RegisteredTool = {
        definition: {
            name: "test_gate",
            description: "Wait until released.",
            inputSchema: { type: "object", properties: {} },
        },
        execute: async (_input, _runtime, signal) => {
            startTool(signal);
            await gate;
            return { kind: "output", output: "Gate released", isError: false };
        },
    };
    const state: RunTurnState = {
        sessionId: "parent",
        messages: [],
        store: worker,
        deliveryInbox: worker,
        toolRuntime: new ToolRuntime(root),
        inbound,
        events: owned.eventBus!,
        hooks: owned.hooks!,
        approvalMode: "auto",
        reviewToolCall: async () => ({
            decision: "allow", reason: "Allowed for the test", riskLevel: "low", userAuthorization: "unknown",
        }),
        extensionTools: [tool],
        loadOptionalContext: false,
    };
    const faux = new FauxAdapter([
        {
            role: "assistant",
            content: [{ type: "tool_call", id: "gate-call", name: "test_gate", input: {} }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        answer("Current turn finished"),
        answer("Next turn finished"),
    ]);
    const requests: { readonly turnId: string | undefined; readonly messages: readonly ModelInputMessage[] }[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push({ turnId: request.turnId, messages: structuredClone(request.messages) });
            return faux.stream(request);
        },
    };
    try {
        client.send({ type: "prompt", content: "Start work" });
        const turn = runTurn(adapter, "test", state);
        const signal = await toolStarted;
        const completion = { id: "child", sourceAgentId: "child", content: "Found the map" };
        expect(await recordDeliveryAndNotify(host, hostEvents, completion)).toBe(true);
        expect(await recordDeliveryAndNotify(host, hostEvents, completion)).toBe(false);
        await waitFor(() => worker.pendingDeliveries().some((entry) => entry.id === "child"));
        client.send({ type: "trigger_delivery_turn" });
        expect(signal.aborted).toBe(false);
        expect(requests).toHaveLength(1);
        releaseTool();
        await turn;

        expect(requests).toHaveLength(2);
        expect(requests[1]!.turnId).toBe(requests[0]!.turnId);
        expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual([...requests[0]!.messages]);
        expect(JSON.stringify(requests[0]!.messages)).not.toContain("Found the map");
        expect(JSON.stringify(requests[1]!.messages)).toContain("Found the map");
        expect(host.pendingDeliveries()).toEqual([]);
        expect(worker.pendingDeliveries()).toEqual([]);
        expect(hostNotifications.filter((event) => event.type === "task_notification")).toHaveLength(1);
        expect(workerEvents.filter((event) => event.type === "task_notification")).toHaveLength(1);
        expect(diverged).toEqual([]);

        const nextTurn = runTurn(adapter, "test", state);
        await waitFor(() => discarded.includes("empty"));
        expect(requests).toHaveLength(2);
        client.send({ type: "prompt", content: "Continue" });
        await nextTurn;
        expect(requests).toHaveLength(3);
        expect(discarded).toEqual(["empty"]);
        const reopened = await SessionStore.open(path);
        const admitted = reopened.activeEntries().filter((entry) =>
            (entry.type === "message" || entry.type === "turn_start") && entry.deliveryId === "child"
        );
        expect(admitted).toHaveLength(1);
        expect(reopened.pendingDeliveries()).toEqual([]);
        expect(diverged).toEqual([]);
    } finally {
        releaseTool();
        await inbound.stopReceivingCommands();
        await state.toolRuntime.close();
        workerPipe.close();
        hostPipe.close();
        await rm(root, { recursive: true, force: true });
    }
});
