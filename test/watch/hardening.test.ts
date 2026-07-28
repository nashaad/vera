import { describe, expect, test } from "bun:test";

import type { OwnedWatchContribution } from "../../src/extensions/contribution-set.ts";
import { Inbox, type InboxEntry } from "../../src/store/inbox.ts";
import { WatchAdmission } from "../../src/watch/admission.ts";
import {
    createArcConnector,
    MAX_FRAME_BYTES,
} from "../../src/watch/arc-connector.ts";
import {
    FAILURES_BEFORE_QUARANTINE,
    HEALTHY_RUN_MS,
    SupervisedWatch,
} from "../../src/watch/supervisor.ts";
import {
    SOURCE_GAP_KIND,
    type SourceCheckpoint,
    type SourceEvent,
    type WatchConnector,
    type WatchRuntimeContext,
} from "../../src/watch/source.ts";
import { parseExtensionContributions } from "../../src/extensions/contributions.ts";

const WATCH_ID = "vera.arc/main";

function event(id: string, overrides: Partial<SourceEvent> = {}): SourceEvent {
    return {
        id,
        kind: "arc.post",
        ts: "2026-07-28T00:00:00.000Z",
        actor: "nash",
        session: null,
        payload: { ok: true },
        ...overrides,
    };
}

function gaps(inbox: Inbox): InboxEntry[] {
    return inbox
        .readAfter(0, { limit: 1_000 })
        .filter((entry) => entry.kind === SOURCE_GAP_KIND);
}

function admissionFor(inbox: Inbox, limits = {}): WatchAdmission {
    return new WatchAdmission({
        inbox,
        watchId: WATCH_ID,
        address: null,
        flood: "shed",
        limits,
    });
}

describe("watch admission hardening", () => {
    test("a failed append leaves the ids redeliverable", () => {
        const inbox = Inbox.open(":memory:");
        const admission = admissionFor(inbox);
        const realAppend = inbox.appendAll.bind(inbox);
        inbox.appendAll = () => {
            throw new Error("disk full");
        };

        expect(() => admission.admit([event("arc:1")])).toThrow("disk full");

        inbox.appendAll = realAppend;
        admission.admit([event("arc:1")]);

        expect(admission.stats().admitted).toBe(1);
        expect(inbox.tail()).toBe(1);
        inbox.close();
    });

    test("malformed and oversize drops write one gap that says why", () => {
        const inbox = Inbox.open(":memory:");
        const admission = admissionFor(inbox, { maxPayloadBytes: 32 });

        admission.admit([
            event("arc:1", { ts: "not a date" }),
            event("arc:2", { payload: { blob: "x".repeat(200) } }),
            event("arc:3", { ts: "also not a date" }),
        ]);

        const written = gaps(inbox);
        expect(written).toHaveLength(1);
        const payload = JSON.parse(written[0]!.payload) as Record<string, unknown>;
        expect(payload.reason).toBe("dropped");
        expect(payload.malformed).toBe(2);
        expect(payload.oversize).toBe(1);
        expect(String(payload.detail)).toContain("bytes");
        inbox.close();
    });

    test("a shed episode writes one gap however many admit calls it spans", () => {
        const inbox = Inbox.open(":memory:");
        let now = 1_000;
        const admission = new WatchAdmission({
            inbox,
            watchId: WATCH_ID,
            address: null,
            flood: "shed",
            limits: { maxEventsPerSec: 1, burstEvents: 1 },
            now: () => now,
        });

        for (let index = 0; index < 200; index += 1) {
            admission.admit([event(`arc:${index}`)]);
        }

        expect(admission.stats().droppedFlood).toBeGreaterThan(100);
        expect(gaps(inbox)).toHaveLength(1);

        // A new episode after the window is a new gap, not a silent one.
        now += 10_000;
        for (let index = 200; index < 400; index += 1) {
            admission.admit([event(`arc:${index}`)]);
        }

        expect(gaps(inbox)).toHaveLength(2);
        inbox.close();
    });
});

function ownedWatch(): OwnedWatchContribution {
    return {
        id: WATCH_ID,
        localId: "main",
        extensionId: "vera.arc",
        definition: {
            id: "main",
            source_family: "arc",
            config: { server: "https://arc.local" },
            flood: "shed",
        },
    };
}

function supervised(
    connector: WatchConnector,
    options: {
        now?: () => number;
        sleep?: (ms: number) => Promise<void>;
        onStateChange?: () => void;
    } = {},
) {
    const inbox = Inbox.open(":memory:");
    const task = new SupervisedWatch({
        watch: ownedWatch(),
        connector,
        admission: admissionFor(inbox),
        random: () => 1,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.onStateChange === undefined
            ? {}
            : { onStateChange: options.onStateChange }),
        sleep: options.sleep ?? (async (): Promise<void> => {
            await Bun.sleep(0);
        }),
    });
    return { inbox, task };
}

describe("watch supervision hardening", () => {
    test("healthy-length runs never accumulate into a quarantine", async () => {
        let now = 0;
        let runs = 0;
        const { inbox, task } = supervised(
            {
                sourceFamily: "arc",
                run: async (): Promise<void> => {
                    runs += 1;
                    now += HEALTHY_RUN_MS + 1_000;
                    throw new Error("upstream dropped the connection");
                },
            },
            { now: () => now },
        );

        task.start();
        await Bun.sleep(10);
        const state = task.status().state;
        await task.stop();

        expect(runs).toBeGreaterThan(FAILURES_BEFORE_QUARANTINE);
        expect(state).not.toBe("quarantined");
        inbox.close();
    });

    test("a crash inside the loop quarantines rather than lying about the state", async () => {
        const { inbox, task } = supervised(
            {
                sourceFamily: "arc",
                run: (): Promise<void> =>
                    Promise.reject(new Error("upstream unavailable")),
            },
            {
                sleep: (): Promise<void> =>
                    Promise.reject(new Error("timer subsystem failed")),
            },
        );

        task.start();
        await Bun.sleep(10);

        expect(task.status().state).toBe("quarantined");
        expect(task.status().lastError).toBe("timer subsystem failed");
        await task.stop();
        inbox.close();
    });

    test("a throwing status listener does not stop supervision", async () => {
        let runs = 0;
        const { inbox, task } = supervised(
            {
                sourceFamily: "arc",
                run: async (): Promise<void> => {
                    runs += 1;
                    throw new Error("upstream unavailable");
                },
            },
            {
                onStateChange: (): void => {
                    throw new Error("listener exploded");
                },
            },
        );

        task.start();
        await Bun.sleep(10);
        await task.stop();

        expect(runs).toBeGreaterThanOrEqual(FAILURES_BEFORE_QUARANTINE);
        inbox.close();
    });
});

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

function connectorContext(inbox: Inbox) {
    const admission = admissionFor(inbox);
    const controller = new AbortController();
    let healthyCalls = 0;
    const context: WatchRuntimeContext = {
        watchId: WATCH_ID,
        sourceFamily: "arc",
        config: { server: "https://arc.local" },
        address: null,
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
        healthy: (): void => {
            healthyCalls += 1;
        },
    };
    return { admission, context, healthyCalls: () => healthyCalls };
}

function respondWith(chunks: readonly string[]) {
    return (): Promise<Response> =>
        Promise.resolve(
            new Response(streamOf(chunks), {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            }),
        );
}

function arcFrame(seq: number, id: string | null = `v1:${seq}`): string {
    const body = JSON.stringify({
        seq,
        kind: "post",
        ts: "2026-07-28T00:00:00.000Z",
    });
    return `${id === null ? "" : `id: ${id}\n`}data: ${body}\n\n`;
}

describe("arc connector hardening", () => {
    test("connecting is not healthy; the first admitted event is", async () => {
        const inbox = Inbox.open(":memory:");
        const bench = connectorContext(inbox);

        await createArcConnector({ fetch: respondWith([]) })
            .run(bench.context);

        expect(bench.healthyCalls()).toBe(0);

        const second = connectorContext(inbox);
        await createArcConnector({ fetch: respondWith([arcFrame(1), arcFrame(2)]) })
            .run(second.context);

        expect(second.healthyCalls()).toBe(1);
        inbox.close();
    });

    test("an oversized frame is discarded to its own boundary and recorded", async () => {
        const inbox = Inbox.open(":memory:");
        const bench = connectorContext(inbox);
        const huge = `data: ${"é".repeat(MAX_FRAME_BYTES)}`;
        const fetchImpl = respondWith([
            huge.slice(0, huge.length / 2),
            `${huge.slice(huge.length / 2)}\n\n`,
            arcFrame(7),
        ]);

        await createArcConnector({ fetch: fetchImpl }).run(bench.context);

        const written = gaps(inbox);
        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0]!.payload).reason).toBe("oversize_frame");
        // The frame after the discard is intact rather than spliced.
        const admitted = inbox
            .readAfter(0, { limit: 100 })
            .filter((entry) => entry.kind === "arc.post");
        expect(admitted).toHaveLength(1);
        expect(JSON.parse(admitted[0]!.payload).seq).toBe(7);
        expect(bench.admission.cursor()).toBe("v1:7");
        inbox.close();
    });

    test("a frame without an id does not move the cursor", async () => {
        const inbox = Inbox.open(":memory:");
        const bench = connectorContext(inbox);

        await createArcConnector({
            fetch: respondWith([arcFrame(1), arcFrame(2, null)]),
        }).run(bench.context);

        expect(bench.admission.cursor()).toBe("v1:1");
        inbox.close();
    });
});

describe("watch contribution defaults", () => {
    test("the default watch config cannot be mutated", () => {
        const contributions = parseExtensionContributions(
            { watches: [{ id: "main", source_family: "arc" }] },
            "vera.arc",
        );
        const config = contributions.watches[0]!.config as Record<string, unknown>;

        expect(Object.isFrozen(config)).toBe(true);
    });
});
