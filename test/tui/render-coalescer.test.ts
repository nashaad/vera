import { expect, test } from "bun:test";

import { createTuiExperimentalEventBus } from "../../clients/tui/experimental-tui-events.ts";
import {
    createRenderCoalescer,
    isCoalescedUpdate,
} from "../../clients/tui/render-coalescer.ts";

interface Clock {
    readonly coalescer: ReturnType<typeof createRenderCoalescer>;
    readonly renders: () => number;
    readonly tick: () => void;
    readonly delays: number[];
}

function testClock(intervalMs?: () => number): Clock {
    const delays: number[] = [];
    let pending: (() => void) | undefined;
    let renders = 0;
    const coalescer = createRenderCoalescer({
        render: () => {
            renders += 1;
        },
        intervalMs,
        setTimer: (run, ms) => {
            pending = run;
            delays.push(ms);
            return 1;
        },
        clearTimer: () => {
            pending = undefined;
        },
    });
    return {
        coalescer,
        renders: () => renders,
        tick: () => {
            const run = pending;
            pending = undefined;
            run?.();
        },
        delays,
    };
}

test("a blurred stream repaints once a second and a focused one at 250 ms", () => {
    let focused = false;
    const clock = testClock(() => (focused ? 250 : 1000));
    clock.coalescer.request("assistant_delta");
    expect(clock.delays).toEqual([1000]);
    clock.tick();

    focused = true;
    clock.coalescer.request("assistant_delta");
    expect(clock.delays).toEqual([1000, 250]);
});

test("a burst of deltas paints once", () => {
    const clock = testClock();
    for (let index = 0; index < 200; index += 1) {
        clock.coalescer.request("assistant_delta");
    }

    expect(clock.renders()).toBe(0);
    clock.tick();
    expect(clock.renders()).toBe(1);
});

test("a burst of reasoning deltas paints once", () => {
    const clock = testClock();
    for (let index = 0; index < 200; index += 1) {
        clock.coalescer.request("assistant_thinking");
    }

    expect(clock.renders()).toBe(0);
    clock.tick();
    expect(clock.renders()).toBe(1);
});

test("a changed transcript waits for the timer", () => {
    const clock = testClock();
    clock.coalescer.request("transcript_changed");

    expect(clock.renders()).toBe(0);
    expect(clock.delays).toEqual([250]);
    clock.tick();
    expect(clock.renders()).toBe(1);
});

test("a render that reports a changed transcript does not render again before it returns", () => {
    let pending: (() => void) | undefined;
    let renders = 0;
    let insideRender = false;
    let nestedRenders = 0;
    const transcript = [{ role: "assistant" as const, text: "streamed" }];
    const bus = createTuiExperimentalEventBus(
        () => {},
        (updateType) => coalescer.request(updateType),
    );
    const coalescer = createRenderCoalescer({
        render: () => {
            renders += 1;
            if (insideRender) nestedRenders += 1;
            insideRender = true;
            bus.transcriptChanged(transcript);
            insideRender = false;
        },
        setTimer: (run) => {
            pending = run;
            return 1;
        },
        clearTimer: () => {
            pending = undefined;
        },
    });
    bus.events.on("fixture", "transcript_changed", () => {});

    function tick(): void {
        const run = pending;
        pending = undefined;
        run?.();
    }

    coalescer.request("transcript_changed");
    tick();
    expect(renders).toBe(1);

    tick();
    expect(renders).toBe(2);
    expect(nestedRenders).toBe(0);
});

test("the last delta of a burst still lands", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.tick();
    clock.coalescer.request("assistant_delta");

    // The trailing delta is waiting, and finishing the turn shows it without
    // waiting for the timer.
    expect(clock.renders()).toBe(1);
    clock.coalescer.request("turn_finished");
    expect(clock.renders()).toBe(2);
});

test("an interaction surface paints at once, with whatever was waiting", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.coalescer.request("ui_request");

    expect(clock.renders()).toBe(1);
    // The delta rode along with it, so the timer has nothing left to paint.
    clock.tick();
    expect(clock.renders()).toBe(1);
});

test("a quiet stream does not repaint", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.tick();
    clock.tick();

    expect(clock.renders()).toBe(1);
});

test("stopping drops a pending repaint", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.coalescer.stop();
    clock.tick();
    clock.coalescer.flush();

    expect(clock.renders()).toBe(0);
});

test("only streaming updates are coalesced", () => {
    expect(isCoalescedUpdate("assistant_delta")).toBe(true);
    expect(isCoalescedUpdate("assistant_thinking")).toBe(true);
    expect(isCoalescedUpdate("model_activity")).toBe(true);
    // A type nobody listed is immediate, which is the safe direction for one
    // added later.
    expect(isCoalescedUpdate("tool_started")).toBe(false);
    expect(isCoalescedUpdate("ui_request")).toBe(false);
});
