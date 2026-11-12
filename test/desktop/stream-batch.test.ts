import { describe, expect, test } from "bun:test";

import { createStreamBatcher, isStreamedText, type StreamBatcherOptions } from "../../clients/ui/src/session/streamBatch.ts";
import { parseSessionLine, type SessionMessage } from "../../clients/ui/src/session/wire.ts";

function line(value: unknown): SessionMessage {
    const message = parseSessionLine(JSON.stringify(value));
    if (message === undefined) throw new Error("test line did not parse");
    return message;
}

const delta = (text: string): SessionMessage => line({ type: "assistant_delta", text });
const thinking = (text: string): SessionMessage => line({ type: "assistant_thinking", text });
const turnFinished = (): SessionMessage => line({ type: "turn_finished" });
const toolStarted = (): SessionMessage => line({ type: "tool_started", tool: "bash", args: { command: "ls" } });

interface Scheduled {
    readonly run: () => void;
    readonly ms: number;
    cancelled: boolean;
}

interface Harness {
    readonly applied: SessionMessage[][];
    readonly scheduled: Scheduled[];
    readonly options: StreamBatcherOptions;
}

function harness(intervals: readonly number[] = [250]): Harness {
    const applied: SessionMessage[][] = [];
    const scheduled: Scheduled[] = [];
    const queue = [...intervals];
    const options: StreamBatcherOptions = {
        apply: (messages) => {
            applied.push([...messages]);
        },
        interval: () => queue.shift() ?? 250,
        schedule: (run, ms) => {
            const timer: Scheduled = { run, ms, cancelled: false };
            scheduled.push(timer);
            return () => {
                timer.cancelled = true;
            };
        },
    };
    return { applied, scheduled, options };
}

function fire(timer: Scheduled | undefined): void {
    if (timer === undefined) throw new Error("no timer was scheduled");
    timer.run();
}

describe("stream batching", () => {
    test("only assistant text and thinking count as streamed", () => {
        expect(isStreamedText(delta("a"))).toBe(true);
        expect(isStreamedText(thinking("a"))).toBe(true);
        expect(isStreamedText(turnFinished())).toBe(false);
        expect(isStreamedText(toolStarted())).toBe(false);
    });

    test("deltas are held until the timer runs, then applied as one batch in order", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        const first = delta("Hel");
        const second = thinking("hmm");
        const third = delta("lo");
        batcher.push(first);
        batcher.push(second);
        batcher.push(third);
        expect(h.applied).toEqual([]);

        fire(h.scheduled[0]);
        expect(h.applied).toEqual([[first, second, third]]);
    });

    test("a batch opens one timer and later deltas join it", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        batcher.push(delta("a"));
        batcher.push(delta("b"));
        batcher.push(thinking("c"));
        expect(h.scheduled.length).toBe(1);
        expect(h.scheduled[0]?.cancelled).toBe(false);
    });

    test("a non-text message applies held deltas and itself in one batch, then cancels the timer", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        const streamed = delta("partial");
        const finished = turnFinished();
        batcher.push(streamed);
        batcher.push(finished);

        expect(h.applied).toEqual([[streamed, finished]]);
        expect(h.scheduled[0]?.cancelled).toBe(true);
    });

    test("a tool call after deltas flushes them in order, and a later delta opens a new timer", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        const streamed = delta("before");
        const call = toolStarted();
        const after = delta("after");
        batcher.push(streamed);
        batcher.push(call);
        batcher.push(after);

        expect(h.applied).toEqual([[streamed, call]]);
        expect(h.scheduled.length).toBe(2);
        expect(h.scheduled[0]?.cancelled).toBe(true);
        expect(h.scheduled[1]?.cancelled).toBe(false);

        fire(h.scheduled[1]);
        expect(h.applied).toEqual([[streamed, call], [after]]);
    });

    test("a non-text message with nothing held applies only itself", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        const finished = turnFinished();
        batcher.push(finished);
        expect(h.applied).toEqual([[finished]]);
    });

    test("flush applies held messages now and cancels the timer", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        const first = delta("x");
        const second = delta("y");
        batcher.push(first);
        batcher.push(second);
        batcher.flush();

        expect(h.applied).toEqual([[first, second]]);
        expect(h.scheduled[0]?.cancelled).toBe(true);
    });

    test("flush with nothing held does not call apply", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        batcher.flush();
        expect(h.applied).toEqual([]);

        batcher.push(delta("z"));
        batcher.flush();
        batcher.flush();
        expect(h.applied.length).toBe(1);
    });

    test("dispose cancels the timer and drops held messages", () => {
        const h = harness();
        const batcher = createStreamBatcher(h.options);
        batcher.push(delta("gone"));
        batcher.dispose();

        expect(h.scheduled[0]?.cancelled).toBe(true);
        batcher.flush();
        expect(h.applied).toEqual([]);
    });

    test("the interval is read when a batch opens and that value is the timer delay", () => {
        const h = harness([250, 1000]);
        const batcher = createStreamBatcher(h.options);
        batcher.push(delta("a"));
        batcher.push(delta("b"));
        expect(h.scheduled.map((timer) => timer.ms)).toEqual([250]);

        fire(h.scheduled[0]);
        batcher.push(delta("c"));
        expect(h.scheduled.map((timer) => timer.ms)).toEqual([250, 1000]);
    });
});
