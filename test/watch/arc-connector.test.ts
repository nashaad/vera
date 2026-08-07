import { describe, expect, test } from "bun:test";

import { Inbox } from "../../src/store/inbox.ts";
import { WatchAdmission } from "../../src/watch/admission.ts";
import {
    arcEventsUrl,
    createArcConnector,
} from "../../src/watch/arc-connector.ts";
import {
    WatchFatalError,
    type SourceCheckpoint,
    type SourceEvent,
    type WatchRuntimeContext,
} from "../../src/watch/source.ts";
import type { JsonObject } from "../../src/extensions/contributions.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import type { PendingDelivery } from "../../src/store/session-store.ts";

function sseResponse(frames: readonly string[], status = 200): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) {
                controller.enqueue(encoder.encode(frame));
            }
            controller.close();
        },
    });
    return new Response(stream, { status });
}

function arcFrame(seq: number, body: Record<string, unknown>): string {
    return `id: v1:${seq}\nevent: post\ndata: ${JSON.stringify(body)}\n\n`;
}

function context(
    inbox: Inbox,
    config: JsonObject,
    controller = new AbortController(),
): { context: WatchRuntimeContext; admission: WatchAdmission } {
    const admission = new WatchAdmission({
        inbox,
        watchId: "vera.arc/main",
        address: "coordinator",
        flood: "shed",
    });
    return {
        admission,
        context: {
            watchId: "vera.arc/main",
            sourceFamily: "arc",
            config,
            address: "coordinator",
            flood: "shed",
            signal: controller.signal,
            cursor: (): string | null => admission.cursor(),
            admit: async (events: readonly SourceEvent[]): Promise<void> => {
                admission.admit(events);
            },
            checkpoint: (checkpoint: SourceCheckpoint): void => {
                admission.checkpoint(checkpoint.cursor);
            },
            recordGap: (
                reason: string,
                detail: Record<string, string | number>,
            ): void => {
                admission.recordGap(reason, detail);
            },
            healthy: (): void => undefined,
        },
    };
}

describe("arc events url", () => {
    test("filters become query parameters on the events endpoint", () => {
        expect(arcEventsUrl({
            server: "https://arc.local",
            topic: "vera-inbox",
            kind: ["post", "claim"],
        })).toBe("https://arc.local/events?topic=vera-inbox&kind=post%2Cclaim");
    });

    test("a missing server is a configuration failure, not a retry", () => {
        expect(() => arcEventsUrl({})).toThrow(WatchFatalError);
    });

    test("a multi-topic config is rejected rather than silently narrowed", () => {
        expect(() => arcEventsUrl({
            server: "https://arc.local",
            topics: ["a", "b"],
        })).toThrow("one topic");
    });
});

describe("arc connector", () => {
    test("each arc event becomes one entry keeping actor, session and issue", async () => {
        const inbox = Inbox.open(":memory:");
        const { context: ctx } = context(inbox, { server: "https://arc.local" });
        const connector = createArcConnector({
            fetch: async () =>
                sseResponse([
                    arcFrame(1483, {
                        seq: 1483,
                        kind: "post",
                        issue_id: "nash-95",
                        topic: "vera-inbox",
                        actor: "node-a/nash",
                        session: "opus-94",
                        payload: JSON.stringify({ excerpt: "spec drafted" }),
                        ts: "2026-07-28T14:03:11.412Z",
                    }),
                ]),
        });

        await connector.run(ctx);

        const [entry] = inbox.readAfter(0, { limit: 10 });
        expect(entry?.source).toBe("vera.arc/main");
        expect(entry?.kind).toBe("arc.post");
        expect(entry?.actor).toBe("node-a/nash");
        expect(entry?.session).toBe("opus-94");
        expect(entry?.address).toBe("coordinator");
        expect(entry?.ts).toBe("2026-07-28T14:03:11.412Z");
        expect(JSON.parse(entry?.payload ?? "{}")).toEqual({
            seq: 1483,
            kind: "post",
            issue_id: "nash-95",
            topic: "vera-inbox",
            actor: "node-a/nash",
            session: "opus-94",
            detail: { excerpt: "spec drafted" },
        });
        expect(inbox.watchCursor("vera.arc/main")).toBe("v1:1483");
        inbox.close();
    });

    test("an unattributed event still carries a stable actor", async () => {
        const inbox = Inbox.open(":memory:");
        const { context: ctx } = context(inbox, { server: "https://arc.local" });
        const connector = createArcConnector({
            fetch: async () =>
                sseResponse([
                    arcFrame(1, { seq: 1, kind: "expire", ts: "2026-07-28T14:00:00Z" }),
                ]),
        });

        await connector.run(ctx);

        const [entry] = inbox.readAfter(0, { limit: 10 });
        expect(entry?.actor).toBe("source:arc");
        expect(entry?.session).toBeNull();
        inbox.close();
    });

    test("a persisted cursor resumes the stream with Last-Event-ID", async () => {
        const inbox = Inbox.open(":memory:");
        inbox.setWatchCursor("vera.arc/main", "v1:1482");
        const { context: ctx } = context(inbox, { server: "https://arc.local" });
        let seen: Record<string, string> = {};
        const connector = createArcConnector({
            secret: () => "token-abc",
            fetch: async (_url, init) => {
                seen = (init?.headers ?? {}) as Record<string, string>;
                return sseResponse([]);
            },
        });

        await connector.run(ctx);

        expect(seen["Last-Event-ID"]).toBe("v1:1482");
        expect(seen.Accept).toBe("text/event-stream");
        expect(seen.Authorization).toBe("Bearer token-abc");
        inbox.close();
    });

    test("keepalives are silent and malformed frames record a gap", async () => {
        const inbox = Inbox.open(":memory:");
        const { context: ctx } = context(inbox, { server: "https://arc.local" });
        const connector = createArcConnector({
            fetch: async () =>
                sseResponse([
                    ": keepalive\n\n",
                    "id: v1:9\nevent: post\ndata: not json\n\n",
                    arcFrame(10, { seq: 10, kind: "done", ts: "2026-07-28T14:00:00Z" }),
                ]),
        });

        await connector.run(ctx);

        expect(inbox.tail()).toBe(2);
        const entries = inbox.readAfter(0, { limit: 10 });
        expect(entries[0]!.kind).toBe("source.gap");
        expect(entries[0]!.payload).toContain("malformed_frame");
        expect(entries[0]!.payload).toContain("v1:9");
        expect(entries[1]!.kind).toBe("arc.done");
        expect(inbox.watchCursor("vera.arc/main")).toBe("v1:10");
        inbox.close();
    });

    test("a rejected token quarantines rather than retrying forever", async () => {
        const inbox = Inbox.open(":memory:");
        const { context: ctx } = context(inbox, { server: "https://arc.local" });
        const connector = createArcConnector({
            fetch: async () => sseResponse([], 401),
        });

        await expect(connector.run(ctx)).rejects.toThrow(WatchFatalError);
        inbox.close();
    });
});

describe("self-echo through the arc connector", () => {
    /**
     * arc stamps a post's event with the poster's node id as `actor` and its
     * `ARC_SESSION` as `session`; the host attaches a session's consumer with
     * (arc node id, agent id) as the self-echo pair. This drives the real
     * connector over both halves of the acceptance: the session's own post is
     * suppressed, anything else still wakes it.
     */
    test("a session's own arc posts do not wake it; another session's do", async () => {
        const inbox = Inbox.open(":memory:");
        const consumers = new ConsumerRegistry(inbox, "vera-host");
        const coordinator = new InboxDeliveryCoordinator(consumers);
        const recorded: PendingDelivery[] = [];
        let wakes = 0;
        const session = coordinator.attach({
            label: "agent-1",
            actor: "node-a",
            session: "agent-1",
            target: {
                recordDelivery: (delivery) => {
                    recorded.push(delivery);
                    return Promise.resolve(true);
                },
                pendingDeliveryIds: () => [],
            },
            triggerTurn: () => {
                wakes += 1;
            },
            minWakeIntervalMs: 0,
        });
        const admission = new WatchAdmission({
            inbox,
            watchId: "vera.arc/main",
            address: null,
            flood: "shed",
        });
        const controller = new AbortController();
        const ctx: WatchRuntimeContext = {
            watchId: "vera.arc/main",
            sourceFamily: "arc",
            config: { server: "https://arc.local" },
            address: null,
            flood: "shed",
            signal: controller.signal,
            cursor: () => admission.cursor(),
            admit: async (events) => {
                admission.admit(events);
            },
            checkpoint: (checkpoint) => {
                admission.checkpoint(checkpoint.cursor);
            },
            recordGap: (reason, detail) => {
                admission.recordGap(reason, detail);
            },
            healthy: () => undefined,
        };
        const connector = createArcConnector({
            fetch: async () =>
                sseResponse([
                    arcFrame(1, {
                        seq: 1,
                        kind: "post",
                        issue_id: "nash-99",
                        actor: "node-a",
                        session: "agent-1",
                        payload: JSON.stringify({ excerpt: "my own post" }),
                        ts: "2026-08-07T10:00:00Z",
                    }),
                    arcFrame(2, {
                        seq: 2,
                        kind: "post",
                        issue_id: "nash-99",
                        actor: "node-a",
                        session: "agent-2",
                        payload: JSON.stringify({ excerpt: "a sibling reply" }),
                        ts: "2026-08-07T10:00:01Z",
                    }),
                ]),
        });

        await connector.run(ctx);
        await coordinator.pumpAll();

        expect(wakes).toBe(1);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]!.content).toContain("a sibling reply");
        expect(recorded[0]!.content).not.toContain("my own post");
        // Suppressed is not lost: the offset moved past the session's own
        // entry, so it never comes back as a later wake either.
        expect(session.consumer.lag()).toBe(0);

        session.release();
        coordinator.close();
        inbox.close();
    });
});
