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

    test("keepalives and malformed frames leave the log untouched", async () => {
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

        expect(inbox.tail()).toBe(1);
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
