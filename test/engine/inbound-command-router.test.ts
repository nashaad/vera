import { expect, test } from "bun:test";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { HookToolCall } from "../../src/sdk/hooks.ts";

test("the inbound router queues prompts and aborts only the active turn", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe((event) => observed.push(event));
    const router = new InboundCommandRouter(channel.engine, events);

    const firstTurn = router.startTurn();
    await expect(router.startTurn()).rejects.toThrow(
        "A turn is already pending or active",
    );
    channel.client.send({ type: "prompt", content: "first" });
    const active = await firstTurn;
    expect(active.prompt.content).toBe("first");

    const aborted = new Promise<void>((resolve) => {
        active.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    channel.client.send({ type: "prompt", content: "second" });
    channel.client.send({ type: "abort" });
    await aborted;
    expect(active.signal.aborted).toBe(true);
    router.finishTurn();

    const next = await router.startTurn();
    expect(next.prompt.content).toBe("second");
    expect(next.signal.aborted).toBe(false);
    router.finishTurn();

    expect(observed).toEqual([
        { type: "prompt_queued", content: "second" },
        { type: "abort_requested" },
    ]);
});

test("the inbound router matches one approval response by request ID", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe(createProtocolEncoder(channel.engine));
    events.subscribe((event) => observed.push(event));
    const router = new InboundCommandRouter(channel.engine, events);
    const toolCall = bashToolCall("curl https://example.com");

    const approval = router.requestToolApproval(
        toolCall,
        "This command may access the network.",
        { timeoutMs: 1_000 },
    );
    const request = await channel.client.receive();
    expect(request).toMatchObject({
        type: "ui_request",
        request: {
            type: "tool_approval",
            toolCall,
            reason: "This command may access the network.",
            warning: "If allowed, this command and its child processes run with your full user permissions.",
        },
        seq: 1,
    });
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }

    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "tool_approval", decision: "allow" },
    });

    expect(await approval).toEqual({ behavior: "allow" });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: request.requestId,
        seq: 2,
    });
    expect(observed.map((event) => event.type)).toEqual([
        "ui_request",
        "ui_response",
        "ui_request_closed",
    ]);
});

test("an unknown approval response is ignored and denial is explicit", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    const approval = router.requestToolApproval(
        bashToolCall("bun install"),
        "This command may access the network.",
        { timeoutMs: 1_000 },
    );
    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: "stale-request",
        response: { type: "tool_approval", decision: "allow" },
    });
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "tool_approval", decision: "deny" },
    });

    expect(await approval).toEqual({
        behavior: "deny",
        reason: "Tool use was denied by the user.",
    });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: request.requestId,
        seq: 2,
    });
});

test("approval timeout and turn abort both deny and clean up", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    const timedOut = router.requestToolApproval(
        bashToolCall("bun install"),
        "This command may access the network.",
        { timeoutMs: 10 },
    );
    const timeoutRequest = await channel.client.receive();
    if (timeoutRequest.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    expect(await timedOut).toEqual({
        behavior: "deny",
        reason: "Tool approval timed out.",
    });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: timeoutRequest.requestId,
        seq: 2,
    });

    const turn = router.startTurn();
    channel.client.send({ type: "prompt", content: "run it" });
    const active = await turn;
    const aborted = router.requestToolApproval(
        bashToolCall("curl https://example.com"),
        "This command may access the network.",
        { timeoutMs: 1_000, signal: active.signal },
    );
    const abortRequest = await channel.client.receive();
    if (abortRequest.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({ type: "abort" });
    expect(await aborted).toEqual({
        behavior: "deny",
        reason: "Tool approval was cancelled.",
    });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: abortRequest.requestId,
        seq: 4,
    });
    expect(active.signal.aborted).toBe(true);
    router.finishTurn();
});

test("a disconnected client denies approval without waiting for timeout", async () => {
    const events = new EngineEventBus();
    const router = new InboundCommandRouter({
        send(): void {},
        receive(): Promise<never> {
            return Promise.reject(new Error("client disconnected"));
        },
    }, events);

    expect(await router.requestToolApproval(
        bashToolCall("curl https://example.com"),
        "This command may access the network.",
        { timeoutMs: 10_000 },
    )).toEqual({
        behavior: "deny",
        reason: "No client is available to approve this tool.",
    });
});

test("model settings commands reject explicitly when no owner is installed", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events);

    channel.client.send({
        type: "get_model_settings",
        requestId: "read-settings",
    });
    expect(await channel.client.receive()).toEqual({
        type: "model_settings_rejected",
        requestId: "read-settings",
        reason: "unavailable",
        seq: 1,
    });

    channel.client.send({
        type: "update_model_settings",
        requestId: "change-settings",
        patch: { model: "next-model" },
    });
    expect(await channel.client.receive()).toEqual({
        type: "model_settings_rejected",
        requestId: "change-settings",
        reason: "unavailable",
        seq: 2,
    });
});

test("permission commands reject explicitly when no owner is installed", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events);

    channel.client.send({
        type: "get_permissions",
        requestId: "read-permissions",
    });
    expect(await channel.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "read-permissions",
        reason: "unavailable",
        seq: 1,
    });

    channel.client.send({
        type: "update_permissions",
        requestId: "change-permissions",
        mode: "full_access",
    });
    expect(await channel.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "change-permissions",
        reason: "unavailable",
        seq: 2,
    });
});

test("a later settings command cannot change an earlier queued prompt", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    let settings: ModelTurnSettings = {
        model: "first-model",
        reasoningEffort: "low",
    };
    const router = new InboundCommandRouter(channel.engine, events, {
        readModelSettings: () => settings,
        async updateModelSettings(patch) {
            settings = {
                model: patch.model ?? settings.model,
                reasoningEffort: "low",
            };
            return settings;
        },
    });

    channel.client.send({ type: "prompt", content: "first" });
    channel.client.send({
        type: "update_model_settings",
        requestId: "change-settings",
        patch: { model: "second-model" },
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "model_settings",
        requestId: "change-settings",
        settings: { model: "second-model", reasoningEffort: "low" },
        pending: true,
    });

    const first = await router.startTurn();
    expect(first.prompt.content).toBe("first");
    expect(first.modelSettings).toEqual({
        model: "first-model",
        reasoningEffort: "low",
    });
    router.finishTurn();

    channel.client.send({ type: "prompt", content: "second" });
    const second = await router.startTurn();
    expect(second.modelSettings).toEqual({
        model: "second-model",
        reasoningEffort: "low",
    });
    router.finishTurn();
});

test("a following prompt waits for the durable settings boundary", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    let settings: ModelTurnSettings = {
        model: "first-model",
        reasoningEffort: "low",
    };
    let finishPersistence: () => void = () => {};
    const persistence = new Promise<void>((resolve) => {
        finishPersistence = resolve;
    });
    let signalPersistenceStarted: () => void = () => {};
    const persistenceStarted = new Promise<void>((resolve) => {
        signalPersistenceStarted = resolve;
    });
    const router = new InboundCommandRouter(channel.engine, events, {
        readModelSettings: () => settings,
        async updateModelSettings() {
            signalPersistenceStarted();
            await persistence;
            settings = {
                model: "second-model",
                reasoningEffort: "high",
            };
            return settings;
        },
    });

    channel.client.send({
        type: "update_model_settings",
        requestId: "durable-settings",
        patch: { model: "second-model", reasoningEffort: "high" },
    });
    await persistenceStarted;
    channel.client.send({ type: "prompt", content: "after settings" });
    const turn = router.startTurn();
    expect(await Promise.race([
        turn.then(() => "started" as const),
        Bun.sleep(10).then(() => "waiting" as const),
    ])).toBe("waiting");

    finishPersistence();
    expect(await channel.client.receive()).toMatchObject({
        type: "model_settings",
        requestId: "durable-settings",
        settings: {
            model: "second-model",
            reasoningEffort: "high",
        },
    });
    const active = await turn;
    expect(active.prompt.content).toBe("after settings");
    expect(active.modelSettings).toEqual({
        model: "second-model",
        reasoningEffort: "high",
    });
    router.finishTurn();
});

test("permission changes preserve earlier prompts and order later prompts", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    let mode: ApprovalMode = "ask";
    let finishPersistence: () => void = () => {};
    const persistence = new Promise<void>((resolve) => {
        finishPersistence = resolve;
    });
    let signalPersistenceStarted: () => void = () => {};
    const persistenceStarted = new Promise<void>((resolve) => {
        signalPersistenceStarted = resolve;
    });
    const router = new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => mode,
        async updateApprovalMode(nextMode) {
            signalPersistenceStarted();
            await persistence;
            mode = nextMode;
            return mode;
        },
    });

    channel.client.send({ type: "prompt", content: "before change" });
    channel.client.send({
        type: "update_permissions",
        requestId: "durable-permissions",
        mode: "full_access",
    });
    await persistenceStarted;
    channel.client.send({ type: "prompt", content: "after change" });

    const first = await router.startTurn();
    expect(first.approvalMode).toBe("ask");
    router.finishTurn();
    const secondTurn = router.startTurn();
    expect(await Promise.race([
        secondTurn.then(() => "started" as const),
        Bun.sleep(10).then(() => "waiting" as const),
    ])).toBe("waiting");

    finishPersistence();
    expect(await channel.client.receive()).toMatchObject({
        type: "permissions",
        requestId: "durable-permissions",
        mode: "full_access",
        pending: false,
    });
    const second = await secondTurn;
    expect(second.approvalMode).toBe("full_access");
    router.finishTurn();
});

test("a failed permissions write rejects without closing the command router", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
        async updateApprovalMode() {
            throw new Error("disk unavailable");
        },
    });

    channel.client.send({
        type: "update_permissions",
        requestId: "failed-permissions",
        mode: "full_access",
    });
    expect(await channel.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "failed-permissions",
        reason: "unavailable",
        seq: 1,
    });

    channel.client.send({ type: "prompt", content: "still connected" });
    const turn = await router.startTurn();
    expect(turn.prompt.content).toBe("still connected");
    expect(turn.approvalMode).toBe("ask");
    router.finishTurn();
});

test("timeline commands stay ordered with queued prompts", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const handled: Array<{
        ownerId: string;
        type: string;
        blocked: boolean;
    }> = [];
    let notifyHandled: () => void = () => {};
    let handledNext = new Promise<void>((resolve) => notifyHandled = resolve);
    let router: InboundCommandRouter;
    router = new InboundCommandRouter(channel.engine, events, {
        async handleTimelineCommand(ownerId, command) {
            handled.push({
                ownerId,
                type: command.type,
                blocked: router.timelineBlocked(),
            });
            notifyHandled();
        },
    });

    channel.client.send({ type: "list_timeline", requestId: "list-1" });
    await handledNext;
    expect(handled.shift()).toEqual({
        ownerId: "direct-client",
        type: "list_timeline",
        blocked: false,
    });

    handledNext = new Promise<void>((resolve) => notifyHandled = resolve);
    channel.client.send({ type: "prompt", content: "queued first" });
    channel.client.send({
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: "message-1",
        action: "rewind_conversation",
    });
    await handledNext;
    expect(handled.shift()).toEqual({
        ownerId: "direct-client",
        type: "preview_timeline_action",
        blocked: true,
    });

    const turn = await router.startTurn();
    expect(turn.prompt.content).toBe("queued first");
    router.finishTurn();
});

function bashToolCall(command: string): HookToolCall {
    return {
        id: "call_1",
        name: "bash",
        input: { command },
    };
}
