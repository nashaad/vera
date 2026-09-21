import { expect, test } from "bun:test";

import {
    AgentCommandQueueFullError,
    AgentDetachedError,
    ResidentAgent,
    ResidentAgentClosedError,
} from "../../src/host/resident-agent.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import type { HistoryUpdate } from "../../src/engine/protocol.ts";

test("an out-of-band admission question preserves idle resident state", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(agent.engine));
    const router = new InboundCommandRouter(agent.engine, events);
    const attachment = agent.attach();

    try {
        expect((await attachment.receive()).type).toBe("history");
        const result = router.requestUserQuestion({
            question: "Admit this source?",
            choices: [{ id: "once", label: "Once" }],
        }, { outOfBand: true });
        const request = await attachment.receive();
        expect(request).toMatchObject({
            type: "ui_request",
            request: { type: "user_question", outOfBand: true },
        });
        if (request.type !== "ui_request") throw new Error("missing question");
        attachment.send({
            type: "ui_response",
            requestId: request.requestId,
            response: { type: "user_question", outcome: "cancelled" },
        });
        await expect(result).resolves.toEqual({ outcome: "cancelled" });
        expect((await attachment.receive()).type).toBe("ui_request_closed");
        expect(agent.status).toBe("idle");
        expect(agent.idleForReplacement()).toBe(true);
    } finally {
        attachment.detach();
        agent.close();
    }
});

test("resident agent replays a checkpoint and every later update", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();

    expect(await first.receive()).toEqual({
        type: "history",
        entries: [],
        seq: 0,
    });

    first.send({ type: "prompt", content: "hello" });
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "hello",
    });
    agent.engine.send({ type: "user_prompt", content: "hello", seq: 1 });
    agent.engine.send({ type: "assistant_delta", text: "hello", seq: 2 });

    expect(await first.receive()).toEqual({
        type: "user_prompt",
        content: "hello",
        seq: 1,
    });
    expect(await first.receive()).toEqual({
        type: "assistant_delta",
        text: "hello",
        seq: 2,
    });

    const second = agent.attach();
    // Every replayed checkpoint states the status it is joining, so a turn
    // already running is not left to be inferred from what follows.
    expect(await second.receive()).toEqual({
        type: "history",
        entries: [],
        seq: 0,
        status: "working",
    });
    expect(await second.receive()).toEqual({
        type: "user_prompt",
        content: "hello",
        seq: 1,
    });
    expect(await second.receive()).toEqual({
        type: "assistant_delta",
        text: "hello",
        seq: 2,
    });
    const resumed = agent.attach(1);
    expect(await resumed.receive()).toEqual({
        type: "assistant_delta",
        text: "hello",
        seq: 2,
    });

    const checkpoint: HistoryUpdate = {
        type: "history",
        entries: [
            { kind: "user", text: "hello" },
            { kind: "assistant", text: "hello" },
        ],
        seq: 2,
    };
    agent.engine.send(checkpoint);
    expect(await first.receive()).toEqual(checkpoint);
    expect(await second.receive()).toEqual(checkpoint);

    const third = agent.attach();
    // The live copies above carry no status: the updates that said the turn
    // started are still ahead of them. This one replaces those updates, so it
    // carries the status instead of losing it with them.
    expect(await third.receive()).toEqual({ ...checkpoint, status: "working" });
    const notification = {
        type: "task_notification" as const,
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 3,
    };
    agent.engine.send(notification);
    expect(await first.receive()).toEqual(notification);
    expect(await second.receive()).toEqual(notification);
    expect(await third.receive()).toEqual(notification);

    const fourth = agent.attach();
    expect(await fourth.receive()).toEqual({ ...checkpoint, status: "working" });
    expect(await fourth.receive()).toEqual(notification);

    const resumedFromCheckpoint = agent.attach(2);
    expect(await resumedFromCheckpoint.receive()).toEqual(notification);
    const resumedBeforeCheckpoint = agent.attach(1);
    expect(await resumedBeforeCheckpoint.receive()).toEqual({
        ...checkpoint,
        status: "working",
    });
    expect(await resumedBeforeCheckpoint.receive()).toEqual(notification);
    expect(() => agent.attach(4)).toThrow("replay cursor is unavailable");
});

test("a reconnect history keeps the last request recipe", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();
    await first.receive();
    const projection = {
        estimatedTokens: 100,
        components: [{
            kind: "prompt_contribution" as const,
            id: "core.project-instructions",
            owner: "core",
            source: "contextual",
            displayName: "Project instructions",
            count: 1,
            estimatedTokens: 100,
        }],
    };
    agent.engine.send({
        type: "context",
        measurement: {
            tokens: 100,
            estimated: true,
            projection,
        },
        seq: 1,
    });
    expect((await first.receive()).type).toBe("context");
    agent.engine.send({
        type: "history",
        entries: [],
        context: { tokens: 120, estimated: true },
        seq: 1,
    });
    const liveHistory = await first.receive();
    expect(liveHistory).toMatchObject({
        type: "history",
        context: {
            tokens: 120,
            estimated: true,
            projection: { estimatedTokens: 120 },
        },
    });

    const second = agent.attach();
    expect(await second.receive()).toMatchObject({
        type: "history",
        context: {
            tokens: 120,
            projection: {
                components: [{ id: "core.project-instructions" }],
            },
        },
    });
    first.detach();
    second.detach();
    agent.close();
});

test("resident agent bounds commands waiting for the engine", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one", {
        maxPendingCommands: 1,
    });
    const client = agent.attach();
    await client.receive();

    client.send({ type: "prompt", content: "first" });
    expect(() => client.send({ type: "prompt", content: "second" }))
        .toThrow(AgentCommandQueueFullError);
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "first",
    });
    client.send({ type: "prompt", content: "after drain" });
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "after drain",
    });
});

test("image attachment results return only to the requesting client", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one", {
        attachImage: async (path) => ({
            id: "hash.png",
            name: path.split("/").at(-1)!,
            mediaType: "image/png",
            bytes: 3,
            width: 2,
            height: 1,
        }),
    });
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();

    first.send({
        type: "attach_image",
        requestId: "request-1",
        path: "/tmp/screen.png",
    });

    expect(await first.receive()).toEqual({
        type: "image_attached",
        requestId: "request-1",
        attachment: {
            id: "hash.png",
            name: "screen.png",
            mediaType: "image/png",
            bytes: 3,
            width: 2,
            height: 1,
        },
    });
    second.send({ type: "prompt", content: "still ordered" });
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "still ordered",
    });
});

test("detaching cancels that client's in-flight image attachments", async () => {
    let observedSignal: AbortSignal | undefined;
    const cancelled = Promise.withResolvers<void>();
    const agent = new ResidentAgent("agent-1", "/work/one", {
        attachImage: async (_path, signal) => {
            observedSignal = signal;
            await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                    cancelled.resolve();
                    reject(signal.reason);
                }, { once: true });
            });
            throw new Error("unreachable");
        },
    });
    const client = agent.attach();
    await client.receive();
    client.send({
        type: "attach_image",
        requestId: "request-1",
        path: "/tmp/screen.png",
    });

    client.detach();
    await cancelled.promise;

    expect(observedSignal?.aborted).toBe(true);
});

test("detaching one client leaves the resident agent and peers alive", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();

    first.detach();
    first.detach();
    expect(() => first.send({ type: "abort" })).toThrow(AgentDetachedError);
    await expect(first.receive()).rejects.toBeInstanceOf(AgentDetachedError);
    expect(await agent.engine.receive()).toMatchObject({
        type: "timeline_owner_detached",
    });

    second.send({ type: "prompt", content: "still here" });
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "still here",
    });
    agent.engine.send({ type: "turn_finished", seq: 1 });
    expect(await second.receive()).toEqual({ type: "turn_finished", seq: 1 });
});

test("close after the last detach still delivers the abort to the running turn", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const client = agent.attach();
    await client.receive();
    // The engine takes the detach and has not asked again when close runs.
    const detachReceived = agent.engine.receive();
    client.detach();
    agent.close();

    expect(await detachReceived).toMatchObject({
        type: "timeline_owner_detached",
    });
    expect(await agent.engine.receive()).toEqual({ type: "abort" });
    await expect(agent.engine.receive()).rejects.toBeInstanceOf(
        ResidentAgentClosedError,
    );
});

test("closing a resident agent discards buffered commands and updates", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const client = agent.attach();
    await client.receive();
    client.send({ type: "prompt", content: "do not run" });
    agent.engine.send({ type: "assistant_delta", text: "stale", seq: 1 });

    agent.close();
    agent.close();

    expect(await agent.engine.receive()).toEqual({ type: "abort" });
    await expect(agent.engine.receive()).rejects.toBeInstanceOf(
        ResidentAgentClosedError,
    );
    await expect(client.receive()).rejects.toBeInstanceOf(
        ResidentAgentClosedError,
    );
    expect(() => agent.attach()).toThrow(ResidentAgentClosedError);
});

test("failing a resident agent drains one typed terminal update", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();
    agent.engine.send({ type: "assistant_delta", text: "partial", seq: 1 });

    agent.fail("failure-1", "Resident agent stopped unexpectedly");
    agent.fail("failure-2", "duplicate");

    for (const attachment of [first, second]) {
        expect(await attachment.receive()).toEqual({
            type: "assistant_delta",
            text: "partial",
            seq: 1,
        });
        expect(await attachment.receive()).toEqual({
            type: "agent_failed",
            failureId: "failure-1",
            detail: "Resident agent stopped unexpectedly",
            seq: 2,
        });
        await expect(attachment.receive()).rejects.toBeInstanceOf(
            ResidentAgentClosedError,
        );
    }
    expect(agent.status).toBe("idle");
    expect(agent.failed).toBeTrue();
    expect(agent.closed).toBeFalse();

    const replay = agent.attach();
    expect((await replay.receive()).type).toBe("history");
    expect((await replay.receive()).type).toBe("assistant_delta");
    expect(await replay.receive()).toMatchObject({
        type: "agent_failed",
        failureId: "failure-1",
    });
    expect(() => replay.send({ type: "prompt", content: "too late" }))
        .toThrow(ResidentAgentClosedError);
    agent.close();
    expect(agent.closed).toBeTrue();
});

test("failing an idle resident agent reports its terminal state", () => {
    const changes: string[] = [];
    const agent = new ResidentAgent("agent-1", "/work/one", {
        onRunStateChanged: () => changes.push(
            agent.failed ? "failed" : agent.status,
        ),
    });

    agent.fail("failure-1", "Resident agent stopped unexpectedly");

    expect(changes).toEqual(["failed"]);
});

test("resident agent snapshots commands and isolates attached clients", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();

    const command = { type: "prompt" as const, content: "original" };
    first.send(command);
    command.content = "changed";
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "original",
    });

    const update = {
        type: "tool_started" as const,
        tool: "write",
        args: { nested: { value: "original" } },
        seq: 1,
    };
    agent.engine.send(update);
    update.args.nested.value = "changed outside";
    const firstUpdate = await first.receive();
    if (firstUpdate.type !== "tool_started") {
        throw new Error("Expected tool update");
    }
    (firstUpdate.args.nested as { value: string }).value = "changed by client";
    expect(await second.receive()).toEqual({
        type: "tool_started",
        tool: "write",
        args: { nested: { value: "original" } },
        seq: 1,
    });

    const later = agent.attach();
    await later.receive();
    expect(await later.receive()).toEqual({
        type: "tool_started",
        tool: "write",
        args: { nested: { value: "original" } },
        seq: 1,
    });
});

test("resident agent rejects malformed producer sequences before broadcast", async () => {
    for (const invalidSequence of [0, 2]) {
        const agent = new ResidentAgent("agent-1", "/work/one");
        const client = agent.attach();
        await client.receive();

        expect(() => agent.engine.send({
            type: "assistant_delta",
            text: "invalid",
            seq: invalidSequence,
        })).toThrow(
            `Invalid resident update sequence: expected 1, received ${invalidSequence}`,
        );

        const valid = {
            type: "assistant_delta" as const,
            text: "valid",
            seq: 1,
        };
        agent.engine.send(valid);
        expect(await client.receive()).toEqual(valid);
        agent.close();
    }

    for (const invalidSequence of [
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        const agent = new ResidentAgent("agent-1", "/work/one");
        expect(() => agent.engine.send({
            type: "status",
            state: "working",
            seq: invalidSequence,
        })).toThrow(
            "Invalid resident update sequence: expected a non-negative safe integer",
        );
        agent.close();
    }

    const agent = new ResidentAgent("agent-1", "/work/one");
    const client = agent.attach();
    await client.receive();
    agent.engine.send({ type: "status", state: "working", seq: 1 });
    expect(await client.receive()).toMatchObject({ seq: 1 });
    for (const invalidSequence of [1, 3, 0]) {
        expect(() => agent.engine.send({
            type: "status",
            state: "idle",
            seq: invalidSequence,
        })).toThrow(
            `Invalid resident update sequence: expected 2, received ${invalidSequence}`,
        );
    }
    agent.fail("failure-1", "Resident agent stopped unexpectedly");
    expect(await client.receive()).toMatchObject({
        type: "agent_failed",
        failureId: "failure-1",
        seq: 2,
    });
    agent.close();
});

test("resident agent checkpoints cannot jump away from current sequence", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const client = agent.attach();
    await client.receive();
    agent.engine.send({ type: "status", state: "working", seq: 1 });
    expect(await client.receive()).toMatchObject({ seq: 1 });

    expect(() => agent.engine.send({
        type: "history",
        entries: [],
        seq: 2,
    })).toThrow(
        "Invalid resident update sequence: expected 1, received 2",
    );

    const checkpoint = { type: "history" as const, entries: [], seq: 1 };
    agent.engine.send(checkpoint);
    expect(await client.receive()).toEqual(checkpoint);
    agent.close();
});

test("timeline replies stay private without creating shared sequence gaps", async () => {
    const attachmentIds = values("owner-a", "owner-b", "owner-c");
    const agent = new ResidentAgent("agent-1", "/work/one", {
        createAttachmentId: attachmentIds,
    });
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();

    first.send({ type: "list_timeline", requestId: "list-1" });
    expect(await agent.engine.receive()).toEqual({
        type: "owned_timeline_command",
        ownerId: "owner-a",
        command: { type: "list_timeline", requestId: "list-1" },
    });
    const reply = {
        type: "timeline" as const,
        requestId: "list-1",
        boundaries: [],
    };
    agent.sendTimelineReply("owner-a", reply);
    agent.engine.send({ type: "status", state: "idle", seq: 1 });

    expect(await first.receive()).toEqual(reply);
    expect(await first.receive()).toEqual({
        type: "status",
        state: "idle",
        seq: 1,
    });
    expect(await second.receive()).toEqual({
        type: "status",
        state: "idle",
        seq: 1,
    });

    const later = agent.attach();
    expect(await later.receive()).toEqual({
        type: "history",
        entries: [],
        seq: 0,
    });
    expect(await later.receive()).toEqual({
        type: "status",
        state: "idle",
        seq: 1,
    });
    expect(() => agent.engine.send(reply)).toThrow(
        "Timeline replies must target one attachment",
    );

    later.detach();
    expect(await agent.engine.receive()).toEqual({
        type: "timeline_owner_detached",
        ownerId: "owner-c",
    });
});

test("session name replies stay private to their requesting attachment", async () => {
    const attachmentIds = values("owner-a", "owner-b");
    const agent = new ResidentAgent("agent-1", "/work/one", {
        createAttachmentId: attachmentIds,
    });
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();

    first.send({
        type: "update_session_name",
        requestId: "same-id",
        name: "First",
    });
    expect(await agent.engine.receive()).toEqual({
        type: "owned_session_name_command",
        ownerId: "owner-a",
        command: {
            type: "update_session_name",
            requestId: "same-id",
            name: "First",
        },
    });
    const reply = {
        type: "session_name" as const,
        requestId: "same-id",
        name: "First",
    };
    agent.sendSessionNameReply("owner-a", reply);
    agent.engine.send({ type: "status", state: "idle", seq: 1 });

    expect(await first.receive()).toEqual(reply);
    expect(await first.receive()).toMatchObject({ type: "status", seq: 1 });
    expect(await second.receive()).toMatchObject({ type: "status", seq: 1 });
    agent.close();
});

test("shutdown idleness includes attachments, queued prompts, and starting turns", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    expect(agent.idleForShutdown()).toBeTrue();
    expect(agent.idleForReplacement()).toBeTrue();

    const attachment = agent.attach();
    await attachment.receive();
    expect(agent.idleForShutdown()).toBeFalse();
    expect(agent.idleForReplacement()).toBeTrue();

    attachment.send({ type: "prompt", content: "hello" });
    attachment.detach();
    expect(agent.idleForShutdown()).toBeFalse();
    expect(agent.idleForReplacement()).toBeFalse();
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "hello",
    });
    expect(agent.idleForShutdown()).toBeFalse();

    agent.engine.send({
        type: "user_prompt",
        content: "hello",
        seq: 1,
    });
    expect(agent.idleForShutdown()).toBeFalse();
    agent.engine.send({ type: "turn_finished", seq: 2 });
    expect(agent.idleForShutdown()).toBeTrue();
    agent.close();
});

test("one reserved delivery wake survives a full user command queue", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one", {
        maxPendingCommands: 1,
    });
    const attachment = agent.attach();
    await attachment.receive();
    attachment.send({ type: "prompt", content: "queued user work" });

    agent.triggerDeliveryTurn();
    agent.triggerDeliveryTurn();
    expect(agent.idleForShutdown()).toBeFalse();
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "queued user work",
    });
    expect(await agent.engine.receive()).toEqual({
        type: "trigger_delivery_turn",
    });
    agent.engine.send({ type: "user_prompt", content: "queued user work", seq: 1 });
    agent.engine.send({ type: "turn_finished", seq: 2 });
    agent.engine.send({ type: "status", state: "working", seq: 3 });
    agent.engine.send({ type: "turn_finished", seq: 4 });
    attachment.detach();
    expect(await agent.engine.receive()).toMatchObject({
        type: "timeline_owner_detached",
    });
    expect(agent.idleForShutdown()).toBeTrue();
    agent.close();
});

test("detached attachment IDs cannot be reused", async () => {
    const attachmentIds = values("owner-a", "owner-a", "owner-b");
    const agent = new ResidentAgent("agent-1", "/work/one", {
        createAttachmentId: attachmentIds,
    });
    const first = agent.attach();
    await first.receive();

    first.detach();
    expect(await agent.engine.receive()).toEqual({
        type: "timeline_owner_detached",
        ownerId: "owner-a",
    });
    expect(() => agent.attach()).toThrow(
        "Attachment ID owner-a was already issued",
    );

    const second = agent.attach();
    await second.receive();
    agent.sendTimelineReply("owner-a", {
        type: "timeline",
        requestId: "stale-reply",
        boundaries: [],
    });
    agent.engine.send({ type: "status", state: "idle", seq: 1 });
    expect(await second.receive()).toEqual({
        type: "status",
        state: "idle",
        seq: 1,
    });

    second.send({ type: "list_timeline", requestId: "list-2" });
    expect(await agent.engine.receive()).toEqual({
        type: "owned_timeline_command",
        ownerId: "owner-b",
        command: { type: "list_timeline", requestId: "list-2" },
    });
});

test("a turn that finishes without starting stops blocking shutdown", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const attachment = agent.attach();
    await attachment.receive();

    attachment.send({ type: "prompt", content: "look at this image" });
    attachment.detach();
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "look at this image",
    });
    expect(await agent.engine.receive()).toMatchObject({
        type: "timeline_owner_detached",
    });
    expect(agent.idleForShutdown()).toBeFalse();

    // Attachment hydration failed, so the turn ends without ever sending a
    // user_prompt or a working status.
    agent.engine.send({ type: "turn_finished", seq: 1 });
    expect(agent.idleForShutdown()).toBeTrue();
    agent.close();
});

test("a delivery wake the engine discards stops blocking shutdown", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const attachment = agent.attach();
    await attachment.receive();

    attachment.send({ type: "prompt", content: "hello" });
    attachment.detach();
    expect(await agent.engine.receive()).toMatchObject({ type: "prompt" });
    expect(await agent.engine.receive()).toMatchObject({
        type: "timeline_owner_detached",
    });
    agent.engine.send({ type: "user_prompt", content: "hello", seq: 1 });

    // The wake lands mid-turn, and that turn drains the delivery, so the
    // router discards the wake without emitting anything at all for it.
    agent.triggerDeliveryTurn();
    expect(await agent.engine.receive()).toEqual({
        type: "trigger_delivery_turn",
    });
    agent.engine.send({ type: "turn_finished", seq: 2 });
    expect(agent.idleForShutdown()).toBeTrue();
    agent.close();
});

test("two prompts accepted before either starts keep their own pending state", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const attachment = agent.attach();
    await attachment.receive();

    attachment.send({ type: "prompt", content: "first" });
    attachment.send({ type: "prompt", content: "second" });
    attachment.detach();
    expect(await agent.engine.receive()).toMatchObject({ content: "first" });
    expect(await agent.engine.receive()).toMatchObject({ content: "second" });
    expect(await agent.engine.receive()).toMatchObject({
        type: "timeline_owner_detached",
    });

    agent.engine.send({ type: "user_prompt", content: "first", seq: 1 });
    agent.engine.send({ type: "turn_finished", seq: 2 });
    expect(agent.idleForShutdown()).toBeFalse();

    agent.engine.send({ type: "user_prompt", content: "second", seq: 3 });
    expect(agent.idleForShutdown()).toBeFalse();
    agent.engine.send({ type: "turn_finished", seq: 4 });
    expect(agent.idleForShutdown()).toBeTrue();
    agent.close();
});

function values<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) {
            throw new Error("No scripted value remains");
        }
        return item;
    };
}

test("resident agent reports every start and stop of its turn, once each", () => {
    const changes: string[] = [];
    const agent = new ResidentAgent("agent-1", "/work/one", {
        onRunStateChanged: () => changes.push(agent.status),
    });

    agent.engine.send({ type: "user_prompt", content: "hello", seq: 1 });
    // Already working: the same state twice is not a change.
    agent.engine.send({ type: "status", state: "working", seq: 2 });
    agent.engine.send({ type: "assistant_delta", text: "hi", seq: 3 });
    agent.engine.send({
        type: "ui_request",
        request: { type: "user_question", question: "which?", choices: [] },
        requestId: "q-1",
        seq: 4,
    });
    agent.engine.send({ type: "ui_request_closed", requestId: "q-1", seq: 5 });
    agent.engine.send({ type: "turn_finished", seq: 6 });
    agent.close();

    expect(changes).toEqual([
        "working",
        "waiting",
        "working",
        "idle",
        "idle",
    ]);
});

test("a cleared selection refuses a prompt and selecting again recovers", async () => {
    let cleared = true;
    const agent = new ResidentAgent("model-clear", "/tmp", { clientPromptRefusal: () => cleared ? "No model selected" : undefined });
    const attachment = agent.attach();
    try {
        await attachment.receive();
        attachment.send({ type: "prompt", content: "first" });
        expect(await attachment.receive()).toEqual({ type: "prompt_rejected", reason: "No model selected" });
        cleared = false;
        attachment.send({ type: "prompt", content: "second" });
        expect(await agent.engine.receive()).toMatchObject({ type: "prompt", content: "second" });
    } finally { attachment.detach(); agent.close(); }
});

test("model settings replies restore live host facts omitted by the engine projection", async () => {
    let cleared = true;
    const catalogs = [{ id: "remaining", label: "Remaining" }];
    const agent = new ResidentAgent("catalog-agent", "/work/one", {
        modelCatalogFacts: () => ({ providerCatalogs: catalogs, selectionCleared: cleared }),
    });
    const attachment = agent.attach();
    try {
        await attachment.receive();
        agent.engine.send({ type: "model_settings", requestId: "first", pending: false,
            settings: { provider: "removed", model: "previous" }, seq: 1 });
        expect(await attachment.receive()).toMatchObject({ type: "model_settings",
            settings: { selectionCleared: true, providerCatalogs: catalogs } });
        cleared = false;
        agent.engine.send({ type: "model_settings", requestId: "next", pending: false,
            settings: { provider: "remaining", model: "next" }, seq: 2 });
        expect(await attachment.receive()).toMatchObject({ type: "model_settings",
            settings: { model: "next", selectionCleared: false } });
    } finally { attachment.detach(); agent.close(); }
});
