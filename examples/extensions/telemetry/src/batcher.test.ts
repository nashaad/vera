import { describe, expect, test } from "bun:test";

import { Batcher } from "./batcher.ts";
import { sessionEndEvent, telemetryDroppedEvent, type TelemetryEvent } from "./events.ts";
import type { TelemetrySink } from "./sinks/sink.ts";

const CONTEXT = { install_id: "install-1" };
const TIME = "2026-01-01T12:00:00.000Z";

function event(id: number): TelemetryEvent {
    return sessionEndEvent(
        { session_id: `s${id}`, provider: "p", model: "m", purpose: "turn" },
        CONTEXT,
        "closed",
        TIME,
    );
}

function ids(events: readonly TelemetryEvent[]): string[] {
    return events.map((entry) => entry.session_id);
}

class FakeSink implements TelemetrySink {
    readonly attempts: TelemetryEvent[][] = [];
    failures = 0;

    async send(events: readonly TelemetryEvent[]): Promise<void> {
        this.attempts.push([...events]);
        if (this.failures > 0) {
            this.failures -= 1;
            throw new Error("log service is down");
        }
    }
}

function batcherFor(sink: FakeSink, overrides: Partial<ConstructorParameters<typeof Batcher>[1]> = {}): Batcher {
    return new Batcher(sink, {
        flushSeconds: 60,
        dropped: (count) => telemetryDroppedEvent(CONTEXT, count, TIME),
        ...overrides,
    });
}

describe("Batcher", () => {
    test("flush sends the queue and empties it", async () => {
        const sink = new FakeSink();
        const batcher = batcherFor(sink);
        batcher.push(event(1));
        batcher.push(event(2));
        expect(batcher.size).toBe(2);
        await batcher.flush();
        expect(sink.attempts.map(ids)).toEqual([["s1", "s2"]]);
        expect(batcher.size).toBe(0);
    });

    test("an empty flush does not call the sink", async () => {
        const sink = new FakeSink();
        await batcherFor(sink).flush();
        expect(sink.attempts).toHaveLength(0);
    });

    test("caps the queue at its limit and counts the oldest drops", async () => {
        const sink = new FakeSink();
        const batcher = batcherFor(sink, { queueLimit: 3, flushAt: 1_000 });
        for (const id of [1, 2, 3, 4, 5]) batcher.push(event(id));
        expect(batcher.size).toBe(3);
        expect(batcher.pendingDrops).toBe(2);
        await batcher.flush();
        expect(ids(sink.attempts[0]!)).toEqual(["s3", "s4", "s5", ""]);
        expect(batcher.pendingDrops).toBe(0);
    });

    test("reports drops once, on the next flush", async () => {
        const sink = new FakeSink();
        const batcher = batcherFor(sink, { queueLimit: 1, flushAt: 1_000 });
        batcher.push(event(1));
        batcher.push(event(2));
        await batcher.flush();
        const dropped = sink.attempts[0]!.filter((entry) => entry.event === "telemetry_dropped");
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toMatchObject({ dropped: 1 });
        await batcher.flush();
        expect(sink.attempts).toHaveLength(1);
    });

    test("flushes as soon as the batch size is reached", async () => {
        const sink = new FakeSink();
        const batcher = batcherFor(sink, { flushAt: 2 });
        batcher.push(event(1));
        expect(sink.attempts).toHaveLength(0);
        batcher.push(event(2));
        expect(sink.attempts.map(ids)).toEqual([["s1", "s2"]]);
        await batcher.flush();
    });

    test("keeps a failed batch for one retry at the next flush", async () => {
        const sink = new FakeSink();
        sink.failures = 1;
        const batcher = batcherFor(sink);
        batcher.push(event(1));
        await batcher.flush();
        expect(sink.attempts.map(ids)).toEqual([["s1"]]);
        expect(batcher.size).toBe(0);

        batcher.push(event(2));
        await batcher.flush();
        expect(sink.attempts.map(ids)).toEqual([["s1"], ["s1", "s2"]]);

        batcher.push(event(3));
        await batcher.flush();
        expect(sink.attempts.map(ids)).toEqual([["s1"], ["s1", "s2"], ["s3"]]);
    });

    test("drops a batch that fails its retry", async () => {
        const sink = new FakeSink();
        sink.failures = 2;
        const batcher = batcherFor(sink);
        batcher.push(event(1));
        await batcher.flush();
        batcher.push(event(2));
        await batcher.flush();
        batcher.push(event(3));
        await batcher.flush();
        expect(sink.attempts.map(ids)).toEqual([["s1"], ["s1", "s2"], ["s3"]]);
    });

    test("stop flushes what is queued and ignores later pushes", async () => {
        const sink = new FakeSink();
        const batcher = batcherFor(sink);
        batcher.push(event(1));
        await batcher.stop();
        expect(sink.attempts.map(ids)).toEqual([["s1"]]);
        batcher.push(event(2));
        expect(batcher.size).toBe(0);
    });

    test("the timer flushes on its interval", async () => {
        const sink = new FakeSink();
        const batcher = batcherFor(sink, { flushSeconds: 0.01 });
        batcher.start();
        batcher.push(event(1));
        await Bun.sleep(50);
        expect(sink.attempts.map(ids)).toEqual([["s1"]]);
        await batcher.stop();
    });
});
