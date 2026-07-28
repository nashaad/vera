import { describe, expect, test } from "bun:test";

import { Inbox } from "../../src/store/inbox.ts";
import {
    WatchAdmission,
    WatchFloodError,
} from "../../src/watch/admission.ts";
import { SOURCE_GAP_KIND, type SourceEvent } from "../../src/watch/source.ts";
import type { WatchFloodPolicy } from "../../src/extensions/contributions.ts";

function event(id: string, extra: Partial<SourceEvent> = {}): SourceEvent {
    return {
        id,
        kind: "arc.post",
        ts: "2026-07-28T14:03:11.412Z",
        actor: "node-a/nash",
        session: null,
        payload: { issue_id: "nash-95" },
        ...extra,
    };
}

function fixture(
    options: { flood?: WatchFloodPolicy; perSec?: number; burst?: number } = {},
) {
    const inbox = Inbox.open(":memory:");
    let pumps = 0;
    const admission = new WatchAdmission({
        inbox,
        watchId: "vera.arc/main",
        address: "coordinator",
        flood: options.flood ?? "shed",
        limits: {
            maxEventsPerSec: options.perSec ?? 50,
            burstEvents: options.burst ?? 500,
        },
        now: () => 1_000,
        onAppended: () => {
            pumps += 1;
        },
    });
    return { inbox, admission, pumps: () => pumps };
}

describe("watch admission", () => {
    test("an admitted event becomes one entry carrying actor and session", () => {
        const { inbox, admission, pumps } = fixture();

        admission.admit([event("arc:1", { session: "opus-95", cursor: "v1:1" })]);

        const [entry] = inbox.readAfter(0, { limit: 10 });
        expect(entry?.source).toBe("vera.arc/main");
        expect(entry?.kind).toBe("arc.post");
        expect(entry?.actor).toBe("node-a/nash");
        expect(entry?.session).toBe("opus-95");
        expect(entry?.address).toBe("coordinator");
        expect(JSON.parse(entry?.payload ?? "{}")).toEqual({ issue_id: "nash-95" });
        expect(pumps()).toBe(1);
        inbox.close();
    });

    test("the cursor only moves once the entries are in the log", () => {
        const { inbox, admission } = fixture();
        expect(admission.cursor()).toBeNull();

        admission.admit([event("arc:1", { cursor: "v1:1" })]);

        expect(inbox.tail()).toBe(1);
        expect(admission.cursor()).toBe("v1:1");
        inbox.close();
    });

    test("a repeated id inside the dedup window is dropped", () => {
        const { inbox, admission } = fixture();

        admission.admit([event("arc:1"), event("arc:1")]);

        expect(inbox.tail()).toBe(1);
        expect(admission.stats().droppedDuplicate).toBe(1);
        inbox.close();
    });

    test("a malformed event is dropped without stopping the batch", () => {
        const { inbox, admission } = fixture();

        admission.admit([event("arc:1", { ts: "not a date" }), event("arc:2")]);

        // One admitted entry plus the gap entry recording the drop.
        expect(inbox.tail()).toBe(2);
        expect(admission.stats().droppedMalformed).toBe(1);
        inbox.close();
    });

    test("an oversized payload is dropped and counted", () => {
        const inbox = Inbox.open(":memory:");
        const admission = new WatchAdmission({
            inbox,
            watchId: "vera.arc/main",
            address: null,
            flood: "shed",
            limits: { maxPayloadBytes: 32 },
        });

        admission.admit([event("arc:1", { payload: { blob: "x".repeat(200) } })]);

        // Nothing admitted; the only entry is the gap recording the drop.
        expect(inbox.tail()).toBe(1);
        expect(admission.stats().droppedOversize).toBe(1);
        inbox.close();
    });

    test("shedding writes a status-only gap entry naming the loss", () => {
        const { inbox, admission } = fixture({ perSec: 1, burst: 2 });

        admission.admit([
            event("arc:1"),
            event("arc:2"),
            event("arc:3"),
            event("arc:4"),
        ]);

        const entries = inbox.readAfter(0, { limit: 10 });
        const gap = entries.at(-1);
        expect(gap?.kind).toBe(SOURCE_GAP_KIND);
        expect(gap?.actor).toBe("source:vera.arc/main");
        expect(gap?.session).toBeNull();
        expect(JSON.parse(gap?.payload ?? "{}")).toMatchObject({
            reason: "flood",
            dropped: 2,
        });
        expect(admission.stats().droppedFlood).toBe(2);
        inbox.close();
    });

    test("a quarantine-policy watch still writes the gap before it raises", () => {
        const { inbox, admission } = fixture({
            flood: "quarantine",
            perSec: 1,
            burst: 1,
        });

        expect(() => admission.admit([event("arc:1"), event("arc:2")]))
            .toThrow(WatchFloodError);
        expect(inbox.readAfter(0, { limit: 10 }).at(-1)?.kind)
            .toBe(SOURCE_GAP_KIND);
        inbox.close();
    });

    test("a checkpoint moves the cursor with nothing appended", () => {
        const { inbox, admission } = fixture();

        admission.checkpoint("v1:9");

        expect(inbox.tail()).toBe(0);
        expect(admission.cursor()).toBe("v1:9");
        inbox.close();
    });
});
