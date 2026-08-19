import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createProtocolEncoder,
    type AgentUpdate,
    type TimelineReplyUpdate,
} from "../../src/engine/protocol.ts";
import { TimelineController } from "../../src/engine/timeline-control.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import {
    withoutCallDuration,
    withoutSessionUsage,
} from "../support/wire-usage.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("timeline list, preview, and apply keep replies requester-owned", async () => {
    const fixture = await conversationFixture();
    const broadcasts: AgentUpdate[] = [];
    const replies: Array<{
        ownerId: string;
        reply: TimelineReplyUpdate;
    }> = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            broadcasts.push(update);
        },
    });
    const controller = new TimelineController({
        state: fixture.state,
        protocol,
        isBlocked: () => false,
        sendReply(ownerId, reply): void {
            replies.push({ ownerId, reply });
        },
        createPlanId: values("plan-1"),
    });

    await controller.handle("owner-a", {
        type: "list_timeline",
        requestId: "list-1",
    });
    expect(replies.shift()).toEqual({
        ownerId: "owner-a",
        reply: {
            type: "timeline",
            requestId: "list-1",
            boundaries: [
                {
                    userMessageId: "message-1",
                    timestamp: "2026-07-19T12:00:01.000Z",
                    prompt: "first request",
                    position: 0,
                },
                {
                    userMessageId: "message-3",
                    timestamp: "2026-07-19T12:00:03.000Z",
                    prompt: "second request",
                    position: 2,
                },
            ],
        },
    });

    await controller.handle("owner-a", {
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: fixture.secondBoundaryId,
        action: "rewind_conversation",
    });
    expect(replies.shift()).toEqual({
        ownerId: "owner-a",
        reply: {
            type: "timeline_action_preview",
            requestId: "preview-1",
            plan: {
                planId: "plan-1",
                expectedHeadId: "message-4",
                boundary: {
                    userMessageId: "message-3",
                    timestamp: "2026-07-19T12:00:03.000Z",
                    prompt: "second request",
                    position: 2,
                },
                keptMessageCount: 2,
                setAsideMessageCount: 2,
            },
        },
    });

    await controller.handle("owner-b", {
        type: "apply_timeline_action",
        requestId: "wrong-owner",
        planId: "plan-1",
    });
    expect(replies.shift()).toEqual({
        ownerId: "owner-b",
        reply: {
            type: "timeline_action_rejected",
            requestId: "wrong-owner",
            operation: "apply",
            reason: "not_plan_owner",
        },
    });

    await controller.handle("owner-a", {
        type: "apply_timeline_action",
        requestId: "apply-1",
        planId: "plan-1",
    });
    expect(fixture.state.messages).toEqual([
        fixture.firstUser,
        fixture.firstAssistant,
    ]);
    expect(broadcasts.map(withoutSessionUsage)).toEqual([{
        type: "history",
        entries: [
            { id: "message-1#0", kind: "user", text: "first request" },
            { id: "message-2#0", kind: "assistant", text: "first answer" },
        ],
        seq: 0,
    }]);
    expect(replies.shift()).toEqual({
        ownerId: "owner-a",
        reply: {
            type: "timeline_action_applied",
            requestId: "apply-1",
            planId: "plan-1",
        },
    });

    await controller.handle("owner-a", {
        type: "apply_timeline_action",
        requestId: "apply-again",
        planId: "plan-1",
    });
    expect(replies.shift()?.reply).toMatchObject({
        type: "timeline_action_rejected",
        reason: "plan_expired",
    });
    expect(replies).toEqual([]);
});

test("timeline plans reject busy, detached, changed, and reused capabilities", async () => {
    const fixture = await conversationFixture();
    const replies: TimelineReplyUpdate[] = [];
    let blocked = true;
    const protocol = createProtocolEncoder({ send(): void {} });
    const controller = new TimelineController({
        state: fixture.state,
        protocol,
        isBlocked: () => blocked,
        sendReply(_ownerId, reply): void {
            replies.push(reply);
        },
        createPlanId: values("plan-1", "plan-1", "plan-2"),
    });

    await controller.handle("owner-a", {
        type: "preview_timeline_action",
        requestId: "busy-preview",
        boundaryId: fixture.secondBoundaryId,
        action: "rewind_conversation",
    });
    expect(replies.shift()).toMatchObject({ reason: "busy" });

    blocked = false;
    await controller.handle("owner-a", {
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: fixture.secondBoundaryId,
        action: "rewind_conversation",
    });
    expect(replies.shift()).toMatchObject({
        type: "timeline_action_preview",
        plan: { planId: "plan-1" },
    });
    controller.detachOwner("owner-a");
    await controller.handle("owner-a", {
        type: "apply_timeline_action",
        requestId: "detached-plan",
        planId: "plan-1",
    });
    expect(replies.shift()).toMatchObject({ reason: "plan_expired" });

    await controller.handle("owner-a", {
        type: "preview_timeline_action",
        requestId: "reused-plan-id",
        boundaryId: fixture.secondBoundaryId,
        action: "rewind_conversation",
    });
    expect(replies.shift()).toMatchObject({ reason: "unavailable" });

    await controller.handle("owner-a", {
        type: "preview_timeline_action",
        requestId: "preview-2",
        boundaryId: fixture.secondBoundaryId,
        action: "rewind_conversation",
    });
    expect(replies.shift()).toMatchObject({
        type: "timeline_action_preview",
        plan: { planId: "plan-2" },
    });
    await fixture.store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "new head" }],
    });
    await controller.handle("owner-a", {
        type: "apply_timeline_action",
        requestId: "changed-head",
        planId: "plan-2",
    });
    expect(replies.shift()).toMatchObject({ reason: "session_changed" });

    await controller.handle("owner-a", {
        type: "preview_timeline_action",
        requestId: "missing-boundary",
        boundaryId: "missing",
        action: "rewind_conversation",
    });
    expect(replies.shift()).toMatchObject({ reason: "boundary_missing" });
    expect(replies).toEqual([]);
});

async function conversationFixture(): Promise<{
    directory: string;
    store: SessionStore;
    state: { messages: ModelMessage[]; store: SessionStore };
    firstUser: ModelMessage;
    firstAssistant: ModelMessage;
    secondBoundaryId: string;
}> {
    const directory = mkdtempSync(join(tmpdir(), "vera-timeline-control-"));
    temporaryDirectories.push(directory);
    const firstUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "first request" }],
    };
    const firstAssistant = assistantMessage("first answer");
    const secondUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "second request" }],
    };
    const store = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-19T12:00:00.000Z",
            "2026-07-19T12:00:01.000Z",
            "2026-07-19T12:00:02.000Z",
            "2026-07-19T12:00:03.000Z",
            "2026-07-19T12:00:04.000Z",
            "2026-07-19T12:00:05.000Z",
        ),
        createId: values(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    await store.appendMessage(firstUser);
    await store.appendMessage(firstAssistant);
    const secondBoundary = await store.appendMessage(secondUser);
    await store.appendMessage(assistantMessage("second answer"));
    return {
        directory,
        store,
        state: { messages: [...store.messages()], store },
        firstUser,
        firstAssistant,
        secondBoundaryId: secondBoundary.id,
    };
}

function assistantMessage(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function dates(...timestamps: string[]): () => Date {
    const next = values(...timestamps);
    return () => new Date(next());
}

function values<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) {
            throw new Error("No scripted value remains");
        }
        return item;
    };
}
