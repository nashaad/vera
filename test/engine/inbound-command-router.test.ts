import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import {
    createInProcessChannel,
    type MessageChannel,
} from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { EngineCommand } from "../../src/engine/timeline-control.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { PermissionPreferenceStore } from "../../src/engine/permission-preferences.ts";
import {
    inspectPermissions,
    type ApprovalMode,
    type PermissionGrant,
    type PermissionInspection,
    type PermissionPredicate,
} from "../../src/engine/permissions.ts";
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

test("a delivery trigger waits behind the active turn without a fake prompt", async () => {
    const channel = createInProcessChannel();
    const internalClient = channel.client as unknown as MessageChannel<
        EngineCommand,
        AgentUpdate
    >;
    let deliveryPending = true;
    const router = new InboundCommandRouter(channel.engine, new EngineEventBus(), {
        hasPendingDeliveryTurn: () => deliveryPending,
    });

    const firstTurn = router.startTurn();
    channel.client.send({ type: "prompt", content: "user work" });
    const active = await firstTurn;
    expect(active.prompt.content).toBe("user work");

    internalClient.send({ type: "trigger_delivery_turn" });
    internalClient.send({ type: "trigger_delivery_turn" });
    router.finishTurn();

    const deliveryTurn = await router.startTurn();
    expect(deliveryTurn.triggeredByDelivery).toBe(true);
    expect(deliveryTurn.prompt.content).toBe("");
    deliveryPending = false;
    router.finishTurn();

    channel.client.send({ type: "prompt", content: "next user turn" });
    const next = await router.startTurn();
    expect(next.prompt.content).toBe("next user turn");
    expect(next.triggeredByDelivery).toBeUndefined();
    router.finishTurn();
});

test("a user turn that drains a delivery cancels its queued wake", async () => {
    const channel = createInProcessChannel();
    const internalClient = channel.client as unknown as MessageChannel<
        EngineCommand,
        AgentUpdate
    >;
    let deliveryPending = true;
    const router = new InboundCommandRouter(channel.engine, new EngineEventBus(), {
        hasPendingDeliveryTurn: () => deliveryPending,
    });

    const firstTurn = router.startTurn();
    channel.client.send({ type: "prompt", content: "user work" });
    internalClient.send({ type: "trigger_delivery_turn" });
    const active = await firstTurn;
    deliveryPending = false;
    router.finishTurn();

    const nextTurn = router.startTurn();
    channel.client.send({ type: "prompt", content: "after delivery" });
    const next = await nextTurn;
    expect(next.prompt.content).toBe("after delivery");
    expect(next.triggeredByDelivery).toBeUndefined();
    router.finishTurn();
});

test("the approval warning names the authority the tool takes", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    void router.requestToolApproval(
        { id: "f1", name: "web_fetch", input: { url: "https://example.com" } },
        "Permission mode ask requires ask: web.fetch.",
        { timeoutMs: 1_000 },
    );
    const request = await channel.client.receive() as {
        readonly request: { readonly warning: string };
    };
    expect(request.request.warning).not.toContain("child processes");
    expect(request.request.warning).toContain("over your network");
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
        response: { type: "tool_approval", decision: "allow_once" },
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

test("session grants are saved before the tool is allowed", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const saved: unknown[] = [];
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {
        addPermissionGrants: async (grants) => {
            saved.push(grants);
        },
    });
    const grants = [{
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    }] as const;
    const approval = router.requestToolApproval(
        bashToolCall("git push origin"),
        "Bash commands run with your full user permissions.",
        { timeoutMs: 1_000, permissionGrants: grants },
    );
    const request = await channel.client.receive();
    expect(request).toMatchObject({
        type: "ui_request",
        request: { permissionGrants: grants },
    });
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }

    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "tool_approval", decision: "allow_similar" },
    });

    expect(await approval).toEqual({ behavior: "allow" });
    expect(saved).toEqual([grants]);
    expect((await channel.client.receive()).type).toBe("ui_request_closed");
});

test("allow_always persists the same predicate the session row would", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const persisted: PermissionPredicate[] = [];
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
        readPermissionInspection: () => inspectPermissions("ask"),
        addPermissionPreference: async (when) => {
            persisted.push(when);
            return { id: "pref-1", when, createdAt: "2026-07-25T00:00:00.000Z" };
        },
    });
    const grants = [{
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    }] as const;
    const approval = router.requestToolApproval(
        bashToolCall("git push origin"),
        "Bash commands run with your full user permissions.",
        { timeoutMs: 1_000, permissionGrants: grants },
    );
    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }

    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "tool_approval", decision: "allow_always" },
    });

    expect(await approval).toEqual({ behavior: "allow" });
    // The predicate is the grant proposal's, not a re-derived one, so the
    // durable row silences exactly what the session row above it would.
    expect(persisted).toEqual([{ operation: "git.push" }]);
    expect((await channel.client.receive()).type).toBe("ui_request_closed");
    // The durable list changed, so clients get an unsolicited refresh: nothing
    // else would tell them, since they only fetch an inspection at startup.
    expect(await channel.client.receive()).toMatchObject({
        type: "permissions",
        requestId: request.requestId,
    });
});

test("allow_always is ignored when no preference store is installed", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    // No `addPermissionPreference`, which is the shape of a host started
    // without a preferences file path.
    const router = new InboundCommandRouter(channel.engine, events, {});
    const approval = router.requestToolApproval(
        bashToolCall("git push origin"),
        "Bash commands run with your full user permissions.",
        {
            timeoutMs: 200,
            permissionGrants: [{
                kind: "action",
                when: { operation: "git.push" },
                scope: "session",
                lifetime: "session",
            }],
        },
    );
    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "tool_approval", decision: "allow_always" },
    });

    // Ignored rather than downgraded to a plain allow: the user is never told a
    // preference was saved when none was, and the prompt stays up until it
    // times out or they choose again.
    expect(await approval).toMatchObject({ behavior: "deny" });
});

test("a failed preference write denies and closes the approval", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {
        addPermissionPreference: async () => {
            throw new Error("disk full");
        },
    });
    const approval = router.requestToolApproval(
        bashToolCall("git push origin"),
        "Bash commands run with your full user permissions.",
        {
            timeoutMs: 1_000,
            permissionGrants: [{
                kind: "action",
                when: { operation: "git.push" },
                scope: "session",
                lifetime: "session",
            }],
        },
    );
    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "tool_approval", decision: "allow_always" },
    });

    expect(await approval).toEqual({
        behavior: "deny",
        reason: "The permission preference could not be saved.",
    });
});

test("a failed session grant write denies and closes the approval", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {
        addPermissionGrants: async () => {
            throw new Error("disk full");
        },
    });
    const approval = router.requestToolApproval(
        bashToolCall("git push origin"),
        "Permission profile ask requires ask.",
        {
            timeoutMs: 1_000,
            permissionGrants: [{
                kind: "action",
                when: { operation: "git.push" },
                scope: "session",
                lifetime: "session",
            }],
        },
    );
    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "tool_approval", decision: "allow_similar" },
    });

    expect(await approval).toEqual({
        behavior: "deny",
        reason: "The session permission grants could not be saved.",
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "ui_request_closed",
        requestId: request.requestId,
    });
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
        response: { type: "tool_approval", decision: "allow_once" },
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

test("the inbound router returns selected and cancelled user questions", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    const selected = router.requestUserQuestion({
        question: "Which environment?",
        choices: [
            { id: "staging", label: "Staging" },
            { id: "production", label: "Production" },
        ],
    });
    const selectedRequest = await channel.client.receive();
    expect(selectedRequest).toMatchObject({
        type: "ui_request",
        request: {
            type: "user_question",
            question: "Which environment?",
        },
        seq: 1,
    });
    if (selectedRequest.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: selectedRequest.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "production",
        },
    });

    expect(await selected).toEqual({
        outcome: "selected",
        choice: { id: "production", label: "Production" },
    });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: selectedRequest.requestId,
        seq: 2,
    });

    const cancelled = router.requestUserQuestion({
        question: "Continue?",
        choices: [{ id: "yes", label: "Yes" }],
    });
    const cancelledRequest = await channel.client.receive();
    if (cancelledRequest.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: cancelledRequest.requestId,
        response: { type: "user_question", outcome: "cancelled" },
    });

    expect(await cancelled).toEqual({ outcome: "cancelled" });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: cancelledRequest.requestId,
        seq: 4,
    });
});

test("configuration-required requests carry semantics and first response wins", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    const configured = router.requestConfigurationRequired({
        destination: {
            kind: "model_assignment",
            assignment: "subagents",
        },
        reason: "Two launches need a subagent policy.",
        pendingAction: {
            id: "batch-1",
            kind: "subagent_launch",
            count: 2,
        },
    });
    const request = await channel.client.receive();
    expect(request).toMatchObject({
        type: "ui_request",
        request: {
            type: "configuration_required",
            destination: {
                kind: "model_assignment",
                assignment: "subagents",
            },
            pendingAction: { id: "batch-1", count: 2 },
        },
    });
    if (request.type !== "ui_request") throw new Error("missing request");
    expect(router.ownsUiRequest(request.requestId)).toBe(true);
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "configuration_required", outcome: "configured" },
    });
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "configuration_required", outcome: "cancelled" },
    });

    expect(await configured).toBe("configured");
    expect(router.ownsUiRequest(request.requestId)).toBe(false);
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: request.requestId,
        seq: 2,
    });
});

test("configuration-required abort and disconnect never leave a waiter", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);
    const abort = new AbortController();
    const pending = router.requestConfigurationRequired({
        destination: { kind: "model_assignment", assignment: "subagents" },
        reason: "A launch needs configuration.",
        pendingAction: { id: "batch-2", kind: "subagent_launch", count: 1 },
    }, { signal: abort.signal });
    const request = await channel.client.receive();
    if (request.type !== "ui_request") throw new Error("missing request");
    abort.abort();
    expect(await pending).toBe("cancelled");
    expect((await channel.client.receive()).type).toBe("ui_request_closed");

    const disconnected = new InboundCommandRouter({
        send(): void {},
        receive(): Promise<never> {
            return Promise.reject(new Error("gone"));
        },
    }, new EngineEventBus());
    await Bun.sleep(0);
    expect(await disconnected.requestConfigurationRequired({
        destination: { kind: "model_assignment", assignment: "subagents" },
        reason: "A launch needs configuration.",
        pendingAction: { id: "batch-3", kind: "subagent_launch", count: 1 },
    })).toBe("unavailable");
});

test("user questions ignore mismatched and stale responses; first valid wins", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    const first = router.requestUserQuestion({
        question: "Pick one",
        choices: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
        ],
    });
    const firstRequest = await channel.client.receive();
    if (firstRequest.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }

    channel.client.send({
        type: "ui_response",
        requestId: firstRequest.requestId,
        response: { type: "tool_approval", decision: "allow_once" },
    });
    channel.client.send({
        type: "ui_response",
        requestId: "unknown-request",
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "one",
        },
    });
    channel.client.send({
        type: "ui_response",
        requestId: firstRequest.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "unknown-choice",
        },
    });
    expect(await Promise.race([
        first.then(() => "resolved" as const),
        Bun.sleep(10).then(() => "waiting" as const),
    ])).toBe("waiting");

    channel.client.send({
        type: "ui_response",
        requestId: firstRequest.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "one",
        },
    });
    channel.client.send({
        type: "ui_response",
        requestId: firstRequest.requestId,
        response: { type: "user_question", outcome: "cancelled" },
    });
    expect(await first).toEqual({
        outcome: "selected",
        choice: { id: "one", label: "One" },
    });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: firstRequest.requestId,
        seq: 2,
    });

    const second = router.requestUserQuestion({
        question: "Pick again",
        choices: [{ id: "one", label: "One" }],
    });
    const secondRequest = await channel.client.receive();
    if (secondRequest.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    expect(secondRequest.seq).toBe(3);
    channel.client.send({
        type: "ui_response",
        requestId: firstRequest.requestId,
        response: { type: "user_question", outcome: "cancelled" },
    });
    expect(await Promise.race([
        second.then(() => "resolved" as const),
        Bun.sleep(10).then(() => "waiting" as const),
    ])).toBe("waiting");
    channel.client.send({
        type: "ui_response",
        requestId: secondRequest.requestId,
        response: { type: "user_question", outcome: "cancelled" },
    });
    expect(await second).toEqual({ outcome: "cancelled" });
});

test("turn abort and endpoint failure cancel pending user questions", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    const turn = router.startTurn();
    channel.client.send({ type: "prompt", content: "ask me" });
    const active = await turn;

    const aborted = router.requestUserQuestion({
        question: "Continue?",
        choices: [{ id: "yes", label: "Yes" }],
    }, { signal: active.signal });
    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({ type: "abort" });
    expect(await aborted).toEqual({ outcome: "cancelled" });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: request.requestId,
        seq: 2,
    });
    expect(active.signal.aborted).toBe(true);
    router.finishTurn();

    const disconnected = new InboundCommandRouter({
        send(): void {},
        receive(): Promise<never> {
            return Promise.reject(new Error("client disconnected"));
        },
    }, new EngineEventBus());
    await Bun.sleep(0);
    expect(await disconnected.requestUserQuestion({
        question: "Continue?",
        choices: [{ id: "yes", label: "Yes" }],
    })).toEqual({ outcome: "cancelled" });
});

test("timeline operations are blocked while a user question is pending", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const handled: boolean[] = [];
    let notifyHandled: () => void = () => {};
    const commandHandled = new Promise<void>((resolve) => {
        notifyHandled = resolve;
    });
    let router: InboundCommandRouter;
    router = new InboundCommandRouter(channel.engine, events, {
        async handleTimelineCommand() {
            handled.push(router.timelineBlocked());
            notifyHandled();
        },
    });

    const question = router.requestUserQuestion({
        question: "Continue?",
        choices: [{ id: "yes", label: "Yes" }],
    });
    expect(router.timelineBlocked()).toBe(true);
    channel.client.send({ type: "list_timeline", requestId: "list-1" });
    await commandHandled;
    expect(handled).toEqual([true]);

    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: { type: "user_question", outcome: "cancelled" },
    });
    expect(await question).toEqual({ outcome: "cancelled" });
    expect(router.timelineBlocked()).toBe(false);
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

test("a failed model settings write rejects without stopping later commands", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {
        readModelSettings: () => ({ model: "current-model" }),
        async updateModelSettings() {
            throw new Error("config is not writable");
        },
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
        seq: 1,
    });

    channel.client.send({
        type: "get_model_settings",
        requestId: "read-settings",
    });
    expect(await channel.client.receive()).toEqual({
        type: "model_settings",
        requestId: "read-settings",
        settings: { model: "current-model" },
        pending: false,
        seq: 2,
    });
});

test("a catalog refresh reports the new settings, and no owner rejects it", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const asked: (string | undefined)[] = [];
    new InboundCommandRouter(channel.engine, events, {
        refreshCatalog: (provider) => {
            asked.push(provider);
            return Promise.resolve(
                provider === "openrouter"
                    ? { model: "refreshed-model" }
                    : undefined,
            );
        },
    });

    channel.client.send({
        type: "catalog_refresh",
        requestId: "refresh-1",
        provider: "openrouter",
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "model_settings",
        requestId: "refresh-1",
        settings: { model: "refreshed-model" },
    });
    expect(asked).toEqual(["openrouter"]);

    channel.client.send({
        type: "catalog_refresh",
        requestId: "refresh-2",
        provider: "nowhere",
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "model_settings_rejected",
        requestId: "refresh-2",
        reason: "invalid",
    });
});

test("a refresh that throws is refused and the session keeps reading", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {
        refreshCatalog: async () => {
            throw new Error("the network is not there");
        },
        readApprovalMode: () => "auto",
    });

    channel.client.send({
        type: "catalog_refresh",
        requestId: "refresh-throw",
        provider: "openrouter",
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "model_settings_rejected",
        requestId: "refresh-throw",
        reason: "invalid",
    });

    // The command loop is still alive: a failed provider call is not a
    // reason to stop reading this session's commands.
    channel.client.send({
        type: "catalog_refresh",
        requestId: "refresh-after",
        provider: "openrouter",
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "model_settings_rejected",
        requestId: "refresh-after",
    });
});

test("a catalog refresh rejects explicitly when no owner is installed", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events);

    channel.client.send({
        type: "catalog_refresh",
        requestId: "refresh-1",
        provider: "openrouter",
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "model_settings_rejected",
        requestId: "refresh-1",
        reason: "unavailable",
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

test("adding a preference replies with the refreshed inspection", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const store = await PermissionPreferenceStore.open(
        join(await mkdtemp(join(tmpdir(), "vera-router-preferences-")), "p.json"),
    );
    new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
        readPermissionInspection: () =>
            inspectPermissions("ask", {}, [], store.list()),
        addPermissionPreference: (when) => store.add(when),
        removePermissionPreference: (id) => store.remove(id),
    });

    channel.client.send({
        type: "add_permission_preference",
        requestId: "add-preference",
        when: { operation: "git.push" },
    });
    const added = await channel.client.receive();
    // Add and inspect share one reply shape on purpose: the client sees the
    // durable list it just changed, without a second round trip.
    expect(added).toMatchObject({
        type: "permissions",
        requestId: "add-preference",
        mode: "ask",
    });
    const preferences =
        (added as { inspection: PermissionInspection }).inspection
            .activePreferences ?? [];
    expect(preferences).toHaveLength(1);
    expect(preferences[0]?.when).toEqual({ operation: "git.push" });

    channel.client.send({
        type: "remove_permission_preference",
        requestId: "remove-preference",
        id: preferences[0]!.id,
    });
    const removed = await channel.client.receive();
    expect(removed).toMatchObject({
        type: "permissions",
        requestId: "remove-preference",
    });
    expect(
        (removed as { inspection: PermissionInspection }).inspection
            .activePreferences,
    ).toEqual([]);
});

test("removing an unknown preference is invalid, not unavailable", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
        removePermissionPreference: async () => false,
    });

    channel.client.send({
        type: "remove_permission_preference",
        requestId: "remove-missing",
        id: "no-such-id",
    });
    // `invalid` distinguishes "the surface exists, your ID does not" from the
    // `unavailable` a host with no preference store returns.
    expect(await channel.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "remove-missing",
        reason: "invalid",
        seq: 1,
    });
});

test("preference commands reject as unavailable with no store installed", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
    });

    channel.client.send({
        type: "add_permission_preference",
        requestId: "add-preference",
        when: { operation: "git.push" },
    });
    expect(await channel.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "add-preference",
        reason: "unavailable",
        seq: 1,
    });
});

test("revoking a session grant replies with the refreshed inspection", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    let grants: readonly PermissionGrant[] = [{
        id: "grant-1:0",
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    }];
    new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
        readPermissionInspection: () =>
            inspectPermissions("ask", {}, grants, []),
        async removePermissionGrant(id) {
            const before = grants.length;
            grants = grants.filter((grant) => grant.id !== id);
            return grants.length < before;
        },
    });

    channel.client.send({
        type: "remove_permission_grant",
        requestId: "revoke",
        id: "grant-1:0",
    });
    const reply = await channel.client.receive();
    // Same reply shape as the preference commands, so the client re-renders its
    // list from the engine rather than guessing what the revocation did.
    expect(reply).toMatchObject({ type: "permissions", requestId: "revoke" });
    expect(
        (reply as { inspection: PermissionInspection }).inspection.activeGrants,
    ).toEqual([]);
});

test("revoking an unknown grant is invalid, and unavailable with no store", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
        removePermissionGrant: async () => false,
    });

    channel.client.send({
        type: "remove_permission_grant",
        requestId: "revoke-missing",
        id: "no-such-grant",
    });
    expect(await channel.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "revoke-missing",
        reason: "invalid",
        seq: 1,
    });

    const bare = createInProcessChannel();
    const bareEvents = new EngineEventBus();
    bareEvents.subscribe(createProtocolEncoder(bare.engine));
    new InboundCommandRouter(bare.engine, bareEvents, {
        readApprovalMode: () => "ask",
    });
    bare.client.send({
        type: "remove_permission_grant",
        requestId: "revoke-nowhere",
        id: "grant-1:0",
    });
    expect(await bare.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "revoke-nowhere",
        reason: "unavailable",
        seq: 1,
    });
});

test("session name commands normalize, clear, and reject invalid names", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const names: Array<string | null> = [];
    new InboundCommandRouter(channel.engine, events, {
        async updateSessionName(name) {
            names.push(name);
            return name;
        },
        sendSessionNameReply(_ownerId, reply) {
            channel.engine.send(reply);
        },
    });

    channel.client.send({
        type: "update_session_name",
        requestId: "rename",
        name: "  Human name  ",
    });
    expect(await channel.client.receive()).toEqual({
        type: "session_name",
        requestId: "rename",
        name: "Human name",
    });

    channel.client.send({
        type: "update_session_name",
        requestId: "clear",
        name: null,
    });
    expect(await channel.client.receive()).toEqual({
        type: "session_name",
        requestId: "clear",
        name: null,
    });

    channel.client.send({
        type: "update_session_name",
        requestId: "empty",
        name: "   ",
    });
    expect(await channel.client.receive()).toEqual({
        type: "session_name_rejected",
        requestId: "empty",
        reason: "invalid",
    });
    expect(names).toEqual(["Human name", null]);
});

test("a consult answers out of band and never becomes a turn", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const asked: string[] = [];
    const router = new InboundCommandRouter(channel.engine, events, {
        async consult(request) {
            asked.push(request.model);
            if (request.model === "missing-model") {
                throw new Error("No provider serves missing-model.");
            }
            return { text: "a second read", model: request.model };
        },
        sendConsultReply(_ownerId, reply) {
            channel.engine.send(reply);
        },
    });

    channel.client.send({
        type: "consult",
        requestId: "one",
        model: "claude-opus-5",
        messages: [{ role: "user", content: "what do you think" }],
    });
    expect(await channel.client.receive()).toEqual({
        type: "consult_result",
        requestId: "one",
        text: "a second read",
        model: "claude-opus-5",
    });

    channel.client.send({
        type: "consult",
        requestId: "two",
        model: "missing-model",
        messages: [{ role: "user", content: "hello" }],
    });
    expect(await channel.client.receive()).toEqual({
        type: "consult_rejected",
        requestId: "two",
        reason: "No provider serves missing-model.",
    });

    // The consults must not have queued anything for the agent to run.
    channel.client.send({ type: "prompt", content: "the real turn" });
    const turn = await router.startTurn();
    expect(turn.prompt.content).toBe("the real turn");
    router.finishTurn();
    expect(asked).toEqual(["claude-opus-5", "missing-model"]);
});

test("a session that cannot consult refuses rather than substituting", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    new InboundCommandRouter(channel.engine, events, {
        sendConsultReply(_ownerId, reply) {
            channel.engine.send(reply);
        },
    });

    channel.client.send({
        type: "consult",
        requestId: "one",
        model: "claude-opus-5",
        messages: [{ role: "user", content: "hello" }],
    });
    const update = await channel.client.receive();
    expect(update.type).toBe("consult_rejected");
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
        updatedDefaults: true,
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
    expect(first.prompt.content).toBe("before change");
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
    expect(second.prompt.content).toBe("after change");
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
    router.finishTurn();
});

test("a failed session permission write rejects without closing the router", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {
        readApprovalMode: () => "ask",
        async updateSessionPermissionMode() {
            throw new Error("disk unavailable");
        },
    });

    channel.client.send({
        type: "update_session_permission_mode",
        requestId: "failed-session-permissions",
        mode: "auto",
    });
    expect(await channel.client.receive()).toEqual({
        type: "permissions_rejected",
        requestId: "failed-session-permissions",
        reason: "unavailable",
        seq: 1,
    });

    channel.client.send({ type: "prompt", content: "still connected" });
    const turn = await router.startTurn();
    expect(turn.prompt.content).toBe("still connected");
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

test("the inbound router carries a preview out and notes back", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events);

    const answered = router.requestUserQuestion({
        question: "Which environment?",
        choices: [
            { id: "staging", label: "Staging", preview: "  staging box" },
            { id: "production", label: "Production" },
        ],
    });
    const request = await channel.client.receive();
    if (request.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    expect(request.request).toMatchObject({
        choices: [
            { id: "staging", label: "Staging", preview: "  staging box" },
            { id: "production", label: "Production" },
        ],
    });
    channel.client.send({
        type: "ui_response",
        requestId: request.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "staging",
            notes: "  but only for a week  ",
        },
    });

    expect(await answered).toEqual({
        outcome: "selected",
        choice: { id: "staging", label: "Staging", preview: "  staging box" },
        notes: "but only for a week",
    });
});
